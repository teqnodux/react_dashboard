"""Unified `/api/feed` — merges press (`feed_items`), SEC (`sec_filing_summary`), and foreign filings."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from config import SEC_FILING_SUMMARY_COLLECTION
from db import get_db, get_feed_items_col, feed_items_deal_id_query
from foreign_collections import FOREIGN_COLLECTIONS
from sec_feed_enrichment import enrich_sec_summary_record

_FOREIGN_CAP = 400


# ─── Sort helpers ─────────────────────────────────────────────────────────────

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
    for k in ("date_published", "created_at", "published_at"):
        t = _parse_sort_ts(doc.get(k))
        if t > 0:
            return t
    return _maybe_oid_ts(doc)


def _sec_sort_ts(doc: dict[str, Any]) -> float:
    for k in ("filing_date", "created_at"):
        t = _parse_sort_ts(doc.get(k))
        if t > 0:
            return t
    return _maybe_oid_ts(doc)


def _foreign_sort_ts(doc: dict[str, Any]) -> float:
    for k in (
        "updated_at",
        "modified_at",
        "created_at",
        "date_published",
        "announcement_date",
        "decision_date",
    ):
        t = _parse_sort_ts(doc.get(k))
        if t > 0:
            return t
    return _maybe_oid_ts(doc)


# ─── Query builder helpers ────────────────────────────────────────────────────

def _days_cutoff(days: int | None) -> datetime | None:
    """Return a UTC datetime `days` ago, or None if days is falsy."""
    if not days:
        return None
    return datetime.now(tz=timezone.utc) - timedelta(days=days)


def _regex_clause(fields: list[str], search: str) -> dict[str, Any]:
    """Build a MongoDB $or regex filter across multiple fields."""
    pattern = {"$regex": search, "$options": "i"}
    return {"$or": [{f: pattern} for f in fields]}


def _and(*clauses: dict[str, Any]) -> dict[str, Any]:
    """Combine query dicts; skip empty ones."""
    active = [c for c in clauses if c]
    if not active:
        return {}
    if len(active) == 1:
        return active[0]
    return {"$and": active}


# ─── Foreign filing helpers ───────────────────────────────────────────────────

def _foreign_title(col_name: str, doc: dict[str, Any]) -> str:
    """Extract display title from a foreign filing document."""
    m = {
        "accc_cases":         lambda d: d.get("title", ""),
        "brazil_cases":       lambda d: d.get("interessados_en") or d.get("interessados", ""),
        "canada_cases":       lambda d: d.get("parties", ""),
        "ec_cases":           lambda d: d.get("case_title", ""),
        "fs_cases":           lambda d: d.get("case_title", ""),
        "german_cases":       lambda d: d.get("pursue_en") or d.get("pursue", ""),
        "nz_cases":           lambda d: d.get("title", ""),
        "samr_cases":         lambda d: d.get("title_en") or d.get("title_cn", ""),
        "samr_conditional":   lambda d: d.get("title_en") or d.get("title_cn", ""),
        "samr_unconditional": lambda d: d.get("title_en") or d.get("title_cn", ""),
        "uk_cma_cases":       lambda d: d.get("title", ""),
    }
    fn = m.get(col_name)
    return str(fn(doc)) if fn else ""


def _foreign_rows_from_db(
    db: Any,
    q: dict[str, Any],
    per_collection_cap: int,
    search: str = "",
    cutoff: datetime | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    rows: list[dict[str, Any]] = []
    hit_cap = False

    for col_name, label, country in FOREIGN_COLLECTIONS:
        coll = db[col_name]
        docs = list(coll.find(q).sort("_id", -1).limit(per_collection_cap))
        if len(docs) >= per_collection_cap:
            hit_cap = True
        for doc in docs:
            d = dict(doc)
            oid = d.pop("_id", None)
            d["id"] = str(oid) if oid is not None else ""
            d["feed_type"] = "foreign_filing"
            d["source"] = col_name
            d["source_label"] = label
            d["country"] = country
            rows.append(d)

    rows.sort(key=_foreign_sort_ts, reverse=True)

    # Python-side filters (foreign fields are too varied for generic Mongo query)
    if cutoff:
        cutoff_ts = cutoff.timestamp()
        rows = [r for r in rows if _foreign_sort_ts(r) >= cutoff_ts]

    if search:
        sq = search.lower()
        rows = [
            r for r in rows
            if sq in _foreign_title(r.get("source", ""), r).lower()
            or sq in (r.get("source_label") or "").lower()
            or sq in (r.get("country") or "").lower()
        ]

    return rows, hit_cap


# ─── Press loader ─────────────────────────────────────────────────────────────

def _load_press_slice(
    skip: int,
    limit: int,
    search: str = "",
    cutoff: datetime | None = None,
) -> tuple[list[dict[str, Any]], int]:
    col = get_feed_items_col()

    base_q = feed_items_deal_id_query()
    search_q = _regex_clause(["title", "description_text", "source"], search) if search else {}
    date_q = {"date_published": {"$gte": cutoff.isoformat()}} if cutoff else {}
    q = _and(base_q, search_q, date_q)

    total = col.count_documents(q)
    raw = list(col.find(q).sort("date_published", -1).skip(skip).limit(limit))
    for doc in raw:
        doc["id"] = str(doc.pop("_id"))
        doc["feed_type"] = "press_release"
    return raw, total


# ─── SEC loader ───────────────────────────────────────────────────────────────

def _load_sec_slice(
    skip: int,
    limit: int,
    search: str = "",
    cutoff: datetime | None = None,
) -> tuple[list[dict[str, Any]], int]:
    db = get_db()
    col = db[SEC_FILING_SUMMARY_COLLECTION]

    search_q = (
        _regex_clause(["company_name", "cik_number", "form_type", "accession_number"], search)
        if search
        else {}
    )
    # filing_date is stored as "YYYY-MM-DD" string — ISO string comparison works correctly
    date_q = {"filing_date": {"$gte": cutoff.strftime("%Y-%m-%d")}} if cutoff else {}
    q = _and(search_q, date_q)

    total = col.count_documents(q)
    raw = list(col.find(q).sort("filing_date", -1).skip(skip).limit(limit))
    items: list[dict[str, Any]] = []
    for doc in raw:
        row = enrich_sec_summary_record(db, doc)
        row["feed_type"] = "sec_filing"
        items.append(row)
    return items, total


# ─── Public entry point ───────────────────────────────────────────────────────

def get_unified_feed(
    tab: str,
    page: int,
    page_size: int,
    search: str = "",
    days: int | None = None,
) -> dict[str, Any]:
    t = (tab or "all").lower().strip()
    if t not in ("all", "sec", "press", "foreign"):
        t = "all"

    page = max(1, page)
    page_size = min(max(1, page_size), 100)

    cutoff = _days_cutoff(days)
    search = (search or "").strip()

    # ── press ──────────────────────────────────────────────────────────────────
    if t == "press":
        skip = (page - 1) * page_size
        items, total = _load_press_slice(skip, page_size, search=search, cutoff=cutoff)
        return {
            "items": items,
            "page": page,
            "page_size": page_size,
            "has_next": skip + len(items) < total,
        }

    # ── sec ────────────────────────────────────────────────────────────────────
    if t == "sec":
        skip = (page - 1) * page_size
        items, total = _load_sec_slice(skip, page_size, search=search, cutoff=cutoff)
        return {
            "items": items,
            "page": page,
            "page_size": page_size,
            "has_next": skip + len(items) < total,
        }

    db = get_db()
    q = feed_items_deal_id_query()

    # ── foreign ────────────────────────────────────────────────────────────────
    if t == "foreign":
        rows, hit_cap = _foreign_rows_from_db(
            db, q, _FOREIGN_CAP, search=search, cutoff=cutoff
        )
        total = len(rows)
        start = (page - 1) * page_size
        chunk = rows[start : start + page_size]
        has_next = start + page_size < total or (hit_cap and not search and not cutoff)
        return {
            "items": chunk,
            "page": page,
            "page_size": page_size,
            "has_next": has_next,
        }

    # ── all ────────────────────────────────────────────────────────────────────
    merge_limit = min(2500, page * page_size + page_size * 4)
    press_items, _pt = _load_press_slice(0, merge_limit, search=search, cutoff=cutoff)
    sec_items, _st = _load_sec_slice(0, merge_limit, search=search, cutoff=cutoff)

    per_col = min(_FOREIGN_CAP, max(page_size * 4, merge_limit // 11 + page_size))
    foreign_bucket, hit_foreign_cap = _foreign_rows_from_db(
        db, q, per_col, search=search, cutoff=cutoff
    )

    merged: list[tuple[float, dict[str, Any]]] = []
    for x in press_items:
        merged.append((_press_sort_ts(x), x))
    for x in sec_items:
        merged.append((_sec_sort_ts(x), x))
    for x in foreign_bucket:
        merged.append((_foreign_sort_ts(x), x))

    merged.sort(key=lambda row: row[0], reverse=True)
    flat = [row[1] for row in merged]

    start = (page - 1) * page_size
    slice_out = flat[start : start + page_size]

    press_truncated = len(press_items) >= merge_limit
    sec_truncated = len(sec_items) >= merge_limit

    has_next = (
        start + page_size < len(flat)
        or press_truncated
        or sec_truncated
        or (hit_foreign_cap and not search and not cutoff)
    )

    return {
        "items": slice_out,
        "page": page,
        "page_size": page_size,
        "has_next": has_next,
    }
