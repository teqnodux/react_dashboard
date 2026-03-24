"""
Covenant Pipeline Runner
Orchestrates: URL → covenant_scraping.py → Stages 6-10 → dashboard HTML

All external scripts are called via subprocess — nothing is modified.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

# Use the same Python that runs the server (avoids version mismatch)
_PYTHON = sys.executable

# Ensure subprocess inherits user site-packages (needed for Homebrew Python 3.13)
_SUBPROCESS_ENV = {**os.environ}
_SUBPROCESS_ENV.pop("PYTHONNOUSERSITE", None)
# Add user site-packages to PYTHONPATH so spawned subprocesses can find them
_user_site = Path.home() / "Library" / "Python" / "3.13" / "lib" / "python" / "site-packages"
if _user_site.exists():
    existing = _SUBPROCESS_ENV.get("PYTHONPATH", "")
    _SUBPROCESS_ENV["PYTHONPATH"] = f"{_user_site}:{existing}" if existing else str(_user_site)

_BACKEND_DIR = Path(__file__).parent
_PROJECT_ROOT = Path(__file__).parent.parent.parent  # Merger Scraper/

COVENANT_PROJECT_DIR = _PROJECT_ROOT / "Covenenat Project Feb 2026"
COVENANT_EMBEDDINGS_DIR = COVENANT_PROJECT_DIR / "Covenant_Embeddings_v1"
COVENANT_OUTPUT_DIR = _BACKEND_DIR / "data" / "covenants"
COVENANT_INPUT_DIR = COVENANT_OUTPUT_DIR / "input"
PIPELINE_DIR = COVENANT_OUTPUT_DIR / "pipeline"
STATUS_DIR = PIPELINE_DIR

DEAL_CONFIG_DIR = _BACKEND_DIR / "data" / "deal_config"


def _status_path(deal_id: str) -> Path:
    return STATUS_DIR / deal_id / "status.json"


def _write_status(deal_id: str, status: str, step: str = "", error: str = ""):
    p = _status_path(deal_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({
        "status": status,
        "step": step,
        "error": error,
        "updated_at": datetime.now().isoformat(),
    }))


def get_pipeline_status(deal_id: str) -> dict:
    p = _status_path(deal_id)
    if p.exists():
        return json.loads(p.read_text())
    return {"status": "idle", "step": "", "error": ""}


def run_covenant_pipeline(deal_id: str, url: str):
    """Run the full covenant pipeline. Designed to be called in a background thread."""
    try:
        _write_status(deal_id, "running", "scraping")

        # ── Step 1: Run covenant_scraping.py ──
        # Write a temporary urls.txt for the scraper
        work_dir = PIPELINE_DIR / deal_id
        work_dir.mkdir(parents=True, exist_ok=True)
        urls_file = COVENANT_PROJECT_DIR / "urls.txt"

        # Back up existing urls.txt if any
        urls_backup = None
        if urls_file.exists():
            urls_backup = urls_file.read_text()
        urls_file.write_text(url + "\n")

        try:
            result = subprocess.run(
                [_PYTHON, "covenant_scraping.py"],
                cwd=str(COVENANT_PROJECT_DIR),
                capture_output=True,
                text=True,
                timeout=600,  # 10 min max
                env=_SUBPROCESS_ENV,
            )
            if result.returncode != 0:
                _write_status(deal_id, "error", "scraping", f"Scraping failed: {result.stderr[:500]}")
                return
        finally:
            # Restore urls.txt
            if urls_backup is not None:
                urls_file.write_text(urls_backup)
            elif urls_file.exists():
                urls_file.unlink()

        # ── Step 2: Find the individual_clauses output ──
        _write_status(deal_id, "running", "finding_output")
        clauses_file = None
        # Search in covenant project dir for the most recent individual_clauses file
        candidates = sorted(
            COVENANT_PROJECT_DIR.glob("openai_response_*_individual_clauses.json"),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
        if candidates:
            clauses_file = candidates[0]
        else:
            _write_status(deal_id, "error", "finding_output", "No individual_clauses.json found after scraping")
            return

        # ── Step 3: Run Stages 6-9 directly (avoids bash script python3 mismatch) ──
        # Stage 6: classify
        _write_status(deal_id, "running", "stage_6")
        result = subprocess.run(
            [_PYTHON, "6_classify_new_deal.py", str(clauses_file)],
            cwd=str(COVENANT_EMBEDDINGS_DIR),
            capture_output=True, text=True, timeout=300, env=_SUBPROCESS_ENV,
        )
        if result.returncode != 0:
            _write_status(deal_id, "error", "stage_6", f"Stage 6 failed: {result.stderr[:500]}")
            return

        # Find classification output
        reports_dir_s6 = COVENANT_EMBEDDINGS_DIR / "new_deal_reports"
        classification_files = sorted(
            reports_dir_s6.glob("deal_classification_*.json"),
            key=lambda f: f.stat().st_mtime, reverse=True,
        )
        if not classification_files:
            _write_status(deal_id, "error", "stage_6", "No classification output found")
            return

        # Stage 7: assess
        _write_status(deal_id, "running", "stage_7")
        result = subprocess.run(
            [_PYTHON, "7_assess_new_deal.py", str(classification_files[0])],
            cwd=str(COVENANT_EMBEDDINGS_DIR),
            capture_output=True, text=True, timeout=300, env=_SUBPROCESS_ENV,
        )
        if result.returncode != 0:
            _write_status(deal_id, "error", "stage_7", f"Stage 7 failed: {result.stderr[:500]}")
            return

        # Find assessment output
        assessment_files = sorted(
            reports_dir_s6.glob("deal_assessment_*.json"),
            key=lambda f: f.stat().st_mtime, reverse=True,
        )

        # Stage 8: benchmark
        _write_status(deal_id, "running", "stage_8")
        if assessment_files:
            result = subprocess.run(
                [_PYTHON, "8_compare_to_benchmark.py", str(assessment_files[0])],
                cwd=str(COVENANT_EMBEDDINGS_DIR),
                capture_output=True, text=True, timeout=300, env=_SUBPROCESS_ENV,
            )
            if result.returncode != 0:
                _write_status(deal_id, "error", "stage_8", f"Stage 8 failed: {result.stderr[:500]}")
                return

        # Stage 9: specific provisions
        _write_status(deal_id, "running", "stage_9")
        result = subprocess.run(
            [_PYTHON, "9_specific_provision_checks.py", str(clauses_file)],
            cwd=str(COVENANT_EMBEDDINGS_DIR),
            capture_output=True, text=True, timeout=300, env=_SUBPROCESS_ENV,
        )
        if result.returncode != 0:
            _write_status(deal_id, "error", "stage_9", f"Stage 9 failed: {result.stderr[:500]}")
            return

        # ── Step 4: Copy stage JSONs to input dir ──
        _write_status(deal_id, "running", "copying_outputs")
        input_dir = COVENANT_INPUT_DIR / deal_id
        # Clear old files so a re-run doesn't leave stale data from a previous URL
        if input_dir.exists():
            for old_file in input_dir.glob("*.json"):
                old_file.unlink()
        input_dir.mkdir(parents=True, exist_ok=True)

        reports_dir = COVENANT_EMBEDDINGS_DIR / "new_deal_reports"
        if reports_dir.exists():
            # Find the most recent files for each stage
            for pattern in [
                "deal_classification_*.json",
                "deal_assessment_*.json",
                "benchmark_comparison_*.json",
                "specific_provisions_*.json",
            ]:
                files = sorted(reports_dir.glob(pattern), key=lambda f: f.stat().st_mtime, reverse=True)
                if files:
                    shutil.copy2(str(files[0]), str(input_dir / files[0].name))

        # ── Step 5: Generate dashboard HTML ──
        _write_status(deal_id, "running", "generating_dashboard")
        from covenant_processor import find_covenant_inputs, build_covenant_dashboard
        verified_input = find_covenant_inputs(deal_id)
        if not verified_input:
            _write_status(deal_id, "error", "generating_dashboard", "Stage JSONs not found after copy")
            return

        build_covenant_dashboard(deal_id, verified_input)
        _write_status(deal_id, "complete", "done")

    except subprocess.TimeoutExpired:
        _write_status(deal_id, "error", "timeout", "Pipeline timed out")
    except Exception as e:
        _write_status(deal_id, "error", "unknown", str(e))


def start_covenant_pipeline(deal_id: str, url: str) -> dict:
    """Launch the covenant pipeline in a background thread."""
    status = get_pipeline_status(deal_id)
    if status.get("status") == "running":
        return {"status": "already_running", "step": status.get("step", "")}

    thread = threading.Thread(
        target=run_covenant_pipeline,
        args=(deal_id, url),
        daemon=True,
    )
    thread.start()
    return {"status": "started"}
