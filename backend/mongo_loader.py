"""
MongoDB loader for Deal_DB_New.
Reads from Deal_DB_New collections and maps fields to Deal model objects.
All field mapping from DB names → frontend-expected names happens here in
the API layer. The DB fields are preserved exactly as stored.

NOTE: Read-only. No writes to MongoDB.
"""

import re
from datetime import date, datetime, timedelta
from typing import Optional

from pymongo import MongoClient

from config import MONGODB_URI, MONGODB_DB
from db import get_feed_items_col
from models import Deal, DealCategory

# ── Persistent MongoDB client (one connection pool, reused across all requests) ──
_mongo_client: Optional[MongoClient] = None

def get_db():
    """Return a shared MongoClient database handle.
    pymongo is thread-safe and manages its own connection pool — calling
    MongoClient() per request is the main source of latency on Atlas.
    """
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
    return _mongo_client[MONGODB_DB]

try:
    import yfinance as yf
    YFINANCE_AVAILABLE = True
except ImportError:
    YFINANCE_AVAILABLE = False


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------

_DATE_FORMATS = (
    "%Y-%m-%d",
    "%B %d, %Y",   # March 23, 2026
    "%b %d, %Y",   # Mar 23, 2026
    "%m/%d/%Y",
    "%d/%m/%Y",
    "%Y/%m/%d",
)


def _parse_date(val) -> Optional[date]:
    """Parse a date from various string formats or datetime objects."""
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val
    if not isinstance(val, str):
        return None
    val = val.strip()
    if not val:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(val, fmt).date()
        except ValueError:
            continue
    # Last resort: grab first "Month DD, YYYY" looking token
    m = re.search(r'[A-Za-z]+ \d{1,2},\s*\d{4}', val)
    if m:
        try:
            return datetime.strptime(m.group(0), "%B %d, %Y").date()
        except ValueError:
            pass
    return None


# ---------------------------------------------------------------------------
# Derivation helpers (read schema_results, never touch DB)
# ---------------------------------------------------------------------------

def _get_answer(obj) -> str:
    """Safely extract the 'answer' field from a schema_results node."""
    if isinstance(obj, dict):
        return str(obj.get("answer", "")).strip()
    return str(obj).strip()


def _derive_exchange_ratio(sr: dict) -> float:
    """
    Extract the stock exchange ratio from deal_consideration_details text.
    Handles 'Exchange Ratio: 1.0340' as well as connector phrasings like
    'Exchange Ratio defined as 0.1574' / 'Exchange Ratio of 0.1574'.
    Returns 0.0 if not found or not a simple fixed ratio.
    """
    if not sr:
        return 0.0
    dc = (sr.get("complex_consideration_and_dividends", {})
            .get("deal_consideration", {}))
    # "Exchange Ratio" optionally followed by a colon/equals or a short connector
    # phrase ("defined as", "equal to", "of", "is", ...) before the number.
    pattern = re.compile(
        r'[Ee]xchange [Rr]atio'
        r'(?:\s*[:=]\s*'
        r'|\s+(?:defined as|equal to|set at|fixed at|approximately|of|is)\s+'
        r'|\s+)'
        r'([0-9]+\.[0-9]+)'
    )
    for key in ("deal_consideration_details", "deal_consideration_overview"):
        node = dc.get(key, {})
        text = node.get("answer", "") if isinstance(node, dict) else str(node)
        if not text:
            continue
        for m in pattern.finditer(text):
            ratio = float(m.group(1))
            if 0.01 < ratio < 20:
                return ratio
    return 0.0


def _derive_offer_price(sr: dict) -> float:
    """
    Extract the cash per-share offer price from deal_consideration_overview or
    deal_consideration_details answer text.
    """
    if not sr:
        return 0.0

    dc = (sr.get("complex_consideration_and_dividends", {})
            .get("deal_consideration", {}))

    for key in ("deal_consideration_overview", "deal_consideration_details"):
        node = dc.get(key, {})
        text = node.get("answer", "") if isinstance(node, dict) else str(node)
        if not text or text.strip().lower() in ("not found", ""):
            continue

        m = re.search(r'\$(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*per\s+[Ss]hare', text)
        if m:
            return float(m.group(1).replace(",", ""))

        m = re.search(r'\$(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:in\s+cash|per\s+[Ss]hare)', text)
        if m:
            return float(m.group(1).replace(",", ""))

        m = re.search(r'\$(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)', text)
        if m:
            return float(m.group(1).replace(",", ""))

    return 0.0


def _derive_outside_date(sr: dict) -> Optional[date]:
    """
    Primary path:   timeline > outside_date > outside_date > answer
    Fallback path:  termination > outside_date > primary_date > answer
    """
    if not sr:
        return None
    try:
        val = sr.get("timeline", {}).get("outside_date", {}).get("outside_date", {}).get("answer")
        d = _parse_date(val)
        if d:
            return d
    except Exception:
        pass
    try:
        val = sr.get("termination", {}).get("outside_date", {}).get("primary_date", {}).get("answer")
        d = _parse_date(val)
        if d:
            return d
    except Exception:
        pass
    return None


def _is_truthy(val) -> bool:
    """Return True for boolean True or strings like 'yes'/'true'."""
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() in ("yes", "true")
    return False


def _derive_deal_type(sr: dict) -> str:
    """
    Derives 'cash' | 'stock' | 'mixed' from deal_consideration flags.
    """
    if not sr:
        return "cash"
    try:
        dc = sr.get("complex_consideration_and_dividends", {}).get("deal_consideration", {})
        all_cash_node = dc.get("is_all_cash_deal", {})
        all_cash_ans = all_cash_node.get("answer") if isinstance(all_cash_node, dict) else all_cash_node

        is_all_cash = _is_truthy(all_cash_ans)

        if is_all_cash:
            return "cash"

        details_node = dc.get("deal_consideration_details", {})
        details_text = str(details_node.get("answer", "") if isinstance(details_node, dict) else details_node).lower()

        has_stock = (
            _derive_exchange_ratio(sr) > 0
            or "exchange ratio" in details_text
            or "parent shares" in details_text
            or "stock consideration" in details_text
        )
        # Cash leg can be phrased many ways (e.g. "Per Share Cash Amount: $155",
        # "$155 in cash"). Match the common variants — not just a single phrase —
        # so mixed deals aren't mislabeled as pure stock. "cash in lieu of
        # fractional shares" is rounding, not a cash leg, so exclude it.
        cash_text = details_text.replace("cash in lieu", "")
        has_cash = (
            "cash consideration" in cash_text
            or "per share in cash" in cash_text
            or "per share cash amount" in cash_text
            or "in cash" in cash_text
        )
        if has_stock and has_cash:
            return "mixed"
        if has_stock:
            return "stock"
    except Exception:
        pass
    return "cash"


def _resolve_consideration(deal_id_str: str, sr: dict, deal_type: str) -> tuple:
    """
    Resolve (cash_per_share, stock_ratio, cvr_per_share, special_div,
    floating_ratio) for a deal.

    Fast path: regex derivation (free, no I/O). For stock/mixed deals whose
    exchange ratio the regex can't extract (wording varies wildly across
    agreements), fall back to the cached Claude Haiku normalizer, which reads
    the consideration semantically. The LLM is only invoked on that miss and is
    cached per deal, so it never fires for cash deals or on repeat loads.
    """
    cash = _derive_offer_price(sr)
    ratio = _derive_exchange_ratio(sr)
    cvr = 0.0
    special = 0.0
    floating = False

    # Fall back to the cached LLM normalizer when the regex can't resolve the
    # consideration: a missing ratio on a stock/mixed deal, OR nothing resolved at
    # all (cash == 0 and ratio == 0) — which also covers cash deals whose price the
    # regex can't parse (e.g. "cash of $150.00 per share"). normalize_consideration
    # returns empty WITHOUT calling the LLM when there is no consideration text, so
    # genuinely data-less deals (e.g. no schema_results) cost nothing and stay
    # unresolved rather than being invented.
    _need_ratio = ratio == 0 and deal_type in ("stock", "mixed")
    _unresolved = cash == 0 and ratio == 0
    if _need_ratio or _unresolved:
        try:
            from consideration_normalizer import normalize_consideration
            norm = normalize_consideration(deal_id_str, sr)
            ratio = norm.get("exchange_ratio") or ratio
            # Prefer the semantic normalizer's cash over the greedy $-regex, which
            # can grab an aggregate/trust figure for SPAC or oddly-worded filings.
            if norm.get("cash_per_share"):
                cash = norm["cash_per_share"]
            cvr = norm.get("cvr_per_share") or 0.0
            special = norm.get("special_div") or 0.0
            floating = bool(norm.get("is_floating_ratio"))
        except Exception as e:
            print(f"[mongo_loader] consideration normalize failed for {deal_id_str}: {e}")

    # Plausibility clamp — per-share cash is never absurdly large. The greedy
    # $-regex in _derive_offer_price can pick up an aggregate deal value; drop it.
    if not (0.0 <= cash <= 10_000.0):
        cash = 0.0

    return cash, ratio, cvr, special, floating


def _derive_regulatory_bodies(sr: dict) -> list:
    """
    Derives list of regulatory bodies from best_efforts section.
    """
    bodies = []
    if not sr:
        return bodies
    try:
        be = sr.get("best_efforts", {})

        def _check(outer_key: str, inner_key: str) -> bool:
            outer = be.get(outer_key, {})
            if not isinstance(outer, dict):
                return False
            inner = outer.get(inner_key, {})
            ans = inner.get("answer") if isinstance(inner, dict) else inner
            return _is_truthy(ans)

        if _check("regulatory_fillings_hsr", "hsr_required"):
            bodies.append("HSR")

        for cfius_inner in ("cfius_required", "cfius_filing_required", "cfius"):
            if _check("regulatory_fillings_cfius", cfius_inner):
                bodies.append("CFIUS")
                break

        for foreign_inner in ("foreign_filling_required", "foreign_required", "foreign_filing_required"):
            if _check("regulatory_fillings_foreign", foreign_inner):
                bodies.append("Foreign")
                break
    except Exception:
        pass
    return bodies


# ---------------------------------------------------------------------------
# Market data enrichment — uses V2 yfinance patterns
# ---------------------------------------------------------------------------

# Module-level caches for expensive historical/dividend yfinance calls
# Key: ticker (unaffected_price) or ticker (annual_dividend) → float
_unaffected_cache: dict[str, float] = {}
_dividend_cache: dict[str, float] = {}


def _get_live_quote(ticker: str):
    """Return live quote dict using whichever source is configured."""
    from config import QUOTE_SOURCE
    if QUOTE_SOURCE == "polygon":
        from polygon_fetcher import get_live_quote
    else:
        from quote_fetcher import get_live_quote
    return get_live_quote(ticker)


def _fetch_current_price(ticker: str) -> float:
    """Fetch live current price. Returns 0.0 on any failure."""
    if not ticker:
        return 0.0
    try:
        q = _get_live_quote(ticker)
        if q and q.get("current_price"):
            return float(q["current_price"])
    except Exception:
        pass
    return 0.0


def _fetch_shares_outstanding(ticker: str) -> int:
    """Fetch shares outstanding. Returns 0 on any failure."""
    if not ticker:
        return 0
    try:
        q = _get_live_quote(ticker)
        if q and q.get("shares_outstanding"):
            return int(q["shares_outstanding"])
    except Exception:
        pass
    return 0


def _fetch_unaffected_price(ticker: str, announce_date: date) -> float:
    """
    Fetch closing price on or just before announce_date.
    Uses Polygon or yfinance depending on QUOTE_SOURCE config.
    Cached per ticker to avoid repeated calls across page loads.
    """
    if not ticker:
        return 0.0
    if ticker in _unaffected_cache:
        return _unaffected_cache[ticker]

    from config import QUOTE_SOURCE
    if QUOTE_SOURCE == "polygon":
        try:
            from polygon_fetcher import get_historical_close
            result = get_historical_close(ticker, announce_date - timedelta(days=1)) or 0.0
            _unaffected_cache[ticker] = result
            return result
        except Exception:
            _unaffected_cache[ticker] = 0.0
            return 0.0

    # yfinance path
    if not YFINANCE_AVAILABLE:
        return 0.0
    try:
        start = announce_date - timedelta(days=7)
        end = announce_date + timedelta(days=1)
        stock = yf.Ticker(ticker)
        hist = stock.history(start=start.isoformat(), end=end.isoformat())
        if hist.empty:
            _unaffected_cache[ticker] = 0.0
            return 0.0
        hist.index = hist.index.date
        valid = hist.loc[hist.index <= announce_date]
        result = float(valid.iloc[-1]["Close"]) if not valid.empty else 0.0
        _unaffected_cache[ticker] = result
        return result
    except Exception:
        _unaffected_cache[ticker] = 0.0
    return 0.0


def _fetch_annual_dividend(ticker: str) -> float:
    """
    Sum of dividends paid in the last 12 months.
    Uses Polygon or yfinance depending on QUOTE_SOURCE config.
    Cached per ticker to avoid repeated calls across page loads.
    """
    if not ticker:
        return 0.0
    if ticker in _dividend_cache:
        return _dividend_cache[ticker]

    from config import QUOTE_SOURCE
    if QUOTE_SOURCE == "polygon":
        try:
            from polygon_fetcher import get_annual_dividend
            result = get_annual_dividend(ticker)
            _dividend_cache[ticker] = result
            return result
        except Exception:
            _dividend_cache[ticker] = 0.0
            return 0.0

    # yfinance path
    if not YFINANCE_AVAILABLE:
        return 0.0
    try:
        stock = yf.Ticker(ticker)
        divs = stock.dividends
        if divs is not None and not divs.empty:
            divs.index = divs.index.tz_localize(None)
            cutoff = datetime.now() - timedelta(days=365)
            recent = divs[divs.index >= cutoff]
            result = float(recent.sum())
            _dividend_cache[ticker] = result
            return result
    except Exception:
        pass
    _dividend_cache[ticker] = 0.0
    return 0.0


# ---------------------------------------------------------------------------
# Shared deal builder
# ---------------------------------------------------------------------------

def _build_deal(doc: dict, sr: dict) -> "Deal":
    """Build a Deal object from a deals doc and its schema_results dict."""
    from bson import ObjectId

    oid = doc["_id"]
    deal_id_str = str(oid)

    target = doc.get("target_name") or doc.get("target") or "Unknown"
    acquirer = doc.get("acquire_name") or doc.get("acquirer") or "Unknown"

    announce_date = _parse_date(doc.get("announce_date")) or date.today()
    outside_date = _derive_outside_date(sr)

    if outside_date:
        expected_close = outside_date
    else:
        try:
            expected_close = date(announce_date.year + 1, announce_date.month, announce_date.day)
        except ValueError:
            expected_close = announce_date + timedelta(days=365)

    deal_type = _derive_deal_type(sr)
    regulatory_bodies = _derive_regulatory_bodies(sr)

    target_ticker   = doc.get("target_ticker") or ""
    acquirer_ticker = doc.get("acquirer_ticker") or ""

    borrow_rate_annual = float(doc.get("borrow_rate_annual") or 0.0)

    current_price = float(doc.get("current_price") or 0.0)
    if not current_price:
        current_price = _fetch_current_price(target_ticker)

    unaffected_price = float(doc.get("unaffected_price") or 0.0)
    if not unaffected_price:
        unaffected_price = _fetch_unaffected_price(target_ticker, announce_date)

    dividend_expected = float(doc.get("dividend_expected") or 0.0)
    if not dividend_expected:
        dividend_expected = _fetch_annual_dividend(target_ticker)

    offer_price = float(doc.get("offer_price") or 0.0)
    if not offer_price:
        cash_component = _derive_offer_price(sr)
        exchange_ratio = _derive_exchange_ratio(sr)
        if exchange_ratio and acquirer_ticker:
            acquirer_price = _fetch_current_price(acquirer_ticker)
            if acquirer_price:
                offer_price = round(cash_component + exchange_ratio * acquirer_price, 2)
        if not offer_price:
            offer_price = cash_component

    shares_outstanding = _fetch_shares_outstanding(target_ticker)
    deal_value_bn = float(doc.get("deal_value_bn") or 0.0)
    if not deal_value_bn and offer_price and shares_outstanding:
        deal_value_bn = round(offer_price * shares_outstanding / 1_000_000_000, 2)

    return Deal(
        id=deal_id_str,
        target=target,
        target_ticker=target_ticker,
        acquirer=acquirer,
        acquirer_ticker=acquirer_ticker,
        deal_value_bn=deal_value_bn,
        deal_type=deal_type,
        category=DealCategory.HIGHER_RISK,
        offer_price=offer_price,
        current_price=current_price,
        unaffected_price=unaffected_price,
        borrow_rate_annual=borrow_rate_annual,
        dividend_expected=dividend_expected,
        announce_date=announce_date,
        expected_close=expected_close,
        outside_date=outside_date,
        cash_per_share=float(doc.get("cash_per_share") or 0.0),
        stock_ratio=float(doc.get("stock_ratio") or 0.0),
        cvr_per_share=float(doc.get("cvr_per_share") or 0.0),
        special_div=float(doc.get("special_div") or 0.0),
        spy_at_announce=float(doc.get("spy_at_announce") or 0.0),
        status=doc.get("status") or "pending",
        regulatory_bodies=regulatory_bodies,
        next_milestone=doc.get("next_milestone") or "",
        next_milestone_date=_parse_date(doc.get("next_milestone_date")),
    )


# ---------------------------------------------------------------------------
# Main loader
# ---------------------------------------------------------------------------

def load_deals_from_mongodb() -> list:
    """
    Load deals from Deal_DB_New (read-only).
    Joins:  deals  +  deal_schema_results  (linked by deal_id = deals._id)

    Field mapping (DB → frontend/model):
      target_name   → target
      acquire_name  → acquirer
      _id (ObjectId) → id (str)

    Derived fields (from schema_results, computed here):
      outside_date, deal_type, regulatory_bodies

    V2 extra fields (cash_per_share, stock_ratio, cvr_per_share,
    special_div, spy_at_announce) default to 0.0 — populated from DB
    when available.
    """
    db = get_db()

    # Pre-load schema_results keyed by deal_id string
    schema_map: dict[str, dict] = {}
    for doc in db["deal_schema_results"].find({}, {"deal_id": 1, "schema_results": 1}):
        key = str(doc.get("deal_id", ""))
        if key:
            schema_map[key] = doc.get("schema_results") or {}

    result = []

    for doc in db["deals"].find({}).sort("announce_date", -1):
        oid = doc["_id"]
        deal_id_str = str(oid)
        sr = schema_map.get(deal_id_str, {})

        # --- core identity mapping ---
        target = doc.get("target_name") or doc.get("target") or "Unknown"
        acquirer = doc.get("acquire_name") or doc.get("acquirer") or "Unknown"

        # --- dates ---
        announce_date = _parse_date(doc.get("announce_date")) or date.today()
        outside_date = _derive_outside_date(sr)

        if outside_date:
            expected_close = outside_date
        else:
            try:
                expected_close = date(announce_date.year + 1, announce_date.month, announce_date.day)
            except ValueError:
                expected_close = announce_date + timedelta(days=365)

        # --- derived structural fields ---
        deal_type = _derive_deal_type(sr)
        regulatory_bodies = _derive_regulatory_bodies(sr)

        # --- tickers ---
        target_ticker   = doc.get("target_ticker") or ""
        acquirer_ticker = doc.get("acquirer_ticker") or ""

        # --- pricing: DB values only — no yfinance in bulk loader ---
        borrow_rate_annual = float(doc.get("borrow_rate_annual") or 0.0)
        current_price      = float(doc.get("current_price") or 0.0)
        unaffected_price   = float(doc.get("unaffected_price") or 0.0)
        dividend_expected  = float(doc.get("dividend_expected") or 0.0)

        # --- offer price: DB first, then derive from schema_results (no yfinance) ---
        offer_price = float(doc.get("offer_price") or 0.0)
        if not offer_price:
            offer_price = _derive_offer_price(sr)

        deal_value_bn = float(doc.get("deal_value_bn") or 0.0)

        # --- V2 extra fields (from DB when available, else derived) ---
        # cash_per_share / stock_ratio are not stored in Mongo — regex-derive from
        # schema_results text, with a cached LLM fallback for hard-to-parse ratios,
        # so the Consideration column can show deal terms (e.g. "$96.00 + 0.9693x FOXA").
        _c_cash, _c_ratio, _c_cvr, _c_special, _c_floating = _resolve_consideration(deal_id_str, sr, deal_type)
        cash_per_share  = float(doc.get("cash_per_share") or 0.0) or _c_cash
        stock_ratio     = float(doc.get("stock_ratio") or 0.0) or _c_ratio
        cvr_per_share   = float(doc.get("cvr_per_share") or 0.0) or _c_cvr
        special_div     = float(doc.get("special_div") or 0.0) or _c_special
        floating_ratio  = _c_floating
        spy_at_announce = float(doc.get("spy_at_announce") or 0.0)

        # If the cash-only price wasn't available as offer_price but the resolver
        # recovered it (e.g. the LLM parsed "cash of $150.00 per share"), adopt it
        # so the Consideration column and spread math have the value.
        if not offer_price and cash_per_share and stock_ratio == 0 and not floating_ratio:
            offer_price = cash_per_share

        # Reconcile deal_type with the resolved consideration. The keyword-based
        # _derive_deal_type can misfire — e.g. it reads the boilerplate Merger-Sub
        # "1-for-1 exchange ratio" mechanics as stock consideration on all-cash
        # deals. The resolved cash/ratio are the source of truth for the badge.
        _has_stock = stock_ratio > 0 or floating_ratio
        _has_cash = cash_per_share > 0
        if _has_stock and _has_cash:
            deal_type = "mixed"
        elif _has_stock:
            deal_type = "stock"
        elif _has_cash:
            deal_type = "cash"
        else:
            # No consideration data resolved at all — don't default to "cash".
            deal_type = "unknown"

        deal = Deal(
            id=deal_id_str,
            target=target,
            target_ticker=target_ticker,
            acquirer=acquirer,
            acquirer_ticker=acquirer_ticker,
            deal_value_bn=deal_value_bn,
            deal_type=deal_type,
            category=DealCategory.HIGHER_RISK,  # default; no category classifier yet
            offer_price=offer_price,
            current_price=current_price,
            unaffected_price=unaffected_price,
            borrow_rate_annual=borrow_rate_annual,
            dividend_expected=dividend_expected,
            announce_date=announce_date,
            expected_close=expected_close,
            outside_date=outside_date,
            cash_per_share=cash_per_share,
            stock_ratio=stock_ratio,
            cvr_per_share=cvr_per_share,
            special_div=special_div,
            floating_ratio=floating_ratio,
            spy_at_announce=spy_at_announce,
            status=doc.get("status") or "pending",
            regulatory_bodies=regulatory_bodies,
            next_milestone=doc.get("next_milestone") or "",
            next_milestone_date=_parse_date(doc.get("next_milestone_date")),
        )
        result.append(deal)

    return result


def load_deals_summary_for_admin(status_filter: str = "all") -> list[dict]:
    """
    Lightweight deal list for the super admin deal-access picker.
    Only fetches 7 fields per deal — no schema_results join, no yfinance calls.
    """
    db = get_db()

    projection = {
        "_id": 1,
        "target_name": 1,
        "acquire_name": 1,
        "target_ticker": 1,
        "acquirer_ticker": 1,
        "deal_value_bn": 1,
        "deal_status": 1,
        "announce_date": 1,
    }

    # Base filter: always exclude Closed deals — only Open and Unknown are shown
    _open_filter = {"deal_status": {"$regex": "^open$", "$options": "i"}}
    _unknown_filter = {"$or": [
        {"deal_status": {"$exists": False}},
        {"deal_status": None},
        {"deal_status": ""},
        {"deal_status": {"$regex": "^unknown$", "$options": "i"}},
    ]}

    if status_filter == "open":
        query: dict = _open_filter
    elif status_filter == "unknown":
        query = _unknown_filter
    else:
        # "all" → Open + Unknown (no Closed)
        query = {"$or": [_open_filter, _unknown_filter]}

    docs = list(db["deals"].find(query, projection).sort("announce_date", -1))

    result = []
    for doc in docs:
        announce = doc.get("announce_date")
        if hasattr(announce, "isoformat"):
            announce_str = announce.isoformat()
        elif announce:
            announce_str = str(announce)
        else:
            announce_str = ""

        result.append({
            "id": str(doc["_id"]),
            "target": doc.get("target_name") or "Unknown",
            "acquirer": doc.get("acquire_name") or "Unknown",
            "target_ticker": doc.get("target_ticker") or "",
            "acquirer_ticker": doc.get("acquirer_ticker") or "",
            "deal_value_bn": float(doc.get("deal_value_bn") or 0.0),
            "status": doc.get("deal_status") or "unknown",
            "announce_date": announce_str,
        })

    return result


def load_deals_page_from_mongodb(skip: int = 0, limit: int = 20, search: str = "", allowed_ids: Optional[set] = None) -> tuple[list, int]:
    """
    Paginated version of load_deals_from_mongodb.
    Returns (deals_for_page, total_count).
    Optional search filters by target name, acquirer name, or ticker (case-insensitive).
    Optional allowed_ids restricts results to a specific set of deal ID strings.
    """
    from bson import ObjectId
    db = get_db()

    query = {}
    if allowed_ids is not None:
        oid_list = []
        for id_str in allowed_ids:
            try:
                oid_list.append(ObjectId(id_str))
            except Exception:
                pass
        query["_id"] = {"$in": oid_list}

    if search:
        regex = {"$regex": search, "$options": "i"}
        search_filter = {"$or": [
            {"target_name": regex},
            {"acquire_name": regex},
            {"target_ticker": regex},
            {"acquirer_ticker": regex},
        ]}
        query = {"$and": [query, search_filter]} if query else search_filter

    total_count = db["deals"].count_documents(query)

    page_docs = list(db["deals"].find(query).sort("announce_date", -1).skip(skip).limit(limit))

    # Only fetch schema_results for the deals on this page
    page_ids = [doc["_id"] for doc in page_docs]
    schema_map: dict[str, dict] = {}
    for doc in db["deal_schema_results"].find({"deal_id": {"$in": page_ids}}, {"deal_id": 1, "schema_results": 1}):
        key = str(doc.get("deal_id", ""))
        if key:
            schema_map[key] = doc.get("schema_results") or {}

    result = []

    for doc in page_docs:
        oid = doc["_id"]
        deal_id_str = str(oid)
        sr = schema_map.get(deal_id_str, {})

        target = doc.get("target_name") or doc.get("target") or "Unknown"
        acquirer = doc.get("acquire_name") or doc.get("acquirer") or "Unknown"

        announce_date = _parse_date(doc.get("announce_date")) or date.today()
        outside_date = _derive_outside_date(sr)

        if outside_date:
            expected_close = outside_date
        else:
            try:
                expected_close = date(announce_date.year + 1, announce_date.month, announce_date.day)
            except ValueError:
                expected_close = announce_date + timedelta(days=365)

        deal_type = _derive_deal_type(sr)
        regulatory_bodies = _derive_regulatory_bodies(sr)

        target_ticker   = doc.get("target_ticker") or ""
        acquirer_ticker = doc.get("acquirer_ticker") or ""

        borrow_rate_annual = float(doc.get("borrow_rate_annual") or 0.0)

        current_price = float(doc.get("current_price") or 0.0)
        # Live price is NOT fetched here — the frontend requests /api/quotes/batch
        # after page load to get all 20 quotes in parallel (avoids serial blocking).

        unaffected_price = float(doc.get("unaffected_price") or 0.0)
        # Unaffected price is not fetched live here — stored value used.
        # This avoids a historical Polygon call per deal on every page load.

        dividend_expected = float(doc.get("dividend_expected") or 0.0)
        # Annual dividend is not fetched live here — stored value used.
        # Update via /api/refresh-prices or store directly in MongoDB.

        offer_price = float(doc.get("offer_price") or 0.0)
        if not offer_price:
            cash_component = _derive_offer_price(sr)
            exchange_ratio = _derive_exchange_ratio(sr)
            # Acquirer live price is not fetched here to avoid blocking polygon calls.
            # For stock deals without a stored offer_price, only the cash component
            # is used. The correct offer_price should be stored in MongoDB.
            offer_price = cash_component

        deal_value_bn = float(doc.get("deal_value_bn") or 0.0)
        # shares_outstanding not fetched live — avoids a polygon call per deal.
        # deal_value_bn should be stored in MongoDB; defaults to 0.0 if missing.

        # cash_per_share / stock_ratio are not stored in Mongo — regex-derive from
        # schema_results text, with a cached LLM fallback for hard-to-parse ratios,
        # so the Consideration column can show deal terms (e.g. "$96.00 + 0.9693x FOXA").
        _c_cash, _c_ratio, _c_cvr, _c_special, _c_floating = _resolve_consideration(deal_id_str, sr, deal_type)
        cash_per_share  = float(doc.get("cash_per_share") or 0.0) or _c_cash
        stock_ratio     = float(doc.get("stock_ratio") or 0.0) or _c_ratio
        cvr_per_share   = float(doc.get("cvr_per_share") or 0.0) or _c_cvr
        special_div     = float(doc.get("special_div") or 0.0) or _c_special
        floating_ratio  = _c_floating
        spy_at_announce = float(doc.get("spy_at_announce") or 0.0)

        # If the cash-only price wasn't available as offer_price but the resolver
        # recovered it (e.g. the LLM parsed "cash of $150.00 per share"), adopt it
        # so the Consideration column and spread math have the value.
        if not offer_price and cash_per_share and stock_ratio == 0 and not floating_ratio:
            offer_price = cash_per_share

        # Reconcile deal_type with the resolved consideration. The keyword-based
        # _derive_deal_type can misfire — e.g. it reads the boilerplate Merger-Sub
        # "1-for-1 exchange ratio" mechanics as stock consideration on all-cash
        # deals. The resolved cash/ratio are the source of truth for the badge.
        _has_stock = stock_ratio > 0 or floating_ratio
        _has_cash = cash_per_share > 0
        if _has_stock and _has_cash:
            deal_type = "mixed"
        elif _has_stock:
            deal_type = "stock"
        elif _has_cash:
            deal_type = "cash"
        else:
            # No consideration data resolved at all — don't default to "cash".
            deal_type = "unknown"

        deal = Deal(
            id=deal_id_str,
            target=target,
            target_ticker=target_ticker,
            acquirer=acquirer,
            acquirer_ticker=acquirer_ticker,
            deal_value_bn=deal_value_bn,
            deal_type=deal_type,
            category=DealCategory.HIGHER_RISK,
            offer_price=offer_price,
            current_price=current_price,
            unaffected_price=unaffected_price,
            borrow_rate_annual=borrow_rate_annual,
            dividend_expected=dividend_expected,
            announce_date=announce_date,
            expected_close=expected_close,
            outside_date=outside_date,
            cash_per_share=cash_per_share,
            stock_ratio=stock_ratio,
            cvr_per_share=cvr_per_share,
            special_div=special_div,
            floating_ratio=floating_ratio,
            spy_at_announce=spy_at_announce,
            status=doc.get("status") or "pending",
            regulatory_bodies=regulatory_bodies,
            next_milestone=doc.get("next_milestone") or "",
            next_milestone_date=_parse_date(doc.get("next_milestone_date")),
        )
        result.append(deal)

    return result, total_count


def load_single_deal_from_mongodb(deal_id: str) -> Optional[Deal]:
    """
    Fetch a single deal by its _id string.
    Used by the deal detail endpoint — avoids loading all 153 deals.
    """
    from bson import ObjectId

    db = get_db()

    try:
        oid = ObjectId(deal_id)
    except Exception:
        return None

    doc = db["deals"].find_one({"_id": oid})
    if not doc:
        return None

    # Fetch schema_results for this deal only
    sr_doc = db["deal_schema_results"].find_one({"deal_id": oid}, {"schema_results": 1})
    sr = (sr_doc.get("schema_results") or {}) if sr_doc else {}

    return _build_deal(doc, sr)


def load_mongo_feed(deal_id: str) -> dict:
    """Load feed items for a deal from MongoDB: DMA, SEC filings, press releases."""
    from bson import ObjectId

    db = get_db()

    try:
        oid = ObjectId(deal_id)
    except Exception:
        return {"items": [], "summary": {"total": 0, "by_type": {}}}

    deal_doc = db["deals"].find_one(
        {"_id": oid},
        {"cik": 1, "sec_url": 1, "announce_date": 1, "target_name": 1},
    )
    if not deal_doc:
        return {"items": [], "summary": {"total": 0, "by_type": {}}}

    items = []

    # 1. DMA — sec_url field on the deal
    if deal_doc.get("sec_url"):
        raw_ts = deal_doc.get("announce_date")
        ts = raw_ts.isoformat() if hasattr(raw_ts, "isoformat") else datetime.utcnow().isoformat()
        items.append({
            "id": f"dma_{deal_id}",
            "type": "dma",
            "title": f"Definitive Merger Agreement — {deal_doc.get('target_name', '')}",
            "description": "Definitive merger agreement filed with the SEC.",
            "timestamp": ts,
            "link": deal_doc["sec_url"],
            "source": "SEC",
            "importance": "high",
            "status": "completed",
            "form_type": "",
        })

    # 2. SEC Filings — from sec_filing_summary, deal_id stored as string
    sec_docs = list(
        db["sec_filing_summary"].find({"deal_id": deal_id}).sort("filing_date", -1)
    )
    for doc in sec_docs:
        raw_ts = doc.get("filing_date") or doc.get("created_at")
        ts = raw_ts.isoformat() if hasattr(raw_ts, "isoformat") else datetime.utcnow().isoformat()
        form_type = doc.get("form_type", "")

        items.append({
            "id": str(doc["_id"]),
            "type": "sec_filing",
            "title": f"{form_type} — {doc.get('accession_number', '')}",
            "l1_headline": doc.get("L1_headline") or "",
            "description": "",
            "timestamp": ts,
            "link": doc.get("sec_document_url", ""),
            "source": f"SEC · {form_type}" if form_type else "SEC",
            "importance": "normal",
            "status": "completed",
            "form_type": form_type,
        })

    # 3. Press Releases — feed items collection (deal_id stored as string)
    pr_docs = list(
        get_feed_items_col().find({"deal_id": deal_id}).sort("created_at", -1)
    )
    for doc in pr_docs:
        raw_ts = doc.get("date_published") or doc.get("created_at") or doc.get("published_at")
        ts = raw_ts.isoformat() if hasattr(raw_ts, "isoformat") else datetime.utcnow().isoformat()
        items.append({
            "id": str(doc["_id"]),
            "type": "press_release",
            "title": doc.get("title", "Press Release"),
            "description": doc.get("description_text") or doc.get("content") or doc.get("description", ""),
            "timestamp": ts,
            "link": doc.get("url") or doc.get("link", ""),
            "source": doc.get("source", "Press Release"),
            "importance": "normal",
            "status": "completed",
            "form_type": "",
        })

    # Sort all by timestamp descending
    items.sort(key=lambda x: x.get("timestamp", ""), reverse=True)

    by_type: dict = {}
    for item in items:
        by_type[item["type"]] = by_type.get(item["type"], 0) + 1

    return {"items": items, "summary": {"total": len(items), "by_type": by_type}}


def load_dockets_from_mongodb(deal_id: Optional[str] = None) -> list | dict:
    """
    Read docket data from the docket_dashboard collection.
    deal_id=None  → list of all deal docket dicts (for /api/all-dockets)
    deal_id=str   → single deal docket dict, or {} if not found
    Tickers are joined from the deals collection.
    """
    db = get_db()

    ticker_map: dict[str, dict] = {}
    for doc in db["deals"].find({}, {"_id": 1, "target_ticker": 1, "acquirer_ticker": 1}):
        ticker_map[str(doc["_id"])] = {
            "target_ticker": doc.get("target_ticker") or "",
            "acquirer_ticker": doc.get("acquirer_ticker") or "",
        }

    query = {"deal_id": deal_id} if deal_id else {}
    cursor = db["docket_dashboard"].find(query)

    def _serialize_entry(e: dict) -> dict:
        return {
            "entry_no": e.get("entry_no", 0),
            "received_date": e.get("received_date", ""),
            "title": e.get("title", ""),
            "relevance_level": e.get("relevance_level", "medium"),
            "filer_role": e.get("filer_role", ""),
            "filer_name": e.get("filer_name", ""),
            "position_on_deal": e.get("position_on_deal", ""),
            "entry_summary": e.get("entry_summary", ""),
            "key_arguments": e.get("key_arguments", []),
            "key_excerpts": e.get("key_excerpts", []),
            "cumulative_impact": e.get("cumulative_impact", ""),
            "download_link": e.get("download_link", ""),
            "opposition_type": e.get("opposition_type", ""),
            "intervenor_type": e.get("intervenor_type", ""),
            "relief_requested": e.get("relief_requested", ""),
            "legal_regulatory_significance": e.get("legal_regulatory_significance", ""),
            "proceeding_phase": e.get("proceeding_phase", ""),
            "document_type": e.get("document_type", ""),
            "deadline_date": e.get("deadline_date", ""),
            "deadline_description": e.get("deadline_description", ""),
        }

    def _serialize_stakeholder(s: dict) -> dict:
        return {"name": s.get("name", ""), "role": s.get("role", ""),
                "filing_count": s.get("filing_count", 0), "position": s.get("position", ""),
                "opposition_type": s.get("opposition_type", ""), "status": s.get("status", ""),
                "intervenor_type": s.get("intervenor_type", "")}

    def _serialize_condition(c: dict) -> dict:
        return {"text": c.get("text", ""), "status": c.get("status", ""),
                "source": c.get("source", ""), "category": c.get("category", ""),
                "opposition_type": c.get("opposition_type", ""), "relief_type": c.get("relief_type", ""),
                "asked_in": c.get("asked_in"), "resolved_in": c.get("resolved_in")}

    def _build_deal_dict(doc: dict) -> dict:
        did = doc.get("deal_id", "")
        tickers = ticker_map.get(did, {})
        entries = [_serialize_entry(e) for e in doc.get("docket_entries", [])]
        stakeholders = [_serialize_stakeholder(s) for s in doc.get("docket_stakeholders", [])]
        conditions = [_serialize_condition(c) for c in doc.get("docket_conditions", [])]
        high = sum(1 for e in entries if e["relevance_level"] == "high")
        oppose = sum(1 for e in entries if e["position_on_deal"] == "Oppose")
        support = sum(1 for e in entries if e["position_on_deal"] == "Support")
        dates = [e["received_date"] for e in entries if e.get("received_date")]
        latest = max(dates) if dates else None
        return {
            "deal_id": did,
            # Unique per docket_dashboard record — a deal can have several dockets
            # (different jurisdictions) which all share the same deal_id.
            "docket_id": str(doc.get("_id", "")),
            "deal_name": doc.get("deal_name", ""),
            "target_ticker": tickers.get("target_ticker", ""),
            "acquirer_ticker": tickers.get("acquirer_ticker", ""),
            "metadata": doc.get("docket_metadata", {}),
            "entries": entries, "stakeholders": stakeholders, "conditions": conditions,
            "entry_count": len(entries), "high_relevance_count": high,
            "opposition_count": oppose, "support_count": support, "latest_entry_date": latest,
        }

    if deal_id:
        # Return the first matching docket (kept for /api/all-dockets one-per-deal grouping).
        # Use load_all_dockets_for_deal() to fetch every docket when a deal has multiple.
        doc = next(cursor, None)
        return _build_deal_dict(doc) if doc else {}

    results = [_build_deal_dict(doc) for doc in cursor]
    results.sort(key=lambda d: d.get("latest_entry_date") or "", reverse=True)
    return results


def load_all_dockets_for_deal(deal_id: str) -> list:
    """
    Return every docket_dashboard record for a deal (not just the first).
    Used by the deal detail endpoint so deals with multiple jurisdictions
    (e.g. Montana PSC + South Dakota PUC) show every docket.
    """
    db = get_db()

    deal_doc = db["deals"].find_one(
        {"_id": __import__("bson").ObjectId(deal_id) if len(deal_id) == 24 else deal_id},
        {"target_ticker": 1, "acquirer_ticker": 1},
    ) if deal_id else None
    tickers = {
        "target_ticker":   (deal_doc.get("target_ticker")   if deal_doc else "") or "",
        "acquirer_ticker": (deal_doc.get("acquirer_ticker") if deal_doc else "") or "",
    }

    def _ent(e: dict) -> dict:
        return {
            "entry_no": e.get("entry_no", 0),
            "received_date": e.get("received_date", ""),
            "title": e.get("title", ""),
            "relevance_level": e.get("relevance_level", "medium"),
            "filer_role": e.get("filer_role", ""),
            "filer_name": e.get("filer_name", ""),
            "position_on_deal": e.get("position_on_deal", ""),
            "entry_summary": e.get("entry_summary", ""),
            "key_arguments": e.get("key_arguments", []),
            "key_excerpts": e.get("key_excerpts", []),
            "cumulative_impact": e.get("cumulative_impact", ""),
            "download_link": e.get("download_link", ""),
            "opposition_type": e.get("opposition_type", ""),
            "intervenor_type": e.get("intervenor_type", ""),
            "relief_requested": e.get("relief_requested", ""),
            "legal_regulatory_significance": e.get("legal_regulatory_significance", ""),
            "proceeding_phase": e.get("proceeding_phase", ""),
            "document_type": e.get("document_type", ""),
            "deadline_date": e.get("deadline_date", ""),
            "deadline_description": e.get("deadline_description", ""),
        }

    def _stk(s: dict) -> dict:
        return {"name": s.get("name", ""), "role": s.get("role", ""),
                "filing_count": s.get("filing_count", 0), "position": s.get("position", ""),
                "opposition_type": s.get("opposition_type", ""), "status": s.get("status", ""),
                "intervenor_type": s.get("intervenor_type", "")}

    def _cnd(c: dict) -> dict:
        return {"text": c.get("text", ""), "status": c.get("status", ""),
                "source": c.get("source", ""), "category": c.get("category", ""),
                "opposition_type": c.get("opposition_type", ""), "relief_type": c.get("relief_type", ""),
                "asked_in": c.get("asked_in"), "resolved_in": c.get("resolved_in")}

    results = []
    for doc in db["docket_dashboard"].find({"deal_id": deal_id}):
        entries = [_ent(e) for e in doc.get("docket_entries", [])]
        results.append({
            "docket_id":        str(doc.get("_id", "")),
            "deal_id":          deal_id,
            "target_ticker":    tickers["target_ticker"],
            "acquirer_ticker":  tickers["acquirer_ticker"],
            "metadata":         doc.get("docket_metadata", {}),
            "entries":          entries,
            "stakeholders":     [_stk(s) for s in doc.get("docket_stakeholders", [])],
            "conditions":       [_cnd(c) for c in doc.get("docket_conditions", [])],
            "entry_count":      len(entries),
        })

    # Sort: most-entries first (the "primary" docket tends to have the most filings)
    results.sort(key=lambda d: d["entry_count"], reverse=True)
    return results


def load_dockets_summary_from_mongodb(deal_id: Optional[str] = None) -> list:
    """
    Lightweight version of load_dockets_from_mongodb() — returns ONLY the
    fields needed to render the docket tab strips and sub-tabs.

    Skips the heavy entries / stakeholders / conditions arrays. Counts are
    derived from MongoDB aggregation so we don't pay for full document scans.

    deal_id=None → all dockets across all deals  (used by /api/all-dockets)
    deal_id=str  → only that deal's docket(s)    (used by /api/deals/{id})
    """
    db = get_db()

    # Ticker lookup from deals collection (same as load_dockets_from_mongodb)
    ticker_map: dict[str, dict] = {}
    for d in db["deals"].find({}, {"_id": 1, "target_ticker": 1, "acquirer_ticker": 1}):
        ticker_map[str(d["_id"])] = {
            "target_ticker": d.get("target_ticker") or "",
            "acquirer_ticker": d.get("acquirer_ticker") or "",
        }

    results = []
    # Project only the lightweight fields — explicitly exclude the heavy arrays
    # by NOT requesting them in the projection. We still need docket_entries to
    # derive counts; do it via aggregation to avoid shipping them across.
    pipeline: list = []
    if deal_id:
        pipeline.append({"$match": {"deal_id": deal_id}})
    pipeline.append(
        {"$project": {
            "_id": 1, "deal_id": 1, "deal_name": 1, "docket_metadata": 1,
            "entry_count": {"$size": {"$ifNull": ["$docket_entries", []]}},
            "high_count": {"$size": {"$filter": {
                "input": {"$ifNull": ["$docket_entries", []]},
                "as":    "e",
                "cond":  {"$eq": ["$$e.relevance_level", "high"]},
            }}},
            "oppose_count": {"$size": {"$filter": {
                "input": {"$ifNull": ["$docket_entries", []]},
                "as":    "e",
                "cond":  {"$eq": ["$$e.position_on_deal", "Oppose"]},
            }}},
            "support_count": {"$size": {"$filter": {
                "input": {"$ifNull": ["$docket_entries", []]},
                "as":    "e",
                "cond":  {"$eq": ["$$e.position_on_deal", "Support"]},
            }}},
            "latest_entry_date": {"$max": "$docket_entries.received_date"},
        }}
    )

    import re as _re
    DATE_RE = _re.compile(r"^\d{4}-\d{2}-\d{2}")

    for doc in db["docket_dashboard"].aggregate(pipeline):
        did = doc.get("deal_id", "")
        tickers = ticker_map.get(did, {})
        latest_raw = doc.get("latest_entry_date")
        # MongoDB $max on strings can return non-date values ('null', 'nullZ',
        # 'TBD', etc.) since the field is loosely typed. Filter to a real ISO date.
        latest = latest_raw if isinstance(latest_raw, str) and DATE_RE.match(latest_raw) else None
        results.append({
            "deal_id":             did,
            "docket_id":           str(doc.get("_id", "")),
            "deal_name":           doc.get("deal_name", ""),
            "target_ticker":       tickers.get("target_ticker", ""),
            "acquirer_ticker":     tickers.get("acquirer_ticker", ""),
            "metadata":            doc.get("docket_metadata", {}),
            "entry_count":         doc.get("entry_count", 0),
            "high_relevance_count": doc.get("high_count", 0),
            "opposition_count":    doc.get("oppose_count", 0),
            "support_count":       doc.get("support_count", 0),
            "latest_entry_date":   latest,
        })

    results.sort(key=lambda d: d.get("latest_entry_date") or "", reverse=True)
    return results


def load_docket_detail_by_id(docket_id: str) -> dict:
    """
    Fetch full entries/stakeholders/conditions for a single docket by its
    docket_dashboard._id. Used by /api/all-dockets/{docket_id}.
    """
    from bson import ObjectId
    db = get_db()

    try:
        oid = ObjectId(docket_id) if len(docket_id) == 24 else docket_id
    except Exception:
        return {}

    doc = db["docket_dashboard"].find_one({"_id": oid})
    if not doc:
        return {}

    def _ent(e: dict) -> dict:
        return {
            "entry_no": e.get("entry_no", 0),
            "received_date": e.get("received_date", ""),
            "title": e.get("title", ""),
            "relevance_level": e.get("relevance_level", "medium"),
            "filer_role": e.get("filer_role", ""),
            "filer_name": e.get("filer_name", ""),
            "position_on_deal": e.get("position_on_deal", ""),
            "entry_summary": e.get("entry_summary", ""),
            "key_arguments": e.get("key_arguments", []),
            "key_excerpts": e.get("key_excerpts", []),
            "cumulative_impact": e.get("cumulative_impact", ""),
            "download_link": e.get("download_link", ""),
            "opposition_type": e.get("opposition_type", ""),
            "intervenor_type": e.get("intervenor_type", ""),
            "relief_requested": e.get("relief_requested", ""),
            "legal_regulatory_significance": e.get("legal_regulatory_significance", ""),
            "proceeding_phase": e.get("proceeding_phase", ""),
            "document_type": e.get("document_type", ""),
            "deadline_date": e.get("deadline_date", ""),
            "deadline_description": e.get("deadline_description", ""),
        }

    def _stk(s: dict) -> dict:
        return {"name": s.get("name", ""), "role": s.get("role", ""),
                "filing_count": s.get("filing_count", 0), "position": s.get("position", ""),
                "opposition_type": s.get("opposition_type", ""), "status": s.get("status", ""),
                "intervenor_type": s.get("intervenor_type", "")}

    def _cnd(c: dict) -> dict:
        return {"text": c.get("text", ""), "status": c.get("status", ""),
                "source": c.get("source", ""), "category": c.get("category", ""),
                "opposition_type": c.get("opposition_type", ""), "relief_type": c.get("relief_type", ""),
                "asked_in": c.get("asked_in"), "resolved_in": c.get("resolved_in")}

    return {
        "docket_id":    docket_id,
        "deal_id":      doc.get("deal_id", ""),
        "metadata":     doc.get("docket_metadata", {}),
        "entries":      [_ent(e) for e in doc.get("docket_entries", [])],
        "stakeholders": [_stk(s) for s in doc.get("docket_stakeholders", [])],
        "conditions":   [_cnd(c) for c in doc.get("docket_conditions", [])],
    }


def load_proxy_filings_for_deal(deal_id: str, allowed_form_types: Optional[list[str]] = None) -> list[dict]:
    """
    Load proxy filings (for the Proxy tab) from `sec_filing_summary`.

    Returns the lightweight list used by the UI's left-side feed.

    Priority rules (matches backend parsing endpoint intent):
      - If `proxy.comparison.result` exists and has change URLs -> "changes"
      - Otherwise -> fallback to "summary" and use `proxy.summary_docx_url`
    """
    if allowed_form_types is None:
        allowed_form_types = [
            "S-4",
            "S-4/A",
            "F-4",
            "PREM14A",
            "PREM14C",
            "DEFM14A",
            "DEFM14C",
        ]

    def _dt_to_iso(v: object) -> str:
        if not v:
            return ""
        try:
            import datetime as _dt
            if isinstance(v, _dt.datetime):
                return v.isoformat()
        except Exception:
            pass
        if isinstance(v, dict) and "$date" in v:
            return str(v["$date"])
        return str(v)

    db = get_db()

    try:
        deal_doc = None
        # deals._id is usually an ObjectId; deal_id passed around in the UI is a string id.
        from bson import ObjectId
        try:
            deal_doc = db["deals"].find_one({"_id": ObjectId(deal_id)}, {"target_ticker": 1, "target_name": 1, "target": 1})
        except Exception:
            deal_doc = db["deals"].find_one({"_id": deal_id}, {"target_ticker": 1, "target_name": 1, "target": 1})

        deal_ticker = (deal_doc.get("target_ticker") if deal_doc else "") or ""
        deal_company = ((deal_doc.get("target_name") or deal_doc.get("target")) if deal_doc else "") or ""

        docs = list(
            db["sec_filing_summary"]
            .find({"deal_id": deal_id, "form_type": {"$in": allowed_form_types}})
            .sort("created_at", -1)
        )
    finally:
        pass  # shared client — do not close

    filings: list[dict] = []
    for doc in docs:
        proxy = doc.get("proxy") or {}
        comparison = proxy.get("comparison") or {}
        cache = comparison.get("cache") or {}
        result = comparison.get("result", None)

        # Changes are only possible if we have a change source URL.
        # If result is missing/null/empty, fallback to proxy.summary_docx_url.
        has_change_urls = bool(
            (result or {}).get("change_txt_url") or (result or {}).get("change_docx_url")
        )
        is_changes = has_change_urls
        doc_type = "changes" if is_changes else "summary"

        filing_type = (
            (cache.get("form_type") if is_changes else doc.get("form_type", "")) or
            doc.get("form_type", "")
        )

        if is_changes:
            generated_raw = (
                (result or {}).get("completed_at") or
                (result or {}).get("filing_date") or
                doc.get("updated_at") or
                doc.get("created_at")
            )
        else:
            generated_raw = (
                proxy.get("summary_generated_at") or
                proxy.get("completed_at") or
                doc.get("updated_at") or
                doc.get("created_at")
            )

        generated = _dt_to_iso(generated_raw)

        proxy_id = str(doc.get("_id", ""))
        filename = f"proxy_{proxy_id}.txt"  # stable key for UI selection

        proxy_company = proxy.get("company_name") or deal_company

        filings.append({
            "proxy_id": proxy_id,
            "filename": filename,
            "doc_type": doc_type,
            "filing_type": filing_type,
            "ticker": deal_ticker,
            "company": proxy_company,
            "generated": generated,
            # Filled in by parsed endpoint after download+parse.
            "transition": "",
        })

    return filings
