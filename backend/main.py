"""
FastAPI backend for Merger Arbitrage Dashboard
Wraps existing Python logic and serves data to React frontend
"""

from fastapi import FastAPI, HTTPException, Body, Request
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from datetime import date, timedelta, datetime
from typing import Optional, Dict
import sys
from pathlib import Path
import time

from timeline_processor import get_timeline_path, get_timeline_json_path, find_docx, build_timeline, build_timeline_from_text, TIMELINES_DIR, INPUT_DIR
from covenant_processor import get_covenant_path, find_covenant_inputs, build_covenant_dashboard
from termination_processor import get_termination_path, find_termination_inputs, build_termination_dashboard
from scorecard_processor import get_scorecard_path, find_scorecard_inputs, build_scorecard, check_scorecard_sources
from sec_processor import get_company_slugs, get_filing_index, get_all_filing_indexes, process_filing_url, SEC_FILINGS_DIR
import json

_DATA_DIR = Path(__file__).parent / "data"

# Yahoo Finance for live prices
try:
    import yfinance as yf
    YFINANCE_AVAILABLE = True
except ImportError:
    YFINANCE_AVAILABLE = False

# Add parent directory to path to import from existing code
sys.path.append(str(Path(__file__).parent.parent))

try:
    from data_loader import load_deals_from_json, create_sample_deals
    from models import Deal, DealCategory
    from quote_fetcher import get_deal_quotes
except ImportError:
    print("Warning: Could not import from existing modules. Using fallback.")
    # Fallback will be handled in data_loader.py
    get_deal_quotes = None

try:
    from config import DATA_SOURCE as _DATA_SOURCE
except ImportError:
    _DATA_SOURCE = "static"


# ── Tracking layer helpers ────────────────────────────────────────────────────

def _add_business_days(start: date, days: int) -> date:
    current = start
    added = 0
    while added < days:
        current += timedelta(days=1)
        if current.weekday() < 5:
            added += 1
    return current


def _tracking_path(deal_id: str) -> Path:
    return TIMELINES_DIR / f"{deal_id}_tracking.json"


def _load_tracking(deal_id: str) -> dict:
    p = _tracking_path(deal_id)
    if p.exists():
        return json.loads(p.read_text())
    return {"events": {}}


def _save_tracking(deal_id: str, data: dict) -> None:
    _tracking_path(deal_id).write_text(json.dumps(data, indent=2))


def _resolve_downstream(trigger_date_str: str, downstream: list) -> list:
    """Given an actual trigger date, compute resolved_date for each downstream item."""
    trigger_date = datetime.strptime(trigger_date_str, "%Y-%m-%d").date()
    result = []
    prev_date = trigger_date
    for raw in downstream:
        item = dict(raw)
        calc_days      = item.get("calc_days")
        calc_days_type = item.get("calc_days_type", "calendar")
        calc_from      = item.get("calc_from", "trigger")
        base = trigger_date if calc_from == "trigger" else prev_date
        if calc_days and base:
            if calc_days_type == "business":
                resolved = _add_business_days(base, calc_days)
            else:
                resolved = base + timedelta(days=calc_days)
            item["resolved_date"] = resolved.isoformat()
            prev_date = resolved
        else:
            item["resolved_date"] = None
        result.append(item)
    return result


def _merge_tracking(deal: dict, deal_id: str) -> dict:
    """Overlay tracking data onto a deal dict (mutates a copy, returns it)."""
    import copy
    deal = copy.deepcopy(deal)
    events = _load_tracking(deal_id).get("events", {})

    # Inject filed_date into deadline_events that have a matching trigger_key
    for ev in deal.get("deadline_events", []):
        tk = ev.get("trigger_key")
        if tk and tk in events and events[tk].get("date"):
            ev["filed_date"]   = events[tk]["date"]
            ev["filed_source"] = events[tk].get("source")

    # Inject trigger_date + resolve downstream dates for triggered_chains
    for chain in deal.get("triggered_chains", []):
        tk = chain.get("trigger_key")
        if tk and tk in events and events[tk].get("date"):
            chain["trigger_date"] = events[tk]["date"]
            chain["downstream"]   = _resolve_downstream(events[tk]["date"], chain["downstream"])

    return deal


def _parse_expected_close_range(ec_text, ec_date):
    """Convert expected close shorthand (2H26, Q2 26, mid-2026) to (start, end) date strings."""
    import re
    if not ec_text:
        return (None, None)
    t = ec_text.upper().strip()

    yr_match = re.search(r'20\d{2}', t)
    yr2_match = re.search(r'(\d{2})\s*$', t)  # 2-digit year at end, e.g. "2H26", "Q2 26"
    year = yr_match.group() if yr_match else ("20" + yr2_match.group(1)) if yr2_match else None
    if not year:
        return (ec_date, None) if ec_date else (None, None)

    # Period boundaries for range computation
    _PERIODS = {
        "1H": (f"{year}-01-01", f"{year}-06-30"),
        "2H": (f"{year}-07-01", f"{year}-12-31"),
        "Q1": (f"{year}-01-01", f"{year}-03-31"),
        "Q2": (f"{year}-04-01", f"{year}-06-30"),
        "Q3": (f"{year}-07-01", f"{year}-09-30"),
        "Q4": (f"{year}-10-01", f"{year}-12-31"),
    }

    # Normalize alternate formats before matching:
    #   "3Q26" → "Q3 26", "1H26" → "1H 26", "H2 26" → "2H 26"
    t = re.sub(r'\b(\d)Q\s*(\d{2,4})\b', r'Q\1 \2', t)    # 3Q26 → Q3 26
    t = re.sub(r'\bH([12])\s', r'\g<1>H ', t)              # H2 26 → 2H 26
    t = re.sub(r'\b([12]H)(\d{2,4})\b', r'\1 \2', t)      # 1H26 → 1H 26, 2H26 → 2H 26

    # Re-extract year after normalization
    yr_match2 = re.search(r'20\d{2}', t)
    yr2_match2 = re.search(r'(\d{2})\s*$', t)
    year = yr_match2.group() if yr_match2 else ("20" + yr2_match2.group(1)) if yr2_match2 else year
    # Rebuild periods with potentially updated year
    _PERIODS = {
        "1H": (f"{year}-01-01", f"{year}-06-30"),
        "2H": (f"{year}-07-01", f"{year}-12-31"),
        "Q1": (f"{year}-01-01", f"{year}-03-31"),
        "Q2": (f"{year}-04-01", f"{year}-06-30"),
        "Q3": (f"{year}-07-01", f"{year}-09-30"),
        "Q4": (f"{year}-10-01", f"{year}-12-31"),
    }

    # Handle compound ranges like "1H26 or 2H26", "Q2-Q4 26", "Q1 to Q3"
    # Collect all period tokens found in the text (word-boundary aware)
    found = []
    for key in _PERIODS:
        if re.search(r'(?<![A-Z0-9])' + key + r'(?![A-Z0-9])', t):
            found.append(key)
    if len(found) >= 2:
        # Use the widest range: earliest start to latest end
        starts = [_PERIODS[k][0] for k in found]
        ends = [_PERIODS[k][1] for k in found]
        return (min(starts), max(ends))
    if len(found) == 1:
        return _PERIODS[found[0]]

    if "FIRST HALF" in t:
        return _PERIODS["1H"]
    if "SECOND HALF" in t:
        return _PERIODS["2H"]
    if "MID" in t:
        return (f"{year}-04-01", f"{year}-08-31")

    return (ec_date, None) if ec_date else (None, None)


def _enrich_from_sources(deal: dict, deal_id: str) -> dict:
    """Enrich timeline data with information from all available document sources."""
    deal = _enrich_from_press_release(deal, deal_id)
    deal = _enrich_from_dma_extract(deal, deal_id)

    # Cap estimated close range at latest outside date (including extensions)
    if deal.get("estimated_close_end") and deal.get("outside_date_initial"):
        # Find the latest possible outside date (initial + all extensions)
        ext_dates = []
        for ext in deal.get("outside_date_extensions", []):
            if ext.get("date"):
                ext_dates.append(ext["date"])
        if deal.get("outside_date_extended"):
            ext_dates.append(deal["outside_date_extended"])
        latest_outside = max(ext_dates) if ext_dates else deal["outside_date_initial"]

        if deal["estimated_close_end"] > latest_outside:
            deal["estimated_close_end"] = latest_outside
            # Update the static event too
            for ev in deal.get("static_events", []):
                if ev.get("label") == "Estimated Close (End)":
                    ev["date"] = latest_outside
                    break
        # Also cap start if it somehow exceeds
        if deal.get("estimated_close_start") and deal["estimated_close_start"] > latest_outside:
            deal["estimated_close_start"] = latest_outside

    # Enrich regulatory_approvals with status/dates from the regulatory tracker
    try:
        from generate_regulatory import load_regulatory
        reg = load_regulatory(deal_id)
        if reg and reg.get("approvals"):
            tracker_map = {}
            for a in reg["approvals"]:
                # Map by short authority name (lowered) for matching
                tracker_map[a["authority_short"].lower()] = a
                # Also map by id
                tracker_map[a["id"].lower()] = a

            for ra in deal.get("regulatory_approvals", []):
                name_lower = ra["name"].lower()
                match = tracker_map.get(name_lower)
                if not match:
                    # Try partial matching
                    for key, val in tracker_map.items():
                        if key in name_lower or name_lower in key:
                            match = val
                            break
                if match:
                    ra["status"] = match.get("status", "pending")
                    ra["filed_date"] = match.get("filed_date")
                    ra["cleared_date"] = match.get("cleared_date")
                    ra["jurisdiction"] = match.get("jurisdiction")
                    ra["category"] = match.get("category")
    except Exception:
        pass  # Regulatory tracker not available — no-op

    return deal


def _enrich_from_press_release(deal: dict, deal_id: str) -> dict:
    """Merge press release data into the timeline at serve-time."""
    from press_release_processor import get_press_release_data
    pr_raw = get_press_release_data(deal_id)
    if not pr_raw:
        return deal
    pr = pr_raw.get("extracted", {})

    # 1. Announce date
    if not deal.get("announce_date") and pr.get("announce_date"):
        deal["announce_date"] = pr["announce_date"]
        if pr["announce_date"] != deal.get("signing_date"):
            deal["static_events"].append({
                "label": "Deal Announced (Press Release)",
                "date": pr["announce_date"],
                "ref": None,
                "source": "press_release",
            })

    # 2. Estimated close range
    if not deal.get("estimated_close_start") and pr.get("expected_close"):
        start, end = _parse_expected_close_range(pr["expected_close"], pr.get("expected_close_date"))
        if start:
            deal["estimated_close_start"] = start
            deal["estimated_close_end"] = end
            deal["estimated_close_guidance"] = pr["expected_close"]
            deal["static_events"].append({
                "label": "Estimated Close (Start)",
                "date": start, "ref": None, "source": "press_release",
            })
            if end and end != start:
                deal["static_events"].append({
                    "label": "Estimated Close (End)",
                    "date": end, "ref": None, "source": "press_release",
                })

    # 3. Regulatory bodies — supplement if timeline has empty array
    if not deal.get("regulatory_approvals") and pr.get("regulatory_bodies"):
        approvals = []
        for body in pr["regulatory_bodies"]:
            if "hart-scott" in body.lower() or "hsr" in body.lower():
                continue
            approvals.append({
                "name": body,
                "filing_days": None,
                "filing_days_type": None,
                "required": True,
                "notes": "Identified in press release",
            })
        deal["regulatory_approvals"] = approvals

    # 4. Source metadata
    deal.setdefault("_sources", {})["press_release"] = {
        "filing_date": pr_raw.get("filing_date") or pr.get("announce_date"),
        "extracted_at": pr_raw.get("extracted_at"),
    }

    return deal


def _enrich_from_dma_extract(deal: dict, deal_id: str) -> dict:
    """Merge DMA extract data into the timeline at serve-time."""
    from dma_summary_processor import get_dma_extract
    dma_raw = get_dma_extract(deal_id)
    if not dma_raw:
        return deal
    dma = dma_raw.get("extracted", {})

    # Expected close from DMA extract (if not already filled by PR)
    if not deal.get("estimated_close_start") and dma.get("expected_close"):
        start, end = _parse_expected_close_range(dma["expected_close"], dma.get("expected_close_date"))
        if start:
            deal["estimated_close_start"] = start
            deal["estimated_close_end"] = end
            deal["estimated_close_guidance"] = dma["expected_close"]
            deal["static_events"].append({
                "label": "Estimated Close (Start)",
                "date": start, "ref": None, "source": "dma_extract",
            })
            if end and end != start:
                deal["static_events"].append({
                    "label": "Estimated Close (End)",
                    "date": end, "ref": None, "source": "dma_extract",
                })

    # Source metadata
    deal.setdefault("_sources", {})["dma_extract"] = {
        "filing_date": dma_raw.get("filing_date") or dma.get("announce_date"),
        "extracted_at": dma_raw.get("extracted_at"),
    }

    return deal


app = FastAPI(title="Merger Arb Dashboard API")

# CORS - allow React dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def auto_process_docx():
    """
    On startup, scan data/dma_docs/input/ for DOCX files and process any
    that don't yet have a corresponding timeline JSON in data/timelines/.
    """
    import re
    if not INPUT_DIR.exists():
        return
    for docx_path in sorted(INPUT_DIR.glob("*.docx")):
        match = re.match(r'^(D\d+)', docx_path.stem, re.IGNORECASE)
        if not match:
            print(f"[startup] Skipping {docx_path.name} — no deal ID prefix found")
            continue
        deal_id = match.group(1).upper()
        json_path = TIMELINES_DIR / f"{deal_id}.json"
        if json_path.exists():
            continue  # already processed
        print(f"[startup] Processing DOCX for {deal_id}: {docx_path.name}")
        try:
            build_timeline(deal_id, docx_path)
            print(f"[startup] Done: {deal_id}")
        except Exception as e:
            print(f"[startup] Failed for {deal_id}: {e}")
            continue
        # Seed regulatory JSON from the freshly generated timeline JSON
        try:
            from generate_regulatory import seed_from_timeline_json
            seed_from_timeline_json(deal_id, TIMELINES_DIR / f"{deal_id}.json")
        except Exception as e:
            print(f"[startup] Regulatory seeding failed for {deal_id}: {e}")

    # Also seed regulatory for any existing timeline JSONs that are missing a regulatory file
    try:
        from generate_regulatory import seed_from_timeline_json
        for jp in TIMELINES_DIR.glob("D*.json"):
            if "_tracking" in jp.stem or "_regulatory" in jp.stem or "_covenant" in jp.stem:
                continue
            deal_id = jp.stem.upper()
            seed_from_timeline_json(deal_id, jp)
    except Exception as e:
        print(f"[startup] Regulatory backfill failed: {e}")


# In-memory cache of deals (reload with /api/refresh endpoint)
_deals_cache = None


def _find_deal(deal_id: str) -> Optional[dict]:
    """Find a deal by ID from the cache, returned as a dict."""
    for d in get_deals():
        did = getattr(d, 'deal_id', None) or getattr(d, 'id', None)
        if did == deal_id:
            return deal_to_dict(d)
    return None


def get_deals():
    """Get deals from cache or load fresh.
    Routes to MongoDB or static JSON based on DATA_SOURCE config.
    """
    global _deals_cache
    if _deals_cache is None:
        if _DATA_SOURCE == "mongodb":
            try:
                from mongo_loader import load_deals_from_mongodb
                print("Loading deals from MongoDB (Deal_DB_New)...")
                _deals_cache = load_deals_from_mongodb()
                print(f"Loaded {len(_deals_cache)} deals from MongoDB")
            except Exception as e:
                print(f"Error loading from MongoDB: {e}")
                print("Falling back to static JSON")
                try:
                    _deals_cache = load_deals_from_json()
                except Exception as e2:
                    print(f"Error loading from JSON: {e2}")
                    _deals_cache = create_sample_deals()
        else:
            try:
                _deals_cache = load_deals_from_json()
            except Exception as e:
                print(f"Error loading from JSON: {e}")
                print("Using sample data")
                _deals_cache = create_sample_deals()
    return _deals_cache


def deal_to_dict(deal: Deal) -> dict:
    """Convert Deal object to dict for JSON serialization"""
    return {
        "id": deal.id,
        "target": deal.target,
        "target_ticker": deal.target_ticker,
        "acquirer": deal.acquirer,
        "acquirer_ticker": deal.acquirer_ticker,
        "deal_value_bn": deal.deal_value_bn,
        "deal_type": deal.deal_type,
        "category": deal.category.value if hasattr(deal.category, 'value') else str(deal.category),
        
        # Pricing
        "offer_price": deal.offer_price,
        "current_price": deal.current_price,
        "unaffected_price": deal.unaffected_price,
        
        # Costs
        "borrow_rate_annual": deal.borrow_rate_annual,
        "dividend_expected": deal.dividend_expected,

        # Consideration breakdown
        "cash_per_share": deal.cash_per_share,
        "stock_ratio": deal.stock_ratio,
        "cvr_per_share": deal.cvr_per_share,
        "special_div": deal.special_div,
        "spy_at_announce": deal.spy_at_announce,

        # Dates
        "announce_date": deal.announce_date.isoformat(),
        "expected_close": deal.expected_close.isoformat(),
        "outside_date": deal.outside_date.isoformat() if deal.outside_date else None,
        
        # Status
        "status": deal.status,
        "regulatory_bodies": deal.regulatory_bodies,
        "next_milestone": deal.next_milestone,
        "next_milestone_date": deal.next_milestone_date.isoformat() if deal.next_milestone_date else None,
        
        # Calculated fields
        "gross_spread_dollars": deal.gross_spread_dollars,
        "gross_spread_pct": deal.gross_spread_pct,
        "days_to_close": deal.days_to_close,
        "borrow_cost_to_close": deal.borrow_cost_to_close,
        "net_spread_dollars": deal.net_spread_dollars,
        "net_spread_pct": deal.net_spread_pct,
        "annualized_gross": deal.annualized_gross,
        "annualized_net": deal.annualized_net,
        
        "notes": deal.notes,
    }


@app.get("/")
def root():
    return {
        "message": "Merger Arb Dashboard API",
        "endpoints": {
            "deals": "/api/deals",
            "deal_detail": "/api/deals/{deal_id}",
            "refresh": "/api/refresh"
        }
    }


@app.get("/api/deals")
def get_all_deals():
    """Get all deals with calculated spreads"""
    deals = get_deals()
    
    # Calculate summary stats
    total_value = sum(d.deal_value_bn for d in deals)
    at_risk_count = sum(1 for d in deals if d.status == "at_risk")
    avg_gross = sum(d.gross_spread_pct for d in deals) / len(deals) if deals else 0
    
    return {
        "deals": [deal_to_dict(d) for d in deals],
        "summary": {
            "total_deals": len(deals),
            "total_value_bn": round(total_value, 1),
            "at_risk_count": at_risk_count,
            "avg_gross_spread": round(avg_gross, 1)
        }
    }


@app.get("/api/deals/{deal_id}")
def get_deal_detail(deal_id: str):
    """Get detailed information for a single deal"""
    deals = get_deals()
    deal = next((d for d in deals if d.id == deal_id), None)
    
    if not deal:
        raise HTTPException(status_code=404, detail=f"Deal {deal_id} not found")
    
    # Extended detail with all nested data
    detail = deal_to_dict(deal)
    
    # Add DMA sections (old format for backwards compatibility)
    detail["dma_sections"] = [
        {
            "name": section.name,
            "clauses": [
                {
                    "topic": clause.topic,
                    "concise": clause.concise,
                    "fulsome": clause.fulsome,
                    "clause_text": clause.clause_text,
                    "references": clause.references
                }
                for clause in section.clauses
            ]
        }
        for section in deal.dma_sections
    ]

    # Add separate concise/fulsome sections (new format)
    if hasattr(deal, 'concise_sections') and hasattr(deal, 'fulsome_sections'):
        detail["concise_sections"] = deal.concise_sections
        detail["fulsome_sections"] = deal.fulsome_sections

    # Add timeline events
    detail["timeline_events"] = [
        {
            "event_date": event.event_date.isoformat(),
            "event_type": event.event_type,
            "title": event.title,
            "description": event.description,
            "status": event.status
        }
        for event in deal.timeline_events
    ]
    
    # Add regulatory events
    detail["regulatory_timeline"] = [
        {
            "agency": event.agency,
            "event": event.event,
            "event_date": event.event_date.isoformat() if event.event_date else None,
            "status": event.status,
            "notes": event.notes
        }
        for event in deal.regulatory_timeline
    ]

    # Add docket entries
    detail["docket_entries"] = [
        {
            "entry_no": entry.entry_no,
            "received_date": entry.received_date.isoformat(),
            "title": entry.title,
            "relevance_level": entry.relevance_level,
            "filer_role": entry.filer_role,
            "filer_name": entry.filer_name,
            "position_on_deal": entry.position_on_deal,
            "entry_summary": entry.entry_summary,
            "key_arguments": entry.key_arguments,
            "cumulative_impact": entry.cumulative_impact,
            "download_link": entry.download_link,
            "opposition_type": entry.opposition_type,
            "intervenor_type": entry.intervenor_type,
            "key_excerpts": entry.key_excerpts
        }
        for entry in deal.docket_entries
    ]

    # Add docket stakeholders
    detail["docket_stakeholders"] = [
        {
            "name": sh.name,
            "role": sh.role,
            "filing_count": sh.filing_count,
            "position": sh.position,
            "opposition_type": sh.opposition_type,
            "status": sh.status,
            "intervenor_type": sh.intervenor_type
        }
        for sh in deal.docket_stakeholders
    ]

    # Add docket conditions
    detail["docket_conditions"] = [
        {
            "text": cond.text,
            "status": cond.status,
            "source": cond.source,
            "category": cond.category,
            "opposition_type": cond.opposition_type,
            "relief_type": cond.relief_type,
            "asked_in": cond.asked_in,
            "resolved_in": cond.resolved_in,
        }
        for cond in deal.docket_conditions
    ]

    # Add docket metadata
    detail["docket_metadata"] = deal.docket_metadata

    # Add SEC filings (legacy scraped data)
    detail["sec_filings"] = [
        {
            "filing_type": filing.filing_type,
            "filed_date": filing.filed_date.isoformat(),
            "description": filing.description,
            "sec_url": filing.sec_url,
            "summary": filing.summary,
            "accession_number": filing.accession_number,
            "sections": filing.sections,
            "documents": filing.documents,
        }
        for filing in deal.sec_filings
    ]

    # Add AI-analyzed SEC filings — MongoDB or static based on DATA_SOURCE
    ai_filings = []
    use_static = True

    if _DATA_SOURCE == "mongodb":
        try:
            from config import MONGODB_URI, MONGODB_DB
            from pymongo import MongoClient
            from bson import ObjectId

            _client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
            _db = _client[MONGODB_DB]

            # Fetch CIK fields from deals collection to determine target vs acquirer role
            try:
                _deal_doc = _db["deals"].find_one({"_id": ObjectId(deal_id)}, {"cik": 1, "acquirer_cik": 1})
                target_cik   = str(_deal_doc.get("cik", "")).lstrip("0") if _deal_doc else ""
                acquirer_cik = str(_deal_doc.get("acquirer_cik", "")).lstrip("0") if _deal_doc else ""
            except Exception:
                target_cik = acquirer_cik = ""

            # Fetch all sec_filing_summary records for this deal
            sec_docs = list(_db["sec_filing_summary"].find({"deal_id": deal_id}))
            _client.close()

            seen_urls = set()
            for doc in sec_docs:
                url = doc.get("sec_document_url", "")
                if url in seen_urls:
                    continue
                seen_urls.add(url)

                # Determine role by matching CIK
                doc_cik = str(doc.get("cik_number", "")).lstrip("0")
                if doc_cik and acquirer_cik and doc_cik == acquirer_cik:
                    role   = "acquirer"
                    ticker = deal.acquirer_ticker
                else:
                    role   = "target"
                    ticker = deal.target_ticker

                filing_date = doc.get("filing_date")
                date_str = (
                    filing_date.isoformat()[:10]
                    if hasattr(filing_date, "isoformat")
                    else str(filing_date)[:10]
                )

                ai_filings.append({
                    "url":       url,
                    "date":      date_str,
                    "form_type": doc.get("form_type", ""),
                    "ticker":    ticker,
                    "_role":     role,
                    "_slug":     doc.get("accession_number", str(doc.get("_id", ""))),
                    "_company":  deal.target if role == "target" else deal.acquirer,
                    "summary": {
                        "L1_headline":    doc.get("L1_headline", ""),
                        "L2_brief":       doc.get("L2_brief", ""),
                        "L3_detailed":    doc.get("L3_detailed", {}),
                        "items_reported": doc.get("items_reported", []),
                    },
                })

            use_static = False  # MongoDB succeeded
        except Exception as e:
            print(f"[sec_filings] MongoDB fetch failed: {e} — falling back to local files")
            use_static = True

    if use_static:
        from sec_processor import _find_existing_folder_for_ticker, get_filing_index
        seen_urls = set()
        for ticker, role in [(deal.target_ticker, "target"), (deal.acquirer_ticker, "acquirer")]:
            if not ticker:
                continue
            slug = _find_existing_folder_for_ticker(ticker)
            if not slug:
                continue
            index = get_filing_index(slug)
            if not index:
                continue
            for r in index.get("results", []):
                url = r.get("url", "")
                if url in seen_urls:
                    continue
                seen_urls.add(url)
                r["_slug"] = slug
                r["_company"] = index.get("company", slug)
                r["_role"] = role
                ai_filings.append(r)

    detail["ai_sec_filings"] = ai_filings

    # Add proxy filings
    detail["proxy_filings"] = [
        {
            "filing_type": filing.filing_type,
            "filed_date": filing.filed_date.isoformat(),
            "description": filing.description,
            "sec_url": filing.sec_url,
            "is_amendment": filing.is_amendment,
            "amendment_number": filing.amendment_number,
            "shareholder_dates": filing.shareholder_dates,
            "consideration_details": filing.consideration_details,
            "regulatory_updates": filing.regulatory_updates,
            "closing_guidance": filing.closing_guidance,
            "background_summary": filing.background_summary,
            "other_items": filing.other_items,
            "changes_summary": filing.changes_summary,
        }
        for filing in deal.proxy_filings
    ]

    # Add spread history for charts
    detail["spread_history"] = deal.spread_history

    return detail


@app.post("/api/refresh")
def refresh_data():
    """Reload deals (from MongoDB or static JSON, depending on DATA_SOURCE config)"""
    global _deals_cache
    _deals_cache = None
    deals = get_deals()
    return {"message": f"Refreshed {len(deals)} deals from {_DATA_SOURCE}"}


@app.post("/api/refresh-prices")
def refresh_prices():
    """Fetch current prices from Yahoo Finance and update deals"""
    if not YFINANCE_AVAILABLE:
        raise HTTPException(status_code=501, detail="yfinance library not available. Install with: pip install yfinance")

    deals = get_deals()
    updated_count = 0
    errors = []

    # Collect all tickers to fetch
    tickers_to_fetch = [d.target_ticker for d in deals if d.target_ticker and d.target_ticker != "N/A"]

    # Fetch prices in batch (more efficient and less likely to hit rate limits)
    try:
        tickers_str = " ".join(tickers_to_fetch)
        data = yf.download(tickers_str, period="1d", progress=False, threads=False)

        # Update deals with fetched prices
        for deal in deals:
            if not deal.target_ticker or deal.target_ticker == "N/A":
                continue

            try:
                # Handle both single ticker and multiple tickers DataFrame structure
                if len(tickers_to_fetch) == 1:
                    price = data['Close'].iloc[-1] if not data.empty else None
                else:
                    price = data['Close'][deal.target_ticker].iloc[-1] if deal.target_ticker in data['Close'].columns else None

                if price and price > 0 and not (isinstance(price, float) and price != price):  # Check for NaN
                    deal.current_price = float(price)
                    updated_count += 1
                else:
                    errors.append(f"{deal.target_ticker}: No valid price data")

            except Exception as e:
                errors.append(f"{deal.target_ticker}: {str(e)}")

    except Exception as e:
        return {
            "message": f"Error fetching prices: {str(e)}",
            "updated_count": 0,
            "total_deals": len(deals),
            "errors": [str(e)]
        }

    return {
        "message": f"Updated {updated_count} of {len(deals)} deals",
        "updated_count": updated_count,
        "total_deals": len(deals),
        "errors": errors if errors else None
    }


@app.get("/api/deals/{deal_id}/quotes")
def get_deal_live_quotes(deal_id: str):
    """
    Fetch real-time quotes for a specific deal (target and acquirer)
    Returns bid, ask, volume, and other live market data
    """
    if not YFINANCE_AVAILABLE:
        raise HTTPException(
            status_code=501,
            detail="yfinance library not available. Install with: pip install yfinance"
        )

    if get_deal_quotes is None:
        raise HTTPException(
            status_code=500,
            detail="Quote fetcher not available"
        )

    # Find the deal
    deals = get_deals()
    deal = next((d for d in deals if d.id == deal_id), None)

    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")

    # Fetch quotes (target, acquirer, and SPY for beta adjustment)
    try:
        quotes = get_deal_quotes(
            target_ticker=deal.target_ticker,
            acquirer_ticker=deal.acquirer_ticker
        )
        # Add SPY current price for beta-adjusted break price
        from quote_fetcher import get_live_quote
        spy_quote = get_live_quote("SPY")
        quotes["spy_price"] = spy_quote["current_price"] if spy_quote else None
        return quotes
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching quotes: {str(e)}"
        )


@app.post("/api/spread-snapshot")
def take_spread_snapshot():
    """Backfill missing trading days then append today's spread snapshot for all deals."""
    if not YFINANCE_AVAILABLE:
        raise HTTPException(status_code=501, detail="yfinance not available")

    import pandas as pd

    deals_file = Path(__file__).parent.parent / "data" / "deals.json"
    with open(deals_file) as f:
        data = json.load(f)

    today = date.today()
    today_str = today.isoformat()

    # --- Determine the earliest date we need to backfill from ---
    earliest_gap = today
    for d in data["deals"]:
        hist = d.get("_spread_history", [])
        if hist:
            last_date = date.fromisoformat(hist[-1]["date"])
            # Next calendar day after last snapshot
            gap_start = last_date + timedelta(days=1)
            if gap_start < earliest_gap:
                earliest_gap = gap_start
        else:
            # No history at all — start from announce date
            ann = d.get("announce_date")
            if ann:
                ann_date = date.fromisoformat(ann)
                if ann_date < earliest_gap:
                    earliest_gap = ann_date

    # Collect all tickers
    all_tickers = set()
    for d in data["deals"]:
        t = d.get("target_ticker", "")
        a = d.get("acquirer_ticker", "")
        if t and t != "N/A":
            all_tickers.add(t)
        if a and a not in ("N/A", "Private", ""):
            all_tickers.add(a)

    if not all_tickers:
        return {"message": "No tickers to fetch", "updated": 0, "backfilled": 0}

    # --- Fetch historical data from earliest gap to today ---
    try:
        tickers_str = " ".join(sorted(all_tickers))
        hist_df = yf.download(
            tickers_str,
            start=earliest_gap.isoformat(),
            end=(today + timedelta(days=1)).isoformat(),
            progress=False,
            threads=False,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"yfinance download failed: {e}")

    if hist_df.empty:
        return {"message": "No price data returned from yfinance", "updated": 0, "backfilled": 0}

    single_ticker = len(all_tickers) == 1

    def get_hist_price(ticker, row):
        """Extract close price for a ticker from a DataFrame row."""
        try:
            if single_ticker:
                p = row["Close"]
            else:
                p = row[("Close", ticker)]
            if pd.notna(p) and p > 0:
                return float(p)
        except Exception:
            pass
        return None

    updated = 0
    total_backfilled = 0

    for d in data["deals"]:
        hist = d.setdefault("_spread_history", [])
        existing_dates = {pt["date"] for pt in hist}

        cash = d.get("_cash", 0.0)
        ratio = d.get("_stock", 0.0)
        cvr = d.get("_cvr", 0.0)
        sp_div = d.get("_special_div", 0.0)
        target_tk = d.get("target_ticker", "")
        acquirer_tk = d.get("acquirer_ticker", "")

        if not target_tk or target_tk == "N/A":
            continue

        new_points = []
        for idx, row in hist_df.iterrows():
            day_str = idx.date().isoformat() if hasattr(idx, 'date') else str(idx)[:10]

            if day_str in existing_dates:
                continue

            target_price = get_hist_price(target_tk, row)
            if target_price is None:
                continue

            acq_price = None
            if ratio > 0 and acquirer_tk and acquirer_tk not in ("N/A", "Private", ""):
                acq_price = get_hist_price(acquirer_tk, row)

            if ratio > 0 and acq_price:
                offer_value = cash + (ratio * acq_price) + cvr + sp_div
            else:
                offer_value = d.get("offer_price", 0)

            spread_dollars = offer_value - target_price
            spread_pct = (spread_dollars / target_price * 100) if target_price else 0

            point = {
                "date": day_str,
                "target_price": round(target_price, 2),
                "offer_value": round(offer_value, 2),
                "spread_dollars": round(spread_dollars, 2),
                "spread_pct": round(spread_pct, 2),
            }
            if acq_price:
                point["acquirer_price"] = round(acq_price, 2)

            new_points.append(point)

        if new_points:
            hist.extend(new_points)
            # Sort by date to keep order clean
            hist.sort(key=lambda p: p["date"])
            total_backfilled += len(new_points)
            updated += 1

            # Update current_price / offer_price to latest
            latest = hist[-1]
            d["current_price"] = latest["target_price"]
            if ratio > 0 and latest.get("acquirer_price"):
                d["offer_price"] = latest["offer_value"]

    with open(deals_file, "w") as f:
        json.dump(data, f, indent=2)

    # Invalidate cache
    global _deals_cache
    _deals_cache = None

    return {
        "message": f"Updated {updated} deals, added {total_backfilled} data points (backfilled from {earliest_gap.isoformat()} to {today_str})",
        "updated": updated,
        "backfilled": total_backfilled,
        "date_range": f"{earliest_gap.isoformat()} → {today_str}",
    }


@app.get("/api/deals/{deal_id}/timeline")
def get_deal_timeline(deal_id: str):
    """Serve the pre-generated timeline HTML for a deal."""
    path = get_timeline_path(deal_id)
    if not path:
        raise HTTPException(
            status_code=404,
            detail=f"No timeline found for {deal_id}. POST to /api/deals/{deal_id}/timeline/generate to create one."
        )
    return FileResponse(path, media_type="text/html")


@app.get("/api/deals/{deal_id}/dma-timeline-data")
def get_dma_timeline_data(deal_id: str):
    """Return structured deal data merged with tracking layer and all document sources."""
    path = get_timeline_json_path(deal_id)
    if not path:
        raise HTTPException(status_code=404, detail=f"No DMA timeline data for {deal_id}")
    deal = json.loads(path.read_text())
    deal = _merge_tracking(deal, deal_id)
    deal = _enrich_from_sources(deal, deal_id)
    return deal


@app.patch("/api/deals/{deal_id}/tracking")
def update_tracking(deal_id: str, body: Dict[str, dict] = Body(...)):
    """
    Record actual filing dates for a deal.
    Body: { "proxy_filed": { "date": "2026-03-15", "source": "8-K 2026-03-15" }, ... }
    Called by the SEC scraper or by the frontend for manual entry.
    """
    if not get_timeline_json_path(deal_id):
        raise HTTPException(status_code=404, detail=f"No DMA timeline data for {deal_id}")
    tracking = _load_tracking(deal_id)
    events   = tracking.setdefault("events", {})
    for event_key, event_data in body.items():
        if event_key not in events:
            events[event_key] = {}
        events[event_key].update(event_data)
    _save_tracking(deal_id, tracking)
    return {"status": "ok", "deal_id": deal_id, "updated": list(body.keys())}


@app.get("/api/deals/{deal_id}/tracking")
def get_tracking(deal_id: str):
    """Return current tracking state for a deal."""
    if not get_timeline_json_path(deal_id):
        raise HTTPException(status_code=404, detail=f"No DMA timeline data for {deal_id}")
    return _load_tracking(deal_id)


# ── Regulatory endpoints ──────────────────────────────────────────────────────

from generate_regulatory import (
    load_regulatory, save_regulatory, process_edgar_filing, manual_update as _reg_manual_update,
    seed_from_timeline_json, compute_deadlines as _reg_compute_deadlines,
    check_time_based_transitions as _reg_check_time_transitions,
)


class EdisonFilingRequest(BaseModel):
    url:      str
    doc_date: Optional[str] = None  # YYYY-MM-DD; if omitted, auto-detected from EDGAR


@app.get("/api/deals/{deal_id}/regulatory")
def get_regulatory(deal_id: str):
    """Return the full regulatory approval state for a deal.
    Works for any deal_id — no DMA timeline required.
    Enriches approvals with computed deadline fields."""
    data = load_regulatory(deal_id)
    if data.get("approvals"):
        # Auto-advance statuses based on time (e.g., HSR 30-day expiration)
        if _reg_check_time_transitions(deal_id, data["approvals"]):
            save_regulatory(deal_id, data)
        data["approvals"] = _reg_compute_deadlines(deal_id, data["approvals"])
    return data


@app.post("/api/deals/{deal_id}/regulatory/process-edgar")
def process_edgar(deal_id: str, body: EdisonFilingRequest):
    """
    Fetch an EDGAR filing URL, extract regulatory approvals via Claude,
    merge into {deal_id}_regulatory.json, and return the diff.
    Body: { "url": "https://www.sec.gov/...", "doc_date": "2026-02-25" }
    Works for any deal_id — no DMA timeline required.
    """
    try:
        diff = process_edgar_filing(deal_id, body.url, body.doc_date)
        return {"status": "ok", "deal_id": deal_id, "diff": diff}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/deals/{deal_id}/sync")
def sync_deal_sources(deal_id: str):
    """Re-run propagation for all existing document sources for a deal.
    Catches up any sources processed before propagation code existed."""
    from propagation import sync_all
    result = sync_all(deal_id)
    # Invalidate deals cache so next request picks up new detail sections
    global _deals_cache
    _deals_cache = None
    return {"status": "ok", "deal_id": deal_id, **result}


@app.patch("/api/deals/{deal_id}/regulatory/{approval_id}")
def update_regulatory_approval(deal_id: str, approval_id: str, body: Dict = Body(...)):
    """
    Manually update a specific regulatory approval.
    Allowed fields: status, status_detail, filed_date, cleared_date, expected_filing_period, conditions, notes.
    """
    try:
        result = _reg_manual_update(deal_id, approval_id, body)
        return {"status": "ok", "deal_id": deal_id, "approval_id": approval_id, **result}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Regulatory Monitoring Pipeline endpoints ─────────────────────────────────

from regulatory_monitor import (
    triage_document as _mon_triage,
    run_monitoring_pipeline as _mon_pipeline,
    backfill_master_ids as _mon_backfill,
    resolve_conflict as _mon_resolve_conflict,
    load_monitor_regulatory as _load_mon_reg,
    save_monitor_regulatory as _save_mon_reg,
)
from approval_master import (
    get_all_approvals as _master_all,
    get_approval as _master_get,
)


@app.get("/api/regulatory/master-approvals")
def get_master_approvals():
    """Return all 37 approval type definitions from the master file."""
    approvals = _master_all()
    return {"total": len(approvals), "approvals": approvals}


@app.get("/api/regulatory/master-approvals/{master_id}")
def get_master_approval_detail(master_id: str):
    """Return a single approval type definition."""
    ap = _master_get(master_id)
    if not ap:
        raise HTTPException(status_code=404, detail=f"Master approval '{master_id}' not found")
    return ap


class MonitorRequest(BaseModel):
    doc_url:   Optional[str] = None
    doc_text:  Optional[str] = None
    doc_type:  str
    doc_date:  Optional[str] = None  # YYYY-MM-DD
    file_path: Optional[str] = None  # local file (proxy_analysis, etc.)


def _read_file_as_text(fp: Path) -> str:
    """Read a local file, extracting meaningful text from JSON structures."""
    raw = fp.read_text(encoding="utf-8")
    if fp.suffix != ".json":
        return raw
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw

    # DMA extract / press release: has source_text + extracted fields
    parts = []
    if data.get("source_text"):
        parts.append(data["source_text"])
    if data.get("extracted"):
        ext = data["extracted"]
        # Pull out key regulatory fields as structured context
        for key in ("regulatory_approvals_required", "regulatory_filing_deadlines",
                     "conditions_to_closing", "specific_termination_triggers",
                     "outside_date", "outside_date_extension"):
            val = ext.get(key)
            if val:
                label = key.replace("_", " ").title()
                if isinstance(val, list):
                    parts.append(f"{label}:\n" + "\n".join(f"- {v}" for v in val))
                else:
                    parts.append(f"{label}: {val}")
    # DMA sections (details JSON): concise_sections / fulsome_sections with clauses
    for sec_key in ("concise_sections", "fulsome_sections", "sections"):
        if isinstance(data, dict) and sec_key in data:
            for sec in data[sec_key]:
                if isinstance(sec, dict):
                    name = sec.get("name", "") or sec.get("title", "")
                    clauses = sec.get("clauses", [])
                    if clauses:
                        clause_texts = [c.get("text", "") for c in clauses if isinstance(c, dict) and c.get("text")]
                        if clause_texts:
                            parts.append(f"## {name}\n" + "\n".join(f"- {t}" for t in clause_texts))
                    else:
                        text = sec.get("text", "") or sec.get("content", "")
                        if name or text:
                            parts.append(f"## {name}\n{text}" if name else text)
    if parts:
        return "\n\n".join(parts)
    # Fallback: return raw JSON
    return raw


@app.post("/api/deals/{deal_id}/regulatory/triage")
def triage_for_regulatory(deal_id: str, body: MonitorRequest):
    """
    Quick relevance check for a document.
    Body: { "doc_type": "8-K", "doc_text": "preview text..." }
    """
    text = body.doc_text or ""
    if body.doc_url and not text:
        # Fetch text from EDGAR URL
        try:
            from generate_regulatory import fetch_edgar_text
            text, detected_type = fetch_edgar_text(body.doc_url)
            if not body.doc_type or body.doc_type == "filing":
                body.doc_type = detected_type
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not fetch URL: {e}")

    # Get deal context
    deal_context = _get_deal_context(deal_id)

    result = _mon_triage(
        text_preview=text[:3000],
        doc_type=body.doc_type,
        deal_name=deal_context.get("deal_name", ""),
        target=deal_context.get("target", ""),
        acquirer=deal_context.get("acquirer", ""),
    )
    return {"status": "ok", "deal_id": deal_id, **result}


@app.post("/api/deals/{deal_id}/regulatory/monitor")
def monitor_document(deal_id: str, body: MonitorRequest):
    """
    Full monitoring pipeline: triage → scope → per-approval monitor → merge.
    Body: { "doc_url": "https://sec.gov/...", "doc_type": "8-K", "doc_date": "2026-03-01" }
    Or:   { "doc_text": "full document text...", "doc_type": "press_release", "doc_date": "2026-03-01" }
    """
    text = body.doc_text or ""
    doc_type = body.doc_type

    # Read from local file if file_path provided
    if body.file_path and not text:
        fp = Path(body.file_path)
        if fp.exists() and fp.is_file():
            text = _read_file_as_text(fp)
        else:
            raise HTTPException(status_code=400, detail=f"File not found: {body.file_path}")

    if body.doc_url and not text:
        try:
            from generate_regulatory import fetch_edgar_text
            text, detected_type = fetch_edgar_text(body.doc_url)
            if not doc_type or doc_type == "filing":
                doc_type = detected_type
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not fetch URL: {e}")

    if not text:
        raise HTTPException(status_code=400, detail="No document text provided. Supply doc_url, file_path, or doc_text.")

    doc_date = body.doc_date or date.today().isoformat()
    deal_context = _get_deal_context(deal_id)

    try:
        result = _mon_pipeline(
            deal_id=deal_id,
            text=text,
            doc_type=doc_type,
            doc_date=doc_date,
            doc_url=body.doc_url,
            deal_context=deal_context,
        )
        return {"status": "ok", "deal_id": deal_id, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/deals/{deal_id}/regulatory/conflicts")
def get_regulatory_conflicts(deal_id: str):
    """Return all unresolved conflicts across all approvals for a deal."""
    data = load_regulatory(deal_id)
    conflicts = []
    for approval in data.get("approvals", []):
        for c in approval.get("conflicts", []):
            if not c.get("resolved"):
                conflicts.append({
                    "approval_id": approval["id"],
                    "approval_name": approval.get("authority_short", approval["id"]),
                    **c,
                })
    return {"deal_id": deal_id, "unresolved_count": len(conflicts), "conflicts": conflicts}


@app.patch("/api/deals/{deal_id}/regulatory/{approval_id}/conflicts/{conflict_id}")
def resolve_regulatory_conflict(
    deal_id: str, approval_id: str, conflict_id: str, body: Dict = Body(...)
):
    """
    Resolve a conflict on a specific approval.
    Body: { "resolution": "accepted" | "dismissed" | "older_document" }
    """
    resolution = body.get("resolution")
    if resolution not in ("accepted", "dismissed", "older_document"):
        raise HTTPException(status_code=400, detail="resolution must be 'accepted', 'dismissed', or 'older_document'")
    try:
        result = _mon_resolve_conflict(deal_id, approval_id, conflict_id, resolution)
        return {"status": "ok", **result}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/deals/{deal_id}/regulatory/available-documents")
def get_available_documents(deal_id: str):
    """
    Return documents available for this deal that can be processed through
    the monitoring pipeline. Merges SEC filing index, proxy filings, etc.
    Marks documents that have already been processed.
    """
    data = load_regulatory(deal_id)
    processed_urls = {
        dp.get("doc_url") for dp in data.get("documents_processed", []) if dp.get("doc_url")
    }
    processed_types_dates = {
        (dp.get("doc_type"), dp.get("doc_date"))
        for dp in data.get("documents_processed", [])
    }

    available = []

    # SEC AI-analyzed filings
    try:
        from sec_processor import _find_existing_folder_for_ticker, get_filing_index
        # Find deal tickers
        deals = get_deals()
        deal = next((d for d in deals if d.id == deal_id), None)
        if deal:
            for ticker in [deal.target_ticker, deal.acquirer_ticker]:
                if not ticker:
                    continue
                slug = _find_existing_folder_for_ticker(ticker)
                if not slug:
                    continue
                index = get_filing_index(slug)
                for r in index.get("results", []):
                    url = r.get("url", "")
                    doc_type = r.get("form_type", "filing")
                    doc_date = r.get("date", "")
                    already = url in processed_urls or (doc_type, doc_date) in processed_types_dates
                    available.append({
                        "url": url,
                        "doc_type": doc_type,
                        "doc_date": doc_date,
                        "ticker": ticker,
                        "description": r.get("description", ""),
                        "already_processed": already,
                        "source": "sec_ai",
                    })
    except Exception:
        pass

    # Proxy analysis files
    proxy_dir = _DATA_DIR / "proxy_analysis" / deal_id
    if proxy_dir.exists():
        for f in proxy_dir.iterdir():
            if f.suffix == ".txt":
                doc_type = f.stem  # e.g., "PREM14A", "DEFM14A"
                already = (doc_type, None) in processed_types_dates
                available.append({
                    "url": None,
                    "doc_type": doc_type,
                    "doc_date": None,
                    "ticker": None,
                    "description": f"Proxy analysis: {f.name}",
                    "already_processed": already,
                    "source": "proxy_analysis",
                    "file_path": str(f),
                })

    return {
        "deal_id": deal_id,
        "total": len(available),
        "unprocessed": len([d for d in available if not d["already_processed"]]),
        "documents": available,
    }


@app.post("/api/deals/{deal_id}/regulatory/backfill")
def backfill_regulatory_master_ids(deal_id: str):
    """Backfill master_ids and status_history for existing approvals."""
    try:
        result = _mon_backfill(deal_id)
        return {"status": "ok", "deal_id": deal_id, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Regulatory Monitor (new pipeline, separate storage) ──────────────────────

def _load_deal_summary(deal_id: str) -> Optional[dict]:
    """Load deal-level summary from DMA extract + press release."""
    dma_path = _DATA_DIR / "dma_extract" / f"{deal_id}.json"
    if not dma_path.exists():
        return None
    try:
        dma = json.loads(dma_path.read_text(encoding="utf-8"))
        ext = dma.get("extracted", {})
        if not ext:
            return None
        summary: dict = {
            "target":                       ext.get("target"),
            "acquirer":                     ext.get("acquirer"),
            "deal_type":                    ext.get("deal_type"),
            "offer_price_cash":             ext.get("offer_price_cash"),
            "stock_exchange_ratio":         ext.get("stock_exchange_ratio"),
            "total_consideration":          ext.get("total_consideration"),
            "cvr_value":                    ext.get("cvr_value"),
            "expected_close":               ext.get("expected_close"),
            "announce_date":                ext.get("announce_date"),
            "outside_date":                 ext.get("outside_date"),
            "outside_date_extension":       ext.get("outside_date_extension"),
            "outside_date_extension_condition": ext.get("outside_date_extension_condition"),
            "target_break_fee_mm":          ext.get("target_break_fee_mm"),
            "acquirer_reverse_break_fee_mm": ext.get("acquirer_reverse_break_fee_mm"),
            "voting_threshold":             ext.get("voting_threshold"),
            "financing_condition":          ext.get("financing_condition"),
            "go_shop_days":                 ext.get("go_shop_days"),
            "go_shop_end_date":             ext.get("go_shop_end_date"),
            "regulatory_approvals_required": ext.get("regulatory_approvals_required"),
            "regulatory_filing_deadlines":  ext.get("regulatory_filing_deadlines"),
        }
        # Strip None values for cleaner response
        return {k: v for k, v in summary.items() if v is not None}
    except Exception:
        return None


@app.get("/api/deals/{deal_id}/regulatory-monitor")
def get_regulatory_monitor(deal_id: str):
    """Return regulatory monitor state from the master-file pipeline storage."""
    data = _load_mon_reg(deal_id)
    if data.get("approvals"):
        if _reg_check_time_transitions(deal_id, data["approvals"]):
            _save_mon_reg(deal_id, data)
        data["approvals"] = _reg_compute_deadlines(deal_id, data["approvals"])
    data["deal_summary"] = _load_deal_summary(deal_id)
    return data


@app.post("/api/deals/{deal_id}/regulatory-monitor/monitor")
def monitor_document_new(deal_id: str, body: MonitorRequest):
    """Full monitoring pipeline writing to monitor-only storage."""
    text = body.doc_text or ""
    doc_type = body.doc_type

    if body.file_path and not text:
        fp = Path(body.file_path)
        if fp.exists() and fp.is_file():
            text = _read_file_as_text(fp)
        else:
            raise HTTPException(status_code=400, detail=f"File not found: {body.file_path}")

    if body.doc_url and not text:
        try:
            from generate_regulatory import fetch_edgar_text
            text, detected_type = fetch_edgar_text(body.doc_url)
            if not doc_type or doc_type == "filing":
                doc_type = detected_type
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not fetch URL: {e}")

    if not text:
        raise HTTPException(status_code=400, detail="No document text provided.")

    doc_date = body.doc_date or date.today().isoformat()
    deal_context = _get_deal_context(deal_id)

    try:
        result = _mon_pipeline(
            deal_id=deal_id,
            text=text,
            doc_type=doc_type,
            doc_date=doc_date,
            doc_url=body.doc_url,
            deal_context=deal_context,
            storage="monitor",
        )
        return {"status": "ok", "deal_id": deal_id, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/deals/{deal_id}/regulatory-monitor/available-documents")
def get_monitor_available_documents(deal_id: str):
    """Available documents checked against the monitor pipeline's processed list."""
    data = _load_mon_reg(deal_id)
    processed_urls = {
        dp.get("doc_url") for dp in data.get("documents_processed", []) if dp.get("doc_url")
    }
    processed_types_dates = {
        (dp.get("doc_type"), dp.get("doc_date"))
        for dp in data.get("documents_processed", [])
    }

    available = []

    # SEC AI-analyzed filings
    try:
        from sec_processor import _find_existing_folder_for_ticker, get_filing_index
        deals = get_deals()
        deal = next((d for d in deals if d.id == deal_id), None)
        if deal:
            for ticker in [deal.target_ticker, deal.acquirer_ticker]:
                if not ticker:
                    continue
                slug = _find_existing_folder_for_ticker(ticker)
                if not slug:
                    continue
                index = get_filing_index(slug)
                for r in (index or {}).get("results", []):
                    url = r.get("url", "")
                    dt = r.get("form_type", "filing")
                    dd = r.get("date", "")
                    already = url in processed_urls or (dt, dd) in processed_types_dates
                    available.append({
                        "url": url,
                        "doc_type": dt,
                        "doc_date": dd,
                        "ticker": ticker,
                        "description": r.get("description", ""),
                        "already_processed": already,
                        "source": "sec_ai",
                    })
    except Exception:
        pass

    # Proxy analysis files
    proxy_dir = _DATA_DIR / "proxy_analysis" / deal_id
    if proxy_dir.exists():
        for f in proxy_dir.iterdir():
            if f.suffix == ".txt":
                dt = f.stem
                already = (dt, None) in processed_types_dates
                available.append({
                    "url": None,
                    "doc_type": dt,
                    "doc_date": None,
                    "ticker": None,
                    "description": f"Proxy analysis: {f.name}",
                    "already_processed": already,
                    "source": "proxy_analysis",
                    "file_path": str(f),
                })

    # DMA Extract
    dma_path = _DATA_DIR / "dma_extract" / f"{deal_id}.json"
    if dma_path.exists():
        try:
            dma_data = json.loads(dma_path.read_text())
            dma_date = dma_data.get("filing_date")
            already = ("DMA_EXTRACT", dma_date) in processed_types_dates
            available.append({
                "url": None,
                "doc_type": "DMA_EXTRACT",
                "doc_date": dma_date,
                "ticker": None,
                "description": "Definitive Merger Agreement — extracted data",
                "already_processed": already,
                "source": "dma_extract",
                "file_path": str(dma_path),
            })
        except Exception:
            pass

    # Press Release Extract
    pr_path = _DATA_DIR / "press_release" / f"{deal_id}.json"
    if pr_path.exists():
        try:
            pr_data = json.loads(pr_path.read_text())
            pr_date = pr_data.get("filing_date") or (pr_data.get("extracted", {}) or {}).get("announce_date")
            already = ("PRESS_RELEASE", pr_date) in processed_types_dates
            available.append({
                "url": None,
                "doc_type": "PRESS_RELEASE",
                "doc_date": pr_date,
                "ticker": None,
                "description": "Press release — announcement extraction",
                "already_processed": already,
                "source": "press_release",
                "file_path": str(pr_path),
            })
        except Exception:
            pass

    # 10-K / 10-Q analysis summaries
    tenk_dir = _DATA_DIR / "tenk_analysis" / deal_id
    if tenk_dir.exists():
        for f in tenk_dir.iterdir():
            if f.suffix == ".txt":
                dt = f.stem  # e.g., "PEN_10K_summary_20260225"
                already = (dt, None) in processed_types_dates
                # Try to extract form type from filename
                form_type = "10-K" if "10K" in f.name.upper() or "10-K" in f.name.upper() else \
                            "10-Q" if "10Q" in f.name.upper() or "10-Q" in f.name.upper() else "filing"
                available.append({
                    "url": None,
                    "doc_type": form_type,
                    "doc_date": None,
                    "ticker": None,
                    "description": f"Financial filing summary: {f.name}",
                    "already_processed": already,
                    "source": "tenk_analysis",
                    "file_path": str(f),
                })

    # DMA detailed sections (concise/fulsome)
    details_path = _DATA_DIR / "details" / f"{deal_id}.json"
    if details_path.exists():
        already = ("DMA_SECTIONS", None) in processed_types_dates
        available.append({
            "url": None,
            "doc_type": "DMA_SECTIONS",
            "doc_date": None,
            "ticker": None,
            "description": "Merger agreement — detailed section breakdown",
            "already_processed": already,
            "source": "dma_sections",
            "file_path": str(details_path),
        })

    # Sort chronologically — documents without dates go last
    def _sort_key(doc):
        d = doc.get("doc_date") or ""
        return (0 if d else 1, d)
    available.sort(key=_sort_key)

    # Add processing order hint
    for i, doc in enumerate(available):
        doc["suggested_order"] = i + 1

    return {
        "deal_id": deal_id,
        "total": len(available),
        "unprocessed": len([d for d in available if not d["already_processed"]]),
        "documents": available,
    }


@app.get("/api/deals/{deal_id}/regulatory-monitor/conflicts")
def get_monitor_conflicts(deal_id: str):
    """Unresolved conflicts from the monitor pipeline storage."""
    data = _load_mon_reg(deal_id)
    conflicts = []
    for approval in data.get("approvals", []):
        for c in approval.get("conflicts", []):
            if not c.get("resolved"):
                conflicts.append({
                    "approval_id": approval["id"],
                    "approval_name": approval.get("authority_short", approval["id"]),
                    **c,
                })
    return {"deal_id": deal_id, "unresolved_count": len(conflicts), "conflicts": conflicts}


@app.patch("/api/deals/{deal_id}/regulatory-monitor/{approval_id}/conflicts/{conflict_id}")
def resolve_monitor_conflict(
    deal_id: str, approval_id: str, conflict_id: str, body: Dict = Body(...)
):
    """Resolve a conflict in the monitor pipeline storage."""
    resolution = body.get("resolution")
    if resolution not in ("accepted", "dismissed", "older_document"):
        raise HTTPException(status_code=400, detail="resolution must be 'accepted', 'dismissed', or 'older_document'")
    try:
        result = _mon_resolve_conflict(deal_id, approval_id, conflict_id, resolution, storage="monitor")
        return {"status": "ok", **result}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


def _get_deal_context(deal_id: str) -> dict:
    """Build deal context for the monitoring pipeline from available data."""
    context = {"deal_id": deal_id}
    try:
        deals = get_deals()
        deal = next((d for d in deals if d.id == deal_id), None)
        if deal:
            context["target"] = deal.target
            context["acquirer"] = deal.acquirer
            context["target_ticker"] = deal.target_ticker
            context["acquirer_ticker"] = deal.acquirer_ticker
            context["deal_name"] = f"{deal.acquirer} / {deal.target}"
            context["deal_type"] = deal.deal_type
    except Exception:
        pass
    return context


@app.get("/api/deals/{deal_id}/timeline-stock")
def get_timeline_stock(deal_id: str):
    """Return historical stock data for the deal's tickers, scoped to the deal timeline range."""
    path = get_timeline_json_path(deal_id)
    if not path:
        raise HTTPException(status_code=404, detail=f"No timeline data for {deal_id}")
    deal_data = json.loads(path.read_text())
    tickers = [t for t in [deal_data.get("target_ticker"), deal_data.get("acquirer_ticker")] if t]
    if not tickers:
        return {"available": False, "tickers": [], "series": {}}
    start = deal_data.get("nda_date") or deal_data.get("signing_date")
    end   = deal_data.get("outside_date_extended") or deal_data.get("outside_date_initial")
    try:
        import sys
        _dma_dir = str(Path(__file__).parent.parent.parent / "DMA Timeline")
        if _dma_dir not in sys.path:
            sys.path.insert(0, _dma_dir)
        from generate_timeline import fetch_stock_data
        return fetch_stock_data(tickers, start, end)
    except Exception as e:
        return {"available": False, "tickers": tickers, "series": {}, "error": str(e)}


@app.post("/api/deals/{deal_id}/timeline/generate")
def generate_deal_timeline(deal_id: str):
    """
    Generate (or regenerate) the timeline for a deal.
    Tries in order: (1) DOCX file, (2) existing DMA extract source text.
    """
    from propagation import propagate

    # Path 1: DOCX file
    docx_path = find_docx(deal_id)
    if docx_path:
        try:
            build_timeline(deal_id, docx_path)
            prop = propagate(deal_id, "timeline")
            return {
                "message": f"Timeline generated for {deal_id}",
                "source": "docx",
                "docx": str(docx_path.name),
                "url": f"/api/deals/{deal_id}/timeline",
                "propagation": prop,
            }
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))

    # Path 2: Fall back to DMA extract source text
    from dma_summary_processor import get_dma_extract
    dma_raw = get_dma_extract(deal_id)
    source_text = dma_raw.get("source_text", "") if dma_raw else ""
    if source_text and len(source_text) > 200:
        try:
            result = build_timeline_from_text(deal_id, source_text)
            prop = propagate(deal_id, "timeline")
            return {
                "message": f"Timeline generated for {deal_id} from DMA extract text",
                "source": "dma_extract",
                "url": f"/api/deals/{deal_id}/timeline",
                "propagation": prop,
            }
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))

    raise HTTPException(
        status_code=404,
        detail=f"No DOCX or DMA extract text found for {deal_id}. "
               f"Paste the DMA summary via the Document Input box on the Financial Overview tab."
    )


class TimelineTextRequest(BaseModel):
    text: str


@app.post("/api/deals/{deal_id}/timeline/generate-from-text")
def generate_deal_timeline_from_text(deal_id: str, body: TimelineTextRequest):
    """
    Generate (or regenerate) the timeline JSON for a deal from pasted text.
    No DOCX file required — accepts raw merger agreement summary text.
    """
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="Text body is empty.")
    try:
        from propagation import propagate
        json_path = build_timeline_from_text(deal_id, body.text)
        prop = propagate(deal_id, "timeline")
        return {
            "message": f"Timeline generated for {deal_id} from text",
            "url":     f"/api/deals/{deal_id}/dma-timeline-data",
            "propagation": prop,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/all-dockets")
def get_all_dockets():
    """Get all docket entries across all deals"""
    deals = get_deals()

    all_entries = []
    summary = {
        "total_entries": 0,
        "total_deals_with_dockets": 0,
        "high_relevance": 0,
        "opposition_count": 0,
        "support_count": 0,
        "entries_by_deal": []
    }

    for deal in deals:
        if not deal.docket_entries:
            continue

        summary["total_deals_with_dockets"] += 1
        deal_entries = []

        for entry in deal.docket_entries:
            entry_dict = {
                "entry_no": entry.entry_no,
                "received_date": entry.received_date.isoformat(),
                "title": entry.title,
                "relevance_level": entry.relevance_level,
                "filer_role": entry.filer_role,
                "filer_name": entry.filer_name,
                "position_on_deal": entry.position_on_deal,
                "entry_summary": entry.entry_summary,
                "key_arguments": entry.key_arguments,
                "cumulative_impact": entry.cumulative_impact,
                "deal_id": deal.id,
                "deal_name": f"{deal.target} / {deal.acquirer}"
            }
            all_entries.append(entry_dict)
            deal_entries.append(entry_dict)

            # Update summary stats
            summary["total_entries"] += 1
            if entry.relevance_level == "high":
                summary["high_relevance"] += 1
            if entry.position_on_deal == "Oppose":
                summary["opposition_count"] += 1
            elif entry.position_on_deal == "Support":
                summary["support_count"] += 1

        summary["entries_by_deal"].append({
            "deal_id": deal.id,
            "deal_name": f"{deal.target} / {deal.acquirer}",
            "entry_count": len(deal_entries)
        })

    # Sort entries by date (most recent first)
    all_entries.sort(key=lambda x: x["received_date"], reverse=True)

    return {
        "entries": all_entries,
        "summary": summary
    }


@app.get("/api/all-regulatory")
def get_all_regulatory():
    """Get all regulatory events across all deals"""
    deals = get_deals()

    all_events = []
    summary = {
        "total_events": 0,
        "total_deals": 0,
        "pending_approvals": 0,
        "completed_approvals": 0,
        "events_by_agency": {},
        "events_by_deal": []
    }

    for deal in deals:
        if not deal.regulatory_timeline:
            continue

        summary["total_deals"] += 1
        deal_events = []
        deal_pending = 0

        for event in deal.regulatory_timeline:
            event_dict = {
                "agency": event.agency,
                "event": event.event,
                "event_date": event.event_date.isoformat() if event.event_date else None,
                "status": event.status,
                "notes": event.notes,
                "deal_id": deal.id,
                "deal_name": f"{deal.target} / {deal.acquirer}"
            }
            all_events.append(event_dict)
            deal_events.append(event_dict)

            # Update summary stats
            summary["total_events"] += 1
            if event.status == "pending":
                summary["pending_approvals"] += 1
                deal_pending += 1
            elif event.status == "completed":
                summary["completed_approvals"] += 1

            # Count by agency
            if event.agency not in summary["events_by_agency"]:
                summary["events_by_agency"][event.agency] = 0
            summary["events_by_agency"][event.agency] += 1

        summary["events_by_deal"].append({
            "deal_id": deal.id,
            "deal_name": f"{deal.target} / {deal.acquirer}",
            "event_count": len(deal_events),
            "pending_count": deal_pending
        })

    # Convert agency dict to list for frontend
    summary["events_by_agency"] = [
        {"agency": agency, "count": count}
        for agency, count in sorted(summary["events_by_agency"].items(), key=lambda x: -x[1])
    ]

    return {
        "events": all_events,
        "summary": summary
    }


@app.get("/api/all-activity")
def get_all_activity():
    """Get unified activity feed across all deals"""
    deals = get_deals()

    all_activities = []
    activity_id_counter = 0

    # Summary stats
    summary = {
        "total_activities": 0,
        "last_7_days": 0,
        "by_type": {},
        "most_active_deals": [],
        "upcoming_events": 0
    }

    from datetime import timedelta
    seven_days_ago = date.today() - timedelta(days=7)
    seven_days_future = date.today() + timedelta(days=7)

    for deal in deals:
        deal_name = f"{deal.target} / {deal.acquirer}"

        # Timeline events as milestones
        for event in deal.timeline_events:
            activity_id_counter += 1
            event_date = date.fromisoformat(event.event_date) if isinstance(event.event_date, str) else event.event_date

            # Determine importance based on event type and status
            if event.status == "pending":
                importance = "high" if event.event_type == "milestone" else "medium"
            else:
                importance = "low"

            activity = {
                "id": f"timeline-{activity_id_counter}",
                "timestamp": event.event_date if isinstance(event.event_date, str) else event.event_date.isoformat(),
                "type": "milestone",
                "deal_id": deal.id,
                "deal_name": deal_name,
                "title": event.title,
                "description": event.description,
                "importance": importance,
                "status": event.status
            }
            all_activities.append(activity)

            # Update summary
            summary["total_activities"] += 1
            if event_date >= seven_days_ago:
                summary["last_7_days"] += 1
            if event.status == "pending" and event_date <= seven_days_future:
                summary["upcoming_events"] += 1
            summary["by_type"]["milestone"] = summary["by_type"].get("milestone", 0) + 1

        # Regulatory events
        for event in deal.regulatory_timeline:
            activity_id_counter += 1
            event_date = event.event_date if event.event_date else date.today()

            # Determine importance
            if event.status == "pending":
                importance = "high"
            elif event.status == "completed":
                importance = "medium"
            else:
                importance = "low"

            activity = {
                "id": f"regulatory-{activity_id_counter}",
                "timestamp": event_date.isoformat() if isinstance(event_date, date) else event_date,
                "type": "regulatory",
                "deal_id": deal.id,
                "deal_name": deal_name,
                "title": f"{event.agency}: {event.event}",
                "description": event.notes,
                "importance": importance,
                "source": event.agency,
                "status": event.status
            }
            all_activities.append(activity)

            # Update summary
            summary["total_activities"] += 1
            if event_date and isinstance(event_date, date) and event_date >= seven_days_ago:
                summary["last_7_days"] += 1
            if event.status == "pending":
                summary["upcoming_events"] += 1
            summary["by_type"]["regulatory"] = summary["by_type"].get("regulatory", 0) + 1

        # Docket entries
        for entry in deal.docket_entries:
            activity_id_counter += 1
            entry_date = entry.received_date

            # Map relevance to importance
            importance_map = {
                "high": "high",
                "medium": "medium",
                "low": "low"
            }
            importance = importance_map.get(entry.relevance_level, "medium")

            activity = {
                "id": f"docket-{activity_id_counter}",
                "timestamp": entry_date.isoformat(),
                "type": "docket",
                "deal_id": deal.id,
                "deal_name": deal_name,
                "title": entry.title,
                "description": entry.entry_summary,
                "importance": importance,
                "source": entry.filer_name
            }
            all_activities.append(activity)

            # Update summary
            summary["total_activities"] += 1
            if entry_date >= seven_days_ago:
                summary["last_7_days"] += 1
            summary["by_type"]["docket"] = summary["by_type"].get("docket", 0) + 1

        # Add deal announcement as a milestone if not already in timeline
        announce_date = deal.announce_date
        if announce_date:
            activity_id_counter += 1
            activity = {
                "id": f"announcement-{activity_id_counter}",
                "timestamp": announce_date.isoformat(),
                "type": "milestone",
                "deal_id": deal.id,
                "deal_name": deal_name,
                "title": "Deal Announced",
                "description": f"{deal.acquirer} announces acquisition of {deal.target} for ${deal.deal_value_bn}B",
                "importance": "high",
                "status": "completed"
            }
            # Only add if not already in timeline
            if not any(a.get("title") == "Deal Announced" and a.get("deal_id") == deal.id for a in all_activities):
                all_activities.append(activity)
                summary["total_activities"] += 1
                if announce_date >= seven_days_ago:
                    summary["last_7_days"] += 1

    # Sort by timestamp (most recent first)
    all_activities.sort(key=lambda x: x["timestamp"], reverse=True)

    # Calculate most active deals
    deal_activity_counts = {}
    for activity in all_activities:
        deal_id = activity["deal_id"]
        deal_name = activity["deal_name"]
        if deal_id not in deal_activity_counts:
            deal_activity_counts[deal_id] = {"deal_id": deal_id, "deal_name": deal_name, "activity_count": 0}
        deal_activity_counts[deal_id]["activity_count"] += 1

    summary["most_active_deals"] = sorted(
        deal_activity_counts.values(),
        key=lambda x: x["activity_count"],
        reverse=True
    )[:5]

    return {
        "activities": all_activities,
        "summary": summary
    }


@app.get("/api/deals/{deal_id}/feed")
def get_deal_feed(deal_id: str):
    """Unified chronological feed for a single deal — all document sources."""
    deals = get_deals()
    deal = next((d for d in deals if d.id == deal_id), None)
    if not deal:
        raise HTTPException(status_code=404, detail=f"Deal {deal_id} not found")

    items = []
    counter = 0

    def add(type_: str, timestamp: str, title: str, description: str = "",
            importance: str = "medium", source: str = "", status: str = "",
            link: str = ""):
        nonlocal counter
        counter += 1
        if not timestamp:
            return
        items.append({
            "id": f"{type_}-{counter}",
            "timestamp": timestamp,
            "type": type_,
            "title": title,
            "description": description or "",
            "importance": importance,
            "source": source,
            "status": status,
            "link": link,
        })

    # 1. SEC filings (legacy scraped)
    for filing in deal.sec_filings:
        add("sec_filing", filing.filed_date.isoformat(),
            f"{filing.filing_type} — {filing.description}",
            filing.summary or "", "medium", source="SEC EDGAR",
            status="completed", link=filing.sec_url or "")

    # 2. AI-analyzed SEC filings
    try:
        from sec_processor import _find_existing_folder_for_ticker, get_filing_index
        seen_urls = set()
        for ticker, role in [(deal.target_ticker, "target"), (deal.acquirer_ticker, "acquirer")]:
            if not ticker:
                continue
            slug = _find_existing_folder_for_ticker(ticker)
            if not slug:
                continue
            index = get_filing_index(slug)
            if not index:
                continue
            for r in index.get("results", []):
                url = r.get("url", "")
                if url in seen_urls:
                    continue
                seen_urls.add(url)
                # Handle varying field names in index
                filed = r.get("filed") or r.get("date") or ""
                form = r.get("type") or r.get("form_type") or "Filing"
                desc = r.get("description", "")
                summary_obj = r.get("summary", {})
                if isinstance(summary_obj, dict):
                    ai_sum = summary_obj.get("L2_brief") or summary_obj.get("L1_headline", "")
                    if not filed and summary_obj.get("filing_date"):
                        filed = summary_obj["filing_date"]
                else:
                    ai_sum = r.get("ai_summary", "")
                # Normalize date: "02/11/26" → "2026-02-11"
                if filed and "/" in filed and len(filed) <= 10:
                    try:
                        parts = filed.split("/")
                        if len(parts) == 3:
                            m, d, y = parts
                            yr = int(y)
                            if yr < 100:
                                yr += 2000
                            filed = f"{yr:04d}-{int(m):02d}-{int(d):02d}"
                    except Exception:
                        pass
                if not desc and isinstance(summary_obj, dict):
                    desc = summary_obj.get("L1_headline", "")
                add("sec_filing", filed,
                    f"{form} — {desc}" if desc else form,
                    ai_sum, "medium",
                    source=f"SEC EDGAR ({role})", status="completed", link=url)
    except Exception:
        pass

    # 3. Docket entries
    for entry in deal.docket_entries:
        imp_map = {"high": "high", "medium": "medium", "low": "low"}
        add("docket", entry.received_date.isoformat(), entry.title,
            entry.entry_summary or "", imp_map.get(entry.relevance_level, "medium"),
            source=entry.filer_name or "", status="completed")

    # 4. Regulatory status changes
    reg_path = TIMELINES_DIR / f"{deal_id}_regulatory.json"
    if reg_path.exists():
        try:
            reg = json.loads(reg_path.read_text())
            for appr in reg.get("approvals", []):
                filed = appr.get("filing_date", "")
                cleared = appr.get("cleared_date", "")
                st = appr.get("status", "pending")
                agency = appr.get("authority_short") or appr.get("authority") or appr.get("agency", "")
                juris = appr.get("jurisdiction", "")
                label = f"{agency} — {juris}" if agency and juris else agency or juris
                if cleared:
                    add("regulatory", cleared, f"{label} — Cleared",
                        "", "high", source="Regulatory Tracker", status="completed")
                elif filed:
                    add("regulatory", filed, f"{label} — Filed",
                        "", "medium", source="Regulatory Tracker", status=st)
        except Exception:
            pass

    # 5. Press release
    pr_path = Path("data") / "press_release" / f"{deal_id}.json"
    if pr_path.exists():
        try:
            pr = json.loads(pr_path.read_text()).get("extracted", {})
            ann = pr.get("announce_date", "")
            if ann:
                add("press_release", ann, "Press Release — Deal Announcement",
                    pr.get("raw_summary", ""), "high", source="Press Release",
                    status="completed")
        except Exception:
            pass

    # Deduplicate by title + timestamp
    seen = set()
    unique = []
    for item in items:
        key = (item["timestamp"][:10], item["title"][:60])
        if key not in seen:
            seen.add(key)
            unique.append(item)

    # Sort reverse chronological
    unique.sort(key=lambda x: x["timestamp"], reverse=True)

    # Summary
    by_type = {}
    for item in unique:
        by_type[item["type"]] = by_type.get(item["type"], 0) + 1

    return {
        "items": unique,
        "summary": {"total": len(unique), "by_type": by_type}
    }


@app.get("/api/all-sec-filings")
def get_all_sec_filings():
    """Get all SEC filings across all deals, sorted chronologically"""
    deals = get_deals()

    all_filings = []
    summary = {
        "total_filings": 0,
        "total_deals": 0,
        "by_type": {},
        "last_30_days": 0,
        "filings_by_deal": []
    }

    from datetime import timedelta
    thirty_days_ago = date.today() - timedelta(days=30)

    for deal in deals:
        if not deal.sec_filings:
            continue

        summary["total_deals"] += 1
        deal_filings = []

        for filing in deal.sec_filings:
            filing_dict = {
                "filing_type": filing.filing_type,
                "filed_date": filing.filed_date.isoformat(),
                "description": filing.description,
                "sec_url": filing.sec_url,
                "summary": filing.summary,
                "accession_number": filing.accession_number,
                "sections": filing.sections,
                "documents": filing.documents,
                "deal_id": deal.id,
                "deal_name": f"{deal.target} / {deal.acquirer}",
                "target": deal.target,
                "acquirer": deal.acquirer
            }
            all_filings.append(filing_dict)
            deal_filings.append(filing_dict)

            # Update summary stats
            summary["total_filings"] += 1
            if filing.filed_date >= thirty_days_ago:
                summary["last_30_days"] += 1

            # Count by type
            if filing.filing_type not in summary["by_type"]:
                summary["by_type"][filing.filing_type] = 0
            summary["by_type"][filing.filing_type] += 1

        summary["filings_by_deal"].append({
            "deal_id": deal.id,
            "deal_name": f"{deal.target} / {deal.acquirer}",
            "filing_count": len(deal_filings)
        })

    # Sort filings by date (most recent first)
    all_filings.sort(key=lambda x: x["filed_date"], reverse=True)

    # Convert by_type dict to sorted list
    summary["by_type"] = [
        {"type": filing_type, "count": count}
        for filing_type, count in sorted(summary["by_type"].items(), key=lambda x: -x[1])
    ]

    return {
        "filings": all_filings,
        "summary": summary
    }


@app.get("/api/reddit-analysis")
def get_reddit_analysis():
    """Get Reddit antitrust analysis data (standalone page)"""
    import json

    reddit_data_path = Path(__file__).parent / "data" / "reddit" / "sample_reddit_analysis.json"

    if not reddit_data_path.exists():
        return {
            "merger": "No data available",
            "total_items": 0,
            "filtered_items": 0,
            "relevant_items": 0,
            "tier1_high_value": 0,
            "tier2_medium_value": 0,
            "tier3_supporting": 0,
            "results": {
                "tier1_high_value": [],
                "tier2_medium_value": [],
                "tier3_supporting": []
            }
        }

    with open(reddit_data_path) as f:
        data = json.load(f)

    return data


@app.get("/api/deals/{deal_id}/reddit")
def get_deal_reddit_analysis(deal_id: str):
    """Get Reddit antitrust analysis for a specific deal"""
    import json

    reddit_data_path = Path(__file__).parent / "data" / "reddit" / f"{deal_id}_reddit.json"

    if not reddit_data_path.exists():
        raise HTTPException(status_code=404, detail=f"No Reddit analysis found for deal {deal_id}")

    with open(reddit_data_path) as f:
        data = json.load(f)

    return data


@app.get("/api/deals/{deal_id}/covenants")
def get_deal_covenants(deal_id: str):
    """Serve the pre-generated covenant dashboard HTML for a deal."""
    import re
    path = get_covenant_path(deal_id)
    if not path:
        raise HTTPException(
            status_code=404,
            detail=f"No covenant dashboard for {deal_id}. Drop stage JSONs in data/covenants/input/{deal_id}/ then POST to generate."
        )
    html = path.read_text(encoding="utf-8")

    # Replace deal ID with deal name in alert bar
    deal = _find_deal(deal_id)
    if deal:
        deal_label = f"{deal.get('target', '')} / {deal.get('acquirer', '')}"
        html = html.replace(f'<span class="deal-name">{deal_id}</span>',
                            f'<span class="deal-name">{deal_label}</span>')
        html = html.replace(f'<title>{deal_id} -', f'<title>{deal_label} -')

    # Remove executive summary section
    html = re.sub(
        r'<!-- Executive Summary -->\s*<div class="exec-summary">.*?</div>\s*</div>\s*</div>',
        '',
        html,
        flags=re.DOTALL
    )

    return Response(content=html, media_type="text/html")


@app.post("/api/deals/{deal_id}/covenants/generate")
def generate_deal_covenants(deal_id: str):
    """Generate covenant dashboard from stage JSONs in data/covenants/input/{deal_id}/."""
    input_dir = find_covenant_inputs(deal_id)
    if not input_dir:
        raise HTTPException(
            status_code=404,
            detail=f"No covenant inputs found. Drop deal_classification*.json and deal_assessment*.json in data/covenants/input/{deal_id}/"
        )
    try:
        build_covenant_dashboard(deal_id, input_dir)
        return {"message": f"Covenant dashboard generated for {deal_id}", "url": f"/api/deals/{deal_id}/covenants"}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/deals/{deal_id}/termination")
def get_deal_termination(deal_id: str):
    """Serve the pre-generated termination dashboard HTML for a deal."""
    path = get_termination_path(deal_id)
    if not path:
        raise HTTPException(
            status_code=404,
            detail=f"No termination dashboard for {deal_id}. Drop stage JSONs in data/termination/input/{deal_id}/ then POST to generate."
        )
    return FileResponse(path, media_type="text/html")


@app.post("/api/deals/{deal_id}/termination/generate")
def generate_deal_termination(deal_id: str):
    """Generate termination dashboard from stage JSONs in data/termination/input/{deal_id}/."""
    input_dir = find_termination_inputs(deal_id)
    if not input_dir:
        raise HTTPException(
            status_code=404,
            detail=f"No termination inputs found. Drop termination_classification*.json and termination_assessment*.json in data/termination/input/{deal_id}/"
        )
    try:
        build_termination_dashboard(deal_id, input_dir)
        return {"message": f"Termination dashboard generated for {deal_id}", "url": f"/api/deals/{deal_id}/termination"}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Merger Agreement URL ──

class MergerUrlRequest(BaseModel):
    url: str
    run_mae: bool = False
    run_covenants: bool = False
    run_termination: bool = False

@app.get("/api/deals/{deal_id}/merger-agreement-url")
def get_merger_agreement_url(deal_id: str):
    """Get stored merger agreement URL for a deal."""
    config_path = Path(__file__).parent / "data" / "deal_config" / f"{deal_id}.json"
    if config_path.exists():
        cfg = json.loads(config_path.read_text())
        return {"url": cfg.get("merger_agreement_url")}
    return {"url": None}

@app.post("/api/deals/{deal_id}/merger-agreement-url")
def set_merger_agreement_url(deal_id: str, body: MergerUrlRequest):
    """Store merger agreement URL for a deal. Optionally kick off analysis pipelines."""
    config_dir = Path(__file__).parent / "data" / "deal_config"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / f"{deal_id}.json"
    cfg = {}
    if config_path.exists():
        cfg = json.loads(config_path.read_text())
    cfg["merger_agreement_url"] = body.url
    config_path.write_text(json.dumps(cfg, indent=2))

    pipelines_started = []
    if body.run_mae:
        from mae_pipeline import start_mae_pipeline
        deal = _find_deal(deal_id)
        deal_name = deal.get("target", deal_id) if deal else deal_id
        start_mae_pipeline(deal_id, body.url, deal_name)
        pipelines_started.append("mae")
    if body.run_covenants:
        from covenant_pipeline import start_covenant_pipeline
        start_covenant_pipeline(deal_id, body.url)
        pipelines_started.append("covenants")
    if body.run_termination:
        from termination_pipeline import start_termination_pipeline
        start_termination_pipeline(deal_id, body.url)
        pipelines_started.append("termination")

    return {"status": "ok", "url": body.url, "pipelines_started": pipelines_started}


# ── Covenant Pipeline ──

@app.post("/api/deals/{deal_id}/covenants/run-pipeline")
def run_covenant_pipeline_endpoint(deal_id: str):
    """Launch the full covenant pipeline from the stored merger agreement URL."""
    from covenant_pipeline import start_covenant_pipeline
    config_path = Path(__file__).parent / "data" / "deal_config" / f"{deal_id}.json"
    if not config_path.exists():
        raise HTTPException(status_code=404, detail="No merger agreement URL stored")
    cfg = json.loads(config_path.read_text())
    url = cfg.get("merger_agreement_url")
    if not url:
        raise HTTPException(status_code=404, detail="No merger agreement URL stored")
    result = start_covenant_pipeline(deal_id, url)
    return result

@app.get("/api/deals/{deal_id}/covenants/pipeline-status")
def get_covenant_pipeline_status(deal_id: str):
    """Get the current covenant pipeline status."""
    from covenant_pipeline import get_pipeline_status
    return get_pipeline_status(deal_id)


# ── MAE Pipeline ──

@app.get("/api/deals/{deal_id}/mae")
def get_deal_mae(deal_id: str):
    """Serve the pre-generated MAE dashboard HTML for a deal."""
    from mae_pipeline import get_mae_path
    path = get_mae_path(deal_id)
    if not path:
        raise HTTPException(status_code=404, detail=f"No MAE dashboard for {deal_id}")
    return FileResponse(path, media_type="text/html")

@app.post("/api/deals/{deal_id}/mae/run-pipeline")
def run_mae_pipeline_endpoint(deal_id: str):
    """Launch the full MAE pipeline from the stored merger agreement URL."""
    from mae_pipeline import start_mae_pipeline
    config_path = Path(__file__).parent / "data" / "deal_config" / f"{deal_id}.json"
    if not config_path.exists():
        raise HTTPException(status_code=404, detail="No merger agreement URL stored")
    cfg = json.loads(config_path.read_text())
    url = cfg.get("merger_agreement_url")
    if not url:
        raise HTTPException(status_code=404, detail="No merger agreement URL stored")
    deal = _find_deal(deal_id)
    deal_name = deal.get("target", deal_id) if deal else deal_id
    result = start_mae_pipeline(deal_id, url, deal_name)
    return result

@app.get("/api/deals/{deal_id}/mae/pipeline-status")
def get_mae_pipeline_status(deal_id: str):
    """Get the current MAE pipeline status."""
    from mae_pipeline import get_pipeline_status
    return get_pipeline_status(deal_id)


# ── Termination Pipeline ──

class TerminationRunRequest(BaseModel):
    url: Optional[str] = None

@app.post("/api/deals/{deal_id}/termination/run-pipeline")
def run_termination_pipeline_endpoint(deal_id: str, body: TerminationRunRequest = None):
    """Launch the termination pipeline. Accepts optional URL in body; falls back to stored merger agreement URL."""
    from termination_pipeline import start_termination_pipeline
    url = body.url if body and body.url else None
    if not url:
        config_path = Path(__file__).parent / "data" / "deal_config" / f"{deal_id}.json"
        if config_path.exists():
            cfg = json.loads(config_path.read_text())
            url = cfg.get("merger_agreement_url")
    if not url:
        raise HTTPException(status_code=404, detail="No URL provided and no merger agreement URL stored")
    result = start_termination_pipeline(deal_id, url)
    return result

@app.get("/api/deals/{deal_id}/termination/pipeline-status")
def get_termination_pipeline_status(deal_id: str):
    """Get the current termination pipeline status."""
    from termination_pipeline import get_pipeline_status
    return get_pipeline_status(deal_id)


@app.get("/api/deals/{deal_id}/termination/sources")
def get_termination_sources(deal_id: str):
    """List source documents processed for this deal's termination analysis."""
    from termination_processor import TERMINATION_INPUT_DIR
    input_dir = TERMINATION_INPUT_DIR / deal_id
    if not input_dir.exists():
        return {"sources": []}
    sources = []
    # Agreement source — check for triggers or fees (one entry per source type)
    agmt_files = sorted(
        [f for f in input_dir.glob("termination_response_*.json") if "_8k" not in f.name],
        key=lambda p: p.stat().st_mtime, reverse=True,
    )
    if agmt_files:
        f = agmt_files[0]
        doc_id = ""
        if "termination_response_" in f.name:
            doc_id = f.name.split("termination_response_")[1].split("_")[0]
        sources.append({
            "type": "Merger Agreement",
            "doc_id": doc_id,
            "timestamp": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
        })
    # 8-K / press release source
    eight_k_files = sorted(input_dir.glob("*_8k.json"),
                           key=lambda p: p.stat().st_mtime, reverse=True)
    if eight_k_files:
        sources.append({
            "type": "8-K / Press Release",
            "timestamp": datetime.fromtimestamp(eight_k_files[0].stat().st_mtime).isoformat(),
        })
    # Pipeline last run
    from termination_pipeline import get_pipeline_status
    status = get_pipeline_status(deal_id)
    return {"sources": sources, "pipeline_status": status}


@app.get("/api/upcoming-events")
def get_upcoming_events():
    """Aggregate upcoming dated events from all deals (DMA timeline JSONs + deal data)."""
    from datetime import date as date_cls
    today = date_cls.today().isoformat()
    events = []

    # Pull structured events from DMA timeline JSONs
    if TIMELINES_DIR.exists():
        for json_file in TIMELINES_DIR.glob("*.json"):
            deal_id = json_file.stem
            try:
                data = json.loads(json_file.read_text())
                common = {
                    "deal_id":       deal_id,
                    "deal_name":     data.get("deal_name", deal_id),
                    "target":        data.get("target", ""),
                    "acquirer":      data.get("acquirer", ""),
                    "target_ticker": data.get("target_ticker", ""),
                }
                for ev in data.get("static_events", []):
                    if ev.get("date") and ev["date"] >= today:
                        events.append({**common, "date": ev["date"], "label": ev["label"],
                                        "type": "static", "ref": ev.get("ref", "")})
                for ev in data.get("deadline_events", []):
                    if ev.get("date") and ev["date"] >= today:
                        events.append({**common, "date": ev["date"], "label": ev["label"],
                                        "type": "deadline", "ref": ev.get("ref", ""),
                                        "calculation": ev.get("calculation", "")})
            except Exception:
                continue

    # Supplement with deal-level dates for deals without DMA JSONs
    dma_ids = {f.stem for f in TIMELINES_DIR.glob("*.json")} if TIMELINES_DIR.exists() else set()
    for deal in get_deals():
        if deal.id in dma_ids:
            continue
        common = {
            "deal_id": deal.id,
            "deal_name": f"{deal.target} / {deal.acquirer}",
            "target": deal.target,
            "acquirer": deal.acquirer,
            "target_ticker": deal.target_ticker,
            "ref": "",
        }
        if deal.outside_date and deal.outside_date.isoformat() >= today:
            events.append({**common, "date": deal.outside_date.isoformat(),
                            "label": "Outside Date", "type": "static"})
        if deal.expected_close and deal.expected_close.isoformat() >= today:
            events.append({**common, "date": deal.expected_close.isoformat(),
                            "label": "Expected Close", "type": "milestone"})

    events.sort(key=lambda x: x["date"])
    return {"events": events, "as_of": today}


@app.get("/api/deals/{deal_id}/scorecard")
def get_deal_scorecard(deal_id: str):
    """Return the pre-generated scorecard JSON for a deal."""
    path = get_scorecard_path(deal_id)
    if not path:
        raise HTTPException(status_code=404, detail=f"No scorecard for {deal_id}")
    return json.loads(path.read_text())


@app.get("/api/deals/{deal_id}/scorecard/sources")
def get_scorecard_sources(deal_id: str):
    """Check which pipeline outputs are available for scorecard generation."""
    return check_scorecard_sources(deal_id)


class ScorecardRequest(BaseModel):
    proxy_text: str = ""
    merger_agreement_text: str = ""
    auto_gather: bool = True
    supplement_text: str = ""


@app.post("/api/deals/{deal_id}/scorecard/generate")
def generate_deal_scorecard(deal_id: str, body: ScorecardRequest = None):
    """Generate scorecard from auto-gathered pipeline data or manual text input."""
    auto_gather = body.auto_gather if body else True
    proxy_text = (body.proxy_text if body else "") or ""
    ma_text = (body.merger_agreement_text if body else "") or None
    supplement = (body.supplement_text if body else "") or ""

    # If not auto-gathering and no manual text, check file-based inputs
    if not auto_gather and not proxy_text:
        inputs = find_scorecard_inputs(deal_id)
        if not inputs:
            raise HTTPException(
                status_code=404,
                detail=f"No inputs found. Use auto_gather=true or provide proxy_text."
            )
        proxy_text = inputs["proxy"]
        ma_text = inputs.get("merger_agreement")

    try:
        build_scorecard(
            deal_id,
            proxy_text=proxy_text,
            ma_text=ma_text,
            auto_gather=auto_gather,
            supplement_text=supplement,
        )
        return {"message": f"Scorecard generated for {deal_id}", "url": f"/api/deals/{deal_id}/scorecard"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── AI Summaries endpoint ─────────────────────────────────────────────────────

@app.get("/api/ai-summaries/{ticker}")
def get_ai_summaries(ticker: str):
    """Return L1/L2/L3 AI summaries for all filings of a given ticker."""
    summaries_root = Path(__file__).parent.parent.parent / "8K Test" / "Output Summaries"

    # Find folder matching pattern "Company Name (TICKER)"
    target_folder = None
    if summaries_root.exists():
        for folder in summaries_root.iterdir():
            if folder.is_dir() and f"({ticker.upper()})" in folder.name:
                target_folder = folder
                break

    if not target_folder:
        return {"results": []}

    index_path = target_folder / "filing_index.json"
    if not index_path.exists():
        return {"results": []}

    index_data = json.loads(index_path.read_text())

    # Read all individual *_summary.json files and build lookup by L1_headline
    summary_lookup = {}
    for json_file in target_folder.glob("*_summary.json"):
        if json_file.name == "filing_index.json":
            continue
        try:
            data = json.loads(json_file.read_text())
            headline = data.get("L1_headline", "")
            if headline:
                summary_lookup[headline] = data
        except Exception:
            continue

    # Combine filing_index entries with L2/L3 from individual summaries
    results = []
    for entry in index_data.get("results", []):
        headline = entry.get("headline", "")
        summary_data = summary_lookup.get(headline, {})
        result = {
            "index": entry.get("index"),
            "date": entry.get("date"),
            "form_type": entry.get("form_type"),
            "url": entry.get("url"),
            "ticker": entry.get("ticker"),
            "summary": {
                "L1_headline": headline,
                "L2_brief": summary_data.get("L2_brief", ""),
                "L3_detailed": summary_data.get("L3_detailed", {}),
                "items_reported": summary_data.get("items_reported", []),
            }
        }
        results.append(result)

    return {
        "company": index_data.get("company", ""),
        "total_filings": index_data.get("total_filings", len(results)),
        "results": results
    }


# ── SEC AI Filing Endpoints ──────────────────────────────────────────


@app.get("/api/sec-ai/companies")
def get_sec_companies():
    """List all companies that have AI-analyzed SEC filing data."""
    indexes = get_all_filing_indexes()
    companies = []
    for idx in indexes:
        companies.append({
            "slug": idx.get("_slug", ""),
            "company": idx.get("company", ""),
            "total_filings": idx.get("total_filings", 0),
            "successful": idx.get("successful", 0),
        })
    return {"companies": companies}


@app.get("/api/sec-ai/company/{company_slug}")
def get_sec_company_filings(company_slug: str):
    """Get all AI-analyzed filings for a specific company."""
    index = get_filing_index(company_slug)
    if not index:
        raise HTTPException(status_code=404, detail=f"No filings found for {company_slug}")
    return index


@app.get("/api/sec-ai/all")
def get_all_sec_ai_filings():
    """Get all AI-analyzed filings across all companies, sorted by date."""
    indexes = get_all_filing_indexes()
    all_filings = []
    for idx in indexes:
        company = idx.get("company", "")
        slug = idx.get("_slug", "")
        for result in idx.get("results", []):
            result["_company"] = company
            result["_slug"] = slug
            all_filings.append(result)

    # Sort by date descending
    all_filings.sort(key=lambda x: x.get("date", ""), reverse=True)

    # Build summary stats
    by_type: Dict[str, int] = {}
    for f in all_filings:
        ft = f.get("form_type", "Other")
        by_type[ft] = by_type.get(ft, 0) + 1

    return {
        "filings": all_filings,
        "total": len(all_filings),
        "companies": len(indexes),
        "by_type": [{"type": k, "count": v} for k, v in sorted(by_type.items(), key=lambda x: -x[1])]
    }


class SECProcessRequest(BaseModel):
    url: str
    company_slug: Optional[str] = None
    deal_id: Optional[str] = None  # For cross-document propagation


class SECBatchRequest(BaseModel):
    urls: list
    company_slug: Optional[str] = None
    deal_id: Optional[str] = None


# Background batch processing state
import threading
_batch_jobs: Dict[str, dict] = {}


def _run_batch_in_background(job_id: str, urls: list, company_slug: Optional[str], deal_id: Optional[str]):
    """Process SEC filings in a background thread."""
    import traceback
    job = _batch_jobs[job_id]
    for i, url in enumerate(urls, 1):
        try:
            print(f"[batch {job_id}] Processing {i}/{len(urls)}: {url[-60:]}")
            result = process_filing_url(url, company_slug)
            job["completed"] += 1
            headline = result.get("L1_headline", "") if isinstance(result, dict) else ""
            job["results"].append({"url": url, "status": "success", "headline": headline})
            print(f"[batch {job_id}]   OK: {headline[:60]}")
            if deal_id and isinstance(result, dict):
                try:
                    from propagation import propagate
                    propagate(deal_id, "sec_filing", url=url,
                             filing_type=result.get("filing_type", ""),
                             filing_date=result.get("filing_date", ""))
                except Exception:
                    pass
        except Exception as e:
            job["completed"] += 1
            job["results"].append({"url": url, "status": "error", "error": str(e)})
            print(f"[batch {job_id}]   FAILED: {e}")
            traceback.print_exc()
    job["done"] = True
    print(f"[batch {job_id}] DONE — {job['completed']}/{len(urls)} processed")


@app.post("/api/sec-ai/process")
def process_sec_filing(req: SECProcessRequest):
    """Process a single SEC filing URL through the AI summarizer pipeline."""
    try:
        result = process_filing_url(req.url, req.company_slug)
        prop = None
        if req.deal_id:
            from propagation import propagate
            filing_type = result.get("filing_type", "") if isinstance(result, dict) else ""
            filing_date = result.get("filing_date", "") if isinstance(result, dict) else ""
            prop = propagate(req.deal_id, "sec_filing", url=req.url,
                             filing_type=filing_type, filing_date=filing_date)
        return {"status": "success", "result": result, "propagation": prop}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/sec-ai/process-batch")
def process_sec_batch(req: SECBatchRequest):
    """Launch batch processing in background. Returns job_id to poll status."""
    import uuid
    job_id = str(uuid.uuid4())[:8]
    _batch_jobs[job_id] = {
        "total": len(req.urls),
        "completed": 0,
        "done": False,
        "results": []
    }
    thread = threading.Thread(
        target=_run_batch_in_background,
        args=(job_id, req.urls, req.company_slug, req.deal_id),
        daemon=True
    )
    thread.start()
    return {"job_id": job_id, "total": len(req.urls), "status": "processing"}


@app.get("/api/sec-ai/batch-jobs")
def list_batch_jobs():
    """List all batch jobs and their status."""
    return {job_id: {"total": j["total"], "completed": j["completed"], "done": j["done"],
                      "errors": [r for r in j["results"] if r["status"] == "error"]}
            for job_id, j in _batch_jobs.items()}


@app.get("/api/sec-ai/batch-status/{job_id}")
def get_batch_status(job_id: str):
    """Poll batch processing progress."""
    job = _batch_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "job_id": job_id,
        "total": job["total"],
        "completed": job["completed"],
        "done": job["done"],
        "results": job["results"]
    }


@app.get("/api/deals/{deal_id}/proxy-analysis")
def get_proxy_analysis(deal_id: str):
    """Get all proxy analysis filings for a deal."""
    from proxy_analysis_processor import get_proxy_analyses
    results = get_proxy_analyses(deal_id)
    # Backfill ticker/company from deal data when parser couldn't extract them
    deal = _find_deal(deal_id)
    if deal:
        for r in results:
            if not r.get("ticker"):
                r["ticker"] = deal.get("target_ticker", "")
            if not r.get("company"):
                r["company"] = deal.get("target", "")
    return {"filings": results, "total": len(results)}


@app.post("/api/deals/{deal_id}/proxy-analysis/upload")
async def upload_proxy_analysis(deal_id: str, request: Request):
    """Upload proxy analysis txt content."""
    from proxy_analysis_processor import save_proxy_txt, parse_proxy_txt
    from propagation import propagate
    body = await request.json()
    filename = body.get("filename", "")
    content = body.get("content", "")
    if not filename or not content:
        raise HTTPException(status_code=400, detail="filename and content required")
    filepath = save_proxy_txt(deal_id, filename, content)
    parsed = parse_proxy_txt(filepath)
    # Backfill ticker/company from deal data if parser couldn't find them
    if not parsed.get("ticker") or not parsed.get("company"):
        deal = _find_deal(deal_id)
        if deal:
            if not parsed.get("ticker"):
                parsed["ticker"] = deal.get("target_ticker", "")
            if not parsed.get("company"):
                parsed["company"] = deal.get("target", "")
    prop = propagate(deal_id, "proxy_upload")
    return {"status": "saved", "filename": filename, "parsed": parsed, "propagation": prop}


def _load_tenk_from_mongodb(deal_id: str) -> list:
    """Load 10-K/10-Q analysis from MongoDB sec_filing_summary.ten_k_ten_q field."""
    import requests as _req
    from pymongo import MongoClient
    from config import MONGODB_URI, MONGODB_DB

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
    db = client[MONGODB_DB]

    docs = list(db["sec_filing_summary"].find(
        {"deal_id": deal_id, "ten_k_ten_q": {"$ne": None, "$exists": True}}
    ))
    client.close()

    if not docs:
        return []

    filings = []

    for doc in docs:
        t = doc["ten_k_ten_q"]
        filing_type = t.get("filing_type") or "10-K"
        label = t.get("label") or filing_type
        period_date = t.get("period_date") or ""
        _ticker = ""  # populated from first overview JSON fetch

        # ── Overview (excerpts JSON) ──────────────────────────────────────────
        s3_url = t.get("s3_json_url")
        if s3_url:
            try:
                resp = _req.get(s3_url, timeout=15)
                resp.raise_for_status()
                data = resp.json()
                meta = data.get("metadata", {})
                raw_excerpts = data.get("excerpts", [])
                excerpts = []
                for ex in raw_excerpts:
                    tags = []
                    if ex.get("timing_flag"):
                        tags.append("TIMING")
                    if ex.get("regulatory_flag"):
                        tags.append("REGULATORY")
                    if not tags:
                        tags.append("LEGAL")
                    excerpts.append({
                        "number": ex.get("paragraph_index", 0),
                        "tags": tags,
                        "category": ex.get("category", ""),
                        "section": ex.get("section", ""),
                        "text": ex.get("text", ""),
                    })
                _ticker = meta.get("ticker", "")
                filings.append({
                    "doc_type": "overview",
                    "filing_type": filing_type,
                    "filing_label": label,
                    "ticker": _ticker,
                    "company": meta.get("target", ""),
                    "generated": meta.get("generated", period_date),
                    "filename": f"{label}_{period_date}",
                    "excerpts": excerpts,
                })
            except Exception as e:
                print(f"[tenk] overview fetch failed for {doc['_id']}: {e}")

        # ── Redline + Exec (comparison JSON) ─────────────────────────────────
        comp_url = t.get("s3_comparison_json_url")
        if comp_url:
            try:
                resp = _req.get(comp_url, timeout=15)
                resp.raise_for_status()
                comp = resp.json()
                meta = comp.get("metadata", {})
                generated = meta.get("generated", period_date)
                filings_analyzed = meta.get("filings_analyzed", [])
                transition = f"Prior Filings \u2192 {label}"
                if len(filings_analyzed) >= 2:
                    transition = f"{filings_analyzed[-1]} \u2192 {label}"

                step = (comp.get("comparison_steps") or [{}])[0]
                summary = step.get("summary", {})
                findings = step.get("findings", [])

                # Redline excerpts — findings where any pass changed
                redline_excerpts = []
                for i, f in enumerate(findings):
                    passes = [
                        ("timing", f.get("timing") or {}),
                        ("regulatory", f.get("regulatory") or {}),
                        ("legal_language", f.get("legal_language") or {}),
                    ]
                    changed_passes = [(name, p) for name, p in passes if p.get("changed")]
                    if not changed_passes:
                        continue
                    tags = []
                    if f.get("timing_flag"):
                        tags.append("TIMING")
                    if f.get("regulatory_flag"):
                        tags.append("REGULATORY")
                    if not tags:
                        tags.append("LEGAL")
                    prior_text = ""
                    phrase_changes = []
                    for name, p in changed_passes:
                        prior_excerpts = p.get("_prior_excerpts") or []
                        if prior_excerpts and not prior_text:
                            prior_text = prior_excerpts[0].get("text", "")
                        if p.get("analysis"):
                            phrase_changes.append({"analysis": p["analysis"]})
                    severity = f.get("tier") or changed_passes[0][1].get("severity") or "moderate"
                    redline_excerpts.append({
                        "number": i + 1,
                        "significance": severity,
                        "tags": tags,
                        "source": f.get("section", ""),
                        "current_label": label,
                        "current_text": f.get("text", ""),
                        "prior_label": "Prior Filing",
                        "prior_text": prior_text,
                        "phrase_changes": phrase_changes,
                    })

                filings.append({
                    "doc_type": "redline",
                    "filing_type": filing_type,
                    "ticker": _ticker,
                    "transition": transition,
                    "comparison_header": f"{label} — changes vs prior filings",
                    "generated": generated,
                    "filename": f"{label}_{period_date}_redline",
                    "redline_excerpts": redline_excerpts,
                })

                # Exec summary — sections grouped by pass type
                pass_labels = [("timing", "TIMING"), ("regulatory", "REGULATORY"), ("legal_language", "LEGAL LANGUAGE")]
                sections = []
                for pass_key, pass_title in pass_labels:
                    items = []
                    for f in findings:
                        p = f.get(pass_key) or {}
                        if p.get("changed") and p.get("analysis"):
                            items.append(p["analysis"])
                    if items:
                        sections.append({"name": pass_title, "items": items})

                total = summary.get("total_changes", len(redline_excerpts))
                sig = summary.get("significant", 0)
                mod = summary.get("moderate", 0)
                minor = summary.get("minor", 0)
                overview_line = f"{total} total changes — {sig} significant, {mod} moderate, {minor} minor"

                filings.append({
                    "doc_type": "exec",
                    "filing_type": filing_type,
                    "ticker": _ticker,
                    "transition": transition,
                    "overview": overview_line,
                    "generated": generated,
                    "filename": f"{label}_{period_date}_exec",
                    "sections": sections,
                })
            except Exception as e:
                print(f"[tenk] comparison fetch failed for {doc['_id']}: {e}")

    return filings


@app.get("/api/deals/{deal_id}/tenk-analysis")
def get_tenk_analysis(deal_id: str):
    """Get all 10-K/10-Q analysis filings for a deal."""
    if _DATA_SOURCE == "mongodb":
        try:
            results = _load_tenk_from_mongodb(deal_id)
            if results:
                return {"filings": results, "total": len(results)}
        except Exception as e:
            print(f"[tenk] MongoDB load failed, falling back to static: {e}")
    from tenk_analysis_processor import get_tenk_analyses
    results = get_tenk_analyses(deal_id)
    deal = _find_deal(deal_id)
    if deal:
        for r in results:
            if not r.get("ticker"):
                r["ticker"] = deal.get("target_ticker", "")
            if not r.get("company"):
                r["company"] = deal.get("target", "")
    return {"filings": results, "total": len(results)}


@app.post("/api/deals/{deal_id}/tenk-analysis/upload")
async def upload_tenk_analysis(deal_id: str, request: Request):
    """Upload 10-K/10-Q analysis txt content."""
    from tenk_analysis_processor import save_tenk_txt, parse_tenk_txt
    from propagation import propagate
    body = await request.json()
    filename = body.get("filename", "")
    content = body.get("content", "")
    if not filename or not content:
        raise HTTPException(status_code=400, detail="filename and content required")
    filepath = save_tenk_txt(deal_id, filename, content)
    parsed = parse_tenk_txt(filepath)
    prop = propagate(deal_id, "tenk_upload")
    return {"status": "saved", "filename": filename, "parsed": parsed, "propagation": prop}


@app.get("/api/deals/{deal_id}/dma-extract")
def get_dma_extract(deal_id: str):
    """Get saved DMA summary extraction for a deal."""
    from dma_summary_processor import get_dma_extract as _get
    data = _get(deal_id)
    if not data:
        return {"status": "none", "data": None}
    return {"status": "ok", "data": data}


@app.post("/api/deals/{deal_id}/dma-extract")
async def process_dma_summary(deal_id: str, request: Request):
    """Extract structured deal data from a DMA summary using LLM.
    Also parses concise/fulsome sections and saves to details file."""
    from dma_summary_processor import extract_from_dma_summary
    from propagation import propagate
    body = await request.json()
    summary_text = body.get("text", "")
    if not summary_text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    try:
        result = extract_from_dma_summary(deal_id, summary_text)
        prop = propagate(deal_id, "dma_extract")

        # Also parse concise/fulsome sections from the pasted text
        sections_saved = False
        try:
            from process_dma_two_pass import extract_sections_from_text, save_detail_sections
            sections = extract_sections_from_text(summary_text)
            if sections["concise_sections"] or sections["fulsome_sections"]:
                save_detail_sections(deal_id, sections)
                sections_saved = True
                # Invalidate deals cache so next load picks up new sections
                global _deals_cache
                _deals_cache = None
        except Exception as e:
            print(f"[dma-extract] Section parsing warning: {e}")

        return {"status": "success", "data": result, "propagation": prop, "sections_saved": sections_saved}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/deals/{deal_id}/press-release")
def get_press_release(deal_id: str):
    """Get saved press release extraction for a deal."""
    from press_release_processor import get_press_release_data
    data = get_press_release_data(deal_id)
    if not data:
        return {"status": "none", "data": None}
    return {"status": "ok", "data": data}


@app.post("/api/deals/{deal_id}/press-release")
async def process_press_release(deal_id: str, request: Request):
    """Extract structured deal data from a press release summary using LLM."""
    from press_release_processor import extract_from_press_release
    from propagation import propagate
    body = await request.json()
    summary_text = body.get("text", "")
    if not summary_text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    try:
        result = extract_from_press_release(deal_id, summary_text)
        prop = propagate(deal_id, "press_release")
        return {"status": "success", "data": result, "propagation": prop}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Milestone Log ────────────────────────────────────────────────────────────

@app.get("/api/deals/{deal_id}/milestone-log")
def get_milestone_log(deal_id: str):
    """Build and return milestone progression log for a deal."""
    from milestone_log_processor import build_milestone_log
    result = build_milestone_log(deal_id)
    if not result.get("milestones"):
        return {"deal_id": deal_id, "milestones": [], "generated_at": result.get("generated_at")}
    return result


def _compute_cross_source_discrepancies(
    pr: Optional[dict],
    dma: Optional[dict],
    timeline: Optional[dict],
) -> list:
    """
    Compare overlapping fields across PR, DMA Extract, and Timeline JSON.
    Returns an array of discrepancies where sources disagree.
    """
    discrepancies = []

    def _source_date(name: str):
        if name == "press_release" and pr:
            return pr.get("announce_date")
        if name == "dma_extract" and dma:
            return dma.get("announce_date")
        if name == "timeline" and timeline:
            return timeline.get("signing_date")
        return None

    def _check(field: str, label: str, mappings: list):
        entries = []
        for src, key, data in mappings:
            if data and data.get(key) is not None:
                entries.append({
                    "source": src,
                    "value": data[key],
                    "date": _source_date(src),
                })
        if len(entries) < 2:
            return
        # Normalize for comparison
        normed = []
        for e in entries:
            v = e["value"]
            if isinstance(v, (int, float)):
                normed.append(round(float(v), 4))
            elif isinstance(v, str):
                normed.append(v.strip().lower())
            else:
                normed.append(str(v))
        if len(set(str(v) for v in normed)) <= 1:
            return
        # Determine most recent
        dated = [e for e in entries if e.get("date")]
        most_recent = None
        if dated:
            dated.sort(key=lambda x: x["date"], reverse=True)
            most_recent = dated[0]["source"]
        discrepancies.append({
            "field": field,
            "label": label,
            "sources": entries,
            "most_recent": most_recent,
        })

    _check("offer_price", "Offer Price (Cash)", [
        ("press_release", "offer_price_cash", pr),
        ("dma_extract", "offer_price_cash", dma),
        ("timeline", "offer_price_per_share", timeline),
    ])
    _check("exchange_ratio", "Stock Exchange Ratio", [
        ("press_release", "stock_exchange_ratio", pr),
        ("dma_extract", "stock_exchange_ratio", dma),
        ("timeline", "exchange_ratio", timeline),
    ])
    _check("deal_type", "Deal Type", [
        ("press_release", "deal_type", pr),
        ("dma_extract", "deal_type", dma),
    ])
    _check("outside_date", "Outside Date", [
        ("dma_extract", "outside_date", dma),
        ("timeline", "outside_date_initial", timeline),
    ])
    _check("expected_close", "Expected Close", [
        ("press_release", "expected_close", pr),
        ("dma_extract", "expected_close", dma),
    ])
    _check("announce_date", "Announce Date", [
        ("press_release", "announce_date", pr),
        ("dma_extract", "announce_date", dma),
        ("timeline", "announce_date", timeline),
    ])
    return discrepancies


@app.get("/api/deals/{deal_id}/document-sources")
def get_document_sources(deal_id: str):
    """Aggregate load status, timestamps, and cross-source discrepancies for ALL document types."""
    from press_release_processor import get_press_release_data
    from dma_summary_processor import get_dma_extract as _get_dma
    from datetime import datetime as _dt

    data_dir = Path(__file__).parent / "data"
    sources = []
    pr_extracted = None
    dma_extracted = None
    timeline_data = None

    def _fmod(p: Path) -> str:
        return _dt.fromtimestamp(p.stat().st_mtime).isoformat()

    # ── Press Release ──
    pr_raw = get_press_release_data(deal_id)
    if pr_raw:
        pr_extracted = pr_raw.get("extracted", {})
        sources.append({
            "source": "press_release", "label": "Press Release", "status": "loaded",
            "extracted_at": pr_raw.get("extracted_at"),
            "filing_date": pr_raw.get("filing_date") or pr_extracted.get("announce_date"),
        })
    else:
        sources.append({"source": "press_release", "label": "Press Release", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # ── DMA Extract ──
    dma_raw = _get_dma(deal_id)
    if dma_raw:
        dma_extracted = dma_raw.get("extracted", {})
        sources.append({
            "source": "dma_extract", "label": "DMA Summary", "status": "loaded",
            "extracted_at": dma_raw.get("extracted_at"),
            "filing_date": dma_raw.get("filing_date") or dma_extracted.get("announce_date"),
        })
    else:
        sources.append({"source": "dma_extract", "label": "DMA Summary", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # ── DMA Sections ──
    # Details can be in backend/data/details/ or project-root/data/details/
    details_path = data_dir / "details" / f"{deal_id}.json"
    if not details_path.exists():
        details_path = Path(__file__).parent.parent / "data" / "details" / f"{deal_id}.json"
    if details_path.exists():
        det = json.loads(details_path.read_text())
        c = len(det.get("concise_sections", []))
        f = len(det.get("fulsome_sections", []))
        sources.append({
            "source": "dma_sections", "label": "DMA Sections", "status": "loaded",
            "extracted_at": None, "filing_date": None,
            "count": c + f, "file_modified": _fmod(details_path),
        })
    else:
        sources.append({"source": "dma_sections", "label": "DMA Sections", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # ── Timeline ──
    tl_path = get_timeline_json_path(deal_id)
    if tl_path:
        timeline_data = json.loads(tl_path.read_text())
        meta = timeline_data.get("_meta", {})
        sources.append({
            "source": "timeline", "label": "Timeline", "status": "loaded",
            "extracted_at": meta.get("extracted_at"), "filing_date": meta.get("filing_date"),
        })
    else:
        sources.append({"source": "timeline", "label": "Timeline", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # ── Regulatory Tracker ──
    reg_path = TIMELINES_DIR / f"{deal_id}_regulatory.json"
    if reg_path.exists():
        reg = json.loads(reg_path.read_text())
        sources.append({
            "source": "regulatory", "label": "Regulatory Tracker", "status": "loaded",
            "extracted_at": reg.get("last_updated"), "filing_date": None,
            "count": len(reg.get("approvals", [])),
        })
    else:
        sources.append({"source": "regulatory", "label": "Regulatory Tracker", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # ── Tracking Layer ──
    trk_path = TIMELINES_DIR / f"{deal_id}_tracking.json"
    if trk_path.exists():
        trk = json.loads(trk_path.read_text())
        evts = trk.get("events", {})
        sources.append({
            "source": "tracking", "label": "Tracking Layer", "status": "loaded",
            "extracted_at": None, "filing_date": None,
            "count": len(evts), "filled": sum(1 for e in evts.values() if e.get("date")),
            "file_modified": _fmod(trk_path),
        })
    else:
        sources.append({"source": "tracking", "label": "Tracking Layer", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # ── Proxy Analysis ──
    proxy_dir = data_dir / "proxy_analysis" / deal_id
    proxy_files = []
    if proxy_dir.exists():
        for fp in sorted(proxy_dir.glob("*.txt")):
            proxy_files.append({
                "filename": fp.name, "modified": _fmod(fp),
                "size_kb": round(fp.stat().st_size / 1024, 1),
            })
    sources.append({
        "source": "proxy", "label": "Proxy Analysis",
        "status": "loaded" if proxy_files else "missing",
        "extracted_at": None, "filing_date": None,
        "count": len(proxy_files), "files": proxy_files,
    })

    # ── 10-K / 10-Q ──
    tenk_dir = data_dir / "tenk_analysis" / deal_id
    tenk_files = []
    if tenk_dir.exists():
        for fp in sorted(tenk_dir.glob("*.txt")):
            tenk_files.append({
                "filename": fp.name, "modified": _fmod(fp),
                "size_kb": round(fp.stat().st_size / 1024, 1),
            })
    sources.append({
        "source": "tenk", "label": "10-K / 10-Q",
        "status": "loaded" if tenk_files else "missing",
        "extracted_at": None, "filing_date": None,
        "count": len(tenk_files), "files": tenk_files,
    })

    # ── Overrides ──
    ov_path = data_dir / "overrides" / f"{deal_id}.json"
    if ov_path.exists():
        ov = json.loads(ov_path.read_text())
        sources.append({
            "source": "overrides", "label": "Overrides", "status": "loaded",
            "extracted_at": None, "filing_date": None,
            "count": len(ov), "file_modified": _fmod(ov_path),
        })
    else:
        sources.append({"source": "overrides", "label": "Overrides", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # ── Termination ──
    term_path = data_dir / "termination" / f"{deal_id}.html"
    if term_path.exists():
        sources.append({
            "source": "termination", "label": "Termination Analysis", "status": "loaded",
            "extracted_at": None, "filing_date": None, "file_modified": _fmod(term_path),
        })
    else:
        sources.append({"source": "termination", "label": "Termination Analysis", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # ── SEC Filings (AI-analyzed) ──
    from sec_processor import _find_existing_folder_for_ticker, get_filing_index
    deal_obj = _find_deal(deal_id)
    sec_filing_files = []
    seen_urls: set = set()
    for ticker in [deal_obj.get("target_ticker", ""), deal_obj.get("acquirer_ticker", "")] if deal_obj else []:
        if not ticker:
            continue
        slug = _find_existing_folder_for_ticker(ticker)
        if not slug:
            continue
        index = get_filing_index(slug)
        if not index:
            continue
        for r in index.get("results", []):
            url = r.get("url", "")
            if url in seen_urls:
                continue
            seen_urls.add(url)
            summary = r.get("summary", {})
            sec_filing_files.append({
                "filename": r.get("_filename", ""),
                "form_type": r.get("form_type") or summary.get("filing_type", ""),
                "date": r.get("date", ""),
                "ticker": r.get("ticker") or summary.get("ticker", ""),
            })
    sources.append({
        "source": "sec_filings", "label": "SEC Filings",
        "status": "loaded" if sec_filing_files else "missing",
        "extracted_at": None, "filing_date": None,
        "count": len(sec_filing_files), "files": sec_filing_files,
    })

    # ── Merger Agreement URL ──
    config_path = data_dir / "deal_config" / f"{deal_id}.json"
    merger_url = None
    if config_path.exists():
        cfg = json.loads(config_path.read_text())
        merger_url = cfg.get("merger_agreement_url")
    sources.append({
        "source": "merger_agreement", "label": "Merger Agreement",
        "status": "loaded" if merger_url else "missing",
        "extracted_at": None, "filing_date": None,
        "url": merger_url,
    })

    # ── Covenants ──
    cov_html = data_dir / "covenants" / f"{deal_id}.html"
    sources.append({
        "source": "covenants", "label": "Covenants Dashboard",
        "status": "loaded" if cov_html.exists() else "missing",
        "extracted_at": None, "filing_date": None,
        "file_modified": _fmod(cov_html) if cov_html.exists() else None,
    })

    # ── MAE ──
    mae_html = data_dir / "mae" / f"{deal_id}.html"
    sources.append({
        "source": "mae", "label": "MAE Dashboard",
        "status": "loaded" if mae_html.exists() else "missing",
        "extracted_at": None, "filing_date": None,
        "file_modified": _fmod(mae_html) if mae_html.exists() else None,
    })

    # ── Reddit ──
    reddit_path = data_dir / "reddit" / f"{deal_id}_reddit.json"
    if reddit_path.exists():
        sources.append({
            "source": "reddit", "label": "Reddit Analysis", "status": "loaded",
            "extracted_at": None, "filing_date": None, "file_modified": _fmod(reddit_path),
        })
    else:
        sources.append({"source": "reddit", "label": "Reddit Analysis", "status": "missing",
                         "extracted_at": None, "filing_date": None})

    # Discrepancies (unchanged)
    discrepancies = _compute_cross_source_discrepancies(pr_extracted, dma_extracted, timeline_data)

    return {"sources": sources, "discrepancies": discrepancies}


@app.get("/api/deals/{deal_id}/documents/{doc_type}/preview")
def get_document_preview(deal_id: str, doc_type: str):
    """Return all fields from a document for inline viewing."""
    data_dir = Path(__file__).parent / "data"
    fields: list = []

    # Skip keys that are internal / not useful to display
    _SKIP_KEYS = {"deal_id", "source_text", "inconsistencies", "extracted_at",
                  "filing_date", "_meta", "last_updated", "source_docs"}

    def _fmt(value) -> str:
        """Format any value for display."""
        if value is None:
            return "—"
        if isinstance(value, bool):
            return "Yes" if value else "No"
        if isinstance(value, list):
            if not value:
                return "—"
            # List of dicts: show one line per item with key fields
            if isinstance(value[0], dict):
                lines = []
                for item in value:
                    # Try common name keys, else show all
                    name = item.get("authority") or item.get("authority_short") or item.get("name") or item.get("event")
                    if name:
                        extras = [f"{k}: {v}" for k, v in item.items()
                                  if k not in ("authority", "authority_short", "name", "event") and v is not None]
                        lines.append(f"{name}" + (f" ({', '.join(extras)})" if extras else ""))
                    else:
                        lines.append("; ".join(f"{k}: {v}" for k, v in item.items() if v is not None))
                return "\n".join(f"• {l}" for l in lines)
            # List of strings
            return "\n".join(f"• {str(item)}" for item in value)
        if isinstance(value, dict):
            return "\n".join(f"{k}: {v}" for k, v in value.items() if v is not None)
        return str(value)

    def _label(key: str) -> str:
        return key.replace("_", " ").title()

    def _add_dict(d: dict, skip: set = set()):
        for k, v in d.items():
            if k in _SKIP_KEYS or k in skip:
                continue
            formatted = _fmt(v)
            if formatted != "—":
                fields.append({"label": _label(k), "value": formatted})

    if doc_type == "overrides":
        path = data_dir / "overrides" / f"{deal_id}.json"
        if path.exists():
            _add_dict(json.loads(path.read_text()))

    elif doc_type in ("dma_extract", "press_release"):
        path = data_dir / doc_type / f"{deal_id}.json"
        if path.exists():
            raw = json.loads(path.read_text())
            ext = raw.get("extracted", {})
            _add_dict(ext)

    elif doc_type == "dma_sections":
        details_path = data_dir / "details" / f"{deal_id}.json"
        if not details_path.exists():
            details_path = Path(__file__).parent.parent / "data" / "details" / f"{deal_id}.json"
        if details_path.exists():
            det = json.loads(details_path.read_text())
            for sec in det.get("concise_sections", []):
                fields.append({"label": f"Concise: {sec.get('name', '?')}", "value": f"{len(sec.get('clauses', []))} clauses"})
            for sec in det.get("fulsome_sections", []):
                fields.append({"label": f"Fulsome: {sec.get('name', '?')}", "value": f"{len(sec.get('clauses', []))} clauses"})

    elif doc_type == "timeline":
        tl_path = get_timeline_json_path(deal_id)
        if tl_path:
            tl = json.loads(tl_path.read_text())
            _add_dict(tl)

    elif doc_type == "regulatory":
        path = TIMELINES_DIR / f"{deal_id}_regulatory.json"
        if path.exists():
            reg = json.loads(path.read_text())
            for a in reg.get("approvals", []):
                status = a.get("status", "pending").upper()
                detail = status
                if a.get("cleared_date"):
                    detail += f" — cleared {a['cleared_date']}"
                if a.get("filed_date"):
                    detail += f" — filed {a['filed_date']}"
                if a.get("conditions"):
                    detail += f" — {a['conditions']}"
                fields.append({"label": a.get("authority_short", "?"), "value": detail})

    elif doc_type == "tracking":
        path = TIMELINES_DIR / f"{deal_id}_tracking.json"
        if path.exists():
            trk = json.loads(path.read_text())
            for key, evt in trk.get("events", {}).items():
                date_val = evt.get("date") or "TBD"
                source = evt.get("source", "")
                val = date_val + (f"  ({source})" if source else "")
                fields.append({"label": _label(key), "value": val})

    elif doc_type == "reddit":
        path = data_dir / "reddit" / f"{deal_id}_reddit.json"
        if path.exists():
            rd = json.loads(path.read_text())
            if isinstance(rd, dict):
                _add_dict(rd)
            elif isinstance(rd, list):
                fields.append({"label": "Items", "value": str(len(rd))})

    elif doc_type == "termination":
        fields.append({"label": "View", "value": "Full analysis available on the Termination tab"})

    if not fields:
        fields.append({"label": "Status", "value": "Empty or not found"})

    return {"doc_type": doc_type, "fields": fields}


@app.get("/api/deals/{deal_id}/documents/{doc_type}/source-text")
def get_document_source_text(deal_id: str, doc_type: str, filename: Optional[str] = None):
    """Return source text for a document if available."""
    data_dir = Path(__file__).parent / "data"
    text = None

    if doc_type == "dma_extract":
        path = data_dir / "dma_extract" / f"{deal_id}.json"
        if path.exists():
            text = json.loads(path.read_text()).get("source_text")
    elif doc_type == "press_release":
        path = data_dir / "press_release" / f"{deal_id}.json"
        if path.exists():
            text = json.loads(path.read_text()).get("source_text")
    elif doc_type in ("proxy", "tenk"):
        subdir = "proxy_analysis" if doc_type == "proxy" else "tenk_analysis"
        if filename:
            path = data_dir / subdir / deal_id / filename
            if path.exists() and path.suffix == ".txt":
                text = path.read_text()
    if text is None:
        raise HTTPException(status_code=404, detail="Source text not available")
    return {"source_text": text}


@app.delete("/api/deals/{deal_id}/documents/{doc_type}")
def delete_document(deal_id: str, doc_type: str, filename: Optional[str] = None):
    """Delete a document for a deal."""
    data_dir = Path(__file__).parent / "data"
    path_map = {
        "dma_extract": data_dir / "dma_extract" / f"{deal_id}.json",
        "dma_sections": data_dir / "details" / f"{deal_id}.json",
        "press_release": data_dir / "press_release" / f"{deal_id}.json",
        "regulatory": TIMELINES_DIR / f"{deal_id}_regulatory.json",
        "tracking": TIMELINES_DIR / f"{deal_id}_tracking.json",
        "overrides": data_dir / "overrides" / f"{deal_id}.json",
        "termination": data_dir / "termination" / f"{deal_id}.html",
        "reddit": data_dir / "reddit" / f"{deal_id}_reddit.json",
    }

    if doc_type in ("proxy", "tenk"):
        if not filename:
            raise HTTPException(status_code=400, detail="filename required for proxy/tenk")
        subdir = "proxy_analysis" if doc_type == "proxy" else "tenk_analysis"
        target = data_dir / subdir / deal_id / filename
    elif doc_type == "timeline":
        # Delete both JSON and HTML
        for ext in (".json", ".html"):
            p = TIMELINES_DIR / f"{deal_id}{ext}"
            if p.exists():
                p.unlink()
        global _deals_cache
        _deals_cache = None
        return {"status": "deleted", "doc_type": doc_type}
    else:
        target = path_map.get(doc_type)

    if not target or not target.exists():
        raise HTTPException(status_code=404, detail=f"Document not found: {doc_type}")

    target.unlink()
    _deals_cache = None
    return {"status": "deleted", "doc_type": doc_type}


@app.get("/api/stock/historical-price")
def get_historical_price(ticker: str, date_str: str):
    """Get closing price for a ticker on a specific date via yfinance."""
    if not YFINANCE_AVAILABLE:
        raise HTTPException(status_code=500, detail="yfinance not available")
    try:
        from datetime import datetime, timedelta
        dt = datetime.strptime(date_str, "%Y-%m-%d").date()
        # Fetch a few days around the date in case it's a weekend/holiday
        start = dt - timedelta(days=5)
        end = dt + timedelta(days=1)
        stock = yf.Ticker(ticker)
        hist = stock.history(start=start.isoformat(), end=end.isoformat())
        if hist.empty:
            return {"price": None, "date": date_str}
        # Find the closest date <= requested date
        hist.index = hist.index.date
        valid = hist.loc[hist.index <= dt]
        if valid.empty:
            return {"price": None, "date": date_str}
        close = float(valid.iloc[-1]["Close"])
        actual_date = valid.index[-1].isoformat()
        return {"price": round(close, 2), "date": actual_date, "requested_date": date_str}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


_OVERRIDES_DIR = Path(__file__).parent / "data" / "overrides"


def _load_overrides(deal_id: str) -> dict:
    p = _OVERRIDES_DIR / f"{deal_id}.json"
    if p.exists():
        return json.loads(p.read_text())
    return {}


def _save_overrides(deal_id: str, data: dict) -> None:
    _OVERRIDES_DIR.mkdir(parents=True, exist_ok=True)
    p = _OVERRIDES_DIR / f"{deal_id}.json"
    existing = _load_overrides(deal_id)
    existing.update(data)
    p.write_text(json.dumps(existing, indent=2))


@app.get("/api/deals/{deal_id}/overrides")
def get_overrides(deal_id: str):
    return _load_overrides(deal_id)


@app.patch("/api/deals/{deal_id}/overrides")
async def update_overrides(deal_id: str, request: Request):
    body = await request.json()
    _save_overrides(deal_id, body)
    return {"status": "ok", "data": _load_overrides(deal_id)}


# ── Global Settings + SOFR ──────────────────────────────────────────────────

_SETTINGS_PATH = Path(__file__).parent / "data" / "settings.json"


def _load_settings() -> dict:
    defaults = {"long_spread_bps": 50, "short_spread_bps": 20}
    if _SETTINGS_PATH.exists():
        stored = json.loads(_SETTINGS_PATH.read_text())
        defaults.update(stored)
    return defaults


def _save_settings(data: dict) -> None:
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = _load_settings()
    existing.update(data)
    _SETTINGS_PATH.write_text(json.dumps(existing, indent=2))


@app.get("/api/settings")
def get_settings():
    return _load_settings()


@app.patch("/api/settings")
async def update_settings(request: Request):
    body = await request.json()
    _save_settings(body)
    return {"status": "ok", "data": _load_settings()}


@app.get("/api/sofr")
def get_sofr():
    """Fetch current SOFR rate from NY Fed, cached for 24 hours."""
    import urllib.request
    settings = _load_settings()
    # Check cache freshness
    cached_at = settings.get("sofr_fetched_at")
    if cached_at and settings.get("sofr_rate") is not None:
        try:
            age_hours = (datetime.now() - datetime.fromisoformat(cached_at)).total_seconds() / 3600
            if age_hours < 24:
                return {
                    "rate": settings["sofr_rate"],
                    "effective_date": settings.get("sofr_effective_date", ""),
                    "cached": True,
                }
        except Exception:
            pass
    # Fetch fresh
    try:
        url = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json"
        req = urllib.request.Request(url, headers={"User-Agent": "MergerDashboard/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        ref = data["refRates"][0]
        rate = ref["percentRate"] / 100  # Convert 4.30 → 0.0430
        eff_date = ref["effectiveDate"]
        _save_settings({
            "sofr_rate": rate,
            "sofr_effective_date": eff_date,
            "sofr_fetched_at": datetime.now().isoformat(),
        })
        return {"rate": rate, "effective_date": eff_date, "cached": False}
    except Exception as e:
        # Return cached value if fetch fails
        if settings.get("sofr_rate") is not None:
            return {"rate": settings["sofr_rate"], "effective_date": settings.get("sofr_effective_date", ""), "cached": True, "error": str(e)}
        return {"rate": 0.0430, "effective_date": "", "cached": False, "error": str(e)}


@app.get("/api/spy-price")
def get_spy_price():
    """Return current SPY price (cached 5 min)."""
    if not YFINANCE_AVAILABLE:
        raise HTTPException(status_code=501, detail="yfinance not available")
    import time
    now = time.time()
    # Simple in-memory cache
    if not hasattr(get_spy_price, '_cache') or now - get_spy_price._cache[1] > 300:
        from quote_fetcher import get_live_quote
        spy = get_live_quote("SPY")
        price = spy["current_price"] if spy else None
        get_spy_price._cache = (price, now)
    return {"price": get_spy_price._cache[0]}


@app.post("/api/backfill-spy")
def backfill_spy_at_announce():
    """Fetch SPY close price on each deal's announce date and save to deals.json."""
    if not YFINANCE_AVAILABLE:
        raise HTTPException(status_code=501, detail="yfinance not available")

    import yfinance as yf
    from datetime import timedelta

    deals_file = Path(__file__).parent.parent / "data" / "deals.json"
    with open(deals_file) as f:
        data = json.load(f)

    # Collect announce dates that need SPY prices
    dates_needed = set()
    for d in data["deals"]:
        if not d.get("spy_at_announce"):
            ann = d.get("announce_date")
            if ann:
                dates_needed.add(ann)

    if not dates_needed:
        return {"status": "ok", "message": "All deals already have spy_at_announce", "updated": 0}

    # Fetch SPY history covering all needed dates
    sorted_dates = sorted(dates_needed)
    start = (date.fromisoformat(sorted_dates[0]) - timedelta(days=5)).isoformat()
    end = (date.fromisoformat(sorted_dates[-1]) + timedelta(days=5)).isoformat()

    spy = yf.download("SPY", start=start, end=end, progress=False)
    if spy.empty:
        raise HTTPException(status_code=500, detail="Failed to fetch SPY data")

    # Flatten multi-level columns if present
    if hasattr(spy.columns, 'levels') and spy.columns.nlevels > 1:
        spy.columns = spy.columns.get_level_values(0)

    # Build date->close lookup (use nearest prior trading day)
    spy_closes = {}
    for d_str in sorted_dates:
        target_date = date.fromisoformat(d_str)
        # Find the closest prior or equal trading day
        mask = spy.index.date <= target_date
        if mask.any():
            closest = spy.loc[mask].iloc[-1]
            spy_closes[d_str] = float(closest["Close"])

    # Update deals
    updated = 0
    for d in data["deals"]:
        if not d.get("spy_at_announce"):
            ann = d.get("announce_date")
            if ann and ann in spy_closes:
                d["spy_at_announce"] = round(spy_closes[ann], 2)
                updated += 1

    with open(deals_file, "w") as f:
        json.dump(data, f, indent=2)

    # Clear cache
    global _deals_cache
    _deals_cache = None

    return {"status": "ok", "updated": updated, "total": len(data["deals"])}


@app.get("/api/deals/{deal_id}/dma-summary")
def get_dma_summary(deal_id: str):
    """
    Fetch, parse, and return the DMA summary DOCX for a deal as JSON.
    Reads summary_docx_url from deal_dma_summary in Deal_DB_New.
    Returns concise_sections + fulsome_sections for the DMA tab.
    """
    from config import MONGODB_URI, MONGODB_DB
    from pymongo import MongoClient
    from bson import ObjectId
    from docx_parser import parse_dma_summary_docx

    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
        db = client[MONGODB_DB]

        try:
            oid = ObjectId(deal_id)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid deal ID")

        summary_doc = db["deal_dma_summary"].find_one({"deal_id": oid})
        client.close()

        if not summary_doc:
            raise HTTPException(status_code=404, detail="No DMA summary found for this deal")

        docx_url = summary_doc.get("summary_docx_url")
        if not docx_url:
            raise HTTPException(status_code=404, detail="No summary DOCX URL for this deal")

        result = parse_dma_summary_docx(docx_url)
        result["summary_status"] = summary_doc.get("summary_status")
        result["summary_using"] = summary_doc.get("summary_using")
        return result

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error parsing DMA summary: {str(e)}")


@app.get("/api/deals/{deal_id}/mae-analysis")
def get_mae_analysis(deal_id: str):
    """
    Return MAE clause analysis for a deal from Deal_DB_New.mae_analyses.
    Merges classification + risk_assessment + compliance per clause into
    a ClauseData-compatible list for the frontend MAEReview component.
    Read-only — no writes to MongoDB.
    """
    from config import MONGODB_URI, MONGODB_DB
    from pymongo import MongoClient
    from bson import ObjectId

    try:
        oid = ObjectId(deal_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid deal ID")

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
    db = client[MONGODB_DB]
    # deal_id is stored as a plain string in mae_analyses (not ObjectId)
    doc = db["mae_analyses"].find_one({"deal_id": deal_id})
    client.close()

    if not doc:
        raise HTTPException(status_code=404, detail="No MAE analysis found for this deal")

    # Build lookup maps for risk and compliance by clause_id
    risk_map: dict = {}
    for analyzed in (doc.get("risk_assessment") or {}).get("detailed_analysis", {}).get("all_analyzed_clauses", []):
        cid = analyzed.get("clause_id") or analyzed.get("label")
        if cid:
            risk_map[cid] = analyzed.get("risk_analysis") or {}

    compliance_map: dict = {}
    for comp in (doc.get("compliance") or {}).get("detailed_results", []):
        cid = comp.get("clause_id")
        if cid:
            compliance_map[cid] = comp.get("compliance") or {}

    # Map each classification result → ClauseData
    clauses = []
    for result in (doc.get("classification") or {}).get("results", []):
        label = result.get("label", "")
        best = result.get("best_match") or {}

        clause: dict = {
            "id": label,
            "text": result.get("text", ""),
            "zone": result.get("zone", "typical"),
            "category": best.get("category", ""),
            "cluster_name": best.get("cluster_name", ""),
            "ratio": best.get("ratio", 0.0),
        }

        ra = risk_map.get(label)
        if ra:
            clause["risk_analysis"] = {
                "explanation": ra.get("explanation"),
                "risk_level": ra.get("risk_level"),
                "investigation_priority": ra.get("investigation_priority"),
                "red_flags": ra.get("red_flags") or [],
            }

        comp = compliance_map.get(label)
        if comp:
            clause["compliance"] = {
                "cybersecurity": comp.get("cybersecurity_mentioned"),
                "tariffs": comp.get("tariffs_trade_mentioned"),
                "countries": [],
                "disclosure": comp.get("disclosure_schedules_referenced"),
            }

        clauses.append(clause)

    # Summary from risk_assessment
    ra_top = (doc.get("risk_assessment") or {}).get("initial_risk_assessment") or {}
    risk_summary = (doc.get("risk_assessment") or {}).get("risk_summary") or {}

    return {
        "deal_name": doc.get("deal_name", ""),
        "clauses": clauses,
        "summary": {
            "overall_risk": ra_top.get("overall_risk") or risk_summary.get("final_risk_level"),
            "typical_count": ra_top.get("typical_count", 0),
            "atypical_count": ra_top.get("atypical_count", 0),
            "outlier_count": ra_top.get("outlier_count", 0),
            "total_clauses": len(clauses),
        },
    }


@app.get("/api/health")
def health_check():
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)