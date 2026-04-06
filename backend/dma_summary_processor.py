"""
DMA Summary Processor
Extracts structured deal data from DMA (Definitive Merger Agreement) summaries
using Claude Haiku, then cross-references against press release extraction
to flag inconsistencies.

Input:  Pasted DMA summary text
Output: backend/data/dma_extract/{deal_id}.json
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

_BACKEND_DIR = Path(__file__).parent
DMA_EXTRACT_DIR = _BACKEND_DIR / "data" / "dma_extract"


def get_dma_extract(deal_id: str):
    """Return saved DMA extraction for a deal, or None.
    MongoDB mode: reads from fo_dma_extraction collection.
    Static mode:  reads from data/dma_extract/{deal_id}.json.
    """
    from config import DATA_SOURCE
    if DATA_SOURCE == "mongodb":
        return _get_dma_extract_from_mongo(deal_id)
    p = DMA_EXTRACT_DIR / f"{deal_id}.json"
    if p.exists():
        return json.loads(p.read_text())
    return None


def _get_dma_extract_from_mongo(deal_id: str):
    """Fetch the most recent fo_dma_extraction record for deal_id."""
    try:
        from pymongo import MongoClient
        from config import MONGODB_URI, MONGODB_DB
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
        db = client[MONGODB_DB]
        doc = db["fo_dma_extraction"].find_one(
            {"deal_id": deal_id},
            sort=[("created_at", -1)],
        )
        client.close()
        if not doc:
            return None
        return {
            "extracted": doc.get("extracted") or {},
            "inconsistencies": doc.get("inconsistencies") or [],
        }
    except Exception as e:
        print(f"[dma_summary_processor] MongoDB error: {e}")
        return None


def _load_press_release(deal_id: str):
    """Load existing press release extraction for comparison."""
    from press_release_processor import get_press_release_data
    pr = get_press_release_data(deal_id)
    if pr and "extracted" in pr:
        return pr["extracted"]
    return None


def _check_inconsistencies(dma: dict, pr: dict) -> list[dict]:
    """Compare DMA extraction against press release — only financial mismatches."""
    flags = []

    def _flag(field: str, label: str, dma_val, pr_val):
        flags.append({
            "field": field,
            "label": label,
            "dma_value": str(dma_val),
            "pr_value": str(pr_val),
            "note": f"DMA: {dma_val}  /  PR: {pr_val}",
        })

    # Offer price
    if dma.get("offer_price_cash") and pr.get("offer_price_cash"):
        if abs(dma["offer_price_cash"] - pr["offer_price_cash"]) > 0.01:
            _flag("offer_price_cash", "Offer Price",
                  f"${dma['offer_price_cash']}", f"${pr['offer_price_cash']}")

    # CVR
    if dma.get("cvr_value") and pr.get("cvr_value"):
        if abs(dma["cvr_value"] - pr["cvr_value"]) > 0.01:
            _flag("cvr_value", "CVR Value",
                  f"${dma['cvr_value']}", f"${pr['cvr_value']}")

    # Deal type
    if dma.get("deal_type") and pr.get("deal_type"):
        if dma["deal_type"].lower() != pr["deal_type"].lower():
            _flag("deal_type", "Deal Type", dma["deal_type"], pr["deal_type"])

    # Stock exchange ratio
    if dma.get("stock_exchange_ratio") and pr.get("stock_exchange_ratio"):
        if abs(dma["stock_exchange_ratio"] - pr["stock_exchange_ratio"]) > 0.001:
            _flag("stock_exchange_ratio", "Exchange Ratio",
                  dma["stock_exchange_ratio"], pr["stock_exchange_ratio"])

    return flags


def extract_from_dma_summary(deal_id: str, summary_text: str) -> dict:
    """
    Send the DMA summary to Claude Haiku for structured extraction.
    Cross-references against existing press release data.
    Saves to DMA_EXTRACT_DIR/{deal_id}.json and returns it.
    """
    import anthropic

    client = anthropic.Anthropic()

    prompt = f"""Extract structured deal data from this Definitive Merger Agreement (DMA) summary.
Return ONLY valid JSON with these fields (use null for anything not stated):

{{
  "target": "Target company name",
  "acquirer": "Acquirer name(s)",
  "offer_price_cash": 0.00,
  "cvr_value": 0.00,
  "stock_exchange_ratio": null,
  "total_consideration": "PER-SHARE total (cash + stock value + CVR). NOT the aggregate deal value.",
  "deal_type": "cash / stock / cash+stock / cash+CVR",
  "outside_date": "YYYY-MM-DD — the initial termination/drop-dead date",
  "outside_date_extension": "YYYY-MM-DD — extended outside date if applicable, or null",
  "outside_date_extension_condition": "condition that triggers the extension, or null",
  "expected_close": "Use standard finance shorthand: 1H26, 2H26, Q1 26, etc.",
  "go_shop_days": null,
  "go_shop_end_date": "YYYY-MM-DD or null",
  "target_break_fee_mm": null,
  "acquirer_reverse_break_fee_mm": null,
  "voting_threshold": "e.g. majority of outstanding shares",
  "regulatory_approvals_required": ["specific agencies: HSR/FTC, EC, CFIUS, etc."],
  "regulatory_filing_deadlines": "any specific deadlines for regulatory filings",
  "dividend_allowed": "what dividends/distributions are permitted during pendency",
  "financing_condition": "is closing conditioned on financing? describe",
  "conditions_to_closing": ["list of key closing conditions"],
  "specific_termination_triggers": ["list of specific termination rights"],
  "interim_operating_covenants": "summary of key restrictions on target operations",
  "announce_date": "YYYY-MM-DD or null"
}}

DMA summary:
{summary_text}"""

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1])

    extracted = json.loads(text)

    # Cross-reference with press release
    pr_data = _load_press_release(deal_id)
    inconsistencies = _check_inconsistencies(extracted, pr_data) if pr_data else []

    # Save
    DMA_EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
    result = {
        "deal_id": deal_id,
        "extracted": extracted,
        "inconsistencies": inconsistencies,
        "source_text": summary_text,
        "extracted_at": datetime.utcnow().isoformat() + "Z",
        "filing_date": extracted.get("announce_date"),
    }
    (DMA_EXTRACT_DIR / f"{deal_id}.json").write_text(json.dumps(result, indent=2))

    return result
