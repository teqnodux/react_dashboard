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
from models import Deal, DealCategory

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
    Pattern: 'Exchange Ratio: 1.0340'
    Returns 0.0 if not found or not a simple fixed ratio.
    """
    if not sr:
        return 0.0
    dc = (sr.get("complex_consideration_and_dividends", {})
            .get("deal_consideration", {}))
    for key in ("deal_consideration_details", "deal_consideration_overview"):
        node = dc.get(key, {})
        text = node.get("answer", "") if isinstance(node, dict) else str(node)
        if not text:
            continue
        m = re.search(r'[Ee]xchange [Rr]atio[:\s]+([0-9]+\.[0-9]+)', text)
        if m:
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
        if "exchange ratio" in details_text or "parent shares" in details_text or "stock consideration" in details_text:
            if "cash consideration" in details_text or "per share in cash" in details_text:
                return "mixed"
            return "stock"
    except Exception:
        pass
    return "cash"


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


def _fetch_current_price(ticker: str) -> float:
    """
    Fetch live current price using quote_fetcher (V2 pattern).
    Returns 0.0 on any failure.
    """
    if not YFINANCE_AVAILABLE or not ticker:
        return 0.0
    try:
        from quote_fetcher import get_live_quote
        q = get_live_quote(ticker)
        if q and q.get("current_price"):
            return float(q["current_price"])
    except Exception:
        pass
    return 0.0


def _fetch_shares_outstanding(ticker: str) -> int:
    """
    Fetch shares outstanding using quote_fetcher (V2 pattern).
    Returns 0 on any failure.
    """
    if not YFINANCE_AVAILABLE or not ticker:
        return 0
    try:
        from quote_fetcher import get_live_quote
        q = get_live_quote(ticker)
        if q and q.get("shares_outstanding"):
            return int(q["shares_outstanding"])
    except Exception:
        pass
    return 0


def _fetch_unaffected_price(ticker: str, announce_date: date) -> float:
    """
    Fetch closing price on or just before announce_date.
    Cached per ticker to avoid repeated yfinance calls across page loads.
    Returns 0.0 on any failure.
    """
    if not YFINANCE_AVAILABLE or not ticker:
        return 0.0
    if ticker in _unaffected_cache:
        return _unaffected_cache[ticker]
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
    Sum of dividends paid in the last 12 months via yfinance.
    Cached per ticker to avoid repeated yfinance calls across page loads.
    Returns 0.0 on any failure.
    """
    if not YFINANCE_AVAILABLE or not ticker:
        return 0.0
    if ticker in _dividend_cache:
        return _dividend_cache[ticker]
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
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
    db = client[MONGODB_DB]

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

        # --- V2 extra fields (from DB when available, else 0.0) ---
        cash_per_share  = float(doc.get("cash_per_share") or 0.0)
        stock_ratio     = float(doc.get("stock_ratio") or 0.0)
        cvr_per_share   = float(doc.get("cvr_per_share") or 0.0)
        special_div     = float(doc.get("special_div") or 0.0)
        spy_at_announce = float(doc.get("spy_at_announce") or 0.0)

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
            spy_at_announce=spy_at_announce,
            status=doc.get("status") or "pending",
            regulatory_bodies=regulatory_bodies,
            next_milestone=doc.get("next_milestone") or "",
            next_milestone_date=_parse_date(doc.get("next_milestone_date")),
        )
        result.append(deal)

    client.close()
    return result


def load_deals_page_from_mongodb(skip: int = 0, limit: int = 20, search: str = "") -> tuple[list, int]:
    """
    Paginated version of load_deals_from_mongodb.
    Returns (deals_for_page, total_count).
    Optional search filters by target name, acquirer name, or ticker (case-insensitive).
    """
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
    db = client[MONGODB_DB]

    query = {}
    if search:
        regex = {"$regex": search, "$options": "i"}
        query = {"$or": [
            {"target_name": regex},
            {"acquire_name": regex},
            {"target_ticker": regex},
            {"acquirer_ticker": regex},
        ]}

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

        cash_per_share  = float(doc.get("cash_per_share") or 0.0)
        stock_ratio     = float(doc.get("stock_ratio") or 0.0)
        cvr_per_share   = float(doc.get("cvr_per_share") or 0.0)
        special_div     = float(doc.get("special_div") or 0.0)
        spy_at_announce = float(doc.get("spy_at_announce") or 0.0)

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
            spy_at_announce=spy_at_announce,
            status=doc.get("status") or "pending",
            regulatory_bodies=regulatory_bodies,
            next_milestone=doc.get("next_milestone") or "",
            next_milestone_date=_parse_date(doc.get("next_milestone_date")),
        )
        result.append(deal)

    client.close()
    return result, total_count


def load_single_deal_from_mongodb(deal_id: str) -> Optional[Deal]:
    """
    Fetch a single deal by its _id string.
    Used by the deal detail endpoint — avoids loading all 153 deals.
    """
    from bson import ObjectId

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
    db = client[MONGODB_DB]

    try:
        oid = ObjectId(deal_id)
    except Exception:
        client.close()
        return None

    doc = db["deals"].find_one({"_id": oid})
    if not doc:
        client.close()
        return None

    # Fetch schema_results for this deal only
    sr_doc = db["deal_schema_results"].find_one({"deal_id": oid}, {"schema_results": 1})
    sr = (sr_doc.get("schema_results") or {}) if sr_doc else {}

    deal = _build_deal(doc, sr)
    client.close()
    return deal


def load_mongo_feed(deal_id: str) -> dict:
    """Load feed items for a deal from MongoDB: DMA, SEC filings, press releases."""
    from bson import ObjectId

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
    db = client[MONGODB_DB]

    try:
        oid = ObjectId(deal_id)
    except Exception:
        client.close()
        return {"items": [], "summary": {"total": 0, "by_type": {}}}

    deal_doc = db["deals"].find_one(
        {"_id": oid},
        {"cik": 1, "sec_url": 1, "announce_date": 1, "target_name": 1},
    )
    if not deal_doc:
        client.close()
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

    # 3. Press Releases — feed_items by deal_id (stored as string)
    pr_docs = list(db["feed_items"].find({"deal_id": deal_id}).sort("created_at", -1))
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

    client.close()

    # Sort all by timestamp descending
    items.sort(key=lambda x: x.get("timestamp", ""), reverse=True)

    by_type: dict = {}
    for item in items:
        by_type[item["type"]] = by_type.get(item["type"], 0) + 1

    return {"items": items, "summary": {"total": len(items), "by_type": by_type}}
