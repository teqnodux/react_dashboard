"""Unified `/api/feed` — press, SEC, foreign; sort by `updated_at` (SAMR: `processed_at`); cursor pagination."""

from __future__ import annotations

import base64
import json
import heapq
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId
from bson.errors import InvalidId

from config import SEC_FILING_SUMMARY_COLLECTION
from db import get_db, get_feed_items_col, feed_items_deal_id_query
from foreign_collections import FOREIGN_COLLECTIONS
from sec_feed_enrichment import enrich_sec_summary_record

ALLOWED_DAYS = frozenset({1, 3, 7})
CURSOR_VERSION = 2
_FETCH_BATCH = 40

SAMR_COLLECTIONS = frozenset(
    {"samr_cases", "samr_conditional", "samr_unconditional"}
)


# ─── Time / sort ts ───────────────────────────────────────────────────────────


def _parse_sort_ts(val: Any) -> float:
    if val is None:
        return 0.0
    if isinstance(val, datetime):
        return val.timestamp()
    if isinstance(val, ObjectId):
        return val.generation_time.timestamp()
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return 0.0
        try:
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            return datetime.fromisoformat(s).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _maybe_oid_ts(doc: dict[str, Any]) -> float:
    oid_val = doc.get("_id")
    if oid_val is None and "id" in doc:
        raw_id = doc.get("id")
        if isinstance(raw_id, str) and len(raw_id) == 24:
            try:
                oid_val = ObjectId(raw_id)
            except InvalidId:
                oid_val = None
    if isinstance(oid_val, ObjectId):
        return oid_val.generation_time.timestamp()
    return 0.0


def _press_sort_ts(doc: dict[str, Any]) -> float:
    t = _parse_sort_ts(doc.get("updated_at"))
    return t if t > 0 else _maybe_oid_ts(doc)


def _sec_sort_ts(doc: dict[str, Any]) -> float:
    t = _parse_sort_ts(doc.get("updated_at"))
    return t if t > 0 else _maybe_oid_ts(doc)


def _foreign_sort_field(col_name: str) -> str:
    return "processed_at" if col_name in SAMR_COLLECTIONS else "updated_at"


def _foreign_sort_ts(doc: dict[str, Any]) -> float:
    col = doc.get("source") or ""
    field = _foreign_sort_field(str(col))
    t = _parse_sort_ts(doc.get(field))
    if t > 0:
        return t
    for k in ("updated_at", "modified_at", "created_at", "processed_at"):
        t = _parse_sort_ts(doc.get(k))
        if t > 0:
            return t
    return _maybe_oid_ts(doc)


def unified_sort_ts(doc: dict[str, Any]) -> float:
    ft = doc.get("feed_type")
    if ft == "press_release":
        return _press_sort_ts(doc)
    if ft == "sec_filing":
        return _sec_sort_ts(doc)
    return _foreign_sort_ts(doc)


def normalize_days(days: int | None) -> int:
    if days is None or days not in ALLOWED_DAYS:
        return 1
    return days


def _days_cutoff(days: int) -> datetime:
    return datetime.now(tz=timezone.utc) - timedelta(days=days)


def _regex_clause(fields: list[str], search: str) -> dict[str, Any]:
    pattern = {"$regex": search, "$options": "i"}
    return {"$or": [{f: pattern} for f in fields]}


def _and(*clauses: dict[str, Any]) -> dict[str, Any]:
    active = [c for c in clauses if c]
    if not active:
        return {}
    if len(active) == 1:
        return active[0]
    return {"$and": active}


# ─── Keyset helpers ───────────────────────────────────────────────────────────


def _parse_cursor_id(s: str) -> Any:
    """Rebuild Mongo `_id` for filters: 24-char hex → ObjectId, else keep string (e.g. UUID)."""
    if len(s) == 24:
        try:
            return ObjectId(s)
        except InvalidId:
            pass
    return s


def _id_from_doc(doc: dict[str, Any]) -> Any:
    """`_id` for keyset queries — unchanged BSON type, or parsed from string `id`."""
    raw = doc.get("_id")
    if raw is not None:
        return raw
    sid = doc.get("id")
    if sid is None or sid == "":
        raise InvalidId("feed row missing id/_id")
    return _parse_cursor_id(str(sid))


def _keyset_clause(sort_field: str, sf_val: Any, id_val: Any) -> dict[str, Any]:
    """Descending sort: next page is strictly older than (sf_val, _id)."""
    return {
        "$or": [
            {sort_field: {"$lt": sf_val}},
            {"$and": [{sort_field: sf_val}, {"_id": {"$lt": id_val}}]},
        ]
    }


def _doc_key_tuple(doc: dict[str, Any], sort_field: str) -> tuple[Any, Any]:
    return doc.get(sort_field), _id_from_doc(doc)


def _serialize_key_part(sort_field: str, sf_val: Any, id_val: Any) -> list[Any]:
    """JSON-serializable cursor fragment."""
    if isinstance(sf_val, datetime):
        sf_out = sf_val.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    elif sf_val is None:
        sf_out = None
    else:
        sf_out = sf_val
    return [sf_out, str(id_val)]


def _deserialize_key_part(
    pair: list[Any] | None,
    *,
    as_datetime: bool = False,
) -> tuple[Any, Any] | None:
    if not pair or len(pair) < 2:
        return None
    sf_raw, oid_s = pair[0], pair[1]
    rid = _parse_cursor_id(str(oid_s))
    if sf_raw is None:
        return None
    if as_datetime and isinstance(sf_raw, str):
        try:
            s = sf_raw.replace("Z", "+00:00")
            sf_val: Any = datetime.fromisoformat(s)
            if sf_val.tzinfo is None:
                sf_val = sf_val.replace(tzinfo=timezone.utc)
            else:
                sf_val = sf_val.astimezone(timezone.utc)
            return sf_val, rid
        except ValueError:
            pass
    sf_val = sf_raw
    return sf_val, rid


# ─── Cursor encode/decode ──────────────────────────────────────────────────────


def encode_feed_cursor(streams: dict[str, list[Any] | None]) -> str | None:
    payload = {"v": CURSOR_VERSION, "s": streams}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_feed_cursor(token: str | None) -> dict[str, list[Any] | None]:
    if not token or not token.strip():
        return {}
    try:
        pad = 4 - len(token) % 4
        if pad != 4:
            token += "=" * pad
        raw = base64.urlsafe_b64decode(token.encode("ascii"))
        data = json.loads(raw.decode("utf-8"))
        if data.get("v") != CURSOR_VERSION:
            return {}
        out = data.get("s") or {}
        return {str(k): v for k, v in out.items()}
    except Exception:
        return {}


def stream_keys_all() -> list[str]:
    keys = ["press", "sec"]
    for col_name, _, _ in FOREIGN_COLLECTIONS:
        keys.append(f"f:{col_name}")
    return keys


def stream_keys_foreign_only() -> list[str]:
    return [f"f:{col_name}" for col_name, _, _ in FOREIGN_COLLECTIONS]


# ─── Foreign title (search) ───────────────────────────────────────────────────


def _foreign_title(col_name: str, doc: dict[str, Any]) -> str:
    m = {
        "accc_cases": lambda d: d.get("title", ""),
        "brazil_cases": lambda d: d.get("interessados_en") or d.get("interessados", ""),
        "canada_cases": lambda d: d.get("parties", ""),
        "ec_cases": lambda d: d.get("case_title", ""),
        "fs_cases": lambda d: d.get("case_title", ""),
        "ftc_cases": lambda d: d.get("title") or d.get("case_title", ""),
        "german_cases": lambda d: d.get("pursue_en") or d.get("pursue", ""),
        "nz_cases": lambda d: d.get("title", ""),
        "samr_cases": lambda d: d.get("title_en") or d.get("title_cn", ""),
        "samr_conditional": lambda d: d.get("title_en") or d.get("title_cn", ""),
        "samr_unconditional": lambda d: d.get("title_en") or d.get("title_cn", ""),
        "uk_cma_cases": lambda d: d.get("title", ""),
    }
    fn = m.get(col_name)
    return str(fn(doc)) if fn else ""


# ─── Fetch batches ────────────────────────────────────────────────────────────


def _fetch_press_batch(
    db: Any,
    cutoff: datetime,
    search: str,
    cursor_pair: tuple[Any, Any] | None,
    limit: int,
) -> list[dict[str, Any]]:
    col = get_feed_items_col()
    base_q = feed_items_deal_id_query()
    search_q = (
        _regex_clause(["title", "description_text", "source"], search) if search else {}
    )
    win = {"updated_at": {"$gte": cutoff}}
    ks = (
        _keyset_clause("updated_at", cursor_pair[0], cursor_pair[1])
        if cursor_pair
        else {}
    )
    q = _and(base_q, search_q, win, ks)
    raw = list(col.find(q).sort([("updated_at", -1), ("_id", -1)]).limit(limit))
    for doc in raw:
        doc["id"] = str(doc.pop("_id"))
        doc["feed_type"] = "press_release"
    return raw


def _fetch_sec_batch(
    db: Any,
    cutoff: datetime,
    search: str,
    cursor_pair: tuple[Any, Any] | None,
    limit: int,
) -> list[dict[str, Any]]:
    col = db[SEC_FILING_SUMMARY_COLLECTION]
    search_q = (
        _regex_clause(
            ["company_name", "cik_number", "form_type", "accession_number"], search
        )
        if search
        else {}
    )
    win = {"updated_at": {"$gte": cutoff}}
    ks = (
        _keyset_clause("updated_at", cursor_pair[0], cursor_pair[1])
        if cursor_pair
        else {}
    )
    q = _and(search_q, win, ks)
    raw = list(col.find(q).sort([("updated_at", -1), ("_id", -1)]).limit(limit))
    items: list[dict[str, Any]] = []
    for doc in raw:
        row = enrich_sec_summary_record(db, doc)
        row["feed_type"] = "sec_filing"
        items.append(row)
    return items


def _utc_iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _fetch_foreign_collection_batch(
    db: Any,
    col_name: str,
    label: str,
    country: str,
    deal_q: dict[str, Any],
    cutoff: datetime,
    search: str,
    cursor_pair: tuple[Any, Any] | None,
    limit: int,
) -> list[dict[str, Any]]:
    coll = db[col_name]
    sf = _foreign_sort_field(col_name)
    cutoff_cmp = _utc_iso_z(cutoff)
    win = {sf: {"$gte": cutoff_cmp}}
    ks = _keyset_clause(sf, cursor_pair[0], cursor_pair[1]) if cursor_pair else {}
    q = _and(deal_q, win, ks)
    raw = list(coll.find(q).sort([(sf, -1), ("_id", -1)]).limit(limit))
    rows: list[dict[str, Any]] = []
    for doc in raw:
        d = dict(doc)
        oid = d.pop("_id", None)
        d["id"] = str(oid) if oid is not None else ""
        d["feed_type"] = "foreign_filing"
        d["source"] = col_name
        d["source_label"] = label
        d["country"] = country
        rows.append(d)
    if search:
        sq = search.lower()
        rows = [
            r
            for r in rows
            if sq in _foreign_title(col_name, r).lower()
            or sq in label.lower()
            or sq in country.lower()
        ]
    return rows


# ─── K-way merge (lazy heap + batch refill) ───────────────────────────────────


def _merge_push_heap(
    heap: list[tuple[tuple[float, str], str, dict[str, Any]]],
    stream_key: str,
    doc: dict[str, Any],
) -> None:
    ts = unified_sort_ts(doc)
    doc_id = doc.get("id") or ""
    heapq.heappush(heap, ((-ts, doc_id), stream_key, doc))


def _stream_key_for_doc(doc: dict[str, Any]) -> str:
    ft = doc.get("feed_type")
    if ft == "press_release":
        return "press"
    if ft == "sec_filing":
        return "sec"
    return "f:" + str(doc.get("source", ""))


def _run_k_way_merge(
    page_size: int,
    cursor_in: dict[str, list[Any] | None],
    stream_keys: list[str],
    fetch_for: Callable[[str, tuple[Any, Any] | None, int], list[dict[str, Any]]],
) -> tuple[list[dict[str, Any]], str | None, bool]:
    """K-way merge with per-stream keyset batches; fetch page_size+1 to detect has_next."""
    next_fetch: dict[str, tuple[Any, Any] | None] = {}
    for sk in stream_keys:
        pair_list = cursor_in.get(sk)
        if sk == "press":
            tup = _deserialize_key_part(pair_list, as_datetime=True)
        elif sk == "sec":
            tup = _deserialize_key_part(pair_list, as_datetime=True)
        elif sk.startswith("f:"):
            tup = _deserialize_key_part(pair_list, as_datetime=False)
        else:
            tup = None
        next_fetch[sk] = tup

    deques: dict[str, deque[dict[str, Any]]] = {sk: deque() for sk in stream_keys}

    def refill(sk: str) -> None:
        cur = next_fetch[sk]
        batch = fetch_for(sk, cur, _FETCH_BATCH)
        if not batch:
            deques[sk] = deque()
            return
        last = batch[-1]
        if sk == "press":
            sf = "updated_at"
        elif sk == "sec":
            sf = "updated_at"
        else:
            col = sk[2:]
            sf = _foreign_sort_field(col)
        sf_val, oid = _doc_key_tuple(last, sf)
        next_fetch[sk] = (sf_val, oid)
        deques[sk] = deque(batch)

    for sk in stream_keys:
        refill(sk)

    heap: list[tuple[tuple[float, str], str, dict[str, Any]]] = []
    for sk in stream_keys:
        if deques[sk]:
            _merge_push_heap(heap, sk, deques[sk][0])

    target = page_size + 1
    out: list[dict[str, Any]] = []

    while len(out) < target and heap:
        _, sk, doc = heapq.heappop(heap)
        if not deques[sk] or deques[sk][0]["id"] != doc["id"]:
            continue
        deques[sk].popleft()
        out.append(doc)

        if not deques[sk]:
            refill(sk)

        if deques[sk]:
            _merge_push_heap(heap, sk, deques[sk][0])

    has_next = len(out) > page_size
    out = out[:page_size]

    if not out:
        return [], encode_feed_cursor(cursor_in) if cursor_in else None, False

    last_row: dict[str, dict[str, Any]] = {}
    for d in out:
        last_row[_stream_key_for_doc(d)] = d

    cursor_out: dict[str, list[Any] | None] = {}
    for sk in stream_keys:
        if sk in last_row:
            d = last_row[sk]
            id_val = _id_from_doc(d)
            if sk == "press":
                cursor_out[sk] = _serialize_key_part(
                    "updated_at", d.get("updated_at"), id_val
                )
            elif sk == "sec":
                cursor_out[sk] = _serialize_key_part(
                    "updated_at", d.get("updated_at"), id_val
                )
            else:
                col = sk[2:]
                sf = _foreign_sort_field(col)
                cursor_out[sk] = _serialize_key_part(sf, d.get(sf), id_val)
        else:
            prev = cursor_in.get(sk)
            cursor_out[sk] = list(prev) if isinstance(prev, list) else prev

    next_token = encode_feed_cursor(cursor_out)
    return out, next_token, has_next


def _make_all_fetcher(
    db: Any, deal_q: dict[str, Any], search: str, cutoff: datetime
) -> Callable[[str, tuple[Any, Any] | None, int], list[dict[str, Any]]]:
    meta = {f"f:{c}": (c, lbl, ct) for c, lbl, ct in FOREIGN_COLLECTIONS}

    def fetch_for(
        sk: str, cur: tuple[Any, Any] | None, limit: int
    ) -> list[dict[str, Any]]:
        if sk == "press":
            return _fetch_press_batch(db, cutoff, search, cur, limit)
        if sk == "sec":
            return _fetch_sec_batch(db, cutoff, search, cur, limit)
        if sk in meta:
            c, lbl, ct = meta[sk]
            return _fetch_foreign_collection_batch(
                db, c, lbl, ct, deal_q, cutoff, search, cur, limit
            )
        return []

    return fetch_for


def _make_foreign_only_fetcher(
    db: Any, deal_q: dict[str, Any], search: str, cutoff: datetime
) -> Callable[[str, tuple[Any, Any] | None, int], list[dict[str, Any]]]:
    meta = {f"f:{c}": (c, lbl, ct) for c, lbl, ct in FOREIGN_COLLECTIONS}

    def fetch_for(
        sk: str, cur: tuple[Any, Any] | None, limit: int
    ) -> list[dict[str, Any]]:
        if sk in meta:
            c, lbl, ct = meta[sk]
            return _fetch_foreign_collection_batch(
                db, c, lbl, ct, deal_q, cutoff, search, cur, limit
            )
        return []

    return fetch_for


# ─── Single-stream cursor page (+1 probe) ─────────────────────────────────────


def _single_stream_page(
    fetch_batch: Callable[..., list[dict[str, Any]]],
    sort_field: str,
    cursor_pair_raw: list[Any] | None,
    page_size: int,
    *,
    as_datetime: bool = True,
) -> tuple[list[dict[str, Any]], str | None, bool]:
    cur = _deserialize_key_part(cursor_pair_raw, as_datetime=as_datetime)
    batch = fetch_batch(cur, page_size + 1)
    has_next = len(batch) > page_size
    batch = batch[:page_size]
    if not batch:
        return (
            [],
            encode_feed_cursor({"main": cursor_pair_raw}) if cursor_pair_raw else None,
            False,
        )
    last = batch[-1]
    id_val = _id_from_doc(last)
    sf_val = last.get(sort_field)
    frag = _serialize_key_part(sort_field, sf_val, id_val)
    return batch, encode_feed_cursor({"main": frag}), has_next


# ─── Public API ───────────────────────────────────────────────────────────────


def get_unified_feed(
    tab: str,
    page_size: int,
    search: str = "",
    days: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    """Cursor-based pagination; days defaults to 1 via normalize_days."""

    t = (tab or "all").lower().strip()
    if t not in ("all", "sec", "press", "foreign"):
        t = "all"

    page_size = min(max(1, page_size), 100)
    days_n = normalize_days(days)
    cutoff = _days_cutoff(days_n)
    search = (search or "").strip()

    cursor_in = decode_feed_cursor(cursor)
    db = get_db()
    deal_q = feed_items_deal_id_query()

    # ── press ────────────────────────────────────────────────────────────────
    if t == "press":
        main_cur = cursor_in.get("main")

        def fetch_batch(
            cur: tuple[Any, Any] | None, lim: int
        ) -> list[dict[str, Any]]:
            return _fetch_press_batch(db, cutoff, search, cur, lim)

        items, next_c, has_next = _single_stream_page(
            fetch_batch, "updated_at", main_cur, page_size, as_datetime=True
        )
        return {
            "items": items,
            "page_size": page_size,
            "has_next": has_next,
            "next_cursor": next_c,
            "days": days_n,
        }

    # ── sec ──────────────────────────────────────────────────────────────────
    if t == "sec":
        main_cur = cursor_in.get("main")

        def fetch_batch_sec(
            cur: tuple[Any, Any] | None, lim: int
        ) -> list[dict[str, Any]]:
            return _fetch_sec_batch(db, cutoff, search, cur, lim)

        items, next_c, has_next = _single_stream_page(
            fetch_batch_sec, "updated_at", main_cur, page_size, as_datetime=True
        )
        return {
            "items": items,
            "page_size": page_size,
            "has_next": has_next,
            "next_cursor": next_c,
            "days": days_n,
        }

    # ── foreign ──────────────────────────────────────────────────────────────
    if t == "foreign":
        keys = stream_keys_foreign_only()
        fetch_for = _make_foreign_only_fetcher(db, deal_q, search, cutoff)
        items, next_c, has_next = _run_k_way_merge(page_size, cursor_in, keys, fetch_for)
        return {
            "items": items,
            "page_size": page_size,
            "has_next": has_next,
            "next_cursor": next_c,
            "days": days_n,
        }

    # ── all ──────────────────────────────────────────────────────────────────
    keys = stream_keys_all()
    fetch_for = _make_all_fetcher(db, deal_q, search, cutoff)
    items, next_c, has_next = _run_k_way_merge(page_size, cursor_in, keys, fetch_for)
    return {
        "items": items,
        "page_size": page_size,
        "has_next": has_next,
        "next_cursor": next_c,
        "days": days_n,
    }
