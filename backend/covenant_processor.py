"""
Covenant Processor
Integrates 10_generate_dashboard.py with the REACT backend.

Input:  backend/data/covenants/input/{deal_id}/
        Drop Stage 6-9 JSON files there:
          deal_classification*.json   (required)
          deal_assessment*.json       (required)
          benchmark_comparison*.json  (optional)
          specific_provisions*.json   (optional)

Output: backend/data/covenants/{deal_id}.html
"""

from __future__ import annotations

import json
import importlib.util
from pathlib import Path

_BACKEND_DIR     = Path(__file__).parent
COVENANTS_DIR    = _BACKEND_DIR / "data" / "covenants"
COVENANT_INPUT_DIR = COVENANTS_DIR / "input"

_SCRIPT_PATH = (
    Path(__file__).parent.parent.parent
    / "Covenenat Project Feb 2026"
    / "Covenant_Embeddings_v1"
    / "10_generate_dashboard.py"
)


def get_covenant_path(deal_id: str) -> Path | None:
    """Return path to an already-generated covenant HTML, or None."""
    p = COVENANTS_DIR / f"{deal_id}.html"
    return p if p.exists() else None


def find_covenant_inputs(deal_id: str) -> Path | None:
    """Return the input folder for deal_id if it contains the required JSONs."""
    deal_dir = COVENANT_INPUT_DIR / deal_id
    if not deal_dir.exists():
        return None
    has_class  = bool(list(deal_dir.glob("deal_classification*.json")))
    has_assess = bool(list(deal_dir.glob("deal_assessment*.json")))
    return deal_dir if (has_class and has_assess) else None


def _load_generator_class():
    """Dynamically import CovenantDashboardGenerator from 10_generate_dashboard.py."""
    if not _SCRIPT_PATH.exists():
        raise RuntimeError(f"Covenant script not found at {_SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("covenant_dashboard", str(_SCRIPT_PATH))
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.CovenantDashboardGenerator


def build_covenant_dashboard(deal_id: str, input_dir: Path) -> Path:
    """
    Generate covenant dashboard HTML from stage JSONs in input_dir.
    Saves to COVENANTS_DIR/{deal_id}.html and returns the path.
    """
    COVENANTS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = COVENANTS_DIR / f"{deal_id}.html"

    def load_latest(pattern: str):
        files = sorted(input_dir.glob(pattern), reverse=True)
        return json.loads(files[0].read_text()) if files else None

    classification = load_latest("deal_classification*.json")
    assessment     = load_latest("deal_assessment*.json")
    comparison     = load_latest("benchmark_comparison*.json")
    provisions     = load_latest("specific_provisions*.json")

    if not classification or not assessment:
        raise RuntimeError(
            f"Missing required files in {input_dir}. "
            "Need deal_classification*.json and deal_assessment*.json"
        )

    covenant_deal_id = deal_id  # Use pipeline deal_id (e.g., "D004"), not SEC accession from classification JSON

    GeneratorClass = _load_generator_class()
    gen  = GeneratorClass(str(_SCRIPT_PATH.parent))
    html = gen._generate_html(classification, assessment, comparison, provisions, covenant_deal_id)

    output_path.write_text(html, encoding="utf-8")
    return output_path
