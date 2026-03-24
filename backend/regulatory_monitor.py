"""
Regulatory Monitoring Pipeline

Three-stage intelligent document processing for merger regulatory approvals:
  1. TRIAGE  — cheap model check: is this doc relevant?
  2. SCOPE   — which of the 37 master approval types does this doc touch?
  3. MONITOR — per-approval, state-aware extraction with conflict detection

Builds on the existing generate_regulatory.py infrastructure (merge_approvals,
save_regulatory, load_regulatory) but adds master-file state-machine intelligence.

Usage:
    from regulatory_monitor import run_monitoring_pipeline
    result = run_monitoring_pipeline(deal_id, doc_url, doc_type, doc_date)
"""

import json
import os
import re
import uuid
from datetime import datetime, date
from pathlib import Path
from typing import Optional

from approval_master import (
    get_approval,
    get_all_for_scoping,
    get_status_states,
    get_key_questions,
    get_monitoring_info,
    get_tracker_fields,
    filter_key_questions,
    map_existing_to_master,
    map_master_to_existing,
    master_status_to_legacy,
    find_status_index,
)
from generate_regulatory import (
    load_regulatory,
    save_regulatory,
    _approval_id,
    _filing_key,
    _write_tracking_date,
    TIMELINES_DIR,
)

# ── Path & env setup ────────────────────────────────────────────────────────

_BACKEND_DIR = Path(__file__).parent
_ENV_PATH = _BACKEND_DIR.parent.parent / ".env"


# ── Monitor-specific storage (separate from legacy regulatory file) ──────────

def _monitor_path(deal_id: str) -> Path:
    return TIMELINES_DIR / f"{deal_id}_regulatory_monitor.json"


def load_monitor_regulatory(deal_id: str) -> dict:
    p = _monitor_path(deal_id)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {
        "deal_id": deal_id,
        "last_updated": date.today().isoformat(),
        "approvals": [],
        "documents_processed": [],
        "documents_triaged": [],
        "change_log": [],
    }


def save_monitor_regulatory(deal_id: str, data: dict) -> None:
    TIMELINES_DIR.mkdir(parents=True, exist_ok=True)
    data["last_updated"] = date.today().isoformat()
    _monitor_path(deal_id).write_text(json.dumps(data, indent=2), encoding="utf-8")

try:
    from dotenv import load_dotenv
    load_dotenv(_ENV_PATH)
except ImportError:
    pass

# ── Document type classification ─────────────────────────────────────────────

_ALWAYS_IRRELEVANT = {"Form 4", "Form 3", "Form 3/A", "Form 4/A",
                       "SC 13G", "SC 13G/A", "Form 144"}
_ALWAYS_RELEVANT = {"PREM14A", "DEFM14A", "S-4", "S-4/A", "F-4", "F-4/A",
                     "SC 13E-3", "SC TO-T", "SC TO-T/A"}
_NEEDS_TRIAGE = {"8-K", "8-K/A", "6-K", "6-K/A", "10-Q", "10-K", "425",
                  "DEFA14A", "DEFA14C", "press_release", "news_article"}


# ── Stage 1: TRIAGE ─────────────────────────────────────────────────────────

def triage_document(
    text_preview: str,
    doc_type: str,
    deal_name: str = "",
    target: str = "",
    acquirer: str = "",
) -> dict:
    """
    Quick relevance check. Returns:
        {
            "relevant": bool,
            "reason": str,
            "confidence": float,
            "skipped": bool,       # True if pre-filtered (no LLM call)
            "model_used": str|None
        }
    """
    # Pre-filter: always irrelevant
    if doc_type in _ALWAYS_IRRELEVANT:
        return {
            "relevant": False,
            "reason": f"{doc_type} filings do not contain regulatory approval information",
            "confidence": 1.0,
            "skipped": True,
            "model_used": None,
        }

    # Pre-approve: always relevant
    if doc_type in _ALWAYS_RELEVANT:
        return {
            "relevant": True,
            "reason": f"{doc_type} filings typically contain regulatory approval details",
            "confidence": 1.0,
            "skipped": True,
            "model_used": None,
        }

    # LLM triage for ambiguous types
    if not text_preview or len(text_preview.strip()) < 50:
        return {
            "relevant": False,
            "reason": "Document text too short to analyze",
            "confidence": 0.5,
            "skipped": True,
            "model_used": None,
        }

    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic must be installed: pip install anthropic")

    client = anthropic.Anthropic()

    # Truncate preview to ~800 words for cheap triage
    words = text_preview.split()
    if len(words) > 800:
        text_preview = " ".join(words[:800])

    prompt = f"""You are screening a {doc_type} SEC filing for the {acquirer}/{target} merger deal.

Does this document contain ANY information about:
- Regulatory approvals (HSR, CFIUS, FCC, FERC, state PUC, international antitrust, etc.)
- Antitrust review status or decisions
- Government clearances or filings
- Shareholder vote details or proxy statement updates
- Closing conditions or deal status changes

Document text (preview):
{text_preview}

Respond with ONLY a JSON object (no markdown):
{{"relevant": true/false, "reason": "one sentence explanation"}}"""

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=100,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    raw = re.sub(r"^```json\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```\s*$", "", raw, flags=re.MULTILINE)

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        # Fallback: assume relevant if we can't parse
        return {
            "relevant": True,
            "reason": "Could not parse triage response — defaulting to relevant",
            "confidence": 0.3,
            "skipped": False,
            "model_used": "claude-haiku-4-5-20251001",
        }

    return {
        "relevant": bool(result.get("relevant", True)),
        "reason": result.get("reason", ""),
        "confidence": 0.8,
        "skipped": False,
        "model_used": "claude-haiku-4-5-20251001",
    }


# ── Stage 2: SCOPE ──────────────────────────────────────────────────────────

def scope_approvals(
    text: str,
    doc_type: str,
    deal_context: dict,
    existing_approval_ids: list[str],
) -> dict:
    """
    Identify which master approval types this document touches.

    Args:
        text: document text (full or relevant section)
        doc_type: SEC filing type
        deal_context: {target, acquirer, deal_type, sectors, ...}
        existing_approval_ids: master_ids already tracked for this deal

    Returns:
        {
            "applicable_ids": ["hsr_filing", "cfius_review"],
            "newly_discovered": ["uk_cma"],
            "evidence": {"hsr_filing": "Mentions HSR waiting period..."},
        }
    """
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic must be installed")

    # Build the scoping prompt
    scoping_data = get_all_for_scoping()
    target = deal_context.get("target", "target company")
    acquirer = deal_context.get("acquirer", "acquirer")

    # For initial scoping (no existing approvals), check all 37
    # For subsequent docs, focus on tracked + catch-all for new discoveries
    if existing_approval_ids:
        # Tracked approvals: full trigger detail
        tracked_section = []
        for sc in scoping_data:
            if sc["master_id"] in existing_approval_ids:
                signals = ", ".join(sc["signals_in_document"][:3])
                tracked_section.append(
                    f"- **{sc['name']}** (ID: {sc['master_id']}) [CURRENTLY TRACKED]\n"
                    f"  Trigger: {sc['trigger_question']}\n"
                    f"  Signals: {signals}"
                )
        # Untracked: just names for discovery
        untracked_names = [sc["name"] for sc in scoping_data
                           if sc["master_id"] not in existing_approval_ids]
        untracked_section = (
            f"Also check if ANY of these OTHER approval types are mentioned:\n"
            f"{', '.join(untracked_names)}"
        )
        approval_block = "\n\n".join(tracked_section) + "\n\n" + untracked_section
    else:
        # First-time scoping: all 37 with details
        lines = []
        for i, sc in enumerate(scoping_data, 1):
            signals = ", ".join(sc["signals_in_document"][:3])
            lines.append(
                f"{i}. **{sc['name']}** (ID: {sc['master_id']})\n"
                f"   Trigger: {sc['trigger_question']}\n"
                f"   Signals: {signals}"
            )
        approval_block = "\n\n".join(lines)

    # Cap text length
    words = text.split()
    if len(words) > 6000:
        text = " ".join(words[:6000])

    prompt = f"""You are analyzing a {doc_type} filing for the {acquirer} / {target} merger.

Determine which regulatory approval types from the list below are MENTIONED or RELEVANT in this document.

APPROVAL TYPES:
{approval_block}

DOCUMENT TEXT:
{text}

For each approval type that this document mentions or provides information about, return its ID and a brief evidence quote.

Respond with ONLY a valid JSON object (no markdown):
{{
  "applicable": [
    {{"master_id": "hsr_filing", "evidence": "brief quote or description"}},
    ...
  ]
}}

If the document doesn't mention any of these, return: {{"applicable": []}}"""

    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    raw = re.sub(r"^```json\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```\s*$", "", raw, flags=re.MULTILINE)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        print(f"[monitor] Could not parse scoping response: {raw[:200]}")
        return {"applicable_ids": [], "newly_discovered": [], "evidence": {}}

    applicable = parsed.get("applicable", [])
    applicable_ids = [a["master_id"] for a in applicable if "master_id" in a]
    evidence = {a["master_id"]: a.get("evidence", "") for a in applicable if "master_id" in a}
    newly_discovered = [mid for mid in applicable_ids if mid not in existing_approval_ids]

    return {
        "applicable_ids": applicable_ids,
        "newly_discovered": newly_discovered,
        "evidence": evidence,
    }


# ── Stage 3: MONITOR (per-approval, state-aware) ────────────────────────────

def monitor_single_approval(
    text: str,
    doc_type: str,
    doc_date: str,
    approval_state: dict,
    deal_context: dict,
) -> dict:
    """
    State-aware extraction for a single approval.

    Args:
        text: document text
        doc_type: filing type
        doc_date: YYYY-MM-DD
        approval_state: current approval from D###_regulatory.json
        deal_context: {target, acquirer, ...}

    Returns:
        {
            "master_id": "hsr_filing",
            "status_in_doc": "Cleared",
            "new_status": "Cleared" or None,
            "status_evidence": "...",
            "dates_found": {"clearance_date": "2026-03-01"},
            "key_findings": [{"question": "...", "answer": "..."}],
            "conditions": None,
            "confidence": 0.9,
        }
    """
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic must be installed")

    master_id = approval_state.get("master_id", "")
    master_def = get_approval(master_id) if master_id else None

    # Get current status (prefer status_detail, fall back to status)
    current_status = approval_state.get("status_detail") or approval_state.get("status", "pending")
    approval_name = (master_def or {}).get("name", approval_state.get("authority_short", "Unknown"))
    target = deal_context.get("target", "target")
    acquirer = deal_context.get("acquirer", "acquirer")

    # Build status states block
    if master_def:
        states = master_def.get("monitoring", {}).get("status_states", [])
        states_block = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(states))
        questions = filter_key_questions(master_id, current_status)
        questions_block = "\n".join(f"  - {q}" for q in questions)
        typical_timeline = master_def.get("monitoring", {}).get("typical_timeline", "")
        closing_trigger = master_def.get("monitoring", {}).get("closing_trigger", "")
        tracker_fields = get_tracker_fields(master_id)
        fields_block = ", ".join(tracker_fields) if tracker_fields else "filing_date, clearance_date, conditions, notes"
    else:
        states_block = "  (no defined progression — report any status found)"
        questions_block = "  - Has this approval been filed?\n  - Has clearance been granted?\n  - Are there any conditions or concerns?"
        typical_timeline = ""
        closing_trigger = ""
        fields_block = "filing_date, clearance_date, conditions, notes"

    # ── Build rich context about what we already know ──────────────────────
    filed_date = approval_state.get("filed_date", "unknown")
    cleared_date = approval_state.get("cleared_date", "unknown")
    last_source = approval_state.get("source_doc", "unknown")
    conditions = approval_state.get("conditions", "")
    notes = approval_state.get("notes", "")

    # Full master definition context — "the truth about this approval type"
    master_context_parts = []
    if master_def:
        desc = master_def.get("description", "")
        if desc:
            master_context_parts.append(f"WHAT THIS APPROVAL IS:\n{desc}")
        scoping = master_def.get("scoping", {})
        trigger = scoping.get("trigger_question", "")
        if trigger:
            master_context_parts.append(f"WHEN IT APPLIES:\n{trigger}")
        thresholds = scoping.get("threshold_details")
        if thresholds:
            thresh_str = ", ".join(f"{k}: {v}" for k, v in thresholds.items() if k != "note")
            note = thresholds.get("note", "")
            master_context_parts.append(f"THRESHOLDS: {thresh_str}" + (f" ({note})" if note else ""))
    master_context_block = "\n\n".join(master_context_parts) if master_context_parts else ""

    # Status history — "what we've learned from previous documents"
    history = approval_state.get("status_history", [])
    history_lines = []
    for h in history:
        h_status = h.get("status", "")
        h_date = h.get("date", "?")
        h_source = h.get("source_doc", "")
        h_excerpt = h.get("excerpt", "")
        line = f"  - [{h_date}] {h_status} (from {h_source})"
        if h_excerpt:
            line += f"\n    Evidence: \"{h_excerpt[:200]}\""
        history_lines.append(line)
    history_block = "\n".join(history_lines) if history_lines else "  (no previous updates — this is the first document)"

    # Tracker fields already populated
    tracker = approval_state.get("tracker_fields", {})
    tracker_lines = []
    for k, v in tracker.items():
        if v is not None:
            tracker_lines.append(f"  - {k.replace('_', ' ').title()}: {v}")
    tracker_context = "\n".join(tracker_lines) if tracker_lines else "  (none yet)"

    # Unresolved conflicts
    conflicts = [c for c in approval_state.get("conflicts", []) if not c.get("resolved")]
    conflict_lines = []
    for c in conflicts:
        conflict_lines.append(f"  - UNRESOLVED: Current \"{c.get('current_status')}\" vs. \"{c.get('conflicting_claim')}\" (from {c.get('source_doc')})")
    conflict_block = "\n".join(conflict_lines) if conflict_lines else ""

    # Cap text
    words = text.split()
    if len(words) > 4000:
        text = " ".join(words[:4000])

    prompt = f"""You are tracking the **{approval_name}** for the {acquirer} / {target} merger.

{"=" * 60}
REFERENCE: ABOUT THIS APPROVAL TYPE
{"=" * 60}
{master_context_block}

Typical timeline: {typical_timeline if typical_timeline else "N/A"}
Closing trigger: {closing_trigger if closing_trigger else "N/A"}

Valid status progression (in order):
{states_block}

{"=" * 60}
WHAT WE KNOW SO FAR (from previously processed documents)
{"=" * 60}
Current status: {current_status}
Filed date: {filed_date}
Cleared date: {cleared_date}
{f"Conditions: {conditions}" if conditions else ""}
{f"Notes: {notes[:300]}" if notes else ""}

Document history for this approval:
{history_block}

Key dates/fields tracked:
{tracker_context}
{f"{chr(10)}Open conflicts:{chr(10)}{conflict_block}" if conflict_block else ""}

{"=" * 60}
NEW DOCUMENT TO ANALYZE: {doc_type} (dated {doc_date})
{"=" * 60}

QUESTIONS TO ANSWER:
{questions_block}

FIELDS TO EXTRACT: {fields_block}

INSTRUCTIONS:
1. What is the status of this approval according to THIS document?
2. If the status has changed from "{current_status}", identify the new status from the progression above.
3. Extract any dates mentioned (filing date, clearance date, deadlines).
4. Quote the relevant excerpt (1-2 sentences max).
5. If the document CONTRADICTS the current status (e.g., says "pending" but current status is "cleared"), flag it as a conflict.
6. Consider the document date ({doc_date}) relative to previous updates — an older document may describe an earlier state that has since been superseded.

Respond with ONLY valid JSON (no markdown):
{{
  "status_in_doc": "the status as described in this document",
  "new_status": "new status from progression list" or null if unchanged,
  "status_evidence": "1-2 sentence quote from document",
  "dates_found": {{"field_name": "YYYY-MM-DD", ...}} or {{}},
  "key_findings": [{{"question": "...", "answer": "..."}}],
  "conditions": "any conditions or remedies mentioned" or null,
  "is_conflict": false,
  "conflict_detail": null,
  "confidence": 0.9
}}

DOCUMENT TEXT:
{text}"""

    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    raw = re.sub(r"^```json\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```\s*$", "", raw, flags=re.MULTILINE)

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        print(f"[monitor] Could not parse monitor response for {master_id}: {raw[:200]}")
        return {
            "master_id": master_id,
            "status_in_doc": None,
            "new_status": None,
            "status_evidence": "",
            "dates_found": {},
            "key_findings": [],
            "conditions": None,
            "confidence": 0.0,
            "is_conflict": False,
            "conflict_detail": None,
        }

    result["master_id"] = master_id
    return result


# ── Stage 3 (batched): ALL APPROVALS + DEAL-LEVEL IN ONE CALL ───────────────

def _build_approval_block(master_id: str, approval_state: dict) -> str:
    """Build a compact context block for one approval in the batched prompt."""
    master_def = get_approval(master_id) if master_id else None
    current_status = approval_state.get("status_detail") or approval_state.get("status", "pending")
    name = (master_def or {}).get("name", approval_state.get("authority_short", master_id))

    parts = [f"### {name} (ID: {master_id})"]

    # Description + key info from master
    if master_def:
        desc = master_def.get("description", "")
        if desc:
            parts.append(f"What it is: {desc[:200]}")
        states = master_def.get("monitoring", {}).get("status_states", [])
        if states:
            parts.append(f"Status progression: {' → '.join(states)}")
        timeline = master_def.get("monitoring", {}).get("typical_timeline", "")
        if timeline:
            parts.append(f"Typical timeline: {timeline}")
        questions = filter_key_questions(master_id, current_status)
        if questions:
            parts.append("Key questions: " + "; ".join(questions[:3]))
        fields = get_tracker_fields(master_id)
        if fields:
            parts.append(f"Fields to extract: {', '.join(fields)}")

    # Current state
    filed = approval_state.get("filed_date")
    cleared = approval_state.get("cleared_date")
    state_line = f"Current status: {current_status}"
    if filed:
        state_line += f" | Filed: {filed}"
    if cleared:
        state_line += f" | Cleared: {cleared}"
    parts.append(state_line)

    # Compact history (last 3 entries, no long excerpts)
    history = approval_state.get("status_history", [])
    if history:
        hist_items = []
        for h in history[-3:]:
            hist_items.append(f"[{h.get('date', '?')}] {h.get('status', '?')} (from {h.get('source_doc', '?')})")
        parts.append("History: " + " → ".join(hist_items))

    # Conflicts
    conflicts = [c for c in approval_state.get("conflicts", []) if not c.get("resolved")]
    if conflicts:
        for c in conflicts:
            parts.append(f"CONFLICT: \"{c.get('current_status')}\" vs \"{c.get('conflicting_claim')}\"")

    return "\n".join(parts)


def monitor_batch(
    text: str,
    doc_type: str,
    doc_date: str,
    approval_states: dict,  # {master_id: approval_state}
    deal_context: dict,
    previous_events: list,
) -> tuple:
    """
    Batched monitoring: all approvals + deal-level in a single LLM call.

    Returns:
        (approval_results: list[dict], deal_level: dict)
    """
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic must be installed")

    target = deal_context.get("target", "target")
    acquirer = deal_context.get("acquirer", "acquirer")
    current_expected = deal_context.get("expected_close", "unknown")

    # Build per-approval blocks
    approval_blocks = []
    master_ids_ordered = list(approval_states.keys())
    for mid in master_ids_ordered:
        block = _build_approval_block(mid, approval_states[mid])
        approval_blocks.append(block)

    approvals_section = "\n\n".join(approval_blocks)

    # Previous deal events (compact)
    prev_lines = []
    for e in previous_events[-10:]:
        prev_lines.append(f"  [{e.get('doc_date','?')}] {e.get('event_type','')}: {e.get('description','')}")
    prev_block = "\n".join(prev_lines) if prev_lines else "  (none)"

    # Cap text
    words = text.split()
    if len(words) > 5000:
        text = " ".join(words[:5000])

    prompt = f"""You are monitoring the {acquirer} / {target} merger. Analyze this {doc_type} (dated {doc_date}).

{"=" * 60}
PART A: REGULATORY APPROVALS TO MONITOR
{"=" * 60}

{approvals_section}

{"=" * 60}
PART B: DEAL-LEVEL CONTEXT
{"=" * 60}
Expected close: {current_expected}
Previous deal events:
{prev_block}

{"=" * 60}
DOCUMENT TEXT
{"=" * 60}
{text}

{"=" * 60}
INSTRUCTIONS
{"=" * 60}

For EACH approval listed above, determine:
1. What does this document say about its status? Use the status progression listed.
2. Has the status changed? If so, what is the new status?
3. Any dates mentioned (filing, clearance, deadlines)?
4. Brief evidence quote (1 sentence max).
5. Does it contradict the current status? Flag as conflict if so.

For DEAL-LEVEL, determine:
1. Has expected close timing changed from "{current_expected}"?
2. Any milestone updates (shareholder meeting, S-4, regulatory filings)?
3. Any material events (amendments, competing bids, litigation, MAE)?
4. Management commentary on deal progress?

If the document says NOTHING about a particular approval, include it with null values.

Respond with ONLY valid JSON (no markdown):
{{
  "approvals": [
    {{
      "master_id": "the_id",
      "status_in_doc": "status described" or null if not mentioned,
      "new_status": "new status from progression" or null,
      "status_evidence": "1 sentence quote" or null,
      "dates_found": {{}},
      "key_findings": [],
      "conditions": null,
      "is_conflict": false,
      "conflict_detail": null,
      "confidence": 0.0 to 1.0
    }}
  ],
  "deal_level": {{
    "expected_close": "updated" or null,
    "expected_close_changed": false,
    "timing_updates": [
      {{"item": "type", "detail": "what", "excerpt": "quote"}}
    ],
    "deal_events": [
      {{"event_type": "type", "description": "what", "date": "{doc_date}", "excerpt": "quote"}}
    ],
    "management_commentary": null
  }}
}}"""

    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    raw = re.sub(r"^```json\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```\s*$", "", raw, flags=re.MULTILINE)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        print(f"[monitor-batch] Could not parse response: {raw[:300]}")
        # Return empty results for all
        empty_approvals = [{
            "master_id": mid,
            "status_in_doc": None, "new_status": None, "status_evidence": "",
            "dates_found": {}, "key_findings": [], "conditions": None,
            "confidence": 0.0, "is_conflict": False, "conflict_detail": None,
        } for mid in master_ids_ordered]
        empty_deal = {
            "expected_close": None, "expected_close_changed": False,
            "timing_updates": [], "deal_events": [],
            "management_commentary": None, "confidence": 0.0,
        }
        return empty_approvals, empty_deal

    # Parse approval results
    approval_results = parsed.get("approvals", [])
    # Ensure master_ids are set
    for i, r in enumerate(approval_results):
        if not r.get("master_id") and i < len(master_ids_ordered):
            r["master_id"] = master_ids_ordered[i]

    deal_level = parsed.get("deal_level", {
        "expected_close": None, "expected_close_changed": False,
        "timing_updates": [], "deal_events": [],
        "management_commentary": None,
    })

    return approval_results, deal_level


def merge_deal_level_results(
    deal_id: str,
    deal_level: dict,
    source_doc: str,
    doc_date: str,
    storage: str = "legacy",
) -> None:
    """Merge deal-level monitoring results into the tracker JSON."""
    _load = load_monitor_regulatory if storage == "monitor" else load_regulatory
    _save = save_monitor_regulatory if storage == "monitor" else save_regulatory

    data = _load(deal_id)
    events = data.setdefault("deal_events", [])

    # Update expected close if changed
    if deal_level.get("expected_close_changed") and deal_level.get("expected_close"):
        old = data.get("expected_close")
        data["expected_close"] = deal_level["expected_close"]
        events.append({
            "doc_date": doc_date,
            "source_doc": source_doc,
            "event_type": "close_timing",
            "description": f"Expected close updated: {old or 'unknown'} → {deal_level['expected_close']}",
            "excerpt": None,
            "detected_at": datetime.utcnow().isoformat() + "Z",
        })

    # Add timing updates
    for tu in deal_level.get("timing_updates", []):
        events.append({
            "doc_date": doc_date,
            "source_doc": source_doc,
            "event_type": tu.get("item", "timing"),
            "description": tu.get("detail", ""),
            "excerpt": tu.get("excerpt"),
            "detected_at": datetime.utcnow().isoformat() + "Z",
        })

    # Add deal events
    for de in deal_level.get("deal_events", []):
        events.append({
            "doc_date": de.get("date", doc_date),
            "source_doc": source_doc,
            "event_type": de.get("event_type", "other"),
            "description": de.get("description", ""),
            "excerpt": de.get("excerpt"),
            "detected_at": datetime.utcnow().isoformat() + "Z",
        })

    # Store management commentary
    if deal_level.get("management_commentary"):
        data.setdefault("management_commentary", []).append({
            "doc_date": doc_date,
            "source_doc": source_doc,
            "commentary": deal_level["management_commentary"],
            "detected_at": datetime.utcnow().isoformat() + "Z",
        })

    _save(deal_id, data)


# ── Stage 4: MERGE + CONFLICT DETECTION ─────────────────────────────────────

def validate_transition(
    master_id: str,
    current_status: str,
    proposed_status: str,
) -> dict:
    """
    Validate a status transition against the master's status_states ordering.

    Returns:
        {
            "valid": bool,
            "type": "forward" | "backward" | "jump" | "same" | "unknown",
            "skipped_states": [...],
            "warning": str | None,
        }
    """
    states = get_status_states(master_id)
    if not states:
        return {"valid": True, "type": "unknown", "skipped_states": [], "warning": None}

    current_idx = find_status_index(current_status, states)
    proposed_idx = find_status_index(proposed_status, states)

    if current_idx is None or proposed_idx is None:
        return {"valid": True, "type": "unknown", "skipped_states": [], "warning": None}

    if proposed_idx == current_idx:
        return {"valid": True, "type": "same", "skipped_states": [], "warning": None}

    if proposed_idx > current_idx:
        skipped = states[current_idx + 1: proposed_idx]
        if skipped:
            return {
                "valid": True,
                "type": "jump",
                "skipped_states": skipped,
                "warning": f"Jumped from '{states[current_idx]}' to '{states[proposed_idx]}', skipping: {', '.join(skipped)}",
            }
        return {"valid": True, "type": "forward", "skipped_states": [], "warning": None}

    # Backward transition — conflict
    return {
        "valid": False,
        "type": "backward",
        "skipped_states": [],
        "warning": f"Backward transition: '{states[current_idx]}' -> '{states[proposed_idx]}'",
    }


def merge_monitored_results(
    deal_id: str,
    monitor_results: list[dict],
    source_doc: str,
    source_doc_type: str,
    source_doc_date: str,
    source_url: Optional[str] = None,
    storage: str = "legacy",
) -> dict:
    """
    Merge monitoring results into the regulatory tracker with conflict detection.

    Args:
        storage: "legacy" writes to D###_regulatory.json,
                 "monitor" writes to D###_regulatory_monitor.json

    Returns:
        {
            "status_changes": [{"id": ..., "from": ..., "to": ..., "type": "forward"|"jump"}],
            "conflicts": [{"id": ..., "current": ..., "conflicting": ..., "source": ...}],
            "date_updates": [{"id": ..., "field": ..., "value": ...}],
            "new_approvals": [...],
            "no_change": [...],
        }
    """
    _load = load_monitor_regulatory if storage == "monitor" else load_regulatory
    _save = save_monitor_regulatory if storage == "monitor" else save_regulatory

    now = datetime.utcnow().isoformat() + "Z"
    data = _load(deal_id)

    existing_map = {a["id"]: a for a in data.get("approvals", [])}
    # Also index by master_id
    master_map = {}
    for a in data.get("approvals", []):
        mid = a.get("master_id")
        if mid:
            master_map[mid] = a

    changes = []
    status_changes = []
    conflicts_created = []
    date_updates = []
    new_approvals = []
    no_change = []

    for result in monitor_results:
        master_id = result.get("master_id", "")
        if not master_id:
            continue

        new_status_str = result.get("new_status")
        dates_found = result.get("dates_found", {})
        conditions = result.get("conditions")
        evidence = result.get("status_evidence", "")
        is_conflict = result.get("is_conflict", False)
        confidence = result.get("confidence", 0.0)

        # Find existing approval by master_id or generate existing-style ID
        existing = master_map.get(master_id)
        if not existing:
            existing_id = map_master_to_existing(master_id)
            existing = existing_map.get(existing_id)

        if existing:
            # ── Update existing approval ──
            approval_id = existing["id"]
            current_status_detail = existing.get("status_detail") or existing.get("status", "pending")
            changed = False

            # Status transition
            if new_status_str and new_status_str != current_status_detail:
                transition = validate_transition(master_id, current_status_detail, new_status_str)

                if transition["valid"]:
                    # Forward or jump — apply the change
                    old_status = current_status_detail
                    existing["status_detail"] = new_status_str
                    existing["status"] = master_status_to_legacy(new_status_str)

                    # Append to status_history
                    existing.setdefault("status_history", []).append({
                        "status": new_status_str,
                        "status_legacy": existing["status"],
                        "date": source_doc_date,
                        "source_doc": source_doc,
                        "source_doc_type": source_doc_type,
                        "source_url": source_url,
                        "excerpt": evidence[:500] if evidence else None,
                        "detected_at": now,
                    })

                    status_changes.append({
                        "id": approval_id,
                        "master_id": master_id,
                        "from": old_status,
                        "to": new_status_str,
                        "type": transition["type"],
                        "skipped_states": transition.get("skipped_states", []),
                    })

                    changes.append({
                        "type": "status_change",
                        "approval_id": approval_id,
                        "from": old_status,
                        "to": new_status_str,
                        "detail": f"{existing.get('authority_short', master_id)}: {old_status} → {new_status_str}",
                    })

                    changed = True

                else:
                    # Backward transition — but check if this document is older
                    # than the one that set the current status. If so, it's stale
                    # (accurate at its time), not a true conflict.
                    last_update_date = None
                    history = existing.get("status_history", [])
                    if history:
                        last_update_date = history[-1].get("date")

                    is_stale = False
                    if last_update_date and source_doc_date:
                        try:
                            # Normalize dates for comparison
                            from dateutil.parser import parse as _dp
                            doc_dt = _dp(source_doc_date, fuzzy=True).date()
                            last_dt = _dp(last_update_date, fuzzy=True).date()
                            is_stale = doc_dt < last_dt
                        except Exception:
                            pass

                    if is_stale:
                        # Older document — not a conflict, just stale info. Skip silently.
                        no_change.append(approval_id)
                    else:
                        # Genuine conflict — newer or same-date doc disagrees
                        conflict_entry = {
                            "id": f"conflict_{uuid.uuid4().hex[:8]}",
                            "detected_at": now,
                            "current_status": current_status_detail,
                            "conflicting_claim": new_status_str,
                            "source_doc": source_doc,
                            "source_doc_type": source_doc_type,
                            "source_url": source_url,
                            "source_doc_date": source_doc_date,
                            "excerpt": evidence[:500] if evidence else None,
                            "resolved": False,
                            "resolution": None,
                            "resolved_at": None,
                        }
                        existing.setdefault("conflicts", []).append(conflict_entry)
                        conflicts_created.append({
                            "id": approval_id,
                            "master_id": master_id,
                            "current_status": current_status_detail,
                            "conflicting_claim": new_status_str,
                            "conflict_id": conflict_entry["id"],
                        })
                        changed = True

            # Also flag if the LLM itself detected a conflict — but only if
            # a valid forward status change wasn't already applied (the LLM
            # often marks is_conflict=true when it sees the status needs to
            # advance, which the merge code already handles).
            if is_conflict and result.get("conflict_detail") and not changed:
                conflict_entry = {
                    "id": f"conflict_{uuid.uuid4().hex[:8]}",
                    "detected_at": now,
                    "current_status": current_status_detail,
                    "conflicting_claim": result.get("conflict_detail", ""),
                    "source_doc": source_doc,
                    "source_doc_type": source_doc_type,
                    "source_url": source_url,
                    "source_doc_date": source_doc_date,
                    "excerpt": evidence[:500] if evidence else None,
                    "resolved": False,
                    "resolution": None,
                    "resolved_at": None,
                }
                existing.setdefault("conflicts", []).append(conflict_entry)
                conflicts_created.append({
                    "id": approval_id,
                    "master_id": master_id,
                    "current_status": current_status_detail,
                    "conflicting_claim": result.get("conflict_detail", ""),
                    "conflict_id": conflict_entry["id"],
                })
                changed = True

            # Date updates (fill in, don't overwrite)
            tracker_fields = existing.setdefault("tracker_fields", {})
            for field, value in dates_found.items():
                if value and not tracker_fields.get(field):
                    tracker_fields[field] = value
                    date_updates.append({"id": approval_id, "field": field, "value": value})
                    changed = True

                # Also update top-level filed_date / cleared_date
                if field in ("filing_date", "filed_date") and value and not existing.get("filed_date"):
                    existing["filed_date"] = value
                if field in ("clearance_date", "cleared_date") and value and not existing.get("cleared_date"):
                    existing["cleared_date"] = value
                    # Write to tracking layer for cascade calculation
                    fk = existing.get("filing_key", "")
                    if fk:
                        _write_tracking_date(deal_id, fk, value, source_doc)

            # Conditions
            if conditions and not existing.get("conditions"):
                existing["conditions"] = conditions
                changed = True

            if not changed:
                no_change.append(approval_id)

        else:
            # ── New approval discovered ──
            existing_id = map_master_to_existing(master_id)
            fk = _filing_key(master_id)
            master_def = get_approval(master_id)
            approval_name = (master_def or {}).get("name", master_id)
            authority_short = (master_def or {}).get("authority", master_id)

            # Determine initial status
            initial_status = new_status_str or "pending"
            status_detail = new_status_str or (get_status_states(master_id) or ["pending"])[0]

            entry = {
                "id": existing_id,
                "master_id": master_id,
                "jurisdiction": (master_def or {}).get("jurisdiction"),
                "authority_short": authority_short,
                "authority_full": (master_def or {}).get("authority", authority_short),
                "statute": (master_def or {}).get("description", ""),
                "category": (master_def or {}).get("category", "other"),
                "status": master_status_to_legacy(status_detail),
                "status_detail": status_detail,
                "filing_key": fk,
                "filed_date": dates_found.get("filing_date") or dates_found.get("filed_date"),
                "cleared_date": dates_found.get("clearance_date") or dates_found.get("cleared_date"),
                "expected_filing_period": None,
                "conditions": conditions,
                "notes": evidence[:200] if evidence else "",
                "source_doc": source_doc,
                "source_doc_type": source_doc_type,
                "source_doc_url": source_url,
                "first_seen_date": date.today().isoformat(),
                "status_history": [{
                    "status": status_detail,
                    "status_legacy": master_status_to_legacy(status_detail),
                    "date": source_doc_date,
                    "source_doc": source_doc,
                    "source_doc_type": source_doc_type,
                    "source_url": source_url,
                    "excerpt": evidence[:500] if evidence else None,
                    "detected_at": now,
                }],
                "conflicts": [],
                "tracker_fields": dates_found,
            }

            data["approvals"].append(entry)
            new_approvals.append(existing_id)

            changes.append({
                "type": "added",
                "approval_id": existing_id,
                "detail": f"{approval_name} newly discovered from {source_doc_type}",
            })

    # Record the document as processed
    data.setdefault("documents_processed", []).append({
        "doc_type": source_doc_type,
        "doc_date": source_doc_date,
        "doc_url": source_url,
        "processed_at": now,
        "approvals_found": len(monitor_results),
        "additions": new_approvals,
        "status_changes": [f"{sc['id']}: {sc['from']}→{sc['to']}" for sc in status_changes],
        "conflicts_created": len(conflicts_created),
        "pipeline": "regulatory_monitor",
    })

    # Append change log
    if changes:
        data.setdefault("change_log", []).append({
            "timestamp": now,
            "source_doc": source_doc,
            "source_doc_type": source_doc_type,
            "changes": changes,
        })

    _save(deal_id, data)

    return {
        "status_changes": status_changes,
        "conflicts": conflicts_created,
        "date_updates": date_updates,
        "new_approvals": new_approvals,
        "no_change": no_change,
        "total_approvals": len(data["approvals"]),
    }


# ── Backfill: enrich existing approvals with master_id + status_history ─────

def backfill_master_ids(deal_id: str) -> dict:
    """
    For existing regulatory JSONs without master_ids, map them and
    reconstruct status_history from the change_log.
    Returns summary of what was backfilled.
    """
    data = load_regulatory(deal_id)
    backfilled = []

    for approval in data.get("approvals", []):
        if approval.get("master_id"):
            continue  # already has master_id

        master_id = map_existing_to_master(approval["id"])
        if master_id:
            approval["master_id"] = master_id
            backfilled.append(approval["id"])

            # Set status_detail from current status
            if not approval.get("status_detail"):
                status = approval.get("status", "pending")
                states = get_status_states(master_id)
                # Try to find a matching master status
                for state in states:
                    if master_status_to_legacy(state) == status:
                        approval["status_detail"] = state
                        break
                if not approval.get("status_detail"):
                    approval["status_detail"] = status

            # Initialize status_history if empty
            if not approval.get("status_history"):
                approval["status_history"] = [{
                    "status": approval.get("status_detail", approval.get("status", "pending")),
                    "status_legacy": approval.get("status", "pending"),
                    "date": approval.get("first_seen_date", date.today().isoformat()),
                    "source_doc": approval.get("source_doc", "backfill"),
                    "source_doc_type": approval.get("source_doc_type", "backfill"),
                    "source_url": approval.get("source_doc_url"),
                    "excerpt": None,
                    "detected_at": datetime.utcnow().isoformat() + "Z",
                }]

            # Initialize conflicts array
            if not approval.get("conflicts"):
                approval["conflicts"] = []

            # Initialize tracker_fields
            if not approval.get("tracker_fields"):
                approval["tracker_fields"] = {}
                if approval.get("filed_date"):
                    approval["tracker_fields"]["filing_date"] = approval["filed_date"]
                if approval.get("cleared_date"):
                    approval["tracker_fields"]["clearance_date"] = approval["cleared_date"]

    if backfilled:
        save_regulatory(deal_id, data)

    return {"backfilled": backfilled, "total": len(data.get("approvals", []))}


# ── Conflict resolution ─────────────────────────────────────────────────────

def resolve_conflict(
    deal_id: str,
    approval_id: str,
    conflict_id: str,
    resolution: str,  # "accepted" | "dismissed" | "older_document"
    storage: str = "legacy",
) -> dict:
    """
    Resolve a conflict on an approval.

    If resolution is "accepted", the conflicting status becomes the new current status.
    If "dismissed" or "older_document", the conflict is marked resolved with no status change.
    """
    _load = load_monitor_regulatory if storage == "monitor" else load_regulatory
    _save = save_monitor_regulatory if storage == "monitor" else save_regulatory
    data = _load(deal_id)
    now = datetime.utcnow().isoformat() + "Z"

    approval = next((a for a in data.get("approvals", []) if a["id"] == approval_id), None)
    if not approval:
        raise KeyError(f"Approval '{approval_id}' not found")

    conflict = next((c for c in approval.get("conflicts", []) if c["id"] == conflict_id), None)
    if not conflict:
        raise KeyError(f"Conflict '{conflict_id}' not found on approval '{approval_id}'")

    conflict["resolved"] = True
    conflict["resolution"] = resolution
    conflict["resolved_at"] = now

    if resolution == "accepted":
        # Apply the conflicting status as the new current status
        new_status = conflict["conflicting_claim"]
        master_id = approval.get("master_id", "")

        approval["status_detail"] = new_status
        approval["status"] = master_status_to_legacy(new_status)

        approval.setdefault("status_history", []).append({
            "status": new_status,
            "status_legacy": approval["status"],
            "date": date.today().isoformat(),
            "source_doc": f"Conflict resolution ({conflict_id})",
            "source_doc_type": "manual",
            "source_url": conflict.get("source_url"),
            "excerpt": f"Conflict resolved by accepting: {conflict.get('excerpt', '')}",
            "detected_at": now,
        })

    _save(deal_id, data)
    return {"resolved": True, "resolution": resolution, "approval_id": approval_id}


# ── Full Pipeline ────────────────────────────────────────────────────────────

def run_monitoring_pipeline(
    deal_id: str,
    text: str,
    doc_type: str,
    doc_date: str,
    doc_url: Optional[str] = None,
    deal_context: Optional[dict] = None,
    storage: str = "legacy",
) -> dict:
    """
    Run the full triage → scope → monitor → merge pipeline on a document.

    Args:
        deal_id: deal identifier
        text: full document text (or relevant section)
        doc_type: SEC filing type or document type
        doc_date: YYYY-MM-DD
        doc_url: optional source URL
        deal_context: {target, acquirer, deal_type, ...}
        storage: "legacy" or "monitor" — controls which JSON file to read/write

    Returns:
        {
            "triage": {...},
            "scoping": {...},
            "monitor_results": [...],
            "merge_diff": {...},
            "pipeline_status": "completed" | "irrelevant" | "error",
        }
    """
    if deal_context is None:
        deal_context = {}

    source_doc = f"{doc_type} {doc_date}"

    # Stage 1: Triage
    text_preview = " ".join(text.split()[:800])
    triage_result = triage_document(
        text_preview=text_preview,
        doc_type=doc_type,
        deal_name=deal_context.get("deal_name", ""),
        target=deal_context.get("target", ""),
        acquirer=deal_context.get("acquirer", ""),
    )

    _load = load_monitor_regulatory if storage == "monitor" else load_regulatory
    _save = save_monitor_regulatory if storage == "monitor" else save_regulatory

    if not triage_result["relevant"]:
        # Log triage result
        data = _load(deal_id)
        data.setdefault("documents_triaged", []).append({
            "doc_type": doc_type,
            "doc_date": doc_date,
            "doc_url": doc_url,
            "triaged_at": datetime.utcnow().isoformat() + "Z",
            "relevant": False,
            "reason": triage_result["reason"],
        })
        _save(deal_id, data)

        return {
            "triage": triage_result,
            "scoping": None,
            "monitor_results": [],
            "merge_diff": None,
            "pipeline_status": "irrelevant",
        }

    # Backfill master_ids on existing approvals if needed (legacy storage only)
    if storage == "legacy":
        backfill_master_ids(deal_id)

    # Get current state
    data = _load(deal_id)
    existing_master_ids = [
        a.get("master_id") for a in data.get("approvals", []) if a.get("master_id")
    ]

    # Stage 2: Scope
    scope_result = scope_approvals(
        text=text,
        doc_type=doc_type,
        deal_context=deal_context,
        existing_approval_ids=existing_master_ids,
    )

    if not scope_result["applicable_ids"]:
        return {
            "triage": triage_result,
            "scoping": scope_result,
            "monitor_results": [],
            "merge_diff": None,
            "pipeline_status": "no_approvals_found",
        }

    # Stage 3: Batched monitor (approvals + deal-level in one LLM call)

    # Re-read data in case backfill modified it
    data = _load(deal_id)
    approval_by_master = {}
    for a in data.get("approvals", []):
        mid = a.get("master_id")
        if mid:
            approval_by_master[mid] = a

    # Build approval_states dict for all scoped approvals
    approval_states = {}
    for master_id in scope_result["applicable_ids"]:
        approval_states[master_id] = approval_by_master.get(master_id, {
            "master_id": master_id,
            "status": "pending",
            "status_detail": None,
            "filed_date": None,
            "cleared_date": None,
            "source_doc": None,
        })

    previous_events = data.get("deal_events", [])
    if "expected_close" not in deal_context:
        deal_context["expected_close"] = data.get("expected_close", "unknown")

    monitor_results, deal_level = monitor_batch(
        text=text,
        doc_type=doc_type,
        doc_date=doc_date,
        approval_states=approval_states,
        deal_context=deal_context,
        previous_events=previous_events,
    )

    # Stage 4: Merge approval results
    merge_diff = merge_monitored_results(
        deal_id=deal_id,
        monitor_results=monitor_results,
        source_doc=source_doc,
        source_doc_type=doc_type,
        source_doc_date=doc_date,
        source_url=doc_url,
        storage=storage,
    )

    # Merge deal-level results
    merge_deal_level_results(
        deal_id=deal_id,
        deal_level=deal_level,
        source_doc=source_doc,
        doc_date=doc_date,
        storage=storage,
    )

    return {
        "triage": triage_result,
        "scoping": scope_result,
        "monitor_results": monitor_results,
        "deal_level": deal_level,
        "merge_diff": merge_diff,
        "pipeline_status": "completed",
    }
