"""
Scorecard Processor
Uses Claude Sonnet to score deal power dynamics and regulatory risk.

Sources (auto-gathered from pipeline outputs):
  - Press release, DMA extract, proxy analysis, covenants,
    termination, regulatory timeline, MAE classification

Legacy input (file-based):
  backend/data/scorecards/input/{deal_id}/
    proxy_background.txt   (required)
    merger_agreement.txt   (optional)

Output: backend/data/scorecards/{deal_id}.json
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from datetime import datetime, date

_BACKEND_DIR     = Path(__file__).parent
_DATA_DIR        = _BACKEND_DIR / "data"
_DEALS_JSON      = _BACKEND_DIR.parent / "data" / "deals.json"
SCORECARDS_DIR   = _DATA_DIR / "scorecards"
SCORECARD_INPUT_DIR = SCORECARDS_DIR / "input"


# ── Deal info helper ──────────────────────────────────────────────────────────

def _get_deal_info(deal_id: str) -> dict:
    """Read target/acquirer tickers, announce date, offer price from deals.json."""
    if not _DEALS_JSON.exists():
        return {}
    try:
        data = json.loads(_DEALS_JSON.read_text())
        deals = data.get("deals", data) if isinstance(data, dict) else data
        for d in deals:
            if d.get("id") == deal_id:
                return {
                    "deal_id": deal_id,
                    "target_ticker": d.get("target_ticker", ""),
                    "acquirer_ticker": d.get("acquirer_ticker", ""),
                    "announce_date": d.get("announce_date", ""),
                    "offer_price": d.get("offer_price", 0),
                    "cash_per_share": d.get("_cash", 0),
                    "stock_ratio": d.get("_stock", 0),
                    "cvr_per_share": d.get("_cvr", 0),
                    "unaffected_price": d.get("unaffected_price", 0),
                    "target": d.get("target", ""),
                    "acquirer": d.get("acquirer", ""),
                }
    except Exception:
        pass
    return {}


# ── yfinance market data ──────────────────────────────────────────────────────

def _fetch_yfinance_market_data(deal_info: dict) -> dict:
    """Fetch live market data for scorecard signals PD-B and PD-D."""
    try:
        import yfinance as yf
    except ImportError:
        return {"error": "yfinance not installed"}

    result = {}
    target_ticker = deal_info.get("target_ticker", "")
    acquirer_ticker = deal_info.get("acquirer_ticker", "")
    announce_date = deal_info.get("announce_date", "")

    if not target_ticker:
        return {"error": "no target ticker"}

    try:
        target = yf.Ticker(target_ticker)
        info = target.info or {}

        # ── Current price ──────────────────────────────────────────────
        result["target_current_price"] = info.get("regularMarketPrice") or info.get("currentPrice")
        result["target_52w_high"] = info.get("fiftyTwoWeekHigh")
        result["target_52w_low"] = info.get("fiftyTwoWeekLow")

        # ── Context panel fields ─────────────────────────────────────
        result["target_industry"] = info.get("industry")
        result["target_sector"] = info.get("sector")
        result["target_mcap"] = info.get("marketCap")
        result["target_revenue"] = info.get("totalRevenue")
        result["target_ebitda"] = info.get("ebitda")
        result["target_shares_outstanding"] = info.get("sharesOutstanding")

        # ── D4: Institutional ownership ────────────────────────────────
        result["held_pct_institutions"] = info.get("heldPercentInstitutions")
        try:
            inst = target.institutional_holders
            if inst is not None and not inst.empty:
                result["top_institutional_holders"] = inst.head(5).to_dict("records")
        except Exception:
            pass

        # ── D5: Short interest ─────────────────────────────────────────
        result["shares_short"] = info.get("sharesShort")
        result["shares_short_prior_month"] = info.get("sharesShortPriorMonth")
        result["short_pct_float"] = info.get("shortPercentOfFloat")
        result["short_ratio"] = info.get("shortRatio")

        # ── D1: Target announce-day reaction ───────────────────────────
        if announce_date:
            try:
                from datetime import timedelta
                ann = datetime.strptime(announce_date, "%Y-%m-%d").date()
                start = ann - timedelta(days=5)
                end = ann + timedelta(days=3)
                hist = target.history(start=str(start), end=str(end))
                if not hist.empty:
                    ann_str = str(ann)
                    # Find announce day and prior day closes
                    closes = hist["Close"].to_dict()
                    dates_sorted = sorted(closes.keys())
                    for i, dt in enumerate(dates_sorted):
                        dt_str = str(dt.date()) if hasattr(dt, 'date') else str(dt)[:10]
                        if dt_str >= ann_str and i > 0:
                            prior_close = closes[dates_sorted[i - 1]]
                            ann_close = closes[dt]
                            pct_change = ((ann_close - prior_close) / prior_close) * 100
                            result["target_announce_day_close"] = round(ann_close, 2)
                            result["target_prior_day_close"] = round(prior_close, 2)
                            result["target_announce_day_pct"] = round(pct_change, 2)
                            break
            except Exception:
                pass

    except Exception as e:
        result["target_error"] = str(e)

    # ── Acquirer data (D2) ─────────────────────────────────────────────────
    if acquirer_ticker:
        try:
            acquirer = yf.Ticker(acquirer_ticker)
            acq_info = acquirer.info or {}
            result["acquirer_current_price"] = acq_info.get("regularMarketPrice") or acq_info.get("currentPrice")
            result["acquirer_mcap"] = acq_info.get("marketCap")

            if announce_date:
                try:
                    from datetime import timedelta
                    ann = datetime.strptime(announce_date, "%Y-%m-%d").date()
                    start = ann - timedelta(days=5)
                    end = ann + timedelta(days=3)
                    hist = acquirer.history(start=str(start), end=str(end))
                    if not hist.empty:
                        ann_str = str(ann)
                        closes = hist["Close"].to_dict()
                        dates_sorted = sorted(closes.keys())
                        for i, dt in enumerate(dates_sorted):
                            dt_str = str(dt.date()) if hasattr(dt, 'date') else str(dt)[:10]
                            if dt_str >= ann_str and i > 0:
                                prior_close = closes[dates_sorted[i - 1]]
                                ann_close = closes[dt]
                                pct_change = ((ann_close - prior_close) / prior_close) * 100
                                result["acquirer_announce_day_close"] = round(ann_close, 2)
                                result["acquirer_prior_day_close"] = round(prior_close, 2)
                                result["acquirer_announce_day_pct"] = round(pct_change, 2)
                                break
                except Exception:
                    pass
        except Exception as e:
            result["acquirer_error"] = str(e)

    # ── D3: Current spread ─────────────────────────────────────────────────
    offer = deal_info.get("offer_price", 0)
    cash = deal_info.get("cash_per_share", 0)
    ratio = deal_info.get("stock_ratio", 0)
    acq_price = result.get("acquirer_current_price")
    tgt_price = result.get("target_current_price")

    if ratio and acq_price:
        offer_value = cash + (ratio * acq_price) + deal_info.get("cvr_per_share", 0)
        result["computed_offer_value"] = round(offer_value, 2)
    elif offer:
        offer_value = offer
        result["computed_offer_value"] = offer

    if tgt_price and result.get("computed_offer_value"):
        spread = result["computed_offer_value"] - tgt_price
        spread_pct = (spread / tgt_price) * 100 if tgt_price else 0
        result["current_spread_dollars"] = round(spread, 2)
        result["current_spread_pct"] = round(spread_pct, 2)

    return result

# ── Rubrics ────────────────────────────────────────────────────────────────────

POWER_DYNAMICS_SIGNALS = [
    # A. Initiation & Alternatives
    {"id": "A1", "category": "A", "signal": "Who Initiated Contact",
     "scoring": "Buyer initiated = 1\nMutual/Banker-introduced = 3\nTarget initiated = 5",
     "source": "Proxy background section"},
    {"id": "A2", "category": "A", "signal": "Time from NDA to Signing",
     "scoring": "<6 weeks = 1\n6-12 weeks = 3\n>12 weeks = 5",
     "source": "NDA date vs. merger agreement signing date"},
    {"id": "A3", "category": "A", "signal": "Competitive Process",
     "scoring": "No alternatives explored = 1\nInformal market check = 3\nFormal auction / multiple bidders = 5",
     "source": "Proxy background section"},
    {"id": "A4", "category": "A", "signal": "Target's Standalone Viability",
     "scoring": "Distressed or activist pressure = 1\nModerate standalone plan = 3\nStrong standalone with growth = 5",
     "source": "Proxy background, 10-K"},
    {"id": "A5", "category": "A", "signal": "Industry Buyer Universe",
     "scoring": "Only one realistic buyer = 1\n2-3 potential buyers = 3\n4+ credible buyers = 5",
     "source": "Industry analysis, proxy background"},
    # B. Premium & Consideration Structure
    {"id": "B1", "category": "B", "signal": "Headline Premium (vs. unaffected price)",
     "scoring": "<15% = 1\n15-25% = 3\n25-40% = 4\n>40% = 5",
     "source": "Merger agreement + unaffected stock price"},
    {"id": "B2", "category": "B", "signal": "Premium vs. 52-Week High",
     "scoring": "Below 52-week high = 1\nAt 52-week high = 3\n>10% above 52-week high = 5",
     "source": "Stock price data"},
    {"id": "B3", "category": "B", "signal": "Price Movement During Negotiation",
     "scoring": "No movement (first offer accepted) = 1\n1-10% increase = 3\n>10% increase = 5",
     "source": "Proxy background — initial vs. final proposal"},
    {"id": "B4", "category": "B", "signal": "Cash as % of Total Consideration",
     "scoring": "All stock = 1\n10-30% cash = 3\n>50% cash = 5\nAll cash = 5",
     "source": "Merger agreement — consideration section"},
    {"id": "B5", "category": "B", "signal": "Collar or Walk-Away on Buyer Stock Price",
     "scoring": "No protection = 1\nCollar = 3\nTarget walk-away right if buyer stock drops = 5",
     "source": "Merger agreement — consideration adjustment provisions"},
    # C. Protective Terms
    {"id": "C2", "category": "C", "signal": "RTF Trigger Breadth",
     "scoring": "Only outright denial = 1\nDenial + burdensome conditions = 3\nDenial + conditions + End Date expiry = 5",
     "source": "Termination fee trigger provisions"},
    {"id": "C3", "category": "C", "signal": "Ticking Fee / Consideration Increase",
     "scoring": "None = 1\nSmall increase over time = 3\nMeaningful ticking fee = 5",
     "source": "Merger agreement — consideration adjustment for delay"},
    {"id": "C4", "category": "C", "signal": "Target Board Fiduciary Out Breadth",
     "scoring": "Heavily restricted = 1\nStandard fiduciary out = 3\nBroad ability to entertain alternatives = 5",
     "source": "No-solicitation and fiduciary out provisions"},
    {"id": "C5", "category": "C", "signal": "Match Right Duration (business days)",
     "scoring": ">5 days = 1\n4-5 days = 3\n<4 days or none = 5",
     "source": "No-solicitation provisions — match right mechanics"},
    {"id": "C6", "category": "C", "signal": "Specific Performance Right",
     "scoring": "No specific performance (RTF-only remedy) = 1\nLimited specific performance = 3\nFull specific performance (target can force closing) = 5",
     "source": "Remedies / specific performance provisions in merger agreement"},
    # D. Market Signal
    {"id": "D1", "category": "D", "signal": "Target Stock Reaction to Announcement",
     "scoring": "Dropped = 1\nFlat to +5% = 3\n+5-15% = 4\n>15% = 5",
     "source": "Stock price data — announcement day"},
    {"id": "D2", "category": "D", "signal": "Buyer Stock Reaction to Announcement",
     "scoring": "Dropped >3% = 5\nDropped 1-3% = 3\nFlat or up = 1",
     "source": "Stock price data — announcement day"},
    {"id": "D3", "category": "D", "signal": "Current Spread as % of Deal Value",
     "scoring": "<3% = 5\n3-8% = 4\n8-15% = 3\n15-25% = 2\n>25% = 1",
     "source": "Current stock prices + deal consideration"},
    {"id": "D4", "category": "D", "signal": "Institutional Ownership Shift",
     "scoring": "Major institutions selling = 1\nStable holdings = 3\nArb/event funds accumulating = 5",
     "source": "yfinance institutional_holders + heldPercentInstitutions"},
]

REGULATORY_RISK_SIGNALS = [
    # A. Structural Complexity
    {"id": "A1", "category": "A", "signal": "Number of Required Regulatory Approvals",
     "scoring": "1 (HSR only) = 1\n2-3 = 2\n4-5 = 3\n6-8 = 4\n>8 = 5",
     "source": "Section 3.3(c) + 4.3(c)"},
    {"id": "A2", "category": "A", "signal": "Substantive Review Agencies (vs. ministerial)",
     "scoring": "0 = 1\n1 = 2\n2 = 3\n3 = 4\n>3 = 5",
     "source": "Agency profile matching against approval list"},
    {"id": "A3", "category": "A", "signal": "Cross-Border Regulatory Exposure",
     "scoring": "US only = 1\n1 foreign jurisdiction = 2\n2-3 = 3\n4-5 = 4\n>5 = 5",
     "source": "Merger agreement — required filings list"},
    {"id": "A5", "category": "A", "signal": "Parallel vs. Sequential Dependencies",
     "scoring": "All approvals run in parallel = 1\nMostly parallel with 1-2 dependencies = 3\nSequential chain = 5",
     "source": "Dependency rules from merger agreement + agency profiles"},
    {"id": "A6", "category": "A", "signal": "HSR Filing Deadline",
     "scoring": "Filed within 10 business days = 1\n10-20 days = 3\n>20 days or no deadline specified = 5",
     "source": "Merger agreement — HSR filing obligation timeline"},
    # B. Agreement Structure Signals
    {"id": "B1", "category": "B", "signal": "Outside Date Length (months from signing)",
     "scoring": "<12 months = 1\n12-18 = 2\n18-24 = 3\n24-30 = 4\n>30 = 5",
     "source": "Termination provisions — End Date definition"},
    {"id": "B2", "category": "B", "signal": "End Date Extension Mechanics",
     "scoring": "No extensions = 1\nGeneral extension = 3\nAutomatic extension tied to specific agency = 5",
     "source": "End Date definition — extension provisions"},
    {"id": "B3", "category": "B", "signal": "RTF Existence and Size (% of TEV)",
     "scoring": "No RTF = 1\n<2% = 2\n2-4% = 3\n4-6% = 4\n>6% = 5",
     "source": "Termination fee provisions"},
    {"id": "B4", "category": "B", "signal": "Efforts Standard",
     "scoring": "Hell-or-high-water (no carveout) = 1\nRBE with narrow carveout = 2\nRBE with MBRC carveout = 3\nCRE = 4\nCRE with broad carveout = 5",
     "source": "Regulatory covenant — efforts standard + limitations"},
    {"id": "B5", "category": "B", "signal": "Burdensome Condition Walk-Away",
     "scoring": "No burdensome condition concept = 1\nDefined publicly with clear criteria = 3\nPartially or fully hidden in disclosure schedules = 5",
     "source": "Regulatory covenant — MBRC definition + disclosure schedule references"},
    {"id": "B6", "category": "B", "signal": "Divestiture Caps & Remedy Commitments",
     "scoring": "Buyer must divest unlimited / take all actions = 1\nDivestiture cap at significant threshold = 3\nNo divestiture commitment or de minimis cap = 5",
     "source": "Regulatory covenant — remedy/divestiture obligations and limitations"},
    # C. Conditionality Architecture
    {"id": "C1", "category": "C", "signal": "Condition Asymmetry (Buyer-only conditions)",
     "scoring": "Fully symmetric conditions = 1\n1 buyer-only condition = 3\n2+ buyer-only conditions = 5",
     "source": "Conditions article — mutual vs. buyer-only vs. target-only"},
    {"id": "C2", "category": "C", "signal": "Requisite vs. Total Approvals Gap",
     "scoring": "All approvals are requisite = 5\nMost are requisite = 3\nOnly 1-2 requisite out of many = 1",
     "source": "Defined terms — Requisite Regulatory Approvals vs. total list"},
    {"id": "C3", "category": "C", "signal": "Voting Trust Structure",
     "scoring": "Voting trust in place = 1\nOpen to it but not confirmed = 3\nVoting trust contractually prohibited = 5",
     "source": "Regulatory covenant — voting trust provisions"},
    {"id": "C4", "category": "C", "signal": "Pre-Committed Remedies",
     "scoring": "Detailed public remedy commitments = 1\nReferenced in disclosure schedules = 3\nNo pre-committed remedies = 5",
     "source": "Regulatory covenant — remedy commitment references"},
    {"id": "C5", "category": "C", "signal": "Anti-Frustration + Willful Breach Provisions",
     "scoring": "Strong with expectation damages = 1\nStandard anti-frustration clause = 3\nWeak or absent = 5",
     "source": "Termination and effect of termination provisions"},
    # D. External Risk Factors
    {"id": "D1", "category": "D", "signal": "Political Environment",
     "scoring": "Administration/Congress supportive = 1\nNeutral or mixed = 3\nActive political opposition = 5",
     "source": "News search, Congressional statements, executive orders"},
    {"id": "D2", "category": "D", "signal": "Known Opposition Filed",
     "scoring": "No opposition filings = 1\nMinor/expected opposition = 2\nCompetitors have filed = 4\nBroad coalition = 5",
     "source": "Agency docket search, news monitoring"},
    {"id": "D3", "category": "D", "signal": "Precedent Transaction Outcome",
     "scoring": "Recent comparable approved clean = 1\nApproved with manageable conditions = 3\nApproved with severe conditions = 4\nComparable denied = 5",
     "source": "Agency docket — prior decisions in same industry"},
    {"id": "D4", "category": "D", "signal": "Competitive Overlap Assessment",
     "scoring": "No overlap (end-to-end) = 1\nMinor overlap = 2\nModerate overlap = 3\nSignificant horizontal overlap = 5",
     "source": "10-K analysis, market share data, industry research"},
    {"id": "D5", "category": "D", "signal": "Agency Capacity / Timeline Stress",
     "scoring": "Normal agency workload = 1\nAgency handling multiple major reviews = 3\nUnprecedented + capacity constraints = 5",
     "source": "Agency docket volume, leadership changes, news"},
    {"id": "D6", "category": "D", "signal": "Litigation Control",
     "scoring": "Target has full litigation control rights = 1\nJoint control / consultation required = 3\nBuyer controls regulatory litigation strategy = 5",
     "source": "Merger agreement — regulatory litigation provisions, control of proceedings"},
    {"id": "D7", "category": "D", "signal": "Buyer's Regulatory Track Record",
     "scoring": "Buyer has clean regulatory record, all prior deals cleared = 1\nMixed record, some delays = 3\nBuyer has been blocked or faced severe conditions previously = 5",
     "source": "Historical deal outcomes, CFIUS/FTC/DOJ precedent, Claude general knowledge + Perplexity"},
]

PD_CATEGORY_LABELS = {
    "A": "Initiation & Alternatives",
    "B": "Premium & Consideration Structure",
    "C": "Protective Terms",
    "D": "Market Signal",
}

RR_CATEGORY_LABELS = {
    "A": "Structural Complexity",
    "B": "Agreement Structure Signals",
    "C": "Conditionality Architecture",
    "D": "External Risk Factors",
}

# ── Interpretation ─────────────────────────────────────────────────────────────

def _interp_power(score: int, max_score: int = 110) -> str:
    pct = score / max_score * 100 if max_score else 0
    if pct < 40: return "Heavily Buyer-Favored"
    if pct < 55: return "Buyer-Leaning"
    if pct < 65: return "Balanced"
    if pct < 80: return "Target-Leaning"
    return "Heavily Target-Favored"

def _interp_regulatory(score: int, max_score: int = 120) -> str:
    pct = score / max_score * 100 if max_score else 0
    if pct < 35: return "Low Risk"
    if pct < 50: return "Moderate Risk"
    if pct < 65: return "Elevated Risk"
    if pct < 80: return "High Risk"
    return "Extreme Risk"

# ── Pre-computed signals engine ─────────────────────────────────────────────────

def _fmt_money(val_mm: float) -> str:
    """Format dollar amount: $1,200M → $1.2B, $750M stays."""
    if abs(val_mm) >= 1000:
        return f"${val_mm / 1000:.1f}B"
    return f"${val_mm:,.0f}M"


def _fmt_pct(val: float) -> str:
    """Format percentage with sign."""
    return f"{val:+.1f}%"


def _months_between(d1: str, d2: str) -> int | None:
    """Rough month diff between two date strings."""
    try:
        a = datetime.strptime(d1[:10], "%Y-%m-%d")
        b = datetime.strptime(d2[:10], "%Y-%m-%d")
        return round((b - a).days / 30.44)
    except Exception:
        return None


def _precompute_signals(deal_info: dict, yf_data: dict, context: dict) -> dict:
    """Compute 12+ signals deterministically. Returns {signal_key: signal_dict}."""
    precomputed = {}
    offer = deal_info.get("offer_price", 0) or 0
    unaffected = deal_info.get("unaffected_price", 0) or 0
    cash = deal_info.get("cash_per_share", 0) or 0
    ratio = deal_info.get("stock_ratio", 0) or 0

    # Use computed offer value if mixed deal
    offer_val = yf_data.get("computed_offer_value") or offer

    # ── PD-B1: Headline Premium ──────────────────────────────────────
    if offer_val and unaffected and unaffected > 0:
        prem = ((offer_val - unaffected) / unaffected) * 100
        if prem < 15:
            score = 1
        elif prem < 25:
            score = 3
        elif prem < 40:
            score = 4
        else:
            score = 5
        precomputed["PD-B1"] = {
            "id": "B1", "signal": "Headline Premium (vs. unaffected price)",
            "raw_input": f"Offer ${offer_val:.2f} vs unaffected ${unaffected:.2f}",
            "short_answer": f"{prem:.1f}%",
            "score": score, "rationale": f"Premium of {prem:.1f}% vs unaffected price.",
            "estimated": False,
        }

    # ── PD-B2: Premium vs 52-Week High ──────────────────────────────
    hi52 = yf_data.get("target_52w_high")
    if offer_val and hi52 and hi52 > 0:
        prem52 = ((offer_val - hi52) / hi52) * 100
        if prem52 < 0:
            score = 1
        elif prem52 < 10:
            score = 3
        else:
            score = 5
        direction = "above" if prem52 >= 0 else "below"
        precomputed["PD-B2"] = {
            "id": "B2", "signal": "Premium vs. 52-Week High",
            "raw_input": f"Offer ${offer_val:.2f} vs 52w high ${hi52:.2f}",
            "short_answer": f"{abs(prem52):.1f}% {direction}",
            "score": score, "rationale": f"Offer is {abs(prem52):.1f}% {direction} 52-week high.",
            "estimated": False,
        }

    # ── PD-B4: Cash as % of Total ────────────────────────────────────
    if offer_val and offer_val > 0:
        if cash and not ratio:
            cash_pct = 100.0
        elif cash and ratio:
            acq_price = yf_data.get("acquirer_current_price")
            if acq_price:
                cash_pct = (cash / (cash + ratio * acq_price)) * 100
            else:
                cash_pct = (cash / offer_val) * 100
        elif ratio and not cash:
            cash_pct = 0.0
        else:
            cash_pct = 100.0  # assume all cash if no breakdown

        if cash_pct < 10:
            score = 1  # all stock
        elif cash_pct < 30:
            score = 3
        elif cash_pct <= 50:
            score = 4
        else:
            score = 5  # >50% cash or all cash
        precomputed["PD-B4"] = {
            "id": "B4", "signal": "Cash as % of Total Consideration",
            "raw_input": f"${cash} cash + {ratio}x stock ratio" if ratio else f"${cash} all cash",
            "short_answer": f"{cash_pct:.0f}% cash",
            "score": score, "rationale": f"Cash represents {cash_pct:.0f}% of total consideration.",
            "estimated": False,
        }

    # ── PD-C1: RTF as % of deal value ───────────────────────────────
    # Load DMA for RTF
    dma_path = _DATA_DIR / "dma_extract" / f"{deal_info.get('deal_id', '')}.json"
    rtf_mm = None
    tbf_mm = None
    if dma_path.exists():
        try:
            dma = json.loads(dma_path.read_text()).get("extracted", {})
            rtf_mm = dma.get("acquirer_reverse_break_fee_mm")
            tbf_mm = dma.get("target_break_fee_mm")
        except Exception:
            pass

    # Compute equity value: shares × offer or from yfinance marketCap
    shares_out = yf_data.get("target_shares_outstanding")
    equity_mm = None
    if shares_out and offer_val:
        equity_mm = (shares_out * offer_val) / 1_000_000  # in millions
    elif yf_data.get("target_mcap"):
        equity_mm = yf_data["target_mcap"] / 1_000_000

    # ── PD-D1: Target Reaction to Announcement ──────────────────────
    ann_pct = yf_data.get("target_announce_day_pct")
    if ann_pct is not None:
        if ann_pct < 0:
            score = 1
        elif ann_pct < 5:
            score = 3
        elif ann_pct < 15:
            score = 4
        else:
            score = 5
        precomputed["PD-D1"] = {
            "id": "D1", "signal": "Target Stock Reaction to Announcement",
            "raw_input": f"Target moved {ann_pct:+.1f}% on announce day (prior close ${yf_data.get('target_prior_day_close')} → ${yf_data.get('target_announce_day_close')})",
            "short_answer": f"{ann_pct:+.1f}%",
            "score": score, "rationale": f"Target stock {'jumped' if ann_pct > 5 else 'moved'} {ann_pct:+.1f}% on announcement day.",
            "estimated": False,
        }

    # ── PD-D2: Buyer Reaction to Announcement ───────────────────────
    acq_pct = yf_data.get("acquirer_announce_day_pct")
    if acq_pct is not None:
        if acq_pct < -3:
            score = 5
        elif acq_pct < -1:
            score = 3
        else:
            score = 1
        precomputed["PD-D2"] = {
            "id": "D2", "signal": "Buyer Stock Reaction to Announcement",
            "raw_input": f"Buyer moved {acq_pct:+.1f}% on announce day",
            "short_answer": f"{acq_pct:+.1f}%",
            "score": score, "rationale": f"Buyer stock {'dropped' if acq_pct < 0 else 'rose'} {abs(acq_pct):.1f}% on announcement day.",
            "estimated": False,
        }

    # ── PD-D3: Current Spread ────────────────────────────────────────
    spread_pct = yf_data.get("current_spread_pct")
    spread_dollars = yf_data.get("current_spread_dollars")
    if spread_pct is not None:
        if spread_pct < 3:
            score = 5
        elif spread_pct < 8:
            score = 4
        elif spread_pct < 15:
            score = 3
        elif spread_pct < 25:
            score = 2
        else:
            score = 1
        precomputed["PD-D3"] = {
            "id": "D3", "signal": "Current Spread as % of Deal Value",
            "raw_input": f"Spread: {spread_pct:.2f}% (${spread_dollars:.2f})",
            "short_answer": f"{spread_pct:.1f}%",
            "score": score, "rationale": f"Current merger spread is {spread_pct:.1f}%.",
            "estimated": False,
        }

    # ── PD-D4: Institutional Ownership ───────────────────────────────
    inst_pct = yf_data.get("held_pct_institutions")
    if inst_pct is not None:
        inst_display = inst_pct * 100
        # Heuristic: high institutional = more arb activity = positive signal
        if inst_display > 80:
            score = 5
        elif inst_display > 60:
            score = 4
        elif inst_display > 40:
            score = 3
        else:
            score = 1
        precomputed["PD-D4"] = {
            "id": "D4", "signal": "Institutional Ownership Shift",
            "raw_input": f"{inst_display:.1f}% held by institutions",
            "short_answer": f"{inst_display:.1f}% institutional",
            "score": score, "rationale": f"Institutional ownership at {inst_display:.1f}%.",
            "estimated": False,
        }

    # ── RR-A1: Number of Required Approvals ──────────────────────────
    reg_path = _DATA_DIR / "timelines" / f"{deal_info.get('deal_id', '')}_regulatory.json"
    approvals = []
    if reg_path.exists():
        try:
            reg = json.loads(reg_path.read_text())
            approvals = reg.get("approvals", [])
        except Exception:
            pass

    if approvals:
        n = len(approvals)
        if n <= 1:
            score = 1
        elif n <= 3:
            score = 2
        elif n <= 5:
            score = 3
        elif n <= 8:
            score = 4
        else:
            score = 5
        precomputed["RR-A1"] = {
            "id": "A1", "signal": "Number of Required Regulatory Approvals",
            "raw_input": f"{n} regulatory approvals required",
            "short_answer": str(n),
            "score": score, "rationale": f"{n} regulatory approvals required.",
            "estimated": False,
        }

    # ── RR-A3: Cross-Border Exposure ─────────────────────────────────
    if approvals:
        jurisdictions = set(a.get("jurisdiction", "") for a in approvals)
        non_us = [j for j in jurisdictions if j and j != "United States"]
        n_foreign = len(non_us)
        if n_foreign == 0:
            score = 1
        elif n_foreign == 1:
            score = 2
        elif n_foreign <= 3:
            score = 3
        elif n_foreign <= 5:
            score = 4
        else:
            score = 5
        precomputed["RR-A3"] = {
            "id": "A3", "signal": "Cross-Border Regulatory Exposure",
            "raw_input": f"{n_foreign} foreign jurisdictions: {', '.join(sorted(non_us)) if non_us else 'US only'}",
            "short_answer": f"{n_foreign} foreign jurisdictions" if n_foreign else "US only",
            "score": score, "rationale": f"{n_foreign} non-US regulatory jurisdictions.",
            "estimated": False,
        }

    # ── RR-A2: Substantive Review Agencies ────────────────────────────
    if approvals:
        ministerial_kw = {"sec", "nyse", "nasdaq", "registrar", "stock exchange", "listing"}
        substantive = []
        for a in approvals:
            combined = " ".join([
                (a.get("authority_short") or ""),
                (a.get("statute") or ""),
                (a.get("notes") or ""),
            ]).lower()
            if not any(kw in combined for kw in ministerial_kw):
                substantive.append(a.get("authority_short", a.get("authority_full", "")))
        n_sub = len(substantive)
        if n_sub == 0:
            score = 1
        elif n_sub == 1:
            score = 2
        elif n_sub == 2:
            score = 3
        elif n_sub == 3:
            score = 4
        else:
            score = 5
        sub_list = ", ".join(substantive)
        precomputed["RR-A2"] = {
            "id": "A2", "signal": "Substantive Review Agencies (vs. ministerial)",
            "raw_input": f"{n_sub} substantive agencies out of {len(approvals)} total: {sub_list}",
            "short_answer": sub_list if substantive else "None identified",
            "score": score,
            "rationale": f"{n_sub} agencies with substantive review authority.",
            "estimated": False,
        }

    # ── RR-B1: Outside Date Length ───────────────────────────────────
    announce_date = deal_info.get("announce_date", "")
    outside_date = None
    if dma_path.exists():
        try:
            dma_ext = json.loads(dma_path.read_text()).get("extracted", {})
            outside_date = dma_ext.get("outside_date")
        except Exception:
            pass
    if not outside_date:
        outside_date = deal_info.get("outside_date", "")

    if announce_date and outside_date:
        months = _months_between(announce_date, outside_date)
        if months is not None:
            if months < 12:
                score = 1
            elif months < 18:
                score = 2
            elif months < 24:
                score = 3
            elif months < 30:
                score = 4
            else:
                score = 5
            precomputed["RR-B1"] = {
                "id": "B1", "signal": "Outside Date Length (months from signing)",
                "raw_input": f"Announce {announce_date} → outside date {outside_date} = ~{months} months",
                "short_answer": f"{months} months",
                "score": score, "rationale": f"Outside date is approximately {months} months from announcement.",
                "estimated": False,
            }

    # ── RR-B3: RTF Existence and Size (same as PD-C1) ───────────────
    if rtf_mm and equity_mm and equity_mm > 0:
        rtf_pct = (rtf_mm / equity_mm) * 100
        if rtf_pct < 2:
            score = 2
        elif rtf_pct < 4:
            score = 3
        elif rtf_pct < 6:
            score = 4
        else:
            score = 5
        precomputed["RR-B3"] = {
            "id": "B3", "signal": "RTF Existence and Size (% of TEV)",
            "raw_input": f"RTF ${rtf_mm}M = {rtf_pct:.1f}% of equity value (~${equity_mm:,.0f}M)",
            "short_answer": f"{_fmt_money(rtf_mm)} ({rtf_pct:.1f}%)",
            "score": score, "rationale": f"Reverse termination fee is {rtf_pct:.1f}% of equity value.",
            "estimated": False,
        }

    # ── RR-A6: HSR Filing Deadline ─────────────────────────────────
    hsr_deadline = dma_ext.get("regulatory_filing_deadlines", "") if dma_ext else ""
    if hsr_deadline:
        m = re.search(r'(\d+)\s*business\s*days?', hsr_deadline, re.IGNORECASE)
        if m:
            days = int(m.group(1))
            if days <= 10:
                score = 1
            elif days <= 20:
                score = 3
            else:
                score = 5
            precomputed["RR-A6"] = {
                "id": "A6", "signal": "HSR Filing Deadline",
                "raw_input": hsr_deadline,
                "short_answer": f"{days} business days",
                "score": score,
                "rationale": f"HSR filing required within {days} business days of agreement execution.",
                "estimated": False,
            }

    return precomputed


# ── Context panels builder ──────────────────────────────────────────────────

def _build_context_panels(deal_info: dict, yf_data: dict, context: dict) -> dict:
    """Build Deal Overview and Deal Protection context panels from pre-existing data."""

    def _fmt_mcap(val):
        if not val: return None
        neg = val < 0
        av = abs(val)
        if av >= 1_000_000_000:
            s = f"${av / 1_000_000_000:.1f}B"
        elif av >= 1_000_000:
            s = f"${av / 1_000_000:.1f}M"
        else:
            s = f"${av:,.0f}"
        return f"-{s}" if neg else s

    # ── Load DMA + press release for deal-level fields ─────────────
    deal_id = deal_info.get("deal_id", "")
    dma_path = _DATA_DIR / "dma_extract" / f"{deal_id}.json"
    dma_ext = {}
    dma_source_text = ""
    if dma_path.exists():
        try:
            _dma_raw = json.loads(dma_path.read_text())
            dma_ext = _dma_raw.get("extracted", {})
            dma_source_text = _dma_raw.get("source_text", "")
        except Exception:
            pass

    pr_path = _DATA_DIR / "press_release" / f"{deal_id}.json"
    pr_ext = {}
    if pr_path.exists():
        try:
            pr_ext = json.loads(pr_path.read_text()).get("extracted", {})
        except Exception:
            pass

    # Deal type label
    deal_type_raw = dma_ext.get("deal_type") or pr_ext.get("deal_type")
    deal_type_map = {"cash": "All Cash", "stock": "All Stock", "cash+stock": "Cash + Stock"}
    deal_type = deal_type_map.get(deal_type_raw, deal_type_raw)

    # Financing summary
    financing = pr_ext.get("financing") or dma_ext.get("financing_condition")

    # ── Deal Structure (merger type from DMA source text) ───────────
    deal_structure = None
    if dma_source_text:
        lt = dma_source_text.lower()
        if "reverse triangular merger" in lt:
            deal_structure = "Reverse Triangular Merger"
        elif "forward triangular merger" in lt:
            deal_structure = "Forward Triangular Merger"
        elif "forward merger" in lt:
            deal_structure = "Forward Merger"
        elif "tender offer" in lt and "short-form merger" in lt:
            deal_structure = "Tender Offer + Short-Form Merger"
        elif "commence a tender offer" in lt or "the tender offer" in lt:
            deal_structure = "Tender Offer"
        elif "asset purchase" in lt or "asset acquisition" in lt:
            deal_structure = "Asset Purchase"

    # ── Governing Law (legal + financial jurisdictions from DMA source text)
    legal_jurisdiction = None
    financial_jurisdiction = None
    if dma_source_text:
        gov_idx = dma_source_text.find("Governing Law")
        if gov_idx >= 0:
            after = dma_source_text[gov_idx:gov_idx + 600]
            matches = re.findall(r'laws of (?:the State of )?([A-Za-z\s]+?)(?:\.|,|\n)', after, re.IGNORECASE)
            if matches:
                # First match = agreement governing law (legal)
                legal_jurisdiction = matches[0].strip()
                # Look for financing-specific jurisdiction
                if "financing" in after.lower() or "Financing Source" in after:
                    for i, m in enumerate(matches):
                        # Check if this match is near "financing" text
                        m_start = after.lower().find(m.strip().lower())
                        fin_near = after.lower().rfind("financing", 0, m_start) if m_start > 0 else -1
                        if fin_near >= 0 and i > 0:
                            financial_jurisdiction = m.strip()
                            break
                if not financial_jurisdiction and len(matches) > 1:
                    second = matches[1].strip()
                    if second != legal_jurisdiction:
                        financial_jurisdiction = second

    # ── Tender Offer / Going-Private Detection ─────────────────────
    tender_label = None
    tl_path = _DATA_DIR / "timelines" / f"{deal_id}.json"
    if tl_path.exists():
        try:
            tl = json.loads(tl_path.read_text())
            if tl.get("schedule_13e3_required"):
                tender_label = "GOING PRIVATE (Sch 13E-3)"
            elif tl.get("is_going_private"):
                tender_label = "GOING PRIVATE"
        except Exception:
            pass
    if not tender_label and deal_structure and "Tender Offer" in deal_structure:
        tender_label = "TENDER OFFER"

    # ── Deal Overview ────────────────────────────────────────────────
    overview = {
        "Deal Type": deal_type,
        "Deal Structure": deal_structure,
        "Tender Offer": tender_label,
        "Legal Jurisdiction": legal_jurisdiction,
        "Financial Jurisdiction": financial_jurisdiction,
        "Industry": yf_data.get("target_industry"),
        "Sector": yf_data.get("target_sector"),
        "Target MCap": _fmt_mcap(yf_data.get("target_mcap")),
        "Acquirer MCap": _fmt_mcap(yf_data.get("acquirer_mcap")),
        "Target Revenue": _fmt_mcap(yf_data.get("target_revenue")),
        "Target EBITDA": _fmt_mcap(yf_data.get("target_ebitda")),
        "Expected Close": pr_ext.get("expected_close") or dma_ext.get("expected_close"),
        "Voting Threshold": dma_ext.get("voting_threshold"),
        "Financing": financing,
    }
    # Competitors and Overlap will be filled by LLM Call 1
    overview["Closest Competitors"] = None
    overview["Combined Overlap"] = None

    # ── Deal Protection ──────────────────────────────────────────────
    # dma_ext already loaded above

    # Covenant provisions for go-shop/no-shop details
    cov_dir = _DATA_DIR / "covenants" / "input" / deal_info.get("deal_id", "")
    cov_prov = _latest_json(Path(cov_dir), "specific_provisions_*.json") if Path(cov_dir).exists() else None
    ns_info = {}
    if cov_prov:
        ns_info = cov_prov.get("provisions_checked", {}).get("no_shop___go_shop", {})

    go_shop_days = dma_ext.get("go_shop_days")
    if go_shop_days and go_shop_days > 0:
        structure = "Go-Shop"
    else:
        structure = "No-Shop"

    # Compute fee % TEV
    rtf_mm = dma_ext.get("acquirer_reverse_break_fee_mm")
    tbf_mm = dma_ext.get("target_break_fee_mm")
    shares_out = yf_data.get("target_shares_outstanding")
    offer_val = yf_data.get("computed_offer_value") or deal_info.get("offer_price", 0) or 0
    equity_mm = None
    if shares_out and offer_val:
        equity_mm = (shares_out * offer_val) / 1_000_000

    tbf_str = None
    if tbf_mm:
        tbf_str = _fmt_money(tbf_mm)
        if equity_mm and equity_mm > 0:
            tbf_str += f" ({tbf_mm / equity_mm * 100:.1f}%)"

    rtf_str = None
    if rtf_mm:
        rtf_str = _fmt_money(rtf_mm)
        if equity_mm and equity_mm > 0:
            rtf_str += f" ({rtf_mm / equity_mm * 100:.1f}%)"

    # Extension info
    ext_str = None
    ext = dma_ext.get("outside_date_extension")
    if ext:
        cond = dma_ext.get("outside_date_extension_condition", "")
        # Try to compute extension length
        od = dma_ext.get("outside_date", "")
        if od and ext:
            ext_months = _months_between(od, ext)
            if ext_months:
                ext_str = f"+{ext_months}mo"
                if cond:
                    ext_str += f" ({cond})"
            elif cond:
                ext_str = f"Yes ({cond})"
            else:
                ext_str = f"Until {ext}"
        elif cond:
            ext_str = f"Yes ({cond})"

    # Compute days from announcement to outside date (and to extended date)
    announce_date = deal_info.get("announce_date", "")
    outside_date = dma_ext.get("outside_date", "")
    days_to_outside = None
    days_to_extended = None
    if announce_date and outside_date:
        try:
            ann_dt = datetime.strptime(announce_date[:10], "%Y-%m-%d")
            od_dt = datetime.strptime(outside_date[:10], "%Y-%m-%d")
            days_to_outside = (od_dt - ann_dt).days
            ext_date = dma_ext.get("outside_date_extension", "")
            if ext_date:
                try:
                    ext_dt = datetime.strptime(ext_date[:10], "%Y-%m-%d")
                    days_to_extended = (ext_dt - ann_dt).days
                except Exception:
                    pass
        except Exception:
            pass

    outside_str = outside_date
    if days_to_outside is not None:
        mo = round(days_to_outside / 30.44)
        outside_str = f"{outside_date} ({days_to_outside}d / ~{mo}mo)"

    ext_display = ext_str
    if ext_display and days_to_extended is not None:
        ext_mo = round(days_to_extended / 30.44)
        ext_display = f"{ext_str} — {days_to_extended}d / ~{ext_mo}mo total"

    protection = {
        "Structure": structure,
        "Go-Shop Duration": f"{go_shop_days} days" if go_shop_days and go_shop_days > 0 else None,
        "Fiduciary Out": ns_info.get("fiduciary_out_scope") or ("Standard" if ns_info.get("fiduciary_out_present") else None),
        "Match Right": ns_info.get("matching_timeframe") or ("Present" if ns_info.get("matching_rights") else None),
        "Target Break Fee": tbf_str,
        "Reverse Break Fee": rtf_str,
        "Outside Date": outside_str if outside_date else None,
        "Extension": ext_display,
    }

    return {
        "deal_overview": {k: v for k, v in overview.items() if v is not None},
        "deal_protection": {k: v for k, v in protection.items() if v is not None},
    }


# ── Auto-gather from pipelines ─────────────────────────────────────────────────

def _latest_json(directory: Path, pattern: str, exclude_substr: str | None = None) -> dict | None:
    """Load the most recent JSON file matching a glob pattern."""
    if not directory.exists():
        return None
    files = sorted(directory.glob(pattern), key=lambda f: f.stat().st_mtime, reverse=True)
    if exclude_substr:
        files = [f for f in files if exclude_substr not in f.name]
    if not files:
        return None
    try:
        return json.loads(files[0].read_text(encoding="utf-8"))
    except Exception:
        return None


def _latest_text(directory: Path, pattern: str) -> str | None:
    """Load the most recent text file matching a glob pattern."""
    if not directory.exists():
        return None
    files = sorted(directory.glob(pattern), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        return None
    try:
        return files[0].read_text(encoding="utf-8")
    except Exception:
        return None


def check_scorecard_sources(deal_id: str) -> dict:
    """Check which pipeline outputs are available for scorecard generation.
    Returns list of sources with availability and summary stats."""
    sources = []

    # 1. Press release
    pr_path = _DATA_DIR / "press_release" / f"{deal_id}.json"
    pr_stat = None
    if pr_path.exists():
        try:
            pr = json.loads(pr_path.read_text())
            ext = pr.get("extracted", {})
            prem = ext.get("premium_pct")
            pr_stat = f"Premium: {prem}%" if prem else "Available"
        except Exception:
            pr_stat = "Available"
    sources.append({"name": "press_release", "label": "Press Release",
                     "available": pr_path.exists(), "stat": pr_stat})

    # 2. DMA extract
    dma_path = _DATA_DIR / "dma_extract" / f"{deal_id}.json"
    dma_stat = None
    if dma_path.exists():
        try:
            dma = json.loads(dma_path.read_text())
            ext = dma.get("extracted", {})
            conds = ext.get("conditions_to_closing", [])
            dma_stat = f"{len(conds)} conditions" if conds else "Available"
        except Exception:
            dma_stat = "Available"
    sources.append({"name": "dma_extract", "label": "DMA Extract",
                     "available": dma_path.exists(), "stat": dma_stat})

    # 3. Proxy analysis — prefer fulsome/concise over short summary
    proxy_dir = _DATA_DIR / "proxy_analysis" / deal_id
    proxy_text_check = (
        _latest_text(proxy_dir, "*_concise_*.txt")
        or _latest_text(proxy_dir, "*_fulsome_*.txt")
        or _latest_text(proxy_dir, "*Fulsome*.txt")
        or _latest_text(proxy_dir, "*_summary_*.txt")
    )
    proxy_avail = proxy_text_check is not None
    proxy_stat = f"{len(proxy_text_check):,} chars" if proxy_text_check else None
    sources.append({"name": "proxy", "label": "Proxy Analysis",
                     "available": proxy_avail, "stat": proxy_stat})

    # 4. Covenants
    cov_dir = _DATA_DIR / "covenants" / "input" / deal_id
    cov_avail = cov_dir.exists() and any(cov_dir.glob("deal_assessment_*.json"))
    cov_stat = None
    if cov_avail:
        cov = _latest_json(cov_dir, "deal_assessment_*.json")
        if cov:
            avg = cov.get("summary", {}).get("avg_restrictiveness")
            if avg is not None:
                cov_stat = f"{avg:.1f} avg risk"
    sources.append({"name": "covenants", "label": "Covenants",
                     "available": cov_avail, "stat": cov_stat})

    # 5. Termination
    term_dir = _DATA_DIR / "termination" / "input" / deal_id
    term_avail = term_dir.exists() and any(term_dir.glob("termination_assessment_*.json"))
    term_stat = None
    if term_avail:
        ta = _latest_json(term_dir, "termination_assessment_*.json")
        if ta:
            avg = ta.get("summary", {}).get("avg_deal_risk_score")
            if avg is not None:
                term_stat = f"{avg:.1f} avg risk"
    sources.append({"name": "termination", "label": "Termination",
                     "available": term_avail, "stat": term_stat})

    # 6. Regulatory timeline
    reg_path = _DATA_DIR / "timelines" / f"{deal_id}_regulatory.json"
    reg_stat = None
    if reg_path.exists():
        try:
            reg = json.loads(reg_path.read_text())
            approvals = reg.get("approvals", [])
            reg_stat = f"{len(approvals)} approvals"
        except Exception:
            reg_stat = "Available"
    sources.append({"name": "regulatory", "label": "Regulatory",
                     "available": reg_path.exists(), "stat": reg_stat})

    # 7. MAE
    mae_dir = _DATA_DIR / "mae" / "pipeline" / deal_id / "classification_output"
    mae_avail = mae_dir.exists() and any(mae_dir.glob("*.json"))
    sources.append({"name": "mae", "label": "MAE Analysis",
                     "available": mae_avail, "stat": "Available" if mae_avail else None})

    # 8. yfinance (always available if we have a ticker)
    deal_info = _get_deal_info(deal_id)
    yf_avail = bool(deal_info.get("target_ticker"))
    yf_stat = deal_info.get("target_ticker") if yf_avail else None
    sources.append({"name": "yfinance", "label": "Market Data",
                     "available": yf_avail, "stat": yf_stat})

    available_count = sum(1 for s in sources if s["available"])
    return {
        "sources": sources,
        "ready": available_count >= 2,
    }


def gather_scorecard_context(deal_id: str) -> dict:
    """Gather context from all available pipeline outputs for a deal."""
    sources_found: list[str] = []
    sections: list[str] = []
    stats: dict = {}

    # ── 0. Deal info from deals.json ───────────────────────────────────────
    deal_info = _get_deal_info(deal_id)

    # ── 1. Press Release ──────────────────────────────────────────────────────
    pr_path = _DATA_DIR / "press_release" / f"{deal_id}.json"
    if pr_path.exists():
        try:
            pr = json.loads(pr_path.read_text())
            ext = pr.get("extracted", {})
            sources_found.append("press_release")
            lines = ["=== DEAL ANNOUNCEMENT DATA ==="]
            for k in ["target", "acquirer", "deal_type", "offer_price_cash",
                       "stock_exchange_ratio", "deal_value_bn", "premium_pct",
                       "announce_date", "expected_close", "financing",
                       "shareholder_approval_required"]:
                v = ext.get(k)
                if v is not None:
                    lines.append(f"{k}: {v}")
            reg_bodies = ext.get("regulatory_bodies", [])
            if reg_bodies:
                lines.append(f"Regulatory bodies: {', '.join(reg_bodies)}")
            special = ext.get("special_conditions")
            if special:
                lines.append(f"Special conditions: {special}")
            raw = ext.get("raw_summary", "")
            if raw:
                lines.append(f"\nPress release summary:\n{raw[:3000]}")
            sections.append("\n".join(lines))
            if ext.get("premium_pct"):
                stats["premium_pct"] = ext["premium_pct"]
        except Exception:
            pass

    # ── 2. DMA Extract ────────────────────────────────────────────────────────
    dma_path = _DATA_DIR / "dma_extract" / f"{deal_id}.json"
    if dma_path.exists():
        try:
            dma = json.loads(dma_path.read_text())
            ext = dma.get("extracted", {})
            sources_found.append("dma_extract")
            lines = ["=== MERGER AGREEMENT TERMS ==="]
            # Fees
            tbf = ext.get("target_break_fee_mm")
            rbf = ext.get("acquirer_reverse_break_fee_mm")
            if tbf is not None:
                lines.append(f"Target break fee: ${tbf}M")
            if rbf is not None:
                lines.append(f"Acquirer reverse break fee: ${rbf}M")
            # Go-shop
            gs = ext.get("go_shop_days")
            if gs is not None:
                lines.append(f"Go-shop period: {gs} days")
                stats["go_shop_days"] = gs
            # Outside dates
            od = ext.get("outside_date")
            if od:
                lines.append(f"Outside date: {od}")
            ode = ext.get("outside_date_extension")
            if ode:
                lines.append(f"Outside date extension: {ode}")
                cond = ext.get("outside_date_extension_condition", "")
                if cond:
                    lines.append(f"Extension condition: {cond}")
            # Voting
            vt = ext.get("voting_threshold")
            if vt:
                lines.append(f"Voting threshold: {vt}")
            # Regulatory approvals
            ra = ext.get("regulatory_approvals_required", [])
            if ra:
                lines.append(f"Regulatory approvals required: {', '.join(ra)}")
            # Conditions
            ctc = ext.get("conditions_to_closing", [])
            if ctc:
                lines.append("Conditions to closing:")
                for c in ctc:
                    lines.append(f"  - {c}")
            # Termination triggers
            tt = ext.get("specific_termination_triggers", [])
            if tt:
                lines.append("Specific termination triggers:")
                for t in tt:
                    lines.append(f"  - {t}")
            # Interim covenants
            ic = ext.get("interim_operating_covenants")
            if ic:
                lines.append(f"Interim operating covenants: {ic}")
            # Financing
            fc = ext.get("financing_condition")
            if fc:
                lines.append(f"Financing condition: {fc}")
            # Include DMA source text for NDA dates, collar provisions,
            # match rights, specific performance, efforts standard, etc.
            src = dma.get("source_text", "")
            if src:
                lines.append(f"\nDMA summary source text:\n{src}")
            sections.append("\n".join(lines))
        except Exception:
            pass

    # ── 3. Proxy Analysis ─────────────────────────────────────────────────────
    # Prefer fulsome/concise proxy over short summary
    proxy_dir = _DATA_DIR / "proxy_analysis" / deal_id
    proxy_text = (
        _latest_text(proxy_dir, "*_concise_*.txt")
        or _latest_text(proxy_dir, "*_fulsome_*.txt")
        or _latest_text(proxy_dir, "*Fulsome*.txt")
        or _latest_text(proxy_dir, "*_summary_*.txt")
    )
    if proxy_text:
        sources_found.append("proxy")
        sections.append(f"=== PROXY / BACKGROUND OF THE MERGER ===\n{proxy_text}")
        stats["proxy_chars"] = len(proxy_text)

    # ── 4. Covenant Assessment ────────────────────────────────────────────────
    cov_dir = _DATA_DIR / "covenants" / "input" / deal_id
    cov_data = _latest_json(cov_dir, "deal_assessment_*.json")
    cov_prov = _latest_json(cov_dir, "specific_provisions_*.json")
    cov_bench = _latest_json(cov_dir, "benchmark_comparison_*.json")
    if cov_data or cov_prov:
        sources_found.append("covenants")
        lines = ["=== COVENANT ANALYSIS ==="]
        if cov_data:
            s = cov_data.get("summary", {})
            avg = s.get("avg_restrictiveness")
            if avg is not None:
                lines.append(f"Average restrictiveness: {avg:.1f}/10")
                stats["covenant_avg_restrictiveness"] = round(avg, 1)
            rd = s.get("restrictiveness_distribution", {})
            if rd:
                lines.append(f"Distribution: {json.dumps(rd)}")
            sf = s.get("seller_favorable_count", 0)
            rf = s.get("clauses_with_red_flags", 0)
            lines.append(f"Seller-favorable clauses: {sf}")
            lines.append(f"Red flags: {rf}")
        if cov_prov:
            pc = cov_prov.get("provisions_checked", {})
            # No-shop / go-shop
            ns = pc.get("no_shop___go_shop", {})
            if ns.get("present"):
                lines.append(f"No-shop present: yes")
                if ns.get("fiduciary_out_present"):
                    lines.append(f"Fiduciary out: {ns.get('fiduciary_out_scope', 'present')}")
                if ns.get("matching_rights"):
                    lines.append(f"Match right timeframe: {ns.get('matching_timeframe', 'present')}")
                if ns.get("go_shop_period"):
                    lines.append(f"Go-shop duration: {ns.get('go_shop_duration', 'present')}")
            # Asymmetry
            asym = pc.get("asymmetry___carveouts", {})
            if asym.get("present"):
                lines.append(f"Asymmetry risk level: {asym.get('risk_level', 'unknown')}")
                specific = asym.get("specific_asymmetries", [])
                if specific:
                    for a in specific[:3]:
                        lines.append(f"  - {a}")
            # Risk summary
            rs = cov_prov.get("risk_summary", {})
            if rs:
                lines.append(f"Overall covenant risk: {rs.get('overall_risk_level', 'unknown')}")
                tc = rs.get("top_concerns", [])
                if tc:
                    lines.append("Top concerns:")
                    for c in tc[:5]:
                        lines.append(f"  - {c}")
        if cov_bench:
            rc = cov_bench.get("restrictiveness_comparison", {})
            if rc:
                lines.append(f"Benchmark percentile: {rc.get('percentile_rank', 'unknown')}")
                lines.append(f"vs. benchmark: {rc.get('category', 'unknown')}")
            es = cov_bench.get("executive_summary", {})
            if es:
                kf = es.get("key_findings", [])
                if kf:
                    lines.append("Key covenant findings:")
                    for f in kf[:4]:
                        lines.append(f"  - {f}")
        sections.append("\n".join(lines))

    # ── 5. Termination Assessment ─────────────────────────────────────────────
    term_dir = _DATA_DIR / "termination" / "input" / deal_id
    term_data = _latest_json(term_dir, "termination_assessment_*.json")
    if term_data:
        sources_found.append("termination")
        s = term_data.get("summary", {})
        lines = ["=== TERMINATION ANALYSIS ==="]
        avg = s.get("avg_deal_risk_score")
        if avg is not None:
            lines.append(f"Average deal risk score: {avg:.1f}/10")
            stats["termination_avg_risk"] = round(avg, 1)
        lines.append(f"Total termination clauses: {s.get('total_clauses', 0)}")
        td = s.get("trigger_characteristic_distribution", {})
        if td:
            lines.append("Trigger types:")
            for k, v in td.items():
                if v:
                    lines.append(f"  {k}: {v}")
        pf = s.get("party_favorable_distribution", {})
        if pf:
            lines.append(f"Party favorability: {json.dumps(pf)}")
        # Fee implications from top clauses
        clauses = term_data.get("assessed_clauses", [])
        fee_clauses = [c for c in clauses if c.get("fee_implications")]
        if fee_clauses:
            lines.append("Fee-bearing clauses:")
            for c in fee_clauses[:5]:
                lines.append(f"  - [{c.get('trigger_type', '?')}] {c['fee_implications'][:200]}")
        sections.append("\n".join(lines))

    # ── 6. Regulatory Timeline ────────────────────────────────────────────────
    reg_path = _DATA_DIR / "timelines" / f"{deal_id}_regulatory.json"
    if reg_path.exists():
        try:
            reg = json.loads(reg_path.read_text())
            approvals = reg.get("approvals", [])
            if approvals:
                sources_found.append("regulatory")
                stats["regulatory_approval_count"] = len(approvals)
                lines = ["=== REGULATORY APPROVALS ==="]
                lines.append(f"Total required approvals: {len(approvals)}")
                jurisdictions = set()
                categories = {}
                for a in approvals:
                    jurisdictions.add(a.get("jurisdiction", "Unknown"))
                    cat = a.get("category", "other")
                    categories[cat] = categories.get(cat, 0) + 1
                    status = a.get("status", "pending")
                    filed = a.get("filed_date", "not filed")
                    cleared = a.get("cleared_date", "pending")
                    lines.append(f"  {a.get('authority_short', a.get('id', '?'))}: "
                                 f"[{a.get('jurisdiction', '?')}] status={status}, "
                                 f"filed={filed}, cleared={cleared}, "
                                 f"category={cat}")
                lines.append(f"Jurisdictions: {', '.join(sorted(jurisdictions))}")
                lines.append(f"Categories: {json.dumps(categories)}")
                non_us = [j for j in jurisdictions if j != "United States"]
                stats["cross_border_count"] = len(non_us)
                sections.append("\n".join(lines))
        except Exception:
            pass

    # ── 7. MAE Classification ─────────────────────────────────────────────────
    mae_dir = _DATA_DIR / "mae" / "pipeline" / deal_id / "classification_output"
    mae_data = _latest_json(mae_dir, "*.json") if mae_dir.exists() else None
    if mae_data:
        sources_found.append("mae")
        lines = ["=== MAE ANALYSIS ==="]
        results = mae_data.get("results", [])
        if results:
            zones = {}
            categories = {}
            for r in results:
                bm = r.get("best_match", {})
                z = bm.get("zone", "unknown")
                zones[z] = zones.get(z, 0) + 1
                cat = bm.get("category", "unknown")
                categories[cat] = categories.get(cat, 0) + 1
            lines.append(f"MAE carveouts analyzed: {len(results)}")
            lines.append(f"Zone distribution: {json.dumps(zones)}")
            lines.append(f"Category distribution: {json.dumps(categories)}")
        sections.append("\n".join(lines))

    # ── 8. yfinance Market Data (PD-B, PD-D signals) ─────────────────────────
    if deal_info:
        mkt = _fetch_yfinance_market_data(deal_info)
        if mkt and "error" not in mkt:
            sources_found.append("yfinance")
            lines = ["=== MARKET DATA (LIVE) ==="]

            # B1: Premium data
            tgt_price = mkt.get("target_current_price")
            if tgt_price:
                lines.append(f"Target current price: ${tgt_price}")
            hi52 = mkt.get("target_52w_high")
            lo52 = mkt.get("target_52w_low")
            if hi52:
                lines.append(f"Target 52-week high: ${hi52}")
            if lo52:
                lines.append(f"Target 52-week low: ${lo52}")

            # B2: Premium vs 52-week high
            offer_val = mkt.get("computed_offer_value")
            if offer_val and hi52:
                prem_vs_52w = ((offer_val - hi52) / hi52) * 100
                lines.append(f"Offer value vs 52-week high: {prem_vs_52w:+.1f}%")

            # B4: Cash % of total
            cash = deal_info.get("cash_per_share", 0)
            ratio = deal_info.get("stock_ratio", 0)
            acq_price = mkt.get("acquirer_current_price")
            if offer_val and offer_val > 0:
                if cash and ratio and acq_price:
                    cash_pct = (cash / offer_val) * 100
                    lines.append(f"Cash as % of total consideration: {cash_pct:.0f}%")
                    lines.append(f"Acquirer ({deal_info.get('acquirer_ticker')}) current price: ${acq_price}")
                    lines.append(f"Computed offer value: ${offer_val} (${ cash} cash + {ratio} × ${acq_price})")
                elif cash and not ratio:
                    lines.append(f"Cash as % of total: 100% (all cash deal)")

            # D1: Target announce-day reaction
            ann_pct = mkt.get("target_announce_day_pct")
            if ann_pct is not None:
                lines.append(f"\nTarget stock reaction on announce day: {ann_pct:+.1f}%")
                lines.append(f"  Prior close: ${mkt.get('target_prior_day_close')}")
                lines.append(f"  Announce close: ${mkt.get('target_announce_day_close')}")

            # D2: Buyer announce-day reaction
            acq_pct = mkt.get("acquirer_announce_day_pct")
            if acq_pct is not None:
                lines.append(f"Buyer stock reaction on announce day: {acq_pct:+.1f}%")
                lines.append(f"  Prior close: ${mkt.get('acquirer_prior_day_close')}")
                lines.append(f"  Announce close: ${mkt.get('acquirer_announce_day_close')}")

            # D3: Current spread
            spread_pct = mkt.get("current_spread_pct")
            if spread_pct is not None:
                lines.append(f"\nCurrent spread: {spread_pct:.2f}% (${mkt.get('current_spread_dollars')})")

            # D4: Institutional ownership
            inst_pct = mkt.get("held_pct_institutions")
            if inst_pct is not None:
                lines.append(f"\nInstitutional ownership: {inst_pct * 100:.1f}%")
            top_holders = mkt.get("top_institutional_holders", [])
            if top_holders:
                lines.append("Top institutional holders:")
                for h in top_holders[:5]:
                    name = h.get("Holder", h.get("holder", "?"))
                    shares = h.get("Shares", h.get("shares", 0))
                    lines.append(f"  - {name}: {shares:,.0f} shares")

            # D5: Short interest
            si = mkt.get("shares_short")
            si_prior = mkt.get("shares_short_prior_month")
            si_pct = mkt.get("short_pct_float")
            if si is not None:
                lines.append(f"\nShort interest: {si:,.0f} shares")
                if si_prior:
                    change = si - si_prior
                    direction = "up" if change > 0 else "down" if change < 0 else "flat"
                    lines.append(f"Short interest prior month: {si_prior:,.0f} ({direction} {abs(change):,.0f})")
                if si_pct:
                    lines.append(f"Short % of float: {si_pct * 100:.1f}%")
                sr = mkt.get("short_ratio")
                if sr:
                    lines.append(f"Short ratio (days to cover): {sr:.1f}")

            sections.append("\n".join(lines))
            stats["yfinance"] = {k: v for k, v in mkt.items()
                                  if k not in ("top_institutional_holders",)}

    # ── 9. Pre-computed metrics (PD-C1: RTF as % of deal value) ────────────
    # Try to compute RTF% from available data
    pr_path2 = _DATA_DIR / "press_release" / f"{deal_id}.json"
    dma_path2 = _DATA_DIR / "dma_extract" / f"{deal_id}.json"
    try:
        rtf_mm = None
        diluted_shares = None
        offer_price = deal_info.get("offer_price", 0)

        if dma_path2.exists():
            dma2 = json.loads(dma_path2.read_text()).get("extracted", {})
            rtf_mm = dma2.get("acquirer_reverse_break_fee_mm")
            tbf_mm = dma2.get("target_break_fee_mm")
        if pr_path2.exists():
            pr2 = json.loads(pr_path2.read_text()).get("extracted", {})
            diluted_shares = pr2.get("diluted_shares_mm")
            if not offer_price:
                offer_price = pr2.get("offer_price_cash", 0) or pr2.get("total_consideration", 0)

        if rtf_mm and diluted_shares and offer_price:
            equity_value_mm = diluted_shares * offer_price
            rtf_pct = (rtf_mm / equity_value_mm) * 100
            computed_line = f"\n=== PRE-COMPUTED METRICS ===\n"
            computed_line += f"Reverse Termination Fee: ${rtf_mm}M = {rtf_pct:.1f}% of equity value (${equity_value_mm:,.0f}M)"
            if tbf_mm:
                tbf_pct = (tbf_mm / equity_value_mm) * 100
                computed_line += f"\nTarget Break Fee: ${tbf_mm}M = {tbf_pct:.1f}% of equity value"
            sections.append(computed_line)
    except Exception:
        pass

    assembled = "\n\n".join(sections)
    return {
        "sources_found": sources_found,
        "sources_missing": [s["name"] for s in check_scorecard_sources(deal_id)["sources"]
                            if not s["available"]],
        "assembled_text": assembled,
        "stats": stats,
    }


def _build_prompt_from_context(context: dict, supplement: str = "") -> str:
    """Build Claude prompt from gathered pipeline context."""
    docs = context["assembled_text"]
    if supplement:
        docs += f"\n\n=== SUPPLEMENTAL CONTEXT ===\n{supplement}"

    pd_rubric = _format_rubric(POWER_DYNAMICS_SIGNALS)
    rr_rubric = _format_rubric(REGULATORY_RISK_SIGNALS)

    return f"""You are a merger arbitrage analyst. Score the following deal using two scorecards.

The data below has been gathered from multiple analytical pipelines (covenant analysis, termination analysis, regulatory tracking, proxy statements, merger agreement extracts). Use ALL available data to score each signal.

{docs}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCORECARD 1: DEAL POWER DYNAMICS (higher score = more target leverage)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{pd_rubric}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCORECARD 2: REGULATORY RISK (higher score = MORE regulatory risk)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{rr_rubric}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCTIONS:
- Score every signal 1-5 following the rubric exactly
- If the exact data is not in the provided text, provide your best estimate using industry knowledge and context clues, set "estimated": true, and note what source would confirm it
- raw_input should quote or closely paraphrase the relevant finding (or state your estimate basis)
- short_answer: the concrete factual answer in 3-15 words — a data point, not a description. Use numbers, dates, dollar amounts where possible. Examples: "47 days", "$1B (5.6% of TEV)", "15 across 8 jurisdictions", "No collar — fixed 2.2005x ratio", "None", "Bilateral negotiation, no auction", "CyberArk initiated". Think: what would you put in a spreadsheet cell?
- rationale should be 1-2 sentences explaining the score
- Extract deal identification from the text

Return ONLY valid JSON, no markdown fences, no other text:
{{
  "deal_identification": {{
    "deal_name": "Target / Acquirer",
    "buyer": "...",
    "target": "...",
    "announcement_date": "...",
    "deal_value": "...",
    "buyer_counsel": "...",
    "target_counsel": "...",
    "industry": "..."
  }},
  "power_dynamics": {{
    "signals": [
      {{"id": "A1", "signal": "Who Initiated Contact", "raw_input": "...", "short_answer": "...", "score": 1, "rationale": "...", "estimated": false}},
      ... all 22 signals (A1-A5, B1-B5, C1-C7, D1-D5)
    ]
  }},
  "regulatory_risk": {{
    "signals": [
      {{"id": "A1", "signal": "Number of Required Regulatory Approvals", "raw_input": "...", "short_answer": "...", "score": 1, "rationale": "...", "estimated": false}},
      ... all 24 signals (A1-A6, B1-B6, C1-C5, D1-D7)
    ]
  }}
}}"""


# ── Prompt (legacy — raw text input) ──────────────────────────────────────────

def _format_rubric(signals: list) -> str:
    lines = []
    current_cat = None
    cat_headers = {
        "A": ("A", None), "B": ("B", None), "C": ("C", None), "D": ("D", None),
    }
    for s in signals:
        cat = s["category"]
        if cat != current_cat:
            current_cat = cat
            lines.append(f"\nCategory {cat}:")
        lines.append(f"  {s['id']}. {s['signal']}")
        lines.append(f"     Scoring: {s['scoring'].replace(chr(10), ' | ')}")
        lines.append(f"     Source: {s['source']}")
    return "\n".join(lines)


def _build_prompt(proxy_text: str, ma_text: str | None) -> str:
    docs = f"=== PROXY BACKGROUND SECTION ===\n{proxy_text}"
    if ma_text:
        docs += f"\n\n=== MERGER AGREEMENT EXCERPTS ===\n{ma_text}"

    pd_rubric = _format_rubric(POWER_DYNAMICS_SIGNALS)
    rr_rubric = _format_rubric(REGULATORY_RISK_SIGNALS)

    return f"""You are a merger arbitrage analyst. Score the following deal using two scorecards.

{docs}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCORECARD 1: DEAL POWER DYNAMICS (higher score = more target leverage)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{pd_rubric}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCORECARD 2: REGULATORY RISK (higher score = MORE regulatory risk)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{rr_rubric}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCTIONS:
- Score every signal 1-5 following the rubric exactly
- If the exact data is not in the provided text, provide your best estimate using industry knowledge and context clues, set "estimated": true, and note what source would confirm it
- raw_input should quote or closely paraphrase the relevant finding (or state your estimate basis)
- short_answer: the concrete factual answer in 3-15 words — a data point, not a description. Use numbers, dates, dollar amounts where possible. Examples: "47 days", "$1B (5.6% of TEV)", "15 across 8 jurisdictions", "No collar — fixed 2.2005x ratio", "None", "Bilateral negotiation, no auction", "CyberArk initiated". Think: what would you put in a spreadsheet cell?
- rationale should be 1-2 sentences explaining the score
- Extract deal identification from the text

Return ONLY valid JSON, no markdown fences, no other text:
{{
  "deal_identification": {{
    "deal_name": "Target / Acquirer",
    "buyer": "...",
    "target": "...",
    "announcement_date": "...",
    "deal_value": "...",
    "buyer_counsel": "...",
    "target_counsel": "...",
    "industry": "..."
  }},
  "power_dynamics": {{
    "signals": [
      {{"id": "A1", "signal": "Who Initiated Contact", "raw_input": "...", "short_answer": "...", "score": 1, "rationale": "...", "estimated": false}},
      ... all 22 signals (A1-A5, B1-B5, C1-C7, D1-D5)
    ]
  }},
  "regulatory_risk": {{
    "signals": [
      {{"id": "A1", "signal": "Number of Required Regulatory Approvals", "raw_input": "...", "short_answer": "...", "score": 1, "rationale": "...", "estimated": false}},
      ... all 24 signals (A1-A6, B1-B6, C1-C5, D1-D7)
    ]
  }}
}}"""


# ── Group-by-group LLM call architecture ──────────────────────────────────────

# Signal groups: which signals belong to each group, and what context they need
SIGNAL_GROUPS = {
    "context_panels": {
        "label": "Context Panels",
        "type": "context",  # special: returns panel data, not signals
    },
    "PD-A": {
        "label": "Initiation & Alternatives",
        "framework": "power_dynamics",
        "signals": ["A1", "A2", "A3", "A4", "A5"],
        "context_keys": ["proxy"],
    },
    "PD-B": {
        "label": "Premium & Consideration",
        "framework": "power_dynamics",
        "signals": ["B1", "B2", "B3", "B4", "B5"],
        "context_keys": ["proxy", "dma_extract", "press_release"],
    },
    "PD-C": {
        "label": "Protective Terms",
        "framework": "power_dynamics",
        "signals": ["C2", "C3", "C4", "C5", "C6"],
        "context_keys": ["dma_extract", "termination", "covenants"],
    },
    "PD-D": {
        "label": "Market Signal",
        "framework": "power_dynamics",
        "signals": ["D1", "D2", "D3", "D4"],
        "type": "precomputed",  # no LLM call needed
    },
    "RR-A": {
        "label": "Structural Complexity",
        "framework": "regulatory_risk",
        "signals": ["A1", "A2", "A3", "A5", "A6"],
        "context_keys": ["regulatory", "dma_extract"],
    },
    "RR-B": {
        "label": "Agreement Structure",
        "framework": "regulatory_risk",
        "signals": ["B1", "B2", "B3", "B4", "B5", "B6"],
        "context_keys": ["dma_extract", "termination", "covenants"],
    },
    # RR-C and RR-D hidden for now — definitions kept in REGULATORY_RISK_SIGNALS
    # "RR-C": {
    #     "label": "Conditionality Architecture",
    #     "framework": "regulatory_risk",
    #     "signals": ["C1", "C2", "C3", "C4", "C5"],
    #     "context_keys": ["dma_extract", "covenants", "termination"],
    # },
    # "RR-D": {
    #     "label": "External Risk Factors",
    #     "framework": "regulatory_risk",
    #     "signals": ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
    #     "context_keys": ["regulatory", "dma_extract", "proxy"],
    # },
}


def _extract_context_section(assembled_text: str, key: str) -> str:
    """Extract a named section from the assembled context text."""
    section_map = {
        "press_release": "=== DEAL ANNOUNCEMENT DATA ===",
        "dma_extract": "=== MERGER AGREEMENT TERMS ===",
        "proxy": "=== PROXY / BACKGROUND OF THE MERGER ===",
        "covenants": "=== COVENANT ANALYSIS ===",
        "termination": "=== TERMINATION ANALYSIS ===",
        "regulatory": "=== REGULATORY APPROVALS ===",
        "mae": "=== MAE ANALYSIS ===",
        "market": "=== MARKET DATA (LIVE) ===",
        "precomputed": "=== PRE-COMPUTED METRICS ===",
    }
    header = section_map.get(key, "")
    if not header or header not in assembled_text:
        return ""
    start = assembled_text.index(header)
    # Find end: next section header or end of text
    rest = assembled_text[start + len(header):]
    end_markers = [m for m in section_map.values() if m != header and m in rest]
    if end_markers:
        # Find the earliest next section
        earliest = min(rest.index(m) for m in end_markers)
        return assembled_text[start:start + len(header) + earliest].strip()
    return assembled_text[start:].strip()


def _build_group_prompt(group_id: str, group_def: dict, assembled_text: str,
                        precomputed: dict, deal_info: dict) -> str:
    """Build a focused prompt for a specific signal group."""

    # Determine which rubric signals apply
    framework = group_def.get("framework", "")
    signal_ids = group_def.get("signals", [])

    if framework == "power_dynamics":
        all_signals = POWER_DYNAMICS_SIGNALS
        prefix = "PD-"
    else:
        all_signals = REGULATORY_RISK_SIGNALS
        prefix = "RR-"

    # Filter signals for this group
    group_signals = [s for s in all_signals if s["id"] in signal_ids]

    # Collect pre-computed values for this group
    pre_values = []
    llm_signals = []
    for s in group_signals:
        key = f"{prefix}{s['id']}"
        if key in precomputed:
            pre = precomputed[key]
            pre_values.append(f"  {s['id']}. {s['signal']} = {pre['short_answer']} (score: {pre['score']}/5)")
        else:
            llm_signals.append(s)

    # Extract relevant context sections
    context_keys = group_def.get("context_keys", [])
    context_parts = []
    for key in context_keys:
        section = _extract_context_section(assembled_text, key)
        if section:
            context_parts.append(section)

    context_text = "\n\n".join(context_parts) if context_parts else "No specific context available for this group."

    # Build the rubric for LLM-scored signals only
    rubric_lines = []
    for s in llm_signals:
        rubric_lines.append(f"  {s['id']}. {s['signal']}")
        rubric_lines.append(f"     Scoring: {s['scoring'].replace(chr(10), ' | ')}")
        rubric_lines.append(f"     Source: {s['source']}")
    rubric_text = "\n".join(rubric_lines)

    # Pre-computed summary
    pre_text = ""
    if pre_values:
        pre_text = "\n\nThe following signals have been pre-computed from structured data (include them in your output as-is):\n" + "\n".join(pre_values)

    target = deal_info.get("target", "")
    acquirer = deal_info.get("acquirer", "")
    deal_label = f"{target} / {acquirer}" if target and acquirer else "this deal"

    # Per-group short_answer examples for tighter formatting
    group_examples = {
        "PD-A": 'A1→"PANW" (ONLY the ticker symbol, no verb like "initiated" or "approached"), A2→"47 Days", A3→"Bilateral (0 parties)", A4→"Strong — no activist pressure", A5→"1 realistic buyer"',
        "PD-B": 'B3→"+$9 (+2.5%)", B5→"No collar — fixed ratio"',
        "PD-C": 'C2→"Denial + conditions + End Date", C3→"None", C4→"Standard fiduciary out", C5→"4 business days", C6→"Full specific performance", C7→"Available, low dissent risk"',
        "RR-A": 'A2→"3 (DOJ, EC, SAMR)", A4→"Well-established precedent", A5→"Mostly parallel, 1 dependency", A6→"25 business days" (state the ACTUAL number from the agreement, not the rubric bucket)',
        "RR-B": 'B2→"Auto for regulatory, +3 months", B4→"RBE with narrow carveout", B5→"Partially hidden in schedules", B6→"Up to $300M revenue"',
        "RR-C": 'C1→"1 buyer-only condition", C2→"8 / 15", C3→"Not addressed", C4→"$300M divestiture cap", C5→"Standard anti-frustration"',
        "RR-D": 'D1→"Neutral", D2→"No opposition filed", D3→"Recent comparable approved clean", D4→"Significant horizontal overlap", D5→"Normal workload", D6→"Joint control", D7→"Clean record"',
    }
    examples = group_examples.get(group_id, "")
    examples_line = f"\n  Group-specific examples: {examples}" if examples else ""

    return f"""You are a merger arbitrage analyst scoring {deal_label}.
Score the following signals for the {group_def['label']} category.

{context_text}
{pre_text}

SIGNALS TO SCORE:
{rubric_text}

CRITICAL FORMAT RULES:
- Score each signal 1-5 following the rubric exactly
- If data unavailable, estimate with "estimated": true
- short_answer: THE SHORTEST POSSIBLE factual answer. Think spreadsheet cell. 1-8 words MAX. Never repeat the signal name/question in the answer. Never include calculations or explanations.{examples_line}
- raw_input: 1-2 sentence finding (detail goes here, NOT in short_answer)
- rationale: 1-2 sentences explaining the score

Return ONLY valid JSON array, no markdown fences:
[
  {{"id": "{llm_signals[0]['id'] if llm_signals else 'A1'}", "signal": "...", "raw_input": "...", "short_answer": "...", "score": N, "rationale": "...", "estimated": false}},
  ...
]"""


def _build_context_panels_prompt(assembled_text: str, deal_info: dict) -> str:
    """Build prompt for LLM to fill in context panel fields that need inference."""
    target = deal_info.get("target", "")
    acquirer = deal_info.get("acquirer", "")
    industry = ""

    # Extract what we can from assembled text
    context = _extract_context_section(assembled_text, "press_release")
    context += "\n\n" + _extract_context_section(assembled_text, "proxy")
    context += "\n\n" + _extract_context_section(assembled_text, "dma_extract")

    return f"""You are a merger arbitrage analyst. For the deal {target} / {acquirer}, provide two fields.

{context}

RULES:
- closest_competitors: ONLY comma-separated ticker symbols (3-5 tickers). Example: "MDT, SYK, ABT, ZBH"
- combined_overlap: ONE sentence, max 15 words. Example: "Neuro, vascular, and cardiac devices with significant horizontal overlap"

Return ONLY valid JSON, no markdown fences:
{{
  "closest_competitors": "TICK1, TICK2, TICK3",
  "combined_overlap": "One short sentence describing overlap areas"
}}"""


def _call_claude_group(prompt: str, client) -> dict | list | None:
    """Make a single Claude API call for a signal group. Returns parsed JSON or None."""
    try:
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:])
            if raw.endswith("```"):
                raw = raw[: raw.rfind("```")]
            raw = raw.strip()
        return json.loads(raw)
    except Exception:
        return None


def _run_signal_groups(
    assembled_text: str,
    precomputed: dict,
    deal_info: dict,
) -> tuple[list, list, dict]:
    """Run all signal groups in parallel. Returns (pd_signals, rr_signals, panel_updates)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic package not installed")

    client = anthropic.Anthropic()
    pd_signals: list[dict] = []
    rr_signals: list[dict] = []
    panel_updates: dict = {}

    # ── Group 5 (PD-D): Pure computation, no LLM ────────────────────
    for sig_def in POWER_DYNAMICS_SIGNALS:
        if sig_def["category"] == "D":
            key = f"PD-{sig_def['id']}"
            if key in precomputed:
                pd_signals.append(precomputed[key])
            else:
                # Fallback: LLM estimation for missing D signals
                pd_signals.append({
                    "id": sig_def["id"], "signal": sig_def["signal"],
                    "raw_input": "No market data available", "short_answer": "N/A",
                    "score": 3, "rationale": "No market data available; defaulting to neutral.",
                    "estimated": True,
                })

    # ── Build prompts for LLM-scored groups ──────────────────────────
    futures = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        # Context panels call
        ctx_prompt = _build_context_panels_prompt(assembled_text, deal_info)
        futures[executor.submit(_call_claude_group, ctx_prompt, client)] = "context_panels"

        # Signal group calls (skip PD-D which is pure computation)
        for group_id, group_def in SIGNAL_GROUPS.items():
            if group_def.get("type") in ("context", "precomputed"):
                continue  # already handled

            prompt = _build_group_prompt(group_id, group_def, assembled_text, precomputed, deal_info)
            futures[executor.submit(_call_claude_group, prompt, client)] = group_id

        # ── Collect results ──────────────────────────────────────────
        for future in as_completed(futures):
            group_id = futures[future]
            result = future.result()

            if group_id == "context_panels":
                if isinstance(result, dict):
                    panel_updates = result
                continue

            if result is None:
                # Group failed — generate fallback estimated signals
                group_def = SIGNAL_GROUPS[group_id]
                framework = group_def["framework"]
                all_sigs = POWER_DYNAMICS_SIGNALS if framework == "power_dynamics" else REGULATORY_RISK_SIGNALS
                for sig_def in all_sigs:
                    if sig_def["id"] in group_def["signals"]:
                        prefix = "PD-" if framework == "power_dynamics" else "RR-"
                        key = f"{prefix}{sig_def['id']}"
                        if key in precomputed:
                            sig = precomputed[key]
                        else:
                            sig = {
                                "id": sig_def["id"], "signal": sig_def["signal"],
                                "raw_input": f"Group {group_id} call failed",
                                "short_answer": "Error",
                                "score": 3, "rationale": f"LLM call for {group_id} failed. Defaulting to neutral.",
                                "estimated": True,
                            }
                        if framework == "power_dynamics":
                            pd_signals.append(sig)
                        else:
                            rr_signals.append(sig)
                continue

            # Parse successful result — merge with pre-computed
            group_def = SIGNAL_GROUPS[group_id]
            framework = group_def["framework"]
            prefix = "PD-" if framework == "power_dynamics" else "RR-"
            llm_signals = result if isinstance(result, list) else []

            # Build final signal list: pre-computed + LLM-scored
            all_sigs = POWER_DYNAMICS_SIGNALS if framework == "power_dynamics" else REGULATORY_RISK_SIGNALS
            for sig_def in all_sigs:
                if sig_def["id"] not in group_def["signals"]:
                    continue
                key = f"{prefix}{sig_def['id']}"

                if key in precomputed:
                    sig = precomputed[key]
                else:
                    # Find matching LLM result
                    llm_match = next((s for s in llm_signals if s.get("id") == sig_def["id"]), None)
                    if llm_match:
                        sig = llm_match
                    else:
                        sig = {
                            "id": sig_def["id"], "signal": sig_def["signal"],
                            "raw_input": "Signal not returned by LLM",
                            "short_answer": "Missing",
                            "score": 3, "rationale": "Signal not returned in group response.",
                            "estimated": True,
                        }

                if framework == "power_dynamics":
                    pd_signals.append(sig)
                else:
                    rr_signals.append(sig)

    return pd_signals, rr_signals, panel_updates


def _assemble_scorecard(
    deal_id: str,
    pd_signals: list,
    rr_signals: list,
    context_panels: dict,
    sources_used: list,
    deal_info: dict,
) -> dict:
    """Assemble all signal results into the final scorecard JSON."""
    # Sort signals by their expected order
    pd_order = {s["id"]: i for i, s in enumerate(POWER_DYNAMICS_SIGNALS)}
    rr_order = {s["id"]: i for i, s in enumerate(REGULATORY_RISK_SIGNALS)}
    pd_signals.sort(key=lambda s: pd_order.get(s["id"], 99))
    rr_signals.sort(key=lambda s: rr_order.get(s["id"], 99))

    pd_cats = _structure(pd_signals, PD_CATEGORY_LABELS)
    rr_cats = _structure(rr_signals, RR_CATEGORY_LABELS)

    pd_total = sum(c["subtotal"] for c in pd_cats.values())
    rr_total = sum(c["subtotal"] for c in rr_cats.values())
    pd_max = sum(len(c["signals"]) for c in pd_cats.values()) * 5
    rr_max = sum(len(c["signals"]) for c in rr_cats.values()) * 5

    return {
        "deal_id": deal_id,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "sources_used": sources_used,
        "context_panels": context_panels,
        "deal_identification": {
            "deal_name": f"{deal_info.get('target', '')} / {deal_info.get('acquirer', '')}",
            "target": deal_info.get("target", ""),
            "buyer": deal_info.get("acquirer", ""),
            "announcement_date": deal_info.get("announce_date", ""),
            "industry": context_panels.get("deal_overview", {}).get("Industry", ""),
        },
        "power_dynamics": {
            "score": pd_total,
            "max_score": pd_max,
            "interpretation": _interp_power(pd_total, pd_max),
            "categories": pd_cats,
        },
        "regulatory_risk": {
            "score": rr_total,
            "max_score": rr_max,
            "interpretation": _interp_regulatory(rr_total, rr_max),
            "categories": rr_cats,
        },
    }


# ── Structure builder ───────────────────────────────────────────────────────────

def _structure(signals: list, category_labels: dict) -> dict:
    cats: dict = {}
    for sig in signals:
        cat = sig["id"][0]
        if cat not in cats:
            cats[cat] = {"label": category_labels.get(cat, cat), "subtotal": 0, "max_score": 0, "signals": []}
        cats[cat]["signals"].append(sig)
        cats[cat]["max_score"] += 5
        score = sig.get("score")
        if score is not None:
            cats[cat]["subtotal"] += int(score)
    return cats


# ── Public API ─────────────────────────────────────────────────────────────────

def get_scorecard_path(deal_id: str) -> Path | None:
    p = SCORECARDS_DIR / f"{deal_id}.json"
    return p if p.exists() else None


def find_scorecard_inputs(deal_id: str) -> dict | None:
    deal_dir = SCORECARD_INPUT_DIR / deal_id
    proxy_file = deal_dir / "proxy_background.txt"
    if not proxy_file.exists():
        return None
    ma_file = deal_dir / "merger_agreement.txt"
    return {
        "proxy": proxy_file.read_text(encoding="utf-8"),
        "merger_agreement": ma_file.read_text(encoding="utf-8") if ma_file.exists() else None,
    }


def build_scorecard(
    deal_id: str,
    proxy_text: str = "",
    ma_text: str | None = None,
    *,
    auto_gather: bool = False,
    supplement_text: str = "",
) -> Path:
    """Score a deal using group-by-group LLM calls + pre-computed signals.

    If auto_gather=True (default for new calls), uses focused group architecture:
      1. Gather context from all pipelines
      2. Pre-compute 12 signals deterministically
      3. Build context panels
      4. Run 8 parallel LLM calls for remaining signals
      5. Assemble final scorecard

    Falls back to single-prompt legacy mode if auto_gather is False.
    """
    SCORECARDS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = SCORECARDS_DIR / f"{deal_id}.json"

    if auto_gather:
        # ── New group-by-group architecture ────────────────────────────
        deal_info = _get_deal_info(deal_id)
        if not deal_info:
            deal_info = {"deal_id": deal_id}
        elif "deal_id" not in deal_info:
            deal_info["deal_id"] = deal_id

        # Step 1: Gather all context
        context = gather_scorecard_context(deal_id)
        sources_used = context["sources_found"]

        # Append any manual text
        assembled = context["assembled_text"]
        if proxy_text:
            assembled += f"\n\n=== ADDITIONAL PROXY TEXT ===\n{proxy_text}"
        if ma_text:
            assembled += f"\n\n=== ADDITIONAL MERGER AGREEMENT TEXT ===\n{ma_text}"
        if supplement_text:
            assembled += f"\n\n=== SUPPLEMENTAL CONTEXT ===\n{supplement_text}"

        # Step 2: Reuse yfinance data from gather (avoids duplicate API call)
        yf_data = context.get("stats", {}).get("yfinance", {})
        if not yf_data and deal_info.get("target_ticker"):
            yf_data = _fetch_yfinance_market_data(deal_info)

        # Step 3: Pre-compute deterministic signals
        precomputed = _precompute_signals(deal_info, yf_data, context)

        # Step 4: Build context panels
        panels = _build_context_panels(deal_info, yf_data, context)

        # Step 5: Run group-by-group LLM calls
        pd_signals, rr_signals, panel_updates = _run_signal_groups(
            assembled, precomputed, deal_info
        )

        # Merge LLM panel updates (competitors, overlap)
        if panel_updates:
            overview = panels.get("deal_overview", {})
            if panel_updates.get("closest_competitors"):
                overview["Closest Competitors"] = panel_updates["closest_competitors"]
            if panel_updates.get("combined_overlap"):
                overlap = panel_updates["combined_overlap"]
                for _w in ["significantly", "substantially", "heavily", "largely", "considerably", "extremely"]:
                    overlap = overlap.replace(f" {_w}", "").replace(f" {_w.capitalize()}", "")
                overview["Combined Overlap"] = overlap.strip()
            panels["deal_overview"] = overview

        # Step 6: Assemble final scorecard
        result = _assemble_scorecard(
            deal_id, pd_signals, rr_signals, panels, sources_used, deal_info
        )

    else:
        # ── Legacy single-prompt mode ──────────────────────────────────
        try:
            import anthropic
        except ImportError:
            raise RuntimeError("anthropic package not installed")

        if not proxy_text:
            raise ValueError("proxy_text is required when auto_gather is False")
        prompt = _build_prompt(proxy_text, ma_text)
        sources_used = ["manual_input"]

        client = anthropic.Anthropic()
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=16384,
            messages=[{"role": "user", "content": prompt}],
        )

        raw = message.content[0].text.strip()
        if raw.startswith("```"):
            raw = "\n".join(raw.split("\n")[1:])
            if raw.endswith("```"):
                raw = raw[: raw.rfind("```")]
            raw = raw.strip()

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"Claude returned invalid JSON ({e}). Response length: {len(raw)} chars.")

        pd_cats = _structure(data["power_dynamics"]["signals"], PD_CATEGORY_LABELS)
        rr_cats = _structure(data["regulatory_risk"]["signals"], RR_CATEGORY_LABELS)

        pd_total = sum(c["subtotal"] for c in pd_cats.values())
        rr_total = sum(c["subtotal"] for c in rr_cats.values())
        pd_max = sum(len(c["signals"]) for c in pd_cats.values()) * 5
        rr_max = sum(len(c["signals"]) for c in rr_cats.values()) * 5

        result = {
            "deal_id": deal_id,
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "sources_used": sources_used,
            "deal_identification": data.get("deal_identification", {}),
            "power_dynamics": {
                "score": pd_total,
                "max_score": pd_max,
                "interpretation": _interp_power(pd_total, pd_max),
                "categories": pd_cats,
            },
            "regulatory_risk": {
                "score": rr_total,
                "max_score": rr_max,
                "interpretation": _interp_regulatory(rr_total, rr_max),
                "categories": rr_cats,
            },
        }

    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return output_path
