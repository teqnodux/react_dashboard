"""
Enrich `sec_filing_summary` rows with `company_name` by resolving CIK vs `deals` (target/acquirer).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId


def normalize_cik(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    digits = "".join(ch for ch in s if ch.isdigit())
    if digits:
        return digits.zfill(10)
    return None


def _json_safe(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def load_deal_doc(db: Any, deal_id: Any) -> dict[str, Any] | None:
    if deal_id is None:
        return None
    col = db["deals"]
    if isinstance(deal_id, ObjectId):
        return col.find_one({"_id": deal_id})
    s = str(deal_id).strip()
    if not s:
        return None
    try:
        return col.find_one({"_id": ObjectId(s)})
    except InvalidId:
        return col.find_one({"_id": deal_id})


def company_name_and_role_from_deal(
    deal_doc: dict[str, Any],
    filing_cik: Any,
) -> tuple[str | None, str | None]:
    """
    Compare filing issuer CIK against deal `cik` (target) vs `acquirer_cik`.
    Returns (display_name, "target"|"acquirer"|None).
    """
    fc = normalize_cik(filing_cik)
    if not fc or not deal_doc:
        return None, None

    tc = normalize_cik(deal_doc.get("cik"))
    acik = normalize_cik(deal_doc.get("acquirer_cik"))

    target_name = (deal_doc.get("target_name") or deal_doc.get("target") or "").strip()
    acquirer_name = (deal_doc.get("acquire_name") or deal_doc.get("acquirer") or "").strip()

    if tc and fc == tc:
        name = target_name or acquirer_name or None
        return name, "target"
    if acik and fc == acik:
        name = acquirer_name or target_name or None
        return name, "acquirer"

    return None, None


def enrich_sec_summary_record(db: Any, doc: dict[str, Any]) -> dict[str, Any]:
    """
    Normalize one `sec_filing_summary` doc for `/api/sec-feed` and Socket.IO payloads.
    """
    oid = doc.get("_id")

    deal = load_deal_doc(db, doc.get("deal_id"))
    cn, role = None, None
    if deal:
        cn, role = company_name_and_role_from_deal(deal, doc.get("cik_number"))

    out: dict[str, Any] = {}
    for k, v in doc.items():
        if k == "_id":
            continue
        out[k] = _json_safe(v)

    out["id"] = str(oid) if oid is not None else ""
    out["company_name"] = cn or "Unknown"

    ck = doc.get("cik_number")
    out["cik_number"] = str(ck).strip() if ck is not None else ""

    raw_link = doc.get("sec_document_url")
    out["link"] = str(raw_link).strip() if raw_link else None

    if role:
        out["issuer_role"] = role

    return out

