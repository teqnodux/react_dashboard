"""
Timeline Processor
Calls the DMA Timeline generator for a given deal DOCX and stores the HTML output.

Input DOCX:  backend/data/dma_docs/input/{deal_id}_*.docx
Output HTML: backend/data/timelines/{deal_id}.html
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Path to the standalone generator script
_BACKEND_DIR     = Path(__file__).parent
_TIMELINE_SCRIPT = _BACKEND_DIR.parent.parent / "DMA Timeline" / "generate_timeline.py"
TIMELINES_DIR    = _BACKEND_DIR / "data" / "timelines"
INPUT_DIR        = _BACKEND_DIR / "data" / "dma_docs" / "input"

# Ensure DMA Timeline directory is importable
_DMA_DIR = str(_BACKEND_DIR.parent.parent / "DMA Timeline")
if _DMA_DIR not in sys.path:
    sys.path.insert(0, _DMA_DIR)


def get_timeline_path(deal_id: str) -> Path | None:
    """Return path to an already-generated timeline HTML, or None if not found."""
    path = TIMELINES_DIR / f"{deal_id}.html"
    return path if path.exists() else None


def get_timeline_json_path(deal_id: str) -> Path | None:
    """Return path to an already-generated timeline JSON, or None if not found."""
    path = TIMELINES_DIR / f"{deal_id}.json"
    return path if path.exists() else None


def find_docx(deal_id: str) -> Path | None:
    """Locate a DOCX file for deal_id in the input folder."""
    if not INPUT_DIR.exists():
        return None
    # Try deal_id prefix first (D001_DMA.docx, D001.docx, D001_summary.docx, etc.)
    for pattern in (f"{deal_id}*.docx", f"{deal_id.lower()}*.docx"):
        matches = list(INPUT_DIR.glob(pattern))
        if matches:
            return matches[0]
    return None


def build_timeline(deal_id: str, docx_path: Path) -> Path:
    """
    Generate a timeline HTML for deal_id from docx_path.
    Calls generate_timeline.py as a subprocess so the large HTML template
    stays in one place. Returns the path to the generated HTML file.
    """
    TIMELINES_DIR.mkdir(parents=True, exist_ok=True)
    output_path = TIMELINES_DIR / f"{deal_id}.html"

    result = subprocess.run(
        [
            sys.executable,
            str(_TIMELINE_SCRIPT),
            str(docx_path),
            "--output", str(output_path),
            "--no-browser",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(
            f"Timeline generation failed for {deal_id}:\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}"
        )

    return output_path


def build_timeline_from_text(deal_id: str, text: str) -> Path:
    """
    Generate timeline JSON for deal_id from raw text (no DOCX required).
    Calls parse_deal_from_text directly and saves the JSON.
    Returns the path to the generated JSON file.
    """
    from generate_timeline import parse_deal_from_text

    TIMELINES_DIR.mkdir(parents=True, exist_ok=True)
    deal = parse_deal_from_text(text)

    # Add metadata for document-sources tracking
    deal["_meta"] = {
        "extracted_at": datetime.utcnow().isoformat() + "Z",
        "filing_date": deal.get("signing_date"),
    }

    json_path = TIMELINES_DIR / f"{deal_id}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(deal, f, indent=2)

    # Create empty tracking JSON if not present
    tracking_path = TIMELINES_DIR / f"{deal_id}_tracking.json"
    if not tracking_path.exists():
        tracking_keys = [chain["trigger_key"] for chain in deal.get("triggered_chains", [])]
        tracking_data = {
            "events": {key: {"date": None, "source": None} for key in tracking_keys}
        }
        with open(tracking_path, "w", encoding="utf-8") as f:
            json.dump(tracking_data, f, indent=2)

    return json_path
