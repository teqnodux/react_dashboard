"""
Press Release Processor
Extracts structured deal financial data from press release summaries (L1/L2/L3 format)
using Claude Haiku, then saves to a per-deal JSON file.

Input:  Pasted L1/L2/L3 summary text
Output: backend/data/press_release/{deal_id}.json
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

_BACKEND_DIR = Path(__file__).parent
PRESS_RELEASE_DIR = _BACKEND_DIR / "data" / "press_release"


def get_press_release_data(deal_id: str):
    """Return saved press release extraction for a deal, or None.
    MongoDB mode: reads from fo_press_release_extraction collection.
    Static mode:  reads from data/press_release/{deal_id}.json.
    """
    from config import DATA_SOURCE
    if DATA_SOURCE == "mongodb":
        return _get_pr_from_mongo(deal_id)
    p = PRESS_RELEASE_DIR / f"{deal_id}.json"
    if p.exists():
        return json.loads(p.read_text())
    return None


def _get_pr_from_mongo(deal_id: str):
    """Fetch the most recent fo_press_release_extraction record for deal_id."""
    try:
        from pymongo import MongoClient
        from config import MONGODB_URI, MONGODB_DB
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
        db = client[MONGODB_DB]
        doc = db["fo_press_release_extraction"].find_one(
            {"deal_id": deal_id},
            sort=[("created_at", -1)],
        )
        client.close()
        if not doc:
            return None
        return {
            "extracted": doc.get("extracted") or {},
        }
    except Exception as e:
        print(f"[press_release_processor] MongoDB error: {e}")
        return None


def extract_from_press_release(deal_id: str, summary_text: str) -> dict:
    """
    Send the L1/L2/L3 press release summary to Claude Haiku for structured extraction.
    Saves result to PRESS_RELEASE_DIR/{deal_id}.json and returns it.
    """
    import anthropic

    client = anthropic.Anthropic()

    prompt = f"""Extract structured deal financial data from this press release summary.
Return ONLY valid JSON with these fields (use null for anything not stated):

{{
  "target": "Target company name",
  "acquirer": "Acquirer name(s)",
  "offer_price_cash": 0.00,
  "cvr_value": 0.00,
  "stock_exchange_ratio": null,
  "total_consideration": "PER-SHARE total (cash + stock value + CVR). NOT the aggregate deal value. E.g. if offer is $21.50 cash, total_consideration = 21.50",
  "deal_value_bn": "Aggregate deal/equity value in BILLIONS (e.g. 2.5 for a $2.5B deal)",
  "deal_type": "cash / stock / cash+stock / cash+CVR",
  "premium_pct": 0.0,
  "undisturbed_date": "YYYY-MM-DD or null",
  "undisturbed_reference": "description of what the undisturbed price is measured against",
  "expected_close": "Use standard finance shorthand: 1H26, 2H26, Q1 26, Q2 26, mid-2026, etc.",
  "expected_close_date": "YYYY-MM-DD midpoint of the stated range (e.g. 1H26 = 2026-04-01, Q2 26 = 2026-05-15, mid-2026 = 2026-07-01)",
  "announce_date": "YYYY-MM-DD date the deal was announced",
  "go_shop_days": null,
  "diluted_shares_mm": null,
  "cash_on_hand_bn": null,
  "debt_bn": null,
  "financing": "description of financing",
  "regulatory_bodies": ["list of regulatory bodies mentioned"],
  "shareholder_approval_required": true,
  "dividend_info": "any dividend or distribution info mentioned",
  "special_conditions": "any CVR milestones, earnouts, or special terms",
  "minority_investors": ["any minority equity investors"],
  "raw_summary": "the one-line L1 headline"
}}

Press release summary:
{summary_text}"""

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text.strip()

    # Extract JSON from response (handle markdown code blocks)
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first and last lines (```json and ```)
        text = "\n".join(lines[1:-1])

    extracted = json.loads(text)

    # Save
    PRESS_RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    out_path = PRESS_RELEASE_DIR / f"{deal_id}.json"

    # Wrap with metadata
    result = {
        "deal_id": deal_id,
        "extracted": extracted,
        "source_text": summary_text,
        "extracted_at": datetime.utcnow().isoformat() + "Z",
        "filing_date": extracted.get("announce_date"),
    }
    out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False))

    return result
