"""
Approval Master File Loader

Loads merger_approvals_master.json and provides lookup functions for the
regulatory monitoring pipeline. Maps between existing generate_regulatory.py
IDs and the master file's canonical IDs.

Usage:
    from approval_master import get_master, get_status_states, get_key_questions
"""

import json
import re
from pathlib import Path
from typing import Optional

# ── Path setup ───────────────────────────────────────────────────────────────

_DATA_DIR = Path(__file__).parent / "data"
_MASTER_PATH = _DATA_DIR / "merger_approvals_master.json"

# ── Singleton state ──────────────────────────────────────────────────────────

_MASTER: dict = {}          # full parsed JSON
_BY_ID: dict[str, dict] = {}  # {master_id: approval_definition}
_LOADED = False

# ── ID mapping: existing generate_regulatory IDs → master IDs ────────────────
# The existing system creates IDs via _approval_id() which does:
#   "hsr" for anything matching \bhsr\b
#   "reg_{snake_case(authority_short)}" for everything else
# We map these to the canonical master file IDs.

_EXISTING_TO_MASTER: dict[str, str] = {
    # US Antitrust
    "hsr":                      "hsr_filing",
    "reg_hsr_ftc_doj":          "hsr_filing",
    "reg_doj":                  "doj_clearance",
    "reg_ftc":                  "ftc_clearance",
    # US National Security
    "reg_cfius":                "cfius_review",
    # US Federal — Sector
    "reg_fcc":                  "fcc_license_transfer",
    "reg_ferc":                 "ferc_approval",
    "reg_fdic":                 "federal_banking_regulators",
    "reg_occ":                  "federal_banking_regulators",
    "reg_federal_reserve":      "federal_banking_regulators",
    "reg_nrc":                  "nrc_license_transfer",
    "reg_finra":                "sec_finra_broker_dealer",
    "reg_fda":                  "fda_hhs_cms",
    # International — Major
    "reg_ec":                   "eu_ec_merger",
    "reg_european_commission":  "eu_ec_merger",
    "reg_eu":                   "eu_ec_merger",
    "reg_uk_cma":               "uk_cma",
    "reg_cma":                  "uk_cma",
    "reg_samr":                 "china_samr",
    "reg_canada":               "canada_competition_bureau",
    "reg_competition_bureau":   "canada_competition_bureau",
    "reg_investment_canada":    "canada_ica",
    "reg_cade":                 "brazil_cade",
    "reg_bundeskartellamt":     "germany_bkarta",
    "reg_bkarta":               "germany_bkarta",
    # International — National Security
    "reg_uk_nsia":              "uk_nsia",
    # US State
    "reg_state_puc":            "state_puc_electric",
    # Shareholder & Contractual
    "reg_nasdaq":               "target_shareholder_vote",
    "reg_nyse":                 "target_shareholder_vote",
}

# Reverse map: master_id → most common existing ID
_MASTER_TO_EXISTING: dict[str, str] = {}


def _build_reverse_map() -> None:
    """Build master→existing reverse mapping (first match wins)."""
    global _MASTER_TO_EXISTING
    seen: set[str] = set()
    for existing_id, master_id in _EXISTING_TO_MASTER.items():
        if master_id not in seen:
            _MASTER_TO_EXISTING[master_id] = existing_id
            seen.add(master_id)


# ── Loader ───────────────────────────────────────────────────────────────────

def _ensure_loaded() -> None:
    """Load master file if not already loaded."""
    global _MASTER, _BY_ID, _LOADED
    if _LOADED:
        return
    if not _MASTER_PATH.exists():
        raise FileNotFoundError(f"Master approvals file not found at {_MASTER_PATH}")
    _MASTER = json.loads(_MASTER_PATH.read_text(encoding="utf-8"))
    _BY_ID = {a["id"]: a for a in _MASTER.get("approvals", [])}
    _build_reverse_map()
    _LOADED = True


def reload_master() -> None:
    """Force reload of the master file (e.g., after updates)."""
    global _LOADED
    _LOADED = False
    _ensure_loaded()


# ── Lookup functions ─────────────────────────────────────────────────────────

def get_master() -> dict:
    """Return the full master JSON."""
    _ensure_loaded()
    return _MASTER


def get_all_approvals() -> list[dict]:
    """Return all 37 approval definitions."""
    _ensure_loaded()
    return _MASTER.get("approvals", [])


def get_approval(master_id: str) -> Optional[dict]:
    """Return a single approval definition by master ID."""
    _ensure_loaded()
    return _BY_ID.get(master_id)


def get_categories() -> list[str]:
    """Return the list of approval categories."""
    _ensure_loaded()
    return _MASTER.get("categories", [])


def get_status_states(master_id: str) -> list[str]:
    """Return ordered status_states for an approval type."""
    _ensure_loaded()
    ap = _BY_ID.get(master_id)
    if not ap:
        return []
    return ap.get("monitoring", {}).get("status_states", [])


def get_key_questions(master_id: str) -> list[str]:
    """Return all monitoring key_questions for an approval type."""
    _ensure_loaded()
    ap = _BY_ID.get(master_id)
    if not ap:
        return []
    return ap.get("monitoring", {}).get("key_questions", [])


def get_scoping_info(master_id: str) -> dict:
    """Return {trigger_question, signals_in_document} for scoping pass."""
    _ensure_loaded()
    ap = _BY_ID.get(master_id)
    if not ap:
        return {}
    scoping = ap.get("scoping", {})
    return {
        "trigger_question": scoping.get("trigger_question", ""),
        "signals_in_document": scoping.get("signals_in_document", []),
    }


def get_monitoring_info(master_id: str) -> dict:
    """Return full monitoring block for an approval type."""
    _ensure_loaded()
    ap = _BY_ID.get(master_id)
    if not ap:
        return {}
    return ap.get("monitoring", {})


def get_tracker_fields(master_id: str) -> list[str]:
    """Return the deal_tracker_fields for an approval type."""
    _ensure_loaded()
    ap = _BY_ID.get(master_id)
    if not ap:
        return []
    return ap.get("deal_tracker_fields", [])


# ── ID mapping ──────────────────────────────────────────────────────────────

def map_existing_to_master(existing_id: str) -> Optional[str]:
    """
    Map an existing generate_regulatory.py approval ID to a master file ID.
    Returns None if no mapping exists.
    """
    _ensure_loaded()
    # Direct lookup
    if existing_id in _EXISTING_TO_MASTER:
        return _EXISTING_TO_MASTER[existing_id]
    # Check if the existing_id IS a master_id already
    if existing_id in _BY_ID:
        return existing_id
    # Fuzzy: try stripping "reg_" prefix and matching
    if existing_id.startswith("reg_"):
        bare = existing_id[4:]
        if bare in _BY_ID:
            return bare
        # Try matching against master IDs with common substrings
        for master_id in _BY_ID:
            if bare in master_id or master_id in bare:
                return master_id
    return None


def map_master_to_existing(master_id: str) -> str:
    """
    Map a master file ID to an existing-style ID for backward compatibility.
    Falls back to "reg_{master_id}" if no explicit mapping exists.
    """
    _ensure_loaded()
    if master_id in _MASTER_TO_EXISTING:
        return _MASTER_TO_EXISTING[master_id]
    # Special case: HSR
    if master_id == "hsr_filing":
        return "hsr"
    return f"reg_{master_id}"


def get_all_for_scoping() -> list[dict]:
    """
    Return all approvals with their scoping data, formatted for prompt assembly.
    Each item: {master_id, name, category, trigger_question, signals_in_document}
    """
    _ensure_loaded()
    result = []
    for ap in _MASTER.get("approvals", []):
        scoping = ap.get("scoping", {})
        result.append({
            "master_id": ap["id"],
            "name": ap["name"],
            "category": ap.get("category", ""),
            "trigger_question": scoping.get("trigger_question", ""),
            "signals_in_document": scoping.get("signals_in_document", []),
        })
    return result


# ── Status mapping helpers ───────────────────────────────────────────────────

def master_status_to_legacy(status_detail: str) -> str:
    """Map a rich master status string to a legacy flat status for backward compat."""
    s = status_detail.lower()
    if any(w in s for w in ("cleared", "approved", "granted", "complete", "authorized", "all approved")):
        if "condition" in s:
            return "cleared_with_conditions"
        return "cleared"
    if any(w in s for w in ("filed", "application", "submitted", "notice filed", "declaration filed")):
        return "filed"
    if any(w in s for w in ("review", "investigation", "hearing", "evidentiary", "assessment")):
        return "under_review"
    if any(w in s for w in ("phase 2", "phase ii", "second request")):
        return "phase2"
    if any(w in s for w in ("prohibited", "blocked", "challenged", "litigation", "denied", "complaint")):
        return "blocked"
    if "withdrawn" in s:
        return "withdrawn"
    if any(w in s for w in ("not applicable", "not required", "n/a")):
        return "not_required"
    if any(w in s for w in ("intent", "identifying", "monitoring")):
        return "filing_intent"
    return "pending"


def find_status_index(status: str, states: list[str]) -> Optional[int]:
    """
    Find the index of a status in the ordered states list.
    Handles fuzzy matching (case-insensitive, partial match).
    """
    if not states:
        return None
    s_lower = status.lower().strip()
    # Exact match first
    for i, state in enumerate(states):
        if state.lower().strip() == s_lower:
            return i
    # Partial/fuzzy match
    for i, state in enumerate(states):
        state_lower = state.lower().strip()
        if s_lower in state_lower or state_lower in s_lower:
            return i
    return None


def filter_key_questions(master_id: str, current_status: str) -> list[str]:
    """
    Return only the key_questions relevant to the current status position.
    Asks questions for current state + next 1-2 states in the progression.
    """
    _ensure_loaded()
    ap = _BY_ID.get(master_id)
    if not ap:
        return []

    states = ap.get("monitoring", {}).get("status_states", [])
    questions = ap.get("monitoring", {}).get("key_questions", [])

    if not states or not questions:
        return questions

    idx = find_status_index(current_status, states)
    if idx is None:
        return questions  # can't determine position, ask all

    total_q = len(questions)
    total_s = len(states)
    if total_s <= 1:
        return questions

    # Map question range to state position
    q_per_state = total_q / total_s
    start_q = max(0, int((idx - 0.5) * q_per_state))
    end_q = min(total_q, int((idx + 2.5) * q_per_state))

    return questions[start_q:end_q]
