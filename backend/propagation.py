"""
Unified propagation layer.

After any document-processing endpoint saves its data, call:
    propagate(deal_id, source_type, **kwargs)

This syncs already-extracted data into the regulatory tracker
and tracking layer. It never re-extracts — it only reads
existing JSON files and merges what they already contain.

Source types:
    "press_release"   - PR was just extracted
    "dma_extract"     - DMA summary was just extracted
    "timeline"        - Timeline JSON was just generated
    "sec_filing"      - SEC filing was just processed (kwargs: url, filing_type)
    "proxy_upload"    - Proxy TXT was just uploaded
    "tenk_upload"     - 10-K/10-Q TXT was just uploaded
    "regulatory"      - EDGAR regulatory extraction was just run (already handled)
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any, Dict, List, Optional

logger = logging.getLogger("propagation")

# Vague regulatory body names to skip
_SKIP_KEYWORDS = ["multiple", "various", "applicable", "customary", "other regulatory"]


def sync_all(deal_id: str) -> Dict[str, Any]:
    """
    Re-run propagation for every existing document source.
    Call this to catch up on any sources that were processed
    before propagation code existed.
    Also backfills DMA sections from source text if missing.
    """
    result: Dict[str, Any] = {"actions": []}
    try:
        result["actions"] += _sync_pr_to_regulatory(deal_id)
    except Exception as e:
        result["actions"].append(f"PR sync error: {e}")
    try:
        result["actions"] += _sync_dma_to_regulatory(deal_id)
    except Exception as e:
        result["actions"].append(f"DMA sync error: {e}")
    try:
        result["actions"] += _backfill_dma_sections(deal_id)
    except Exception as e:
        result["actions"].append(f"DMA sections backfill error: {e}")
    try:
        result["actions"] += _sync_proxy_to_regulatory(deal_id)
    except Exception as e:
        result["actions"].append(f"Proxy sync error: {e}")
    try:
        result["actions"] += _sync_sec_summaries_to_regulatory(deal_id)
    except Exception as e:
        result["actions"].append(f"SEC summary sync error: {e}")
    try:
        result["actions"] += _sync_all_sec_filings_to_tracking(deal_id)
    except Exception as e:
        result["actions"].append(f"SEC → tracking sync error: {e}")
    return result


def _backfill_dma_sections(deal_id: str) -> List[str]:
    """If DMA extract has source_text but no detail sections exist, parse and save them."""
    from pathlib import Path
    import json

    base_dir = Path(__file__).parent.parent
    detail_path = base_dir / "data" / "details" / f"{deal_id}.json"
    if detail_path.exists():
        return []  # Already has sections

    from dma_summary_processor import get_dma_extract
    dma_raw = get_dma_extract(deal_id)
    if not dma_raw or not dma_raw.get("source_text"):
        return []

    from process_dma_two_pass import extract_sections_from_text, save_detail_sections
    sections = extract_sections_from_text(dma_raw["source_text"])
    if not sections["concise_sections"] and not sections["fulsome_sections"]:
        return []

    save_detail_sections(deal_id, sections)
    c = len(sections["concise_sections"])
    f = len(sections["fulsome_sections"])
    return [f"Backfilled DMA sections: {c} concise, {f} fulsome"]


def propagate(deal_id: str, source_type: str, **kwargs: Any) -> Dict[str, Any]:
    """
    Main entry point. Returns a dict summarising what was propagated.
    Safe to call — catches all exceptions so it never breaks the
    calling endpoint.
    """
    result: Dict[str, Any] = {"source_type": source_type, "actions": []}
    try:
        if source_type == "press_release":
            result["actions"] += _sync_pr_to_regulatory(deal_id)
        elif source_type == "dma_extract":
            result["actions"] += _sync_dma_to_regulatory(deal_id)
            # Also catch up tracking from any existing SEC filings/proxy
            result["actions"] += _sync_all_sec_filings_to_tracking(deal_id)
            result["actions"] += _sync_proxy_dates_to_tracking(deal_id)
        elif source_type == "timeline":
            # After timeline generation + seed, also push PR/DMA bodies
            result["actions"] += _sync_pr_to_regulatory(deal_id)
            result["actions"] += _sync_dma_to_regulatory(deal_id)
            # Also catch up tracking from any existing SEC filings/proxy
            result["actions"] += _sync_all_sec_filings_to_tracking(deal_id)
            result["actions"] += _sync_proxy_dates_to_tracking(deal_id)
        elif source_type == "sec_filing":
            url = kwargs.get("url")
            filing_type = kwargs.get("filing_type", "")
            filing_date = kwargs.get("filing_date")
            result["actions"] += _sync_sec_filing_to_tracking(
                deal_id, filing_type, filing_date, url
            )
            result["actions"] += _maybe_run_regulatory_extraction(
                deal_id, url, filing_type
            )
        elif source_type == "proxy_upload":
            result["actions"] += _sync_proxy_to_regulatory(deal_id)
            result["actions"] += _sync_proxy_dates_to_tracking(deal_id)
        elif source_type in ("tenk_upload", "regulatory"):
            pass  # No structured regulatory data to sync from these
    except Exception as e:
        logger.error("[propagation] Error for %s/%s: %s", deal_id, source_type, e)
        result["error"] = str(e)
    return result


# ── Internal sync functions ──────────────────────────────────────────────────


def _sync_pr_to_regulatory(deal_id: str) -> List[str]:
    """
    Read saved press release extraction. If it lists regulatory_bodies,
    ensure each is represented in the regulatory tracker.
    """
    from press_release_processor import get_press_release_data
    from generate_regulatory import (
        merge_approvals,
        _infer_jurisdiction,
        _infer_category,
    )

    pr_raw = get_press_release_data(deal_id)
    if not pr_raw:
        return []
    pr = pr_raw.get("extracted", {})
    bodies = pr.get("regulatory_bodies", [])
    if not bodies:
        return []

    new_list = []
    for body_name in bodies:
        if any(kw in body_name.lower() for kw in _SKIP_KEYWORDS):
            continue
        new_list.append({
            "authority_short": body_name,
            "authority_full": body_name,
            "jurisdiction": _infer_jurisdiction(body_name),
            "category": _infer_category(body_name),
            "status": "pending",
            "filed_date": None,
            "cleared_date": None,
            "expected_filing_period": None,
            "conditions": None,
            "notes": "Identified in press release",
        })

    if not new_list:
        return []

    # Build doc summary for linked_docs
    pr_summary = {
        "text": pr.get("summary") or ", ".join(bodies),
        "L1": pr.get("headline") or f"Press Release — {deal_id}",
        "L2": pr.get("summary") or "Regulatory bodies identified in press release",
    }

    diff = merge_approvals(
        deal_id=deal_id,
        new_list=new_list,
        source_doc="Press Release",
        source_doc_type="press_release",
        source_doc_date=pr.get("announce_date") or date.today().isoformat(),
        source_url=None,
        doc_summary=pr_summary,
    )

    actions = []
    if diff.get("added"):
        actions.append(f"PR → regulatory: added {diff['added']}")
    if diff.get("status_changes"):
        actions.append(f"PR → regulatory: {len(diff['status_changes'])} status updates")
    return actions


def _sync_dma_to_regulatory(deal_id: str) -> List[str]:
    """
    Read saved DMA extraction. If it lists regulatory_approvals_required,
    ensure each is represented in the regulatory tracker.
    """
    from dma_summary_processor import get_dma_extract
    from generate_regulatory import (
        merge_approvals,
        _infer_jurisdiction,
        _infer_category,
    )

    dma_raw = get_dma_extract(deal_id)
    if not dma_raw:
        return []
    dma = dma_raw.get("extracted", {})
    approvals = dma.get("regulatory_approvals_required", [])
    if not approvals:
        return []

    new_list = []
    for name in approvals:
        if any(kw in name.lower() for kw in _SKIP_KEYWORDS):
            continue
        new_list.append({
            "authority_short": name,
            "authority_full": name,
            "jurisdiction": _infer_jurisdiction(name),
            "category": _infer_category(name),
            "status": "pending",
            "filed_date": None,
            "cleared_date": None,
            "expected_filing_period": None,
            "conditions": None,
            "notes": "Identified in DMA summary extraction",
        })

    if not new_list:
        return []

    dma_summary = {
        "text": ", ".join(approvals),
        "L1": f"DMA Summary — {deal_id}",
        "L2": dma.get("deal_summary") or "Regulatory approvals from DMA extraction",
    }

    diff = merge_approvals(
        deal_id=deal_id,
        new_list=new_list,
        source_doc="DMA Extract",
        source_doc_type="dma_extract",
        source_doc_date=dma.get("announce_date") or date.today().isoformat(),
        source_url=None,
        doc_summary=dma_summary,
    )

    actions = []
    if diff.get("added"):
        actions.append(f"DMA → regulatory: added {diff['added']}")
    return actions


def _maybe_run_regulatory_extraction(
    deal_id: str,
    url: Optional[str],
    filing_type: str,
) -> List[str]:
    """
    When an SEC filing URL is processed and the filing type is one that
    likely contains regulatory info, run the EDGAR regulatory extraction.
    """
    if not url or not deal_id:
        return []

    # Only run for filing types that carry regulatory content
    relevant_types = {"prem14a", "defm14a", "s4", "f4", "sc13e3", "8k"}
    ft_norm = filing_type.upper().replace("-", "").replace(" ", "").replace("_", "").lower()
    if ft_norm not in relevant_types:
        return []

    from generate_regulatory import process_edgar_filing

    try:
        diff = process_edgar_filing(deal_id, url)
        actions = []
        if diff.get("added"):
            actions.append(f"SEC({filing_type}) → regulatory: added {diff['added']}")
        if diff.get("status_changes"):
            actions.append(
                f"SEC({filing_type}) → regulatory: "
                f"{len(diff['status_changes'])} status updates"
            )
        return actions
    except Exception as e:
        logger.warning("[propagation] Regulatory extraction failed for %s: %s", url, e)
        return [f"SEC regulatory extraction skipped: {e}"]


def _sync_proxy_to_regulatory(deal_id: str) -> List[str]:
    """
    Read the most recent proxy analysis TXT for this deal.
    Extract regulatory-relevant sections (HSR, Other Regulatory, Closing,
    Conditions, and Q&A items mentioning regulatory) and send to Claude
    for structured approval extraction.
    """
    from pathlib import Path
    from proxy_analysis_processor import parse_proxy_txt, PROXY_ANALYSIS_DIR
    from generate_regulatory import extract_approvals, merge_approvals

    deal_dir = PROXY_ANALYSIS_DIR / deal_id
    if not deal_dir.exists():
        return []

    # Find most recent proxy file
    proxy_files = sorted(deal_dir.glob("*.txt"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not proxy_files:
        return []

    # Collect regulatory text from all proxy files (may have summary + changes)
    reg_text_parts = []
    for pf in proxy_files:
        parsed = parse_proxy_txt(str(pf))
        _reg_section_names = {"hsr", "other regulatory", "closing", "conditions",
                              "conditions to closing"}

        # Sections (from changes files)
        for section in parsed.get("sections", []):
            name_lower = section.get("name", "").lower()
            if name_lower in _reg_section_names and section.get("has_changes"):
                raw = section.get("raw_text", "")
                if raw:
                    reg_text_parts.append(f"[{section['name']}]\n{raw}")

        # Q&A items mentioning regulatory
        for qa in parsed.get("qa_items", []):
            q = qa.get("question", "").lower()
            a = qa.get("answer", "")
            if any(kw in q for kw in ("regulatory", "antitrust", "hsr", "approval",
                                       "clearance", "competition", "cfius")):
                reg_text_parts.append(f"Q: {qa['question']}\nA: {a}")

        # Detail sections mentioning regulatory (from fulsome summaries)
        for ds in parsed.get("detail_sections", []):
            title_lower = ds.get("title", "").lower()
            if any(kw in title_lower for kw in ("regulatory", "antitrust", "condition",
                                                  "closing", "hsr")):
                content = ds.get("content", "")
                if content:
                    reg_text_parts.append(f"[{ds['title']}]\n{content}")

        # Overview may mention regulatory info
        overview = parsed.get("overview", "")
        if overview and any(kw in overview.lower() for kw in ("regulatory", "hsr",
                                                                "antitrust", "clearance")):
            reg_text_parts.append(f"[Overview]\n{overview}")

    if not reg_text_parts:
        return []

    combined_text = "\n\n".join(reg_text_parts)
    if len(combined_text.strip()) < 50:
        return []

    try:
        approvals = extract_approvals(combined_text, "proxy")
    except Exception as e:
        logger.warning("[propagation] Proxy regulatory extraction failed: %s", e)
        return [f"Proxy regulatory extraction skipped: {e}"]

    if not approvals:
        return []

    proxy_summary = {
        "text": combined_text[:500],
        "L1": f"Proxy Analysis — {deal_id}",
        "L2": combined_text[:300] if len(combined_text) > 50 else combined_text,
    }

    diff = merge_approvals(
        deal_id=deal_id,
        new_list=approvals,
        source_doc="Proxy Analysis",
        source_doc_type="proxy",
        source_doc_date=date.today().isoformat(),
        source_url=None,
        doc_summary=proxy_summary,
    )

    actions = []
    if diff.get("added"):
        actions.append(f"Proxy → regulatory: added {diff['added']}")
    if diff.get("status_changes"):
        actions.append(f"Proxy → regulatory: {len(diff['status_changes'])} status updates")
    if diff.get("date_updates"):
        actions.append(f"Proxy → regulatory: {len(diff['date_updates'])} date updates")
    return actions


def _sync_sec_summaries_to_regulatory(deal_id: str) -> List[str]:
    """
    Read SEC filing summaries (8K, 6K, etc.) for this deal's ticker.
    If any contain regulatory_notes, remaining_conditions, or
    cross_border_considerations, extract approvals and merge.
    """
    import json
    from pathlib import Path
    from generate_regulatory import extract_approvals, merge_approvals

    # Find deal ticker — avoid circular import from main
    import json as _json
    deals_path = Path(__file__).parent.parent / "data" / "deals.json"
    ticker = ""
    if deals_path.exists():
        deals_data = _json.loads(deals_path.read_text())
        deals_list = deals_data.get("deals", deals_data) if isinstance(deals_data, dict) else deals_data
        for d in deals_list:
            did = d.get("deal_id") or d.get("id", "")
            if did == deal_id:
                ticker = (d.get("target_ticker") or "").lower()
                break
    if not ticker:
        # Try timeline JSON for ticker
        tl_path = Path(__file__).parent / "data" / "timelines" / f"{deal_id}.json"
        if tl_path.exists():
            tl = _json.loads(tl_path.read_text())
            ticker = (tl.get("target_ticker") or "").lower()
    if not ticker:
        return []

    sec_dir = Path(__file__).parent / "data" / "sec_filings" / ticker
    # Also check shared 8K Test output directory
    shared_output_dir = Path(__file__).parent.parent.parent / "8K Test" / "Output Summaries"

    # Collect filing summaries from multiple locations
    summaries = []  # list of (summary_dict, form_type, url, filing_date_raw)

    # 1. Per-ticker sec_filings directory
    if sec_dir.exists():
        index_path = sec_dir / "filing_index.json"
        if index_path.exists():
            index_data = _json.loads(index_path.read_text())
            for filing in index_data.get("results", []):
                summary = filing.get("summary", {})
                summaries.append((
                    summary,
                    filing.get("form_type") or summary.get("filing_type") or "SEC",
                    filing.get("url"),
                    filing.get("date") or summary.get("filing_date") or "",
                ))

        for jf in sec_dir.glob("*_summary_*.json"):
            if jf.name == "filing_index.json":
                continue
            try:
                summary = _json.loads(jf.read_text())
                summaries.append((
                    summary,
                    summary.get("filing_type") or jf.name.split("_")[0].upper(),
                    None,
                    summary.get("filing_date") or "",
                ))
            except Exception:
                continue

    # 2. Shared 8K Test output directory — match by ticker in filename or content
    if shared_output_dir.exists():
        ticker_upper = ticker.upper()
        for jf in shared_output_dir.glob("*_summary_*.json"):
            try:
                summary = _json.loads(jf.read_text())
                if summary.get("ticker", "").upper() == ticker_upper:
                    summaries.append((
                        summary,
                        summary.get("filing_type") or jf.name.split("_")[0].upper(),
                        None,
                        summary.get("filing_date") or "",
                    ))
            except Exception:
                continue
        # Check company subdirectories too
        for subdir in shared_output_dir.iterdir():
            if not subdir.is_dir():
                continue
            for jf in subdir.glob("*_summary_*.json"):
                try:
                    summary = _json.loads(jf.read_text())
                    if summary.get("ticker", "").upper() == ticker_upper:
                        summaries.append((
                            summary,
                            summary.get("filing_type") or jf.name.split("_")[0].upper(),
                            None,
                            summary.get("filing_date") or "",
                        ))
                except Exception:
                    continue

    if not summaries:
        return []

    all_actions = []
    for summary, form_type, filing_url, filing_date_raw in summaries:
        l3 = summary.get("L3_detailed", {})
        if not l3 or not isinstance(l3, dict):
            continue

        # Collect regulatory-relevant fields
        parts = []
        for field in ("regulatory_notes", "remaining_conditions",
                      "cross_border_considerations", "regulatory_mentions"):
            val = l3.get(field)
            if val:
                if isinstance(val, list):
                    parts.append(f"{field}: " + "; ".join(str(v) for v in val))
                else:
                    parts.append(f"{field}: {val}")

        # Also check risks_flagged for regulatory mentions
        risks = l3.get("risks_flagged", [])
        if isinstance(risks, list):
            reg_risks = [r for r in risks if isinstance(r, str) and
                         any(kw in r.lower() for kw in ("regulatory", "hsr", "antitrust",
                                                         "cfius", "competition", "approval"))]
            if reg_risks:
                parts.append("regulatory risks: " + "; ".join(reg_risks))

        # Check L2_brief for regulatory mentions too
        l2 = summary.get("L2_brief", "")
        if l2 and any(kw in l2.lower() for kw in ("regulatory", "hsr", "cfius",
                                                     "antitrust", "competition authority")):
            parts.append(f"filing summary: {l2}")

        if not parts:
            continue

        combined = "\n".join(parts)
        if len(combined.strip()) < 50:
            continue

        try:
            approvals = extract_approvals(combined, form_type)
        except Exception as e:
            logger.warning("[propagation] SEC summary extraction failed for %s: %s",
                          form_type, e)
            continue

        if not approvals:
            continue

        # Normalize date format (MM/DD/YY → YYYY-MM-DD)
        filing_date = date.today().isoformat()
        if filing_date_raw:
            parts_d = filing_date_raw.replace("-", "/").split("/")
            if len(parts_d) == 3:
                m, d, y = parts_d
                if len(y) == 2:
                    y = "20" + y
                try:
                    filing_date = f"{y}-{m.zfill(2)}-{d.zfill(2)}"
                except Exception:
                    pass

        sec_summary = {
            "L1": summary.get("L1_headline") or f"{form_type} filing",
            "L2": summary.get("L2_brief") or combined,
            "L3": summary.get("L3_detailed"),
            "text": combined[:500],
        }

        diff = merge_approvals(
            deal_id=deal_id,
            new_list=approvals,
            source_doc=f"{form_type} {filing_date}",
            source_doc_type=form_type,
            source_doc_date=filing_date,
            source_url=filing_url,
            doc_summary=sec_summary,
        )

        if diff.get("added"):
            all_actions.append(f"SEC({form_type}) → regulatory: added {diff['added']}")
        if diff.get("status_changes"):
            all_actions.append(
                f"SEC({form_type}) → regulatory: {len(diff['status_changes'])} status updates"
            )
        if diff.get("date_updates"):
            all_actions.append(
                f"SEC({form_type}) → regulatory: {len(diff['date_updates'])} date updates"
            )

    return all_actions


# ── SEC Filing → Timeline Tracking bridge ────────────────────────────────────

# Maps SEC form types (normalized) to timeline trigger keys
_FORM_TYPE_TO_TRIGGER = {
    "s4":       "s4_filed",
    "s4a":      "s4_filed",
    "s4/a":     "s4_filed",
    "f4":       "s4_filed",       # Foreign equivalent of S-4
    "f4a":      "s4_filed",
    "f4/a":     "s4_filed",
    "prem14a":  "proxy_filed",
    "defm14a":  "proxy_filed",
    "sc13e3":   "13e3_filed",
    "sc13e-3":  "13e3_filed",
}


def _normalize_form_type(ft: str) -> str:
    """Normalize SEC form type for matching: lowercase, strip spaces/hyphens."""
    return ft.lower().replace(" ", "").replace("-", "").replace("_", "")


def _load_tracking_json(deal_id: str) -> dict:
    """Load tracking JSON directly (avoids circular import from main)."""
    import json
    from pathlib import Path
    p = Path(__file__).parent / "data" / "timelines" / f"{deal_id}_tracking.json"
    if p.exists():
        return json.loads(p.read_text())
    return {"events": {}}


def _save_tracking_json(deal_id: str, data: dict) -> None:
    """Save tracking JSON directly."""
    import json
    from pathlib import Path
    p = Path(__file__).parent / "data" / "timelines" / f"{deal_id}_tracking.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2))


def _sync_sec_filing_to_tracking(
    deal_id: str,
    filing_type: str,
    filing_date: Optional[str],
    url: Optional[str],
) -> List[str]:
    """
    When an SEC filing is processed, check if its form type maps to a
    timeline trigger key. If so, write the filing date to tracking.
    Only writes if the trigger key is not already populated (don't overwrite).
    """
    if not deal_id or not filing_type:
        return []

    ft_norm = _normalize_form_type(filing_type)
    trigger_key = _FORM_TYPE_TO_TRIGGER.get(ft_norm)
    if not trigger_key:
        return []

    # Need a date — if not passed, try to extract from URL or use today
    if not filing_date:
        import re
        if url:
            m = re.search(r'(\d{4})-?(\d{2})-?(\d{2})', url)
            if m:
                filing_date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        if not filing_date:
            filing_date = date.today().isoformat()

    # Check if timeline exists for this deal
    from pathlib import Path
    tl_path = Path(__file__).parent / "data" / "timelines" / f"{deal_id}.json"
    if not tl_path.exists():
        return []

    tracking = _load_tracking_json(deal_id)
    events = tracking.setdefault("events", {})

    # Don't overwrite an existing trigger date
    if trigger_key in events and events[trigger_key].get("date"):
        return []

    source_label = f"{filing_type} ({filing_date})"
    if url:
        # Extract short accession reference from URL
        import re
        acc_match = re.search(r'/(\d{10}-\d{2}-\d{6})/', url)
        if acc_match:
            source_label = f"{filing_type} (SEC {acc_match.group(1)})"

    events[trigger_key] = {
        "date": filing_date,
        "source": source_label,
    }
    _save_tracking_json(deal_id, tracking)
    logger.info("[propagation] SEC %s → tracking[%s] = %s for %s",
                filing_type, trigger_key, filing_date, deal_id)
    return [f"SEC({filing_type}) → tracking: set {trigger_key} = {filing_date}"]


def _find_deal_ticker(deal_id: str) -> str:
    """Look up target ticker for a deal from deals.json or timeline JSON."""
    import json as _json
    from pathlib import Path

    deals_path = Path(__file__).parent.parent / "data" / "deals.json"
    if deals_path.exists():
        deals_data = _json.loads(deals_path.read_text())
        deals_list = deals_data.get("deals", deals_data) if isinstance(deals_data, dict) else deals_data
        for d in deals_list:
            did = d.get("deal_id") or d.get("id", "")
            if did == deal_id:
                return (d.get("target_ticker") or "").lower()
    tl_path = Path(__file__).parent / "data" / "timelines" / f"{deal_id}.json"
    if tl_path.exists():
        tl = _json.loads(tl_path.read_text())
        return (tl.get("target_ticker") or "").lower()
    return ""


def _sync_all_sec_filings_to_tracking(deal_id: str) -> List[str]:
    """
    Scan all existing SEC filings for a deal and auto-populate
    timeline tracking triggers. Two passes:
      1. Direct form-type matching (S-4, PREM14A, etc. → trigger key)
      2. Content-based date extraction from ALL filing summaries
         (8-K, 425, 10-K, 10-Q, DEFA14A, etc.) for HSR, S-4,
         proxy, and regulatory milestone dates mentioned in text.
    """
    import json as _json
    from pathlib import Path

    ticker = _find_deal_ticker(deal_id)
    if not ticker:
        return []

    sec_dir = Path(__file__).parent / "data" / "sec_filings" / ticker
    if not sec_dir.exists():
        return []

    index_path = sec_dir / "filing_index.json"
    if not index_path.exists():
        return []

    index_data = _json.loads(index_path.read_text())
    all_actions = []

    # Pass 1: Direct form-type matching
    for filing in index_data.get("results", []):
        form_type = filing.get("form_type", "")
        filing_date = filing.get("date") or (filing.get("summary", {}) or {}).get("filing_date")
        url = filing.get("url")
        actions = _sync_sec_filing_to_tracking(deal_id, form_type, filing_date, url)
        all_actions.extend(actions)

    # Pass 2: Content-based date extraction from summary text fields
    all_actions += _extract_milestone_dates_from_summaries(deal_id, index_data)

    return all_actions


def _extract_milestone_dates_from_summaries(deal_id: str, index_data: dict) -> List[str]:
    """
    Scan the text fields of all SEC filing summaries for milestone dates.
    Extracts HSR filing/clearance, S-4 filing/effectiveness, proxy dates,
    shareholder meeting dates, etc. from any filing type (8-K, 425, 10-K,
    10-Q, DEFA14A, SC TO-T, SC 14D-9, etc.).
    """
    import re
    from pathlib import Path

    tl_path = Path(__file__).parent / "data" / "timelines" / f"{deal_id}.json"
    if not tl_path.exists():
        return []

    tracking = _load_tracking_json(deal_id)
    events = tracking.setdefault("events", {})
    actions = []

    _DATE_PAT = r'(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}'
    # Also handle MM/DD/YY and YYYY-MM-DD formats
    _DATE_PAT_SHORT = r'\d{2}/\d{2}/\d{2,4}'
    _DATE_PAT_ISO = r'\d{4}-\d{2}-\d{2}'

    def _parse_date(text_date: str) -> Optional[str]:
        """Try to parse various date formats to YYYY-MM-DD."""
        from datetime import datetime as _dt
        for fmt in ("%B %d, %Y", "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
            try:
                return _dt.strptime(text_date.strip(), fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        return None

    # Collect all text from all filing summaries
    text_chunks = []  # (text, form_type, filing_date)
    for filing in index_data.get("results", []):
        summary = filing.get("summary", {})
        if not summary or not isinstance(summary, dict):
            continue
        form_type = filing.get("form_type", "")
        filing_date_raw = filing.get("date") or summary.get("filing_date", "")

        # Collect text from relevant fields
        fields_to_scan = [
            "L2_brief",
            "deal_status_update", "regulatory_update", "timeline_update",
            "shareholder_vote_info", "terms_update",
        ]
        parts = []
        for field in fields_to_scan:
            val = summary.get(field) or ""
            if not val:
                # Check nested L3_detailed
                l3 = summary.get("L3_detailed", {})
                if isinstance(l3, dict):
                    val = l3.get(field, "")
            if val:
                parts.append(val)

        # Also check remaining_conditions, regulatory_notes
        l3 = summary.get("L3_detailed", {})
        if isinstance(l3, dict):
            for field in ("remaining_conditions", "regulatory_notes",
                          "regulatory_mentions", "deal_status_update",
                          "regulatory_update", "shareholder_vote_info"):
                val = l3.get(field)
                if val:
                    if isinstance(val, list):
                        parts.extend(str(v) for v in val)
                    else:
                        parts.append(str(val))

        if parts:
            text_chunks.append(("\n".join(parts), form_type, filing_date_raw))

    if not text_chunks:
        return actions

    # Combine all text for pattern matching
    all_text = "\n".join(chunk[0] for chunk in text_chunks)

    # ── HSR filed ──
    if not events.get("hsr_filed", {}).get("date"):
        hsr_patterns = [
            rf'(?:filed|submitted)\s+(?:their\s+)?(?:pre-merger\s+)?(?:HSR|Hart[- ]Scott[- ]Rodino)\s+(?:Act\s+)?(?:notifications?|filings?)\s+(?:on|dated?)\s+({_DATE_PAT})',
            rf'HSR\s+Act\s+(?:notifications?|filings?)\s+(?:on|dated?)\s+({_DATE_PAT})',
            rf'HSR\s+(?:filings?\s+)?(?:were\s+)?(?:made|submitted|filed)\s+(?:on\s+)?({_DATE_PAT})',
        ]
        for pat in hsr_patterns:
            m = re.search(pat, all_text, re.IGNORECASE)
            if m:
                d = _parse_date(m.group(1))
                if d:
                    events["hsr_filed"] = {"date": d, "source": "SEC filing summary"}
                    actions.append(f"SEC summary → tracking: set hsr_filed = {d}")
                    break

    # ── HSR clearance / early termination ──
    if not events.get("hsr_cleared", {}).get("date"):
        hsr_clear_patterns = [
            rf'(?:HSR|Hart[- ]Scott[- ]Rodino)\s+(?:Act\s+)?(?:waiting\s+period\s+)?(?:expired|terminated|early\s+termination\s+(?:was\s+)?granted)\s+(?:on\s+)?({_DATE_PAT})',
            rf'(?:early\s+termination|clearance)\s+(?:of\s+)?(?:the\s+)?(?:HSR|Hart[- ]Scott[- ]Rodino)\s+(?:Act\s+)?(?:waiting\s+period\s+)?(?:was\s+)?(?:granted|received|obtained)\s+(?:on\s+)?({_DATE_PAT})',
            rf'waiting\s+period\s+(?:under\s+the\s+)?(?:HSR|Hart[- ]Scott[- ]Rodino)\s+(?:Act\s+)?(?:expired|terminated)\s+(?:on\s+)?({_DATE_PAT})',
        ]
        for pat in hsr_clear_patterns:
            m = re.search(pat, all_text, re.IGNORECASE)
            if m:
                d = _parse_date(m.group(1))
                if d:
                    events["hsr_cleared"] = {"date": d, "source": "SEC filing summary"}
                    # Also set reg_hsr_act if not already set
                    if not events.get("reg_hsr_act", {}).get("date"):
                        events["reg_hsr_act"] = {"date": d, "source": "SEC filing summary"}
                        actions.append(f"SEC summary → tracking: set reg_hsr_act = {d}")
                    actions.append(f"SEC summary → tracking: set hsr_cleared = {d}")
                    break

    # ── S-4 / F-4 filed ──
    if not events.get("s4_filed", {}).get("date"):
        s4_patterns = [
            rf'(?:filed|submitted)\s+(?:a\s+)?(?:registration\s+statement\s+on\s+)?Form\s+[SF]-4\s+(?:with\s+the\s+SEC\s+)?(?:on|dated?|as\s+of)\s+({_DATE_PAT})',
            rf'Form\s+[SF]-4\s+(?:registration\s+statement\s+)?(?:including\s+.*?\s+)?(?:was\s+)?(?:filed|submitted)\s+(?:with\s+the\s+SEC\s+)?(?:on|dated?|as\s+of)\s+({_DATE_PAT})',
            rf'[SF]-4\s+(?:registration\s+statement\s+)?(?:was\s+)?filed\s+(?:with\s+the\s+SEC\s+)?(?:on\s+)?({_DATE_PAT})',
        ]
        for pat in s4_patterns:
            m = re.search(pat, all_text, re.IGNORECASE)
            if m:
                d = _parse_date(m.group(1))
                if d:
                    events["s4_filed"] = {"date": d, "source": "SEC filing summary"}
                    actions.append(f"SEC summary → tracking: set s4_filed = {d}")
                    break

    # ── S-4 declared effective ──
    if not events.get("s4_effective", {}).get("date"):
        s4_eff_patterns = [
            rf'[SF]-4\s+(?:registration\s+statement\s+)?(?:was\s+)?(?:declared\s+)?effective\s+(?:on|by\s+the\s+SEC\s+on)\s+({_DATE_PAT})',
            rf'(?:registration\s+statement\s+)?(?:on\s+Form\s+[SF]-4\s+)?(?:became|declared)\s+effective\s+(?:on\s+)?({_DATE_PAT})',
        ]
        for pat in s4_eff_patterns:
            m = re.search(pat, all_text, re.IGNORECASE)
            if m:
                d = _parse_date(m.group(1))
                if d:
                    events["s4_effective"] = {"date": d, "source": "SEC filing summary"}
                    actions.append(f"SEC summary → tracking: set s4_effective = {d}")
                    break

    # ── Proxy mailed ──
    if not events.get("proxy_mailed", {}).get("date"):
        proxy_mail_patterns = [
            rf'(?:proxy\s+(?:statement|materials?)|prospectus)\s+(?:was\s+|were\s+)?(?:mailed|sent|distributed)\s+(?:to\s+(?:stock|share)holders\s+)?(?:on\s+)?({_DATE_PAT})',
            rf'(?:mailed|sent|distributed)\s+(?:the\s+)?(?:proxy|definitive\s+proxy)\s+(?:statement\s+)?(?:to\s+(?:stock|share)holders\s+)?(?:on\s+)?({_DATE_PAT})',
        ]
        for pat in proxy_mail_patterns:
            m = re.search(pat, all_text, re.IGNORECASE)
            if m:
                d = _parse_date(m.group(1))
                if d:
                    events["proxy_mailed"] = {"date": d, "source": "SEC filing summary"}
                    actions.append(f"SEC summary → tracking: set proxy_mailed = {d}")
                    break

    # ── Shareholder meeting date ──
    if not events.get("shareholder_meeting", {}).get("date"):
        meeting_patterns = [
            rf'(?:special|annual)\s+meeting\s+(?:of\s+(?:stock|share)holders\s+)?(?:is\s+)?(?:scheduled\s+for|set\s+for|will\s+be\s+held\s+on|to\s+be\s+held\s+on)\s+({_DATE_PAT})',
            rf'(?:stock|share)holder\s+(?:meeting|vote)\s+(?:is\s+)?(?:scheduled\s+for|set\s+for|on)\s+({_DATE_PAT})',
        ]
        for pat in meeting_patterns:
            m = re.search(pat, all_text, re.IGNORECASE)
            if m:
                d = _parse_date(m.group(1))
                if d:
                    events["shareholder_meeting"] = {"date": d, "source": "SEC filing summary"}
                    actions.append(f"SEC summary → tracking: set shareholder_meeting = {d}")
                    break

    # ── Record date ──
    if not events.get("record_date", {}).get("date"):
        record_patterns = [
            rf'record\s+date\s+(?:of|is|has\s+been\s+set\s+(?:as|for))\s+({_DATE_PAT})',
            rf'(?:stock|share)holders\s+of\s+record\s+(?:as\s+of|on)\s+({_DATE_PAT})',
        ]
        for pat in record_patterns:
            m = re.search(pat, all_text, re.IGNORECASE)
            if m:
                d = _parse_date(m.group(1))
                if d:
                    events["record_date"] = {"date": d, "source": "SEC filing summary"}
                    actions.append(f"SEC summary → tracking: set record_date = {d}")
                    break

    if actions:
        _save_tracking_json(deal_id, tracking)

    return actions


def _sync_proxy_dates_to_tracking(deal_id: str) -> List[str]:
    """
    Parse proxy analysis text for key filing dates (HSR filed, S-4 filed, etc.)
    and auto-populate the tracking layer. This catches dates mentioned in the
    proxy statement itself, e.g. "Both parties filed HSR Act notifications on
    February 13, 2026" or "preliminary proxy statement dated February 27, 2026".
    """
    import re
    from pathlib import Path
    from proxy_analysis_processor import PROXY_ANALYSIS_DIR

    deal_dir = PROXY_ANALYSIS_DIR / deal_id
    if not deal_dir.exists():
        return []

    proxy_files = sorted(deal_dir.glob("*.txt"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not proxy_files:
        return []

    # Read the most recent proxy file
    text = proxy_files[0].read_text()

    # Check if timeline exists
    tl_path = Path(__file__).parent / "data" / "timelines" / f"{deal_id}.json"
    if not tl_path.exists():
        return []

    tracking = _load_tracking_json(deal_id)
    events = tracking.setdefault("events", {})
    actions = []

    # Date pattern: "Month DD, YYYY" or "Month D, YYYY"
    _DATE_PATTERN = r'(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}'

    # ── HSR filing date ──
    if "hsr_filed" not in events or not events.get("hsr_filed", {}).get("date"):
        # Look for patterns like "filed HSR Act notifications on February 13, 2026"
        hsr_match = re.search(
            rf'(?:filed|submitted)\s+(?:their\s+)?(?:pre-merger\s+)?(?:HSR|Hart[- ]Scott[- ]Rodino)\s+'
            rf'(?:Act\s+)?(?:notifications?|filings?|forms?)\s+(?:on|dated?)\s+'
            rf'({_DATE_PATTERN})',
            text, re.IGNORECASE
        )
        if not hsr_match:
            # Also try: "HSR Act notifications on DATE"
            hsr_match = re.search(
                rf'HSR\s+Act\s+(?:notifications?|filings?)\s+(?:on|dated?)\s+({_DATE_PATTERN})',
                text, re.IGNORECASE
            )
        if hsr_match:
            from datetime import datetime as _dt
            try:
                hsr_date = _dt.strptime(hsr_match.group(1), "%B %d, %Y").strftime("%Y-%m-%d")
                events["hsr_filed"] = {"date": hsr_date, "source": "Proxy analysis"}
                actions.append(f"Proxy → tracking: set hsr_filed = {hsr_date}")
            except ValueError:
                pass

    # ── S-4 / proxy filing date ──
    # The proxy file itself is the proxy statement, so its date IS the proxy filing date
    if "proxy_filed" not in events or not events.get("proxy_filed", {}).get("date"):
        # Look for "preliminary proxy statement dated DATE" or "proxy statement/prospectus dated DATE"
        proxy_date_match = re.search(
            rf'(?:preliminary\s+)?proxy\s+statement(?:/prospectus)?\s+(?:dated|filed\s+on)\s+'
            rf'({_DATE_PATTERN})',
            text, re.IGNORECASE
        )
        if proxy_date_match:
            from datetime import datetime as _dt
            try:
                proxy_date = _dt.strptime(proxy_date_match.group(1), "%B %d, %Y").strftime("%Y-%m-%d")
                events["proxy_filed"] = {"date": proxy_date, "source": "Proxy analysis"}
                actions.append(f"Proxy → tracking: set proxy_filed = {proxy_date}")
            except ValueError:
                pass

    # For S-4 deals: look for explicit S-4 filing dates, or infer from proxy date
    if "s4_filed" not in events or not events.get("s4_filed", {}).get("date"):
        s4_date_found = None

        # Try explicit S-4 filing date patterns
        s4_match = re.search(
            rf'(?:filed|submitted)\s+(?:a\s+)?(?:registration\s+statement\s+on\s+)?'
            rf'Form\s+S-4\s+(?:with\s+the\s+SEC\s+)?(?:on|dated?)\s+'
            rf'({_DATE_PATTERN})',
            text, re.IGNORECASE
        )
        if not s4_match:
            s4_match = re.search(
                rf'S-4\s+(?:registration\s+statement\s+)?(?:including\s+.*?\s+)?'
                rf'(?:was\s+)?(?:filed|submitted)\s+(?:with\s+the\s+SEC\s+)?(?:on|dated?)\s+'
                rf'({_DATE_PATTERN})',
                text, re.IGNORECASE
            )
        if s4_match:
            from datetime import datetime as _dt
            try:
                s4_date_found = _dt.strptime(s4_match.group(1), "%B %d, %Y").strftime("%Y-%m-%d")
            except ValueError:
                pass

        # If no explicit S-4 date but deal requires S-4 and we found a proxy date,
        # the proxy statement IS the S-4 (proxy/prospectus is part of the S-4 filing)
        if not s4_date_found and events.get("proxy_filed", {}).get("date"):
            import json as _json
            tl = _json.loads(tl_path.read_text())
            if tl.get("requires_s4"):
                s4_date_found = events["proxy_filed"]["date"]

        if s4_date_found:
            events["s4_filed"] = {"date": s4_date_found, "source": "Proxy analysis"}
            actions.append(f"Proxy → tracking: set s4_filed = {s4_date_found}")

    if actions:
        _save_tracking_json(deal_id, tracking)

    return actions
