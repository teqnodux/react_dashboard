"""
Termination Pipeline Runner
Orchestrates: URL → termination_scraping.py → Stages 6/7/9 → dashboard HTML

All external scripts are called via subprocess — nothing is modified.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
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
TERMINATION_EMBEDDINGS_DIR = COVENANT_PROJECT_DIR / "Termination_Embeddings_v1"
TERMINATION_OUTPUT_DIR = _BACKEND_DIR / "data" / "termination"
TERMINATION_INPUT_DIR = TERMINATION_OUTPUT_DIR / "input"
PIPELINE_DIR = TERMINATION_OUTPUT_DIR / "pipeline"


def _status_path(deal_id: str) -> Path:
    return PIPELINE_DIR / deal_id / "status.json"


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


def run_termination_pipeline(deal_id: str, url: str):
    """Run the full termination pipeline. Designed to be called in a background thread."""
    try:
        # ── Step 1: Run termination_scraping.py ──
        _write_status(deal_id, "running", "scraping")

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
                [_PYTHON, "termination_scraping.py"],
                cwd=str(COVENANT_PROJECT_DIR),
                capture_output=True,
                text=True,
                timeout=600,  # 10 min max
                env=_SUBPROCESS_ENV,
            )
            if result.returncode != 0:
                _write_status(deal_id, "error", "scraping",
                              f"Scraping failed: {result.stderr[:500]}")
                return
        finally:
            # Restore urls.txt
            if urls_backup is not None:
                urls_file.write_text(urls_backup)
            elif urls_file.exists():
                urls_file.unlink()

        # ── Step 2: Find the trigger + fee outputs (agreement AND 8-K) ──
        _write_status(deal_id, "running", "finding_output")

        # Agreement-sourced files
        triggers_agmt = sorted(
            COVENANT_PROJECT_DIR.glob("termination_response_*_triggers.json"),
            key=lambda f: f.stat().st_mtime, reverse=True,
        )
        fees_agmt = sorted(
            COVENANT_PROJECT_DIR.glob("termination_response_*_fees.json"),
            key=lambda f: f.stat().st_mtime, reverse=True,
        )
        # 8-K / press-release-sourced files
        triggers_8k = sorted(
            COVENANT_PROJECT_DIR.glob("termination_response_*_triggers_8k.json"),
            key=lambda f: f.stat().st_mtime, reverse=True,
        )
        fees_8k = sorted(
            COVENANT_PROJECT_DIR.glob("termination_response_*_fees_8k.json"),
            key=lambda f: f.stat().st_mtime, reverse=True,
        )

        # Combine — use the most recent file of either type for stages 6/7/9
        all_triggers = sorted(
            list(triggers_agmt) + list(triggers_8k),
            key=lambda f: f.stat().st_mtime, reverse=True,
        )
        all_fees = sorted(
            list(fees_agmt) + list(fees_8k),
            key=lambda f: f.stat().st_mtime, reverse=True,
        )

        if not all_triggers:
            _write_status(deal_id, "error", "finding_output",
                          "No termination trigger output found after scraping")
            return

        triggers_file = all_triggers[0]
        fees_file = all_fees[0] if all_fees else None

        # ── Step 3: Stage 6 — classify against benchmark ──
        _write_status(deal_id, "running", "stage_6")
        result = subprocess.run(
            [_PYTHON, "6_classify_new_deal_termination.py", str(triggers_file)],
            cwd=str(TERMINATION_EMBEDDINGS_DIR),
            capture_output=True,
            text=True,
            timeout=300,  # 5 min max
            env=_SUBPROCESS_ENV,
        )
        if result.returncode != 0:
            _write_status(deal_id, "error", "stage_6",
                          f"Stage 6 failed: {result.stderr[:500]}")
            return

        # ── Step 4: Stage 7 — risk assessment ──
        _write_status(deal_id, "running", "stage_7")
        reports_dir = TERMINATION_EMBEDDINGS_DIR / "new_deal_reports"
        classification_candidates = sorted(
            reports_dir.glob("termination_classification_*.json"),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
        if not classification_candidates:
            _write_status(deal_id, "error", "stage_7",
                          "No classification output found after Stage 6")
            return

        classification_file = classification_candidates[0]
        result = subprocess.run(
            [_PYTHON, "7_assess_new_deal_termination.py", str(classification_file)],
            cwd=str(TERMINATION_EMBEDDINGS_DIR),
            capture_output=True,
            text=True,
            timeout=300,
            env=_SUBPROCESS_ENV,
        )
        if result.returncode != 0:
            _write_status(deal_id, "error", "stage_7",
                          f"Stage 7 failed: {result.stderr[:500]}")
            return

        # ── Step 5: Stage 9 — provision checks ──
        _write_status(deal_id, "running", "stage_9")
        if fees_file:
            result = subprocess.run(
                [_PYTHON, "9_specific_provision_checks_termination.py", str(fees_file)],
                cwd=str(TERMINATION_EMBEDDINGS_DIR),
                capture_output=True,
                text=True,
                timeout=300,
                env=_SUBPROCESS_ENV,
            )
            if result.returncode != 0:
                _write_status(deal_id, "error", "stage_9",
                              f"Stage 9 failed: {result.stderr[:500]}")
                return

        # ── Step 6: Copy outputs to input dir ──
        _write_status(deal_id, "running", "copying_outputs")
        input_dir = TERMINATION_INPUT_DIR / deal_id
        # Clear old files so a re-run doesn't leave stale data from a previous URL
        if input_dir.exists():
            for old_file in input_dir.glob("*.json"):
                old_file.unlink()
        input_dir.mkdir(parents=True, exist_ok=True)

        if reports_dir.exists():
            for pattern in [
                "termination_classification_*.json",
                "termination_assessment_*.json",
                "termination_provision_checks_*.json",
            ]:
                files = sorted(reports_dir.glob(pattern),
                               key=lambda f: f.stat().st_mtime, reverse=True)
                if files:
                    shutil.copy2(str(files[0]), str(input_dir / files[0].name))

        # Copy trigger + fee files from ALL sources (agreement AND 8-K)
        # Preserves existing files from previous runs so Stage 10 can merge
        for src_list in [triggers_agmt[:1], triggers_8k[:1], fees_agmt[:1], fees_8k[:1]]:
            for f in src_list:
                shutil.copy2(str(f), str(input_dir / f.name))

        # ── Step 7: Generate dashboard HTML ──
        _write_status(deal_id, "running", "generating_dashboard")
        from termination_processor import find_termination_inputs, build_termination_dashboard
        verified_input = find_termination_inputs(deal_id)
        if not verified_input:
            _write_status(deal_id, "error", "generating_dashboard",
                          "Stage JSONs not found after copy")
            return

        # Look up deal name for dashboard header
        deal_name = ""
        try:
            deals_path = _BACKEND_DIR.parent / "data" / "deals.json"
            if deals_path.exists():
                deals_data = json.loads(deals_path.read_text())
                deals_list = deals_data.get("deals", deals_data) if isinstance(deals_data, dict) else deals_data
                for d in deals_list:
                    did = d.get("deal_id") or d.get("id", "")
                    if did == deal_id:
                        target = d.get("target", "")
                        acquirer = d.get("acquirer", "")
                        if target and acquirer:
                            deal_name = f"{acquirer} / {target}"
                        elif target:
                            deal_name = target
                        break
        except Exception:
            pass

        build_termination_dashboard(deal_id, verified_input, deal_name=deal_name)
        _write_status(deal_id, "complete", "done")

    except subprocess.TimeoutExpired:
        _write_status(deal_id, "error", "timeout", "Pipeline timed out")
    except Exception as e:
        _write_status(deal_id, "error", "unknown", str(e))


def start_termination_pipeline(deal_id: str, url: str) -> dict:
    """Launch the termination pipeline in a background thread."""
    status = get_pipeline_status(deal_id)
    if status.get("status") == "running":
        return {"status": "already_running", "step": status.get("step", "")}

    thread = threading.Thread(
        target=run_termination_pipeline,
        args=(deal_id, url),
        daemon=True,
    )
    thread.start()
    return {"status": "started"}
