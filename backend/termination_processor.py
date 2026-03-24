"""
Termination Processor
Integrates 10_generate_dashboard_termination.py with the REACT backend.

Input:  backend/data/termination/input/{deal_id}/
        Drop stage JSON files there:
          termination_classification*.json    (required)
          termination_assessment*.json        (required)
          termination_provision_checks*.json  (optional)
          *fees*.json                         (optional)
          *triggers*.json                     (optional)

Output: backend/data/termination/{deal_id}.html
"""

from __future__ import annotations

import json
import importlib.util
from pathlib import Path

_BACKEND_DIR          = Path(__file__).parent
TERMINATION_DIR       = _BACKEND_DIR / "data" / "termination"
TERMINATION_INPUT_DIR = TERMINATION_DIR / "input"

_SCRIPT_PATH = (
    Path(__file__).parent.parent.parent
    / "Covenenat Project Feb 2026"
    / "Termination_Embeddings_v1"
    / "10_generate_dashboard_termination.py"
)


def get_termination_path(deal_id: str) -> Path | None:
    """Return path to an already-generated termination HTML, or None."""
    p = TERMINATION_DIR / f"{deal_id}.html"
    return p if p.exists() else None


def find_termination_inputs(deal_id: str) -> Path | None:
    """Return the input folder for deal_id if it has the required stage JSONs."""
    deal_dir = TERMINATION_INPUT_DIR / deal_id
    if not deal_dir.exists():
        return None
    has_class  = bool(list(deal_dir.glob("termination_classification*.json")))
    has_assess = bool(list(deal_dir.glob("termination_assessment*.json")))
    return deal_dir if (has_class and has_assess) else None


def _load_module():
    """Dynamically import the termination dashboard module."""
    if not _SCRIPT_PATH.exists():
        raise RuntimeError(f"Termination script not found at {_SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("termination_dashboard", str(_SCRIPT_PATH))
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def build_termination_dashboard(deal_id: str, input_dir: Path, deal_name: str = "") -> Path:
    """
    Generate termination dashboard HTML from stage JSONs in input_dir.
    Supports multi-source: agreement + 8-K files are loaded separately,
    merged via Stage 10's merge_fees_with_provenance / build_discrepancies.
    Saves to TERMINATION_DIR/{deal_id}.html and returns the path.
    """
    TERMINATION_DIR.mkdir(parents=True, exist_ok=True)
    output_path = TERMINATION_DIR / f"{deal_id}.html"

    def load_latest(pattern, exclude_substr=None):
        files = sorted(input_dir.glob(pattern),
                       key=lambda f: f.stat().st_mtime, reverse=True)
        if exclude_substr:
            files = [f for f in files if exclude_substr not in f.name]
        return json.loads(files[0].read_text()) if files else None

    classification = load_latest("termination_classification*.json")
    assessment     = load_latest("termination_assessment*.json")
    provisions     = load_latest("termination_provision_checks*.json")

    # Load agreement and 8-K sources separately for merge
    fees_agmt     = load_latest("*fees*.json", exclude_substr="_8k")
    fees_8k       = load_latest("*fees_8k*.json")
    triggers_agmt = load_latest("*triggers*.json", exclude_substr="_8k")
    triggers_8k   = load_latest("*triggers_8k*.json")

    # Primary data: agreement takes precedence, 8-K fills gaps
    fees     = fees_agmt or fees_8k
    triggers = triggers_agmt or triggers_8k

    if not classification or not assessment:
        raise RuntimeError(
            f"Missing required files in {input_dir}. "
            "Need termination_classification*.json and termination_assessment*.json"
        )

    mod = _load_module()

    covenant_deal_id = deal_id  # Use pipeline deal_id, not SEC accession from classification JSON
    analysis_ts      = classification.get("analysis_timestamp", "")

    # Multi-source merge: use Stage 10's merge + discrepancy functions
    merged_fees = fees
    provenance = None
    discrepancies = None
    sources = []

    if fees_agmt or triggers_agmt:
        sources.append("Merger Agreement")
    if fees_8k or triggers_8k:
        sources.append("8-K / Press Release")

    if hasattr(mod, "merge_fees_with_provenance"):
        merged_fees, provenance = mod.merge_fees_with_provenance(fees_agmt, fees_8k)
        if not merged_fees:
            merged_fees = fees
    if hasattr(mod, "build_discrepancies") and fees_agmt and fees_8k:
        discrepancies = mod.build_discrepancies(fees_agmt, fees_8k)

    guide_rows      = mod.build_guide_rows(merged_fees, triggers) if (merged_fees and triggers) else []
    audit           = mod.build_clause_audit(classification)
    deal_type_label = mod.derive_deal_type_label(classification, merged_fees) if merged_fees else "Strategic Acquisition"

    gen  = mod.TerminationDashboardGenerator()
    html = gen._build_html(
        covenant_deal_id,
        analysis_ts,
        deal_type_label,
        guide_rows,
        audit,
        merged_fees,
        classification,
        assessment,
        provisions,
        {},    # deal_financials — skipped
        deal_name or None,
        sources=sources if sources else None,
        provenance=provenance if provenance else None,
        discrepancies=discrepancies if discrepancies else None,
    )

    output_path.write_text(html, encoding="utf-8")
    return output_path
