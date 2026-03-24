"""
MAE Pipeline Runner
Orchestrates: URL → fetch text → extract MAE clause → Stages 6-10 → dashboard HTML

All external scripts are called via subprocess wrappers — nothing is modified.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import re
from datetime import datetime
from pathlib import Path

# Use the same Python that runs the server (avoids 3.9 vs 3.12 mismatch)
_PYTHON = sys.executable

_BACKEND_DIR = Path(__file__).parent
_PROJECT_ROOT = Path(__file__).parent.parent.parent  # Merger Scraper/

MAE_PROJECT_DIR = _PROJECT_ROOT / "MAE Embeddings Advanced Split"
MAE_V2_DIR = MAE_PROJECT_DIR / "MAE v2"
MAE_OUTPUT_DIR = _BACKEND_DIR / "data" / "mae"
PIPELINE_DIR = MAE_OUTPUT_DIR / "pipeline"
BENCHMARK_FILE = MAE_PROJECT_DIR / "final_results" / "benchmark_20260211_151459.json"


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


def get_mae_path(deal_id: str) -> Path | None:
    """Return path to generated MAE dashboard HTML, or None."""
    p = MAE_OUTPUT_DIR / f"{deal_id}.html"
    return p if p.exists() else None


def _fetch_agreement_text(url: str) -> str:
    """Fetch merger agreement text from SEC EDGAR URL."""
    import requests
    from bs4 import BeautifulSoup

    headers = {
        "User-Agent": "Mozilla/5.0 (Merger Dashboard Research Bot) research@example.com",
        "Accept": "text/html",
    }
    resp = requests.get(url, headers=headers, timeout=60)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    # Remove script/style tags
    for tag in soup(["script", "style"]):
        tag.decompose()
    text = soup.get_text(separator="\n")
    # Clean up whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text


def _extract_mae_clause(agreement_text: str, deal_name: str) -> str:
    """Use Claude to extract the MAE definition clause from the full agreement text."""
    from anthropic import Anthropic

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    client = Anthropic(api_key=api_key)

    # Truncate to ~50k chars to fit in context
    text = agreement_text[:80000]

    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=8192,
        temperature=0,
        messages=[{
            "role": "user",
            "content": f"""Find and extract the complete "Material Adverse Effect" or "Material Adverse Change" definition from this merger agreement.

Return ONLY the full MAE definition text, starting from where it defines what constitutes a Material Adverse Effect (usually beginning with language like "Material Adverse Effect means..." or similar), including ALL carve-outs/exclusions (i), (ii), (iii), etc., and ending at the disproportionality qualifier or the end of the definition.

If there are multiple MAE definitions (for Company and Parent), return the Company/Target MAE definition.

Do not add any commentary. Return only the clause text.

Agreement text:
{text}"""
        }]
    )

    return response.content[0].text.strip()


def run_mae_pipeline(deal_id: str, url: str, deal_name: str = ""):
    """Run the full MAE pipeline. Designed to be called in a background thread."""
    from dotenv import load_dotenv
    load_dotenv(str(_PROJECT_ROOT / ".env"))
    load_dotenv(str(MAE_PROJECT_DIR / ".env"))

    work_dir = PIPELINE_DIR / deal_id
    # Clear old pipeline outputs so a re-run doesn't leave stale data from a previous URL
    if work_dir.exists():
        for old_file in work_dir.glob("*.json"):
            old_file.unlink()
        for sub in work_dir.iterdir():
            if sub.is_dir():
                for old_file in sub.glob("*.json"):
                    old_file.unlink()
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        # ── Step 1: Fetch merger agreement text ──
        _write_status(deal_id, "running", "fetching")
        agreement_text = _fetch_agreement_text(url)
        if not agreement_text or len(agreement_text) < 1000:
            _write_status(deal_id, "error", "fetching", "Failed to fetch agreement text or text too short")
            return

        # ── Step 2: Extract MAE clause via Claude ──
        _write_status(deal_id, "running", "extracting_mae")
        mae_text = _extract_mae_clause(agreement_text, deal_name)
        if not mae_text or len(mae_text) < 100:
            _write_status(deal_id, "error", "extracting_mae", "Failed to extract MAE clause")
            return

        # Save MAE input JSON for 6_prep
        if not deal_name:
            deal_name = deal_id
        mae_input = {"mae_clauses": [{"dealName": deal_name, "text": mae_text}]}
        mae_input_path = work_dir / "mae_input.json"
        mae_input_path.write_text(json.dumps(mae_input, indent=2))

        # ── Step 3: Run 6_prep_new_MAE.py (extract exclusions) ──
        _write_status(deal_id, "running", "prep_clauses")
        extracted_path = work_dir / "extracted_clauses.json"
        result = subprocess.run(
            [_PYTHON, "-c", f"""
import sys, json, os
sys.path.insert(0, {repr(str(MAE_V2_DIR))})
os.chdir({repr(str(MAE_V2_DIR))})
from dotenv import load_dotenv
load_dotenv({repr(str(_PROJECT_ROOT / '.env'))})
load_dotenv({repr(str(MAE_PROJECT_DIR / '.env'))})

# Import the extraction function
exec(open({repr(str(MAE_V2_DIR / '6_prep_new_MAE.py'))}).read().split('def main():')[0])

api_key = os.getenv('ANTHROPIC_API_KEY')
if not api_key:
    print('ERROR: ANTHROPIC_API_KEY not set', file=sys.stderr)
    sys.exit(1)

input_data = json.loads(open({repr(str(mae_input_path))}).read())
all_clauses = []
for deal in input_data['mae_clauses']:
    clauses = extract_exclusions(api_key, deal['dealName'], deal['text'])
    all_clauses.extend(clauses)

with open({repr(str(extracted_path))}, 'w') as f:
    json.dump(all_clauses, f, indent=2)
print(f'Extracted {{len(all_clauses)}} clauses')
"""],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0 or not extracted_path.exists():
            _write_status(deal_id, "error", "prep_clauses", f"Extraction failed: {result.stderr[:500]}")
            return

        # ── Step 4: Run Stage 6 — classify clauses ──
        _write_status(deal_id, "running", "stage6_classify")
        classification_dir = work_dir / "classification_output"
        classification_dir.mkdir(exist_ok=True)
        result = subprocess.run(
            [_PYTHON, "-c", f"""
import sys, os, json
sys.path.insert(0, {repr(str(MAE_V2_DIR))})
os.chdir({repr(str(MAE_V2_DIR))})
from dotenv import load_dotenv
load_dotenv({repr(str(_PROJECT_ROOT / '.env'))})
load_dotenv({repr(str(MAE_PROJECT_DIR / '.env'))})

import importlib.util
_spec = importlib.util.spec_from_file_location('stage6', {repr(str(MAE_V2_DIR / '6_classify_new_clauses.py'))})
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

cohere_key = os.getenv('COHERE_API_KEY')
if not cohere_key:
    print('ERROR: COHERE_API_KEY not set', file=sys.stderr)
    sys.exit(1)

classifier = mod.ClauseClassifier({repr(str(BENCHMARK_FILE))}, cohere_key)
results = classifier.process_file({repr(str(extracted_path))}, {repr(str(classification_dir))})
print(f'Classified {{len(results)}} clauses')
"""],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            _write_status(deal_id, "error", "stage6_classify", f"Classification failed: {result.stderr[:500]}")
            return

        # Find classification output file
        class_files = sorted(classification_dir.glob("classification_*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        if not class_files:
            _write_status(deal_id, "error", "stage6_classify", "No classification output found")
            return
        class_file = class_files[0]

        # ── Step 5: Run Stage 7 — risk analysis ──
        _write_status(deal_id, "running", "stage7_risk")
        risk_dir = work_dir / "risk_analysis_output"
        risk_dir.mkdir(exist_ok=True)
        result = subprocess.run(
            [_PYTHON, "-c", f"""
import sys, os
sys.path.insert(0, {repr(str(MAE_V2_DIR))})
os.chdir({repr(str(MAE_V2_DIR))})
from dotenv import load_dotenv
load_dotenv({repr(str(_PROJECT_ROOT / '.env'))})
load_dotenv({repr(str(MAE_PROJECT_DIR / '.env'))})

import importlib.util
_spec = importlib.util.spec_from_file_location('stage7', {repr(str(MAE_V2_DIR / '7_new_MAE_risk.py'))})
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

api_key = os.getenv('ANTHROPIC_API_KEY')
if not api_key:
    print('ERROR: ANTHROPIC_API_KEY not set', file=sys.stderr)
    sys.exit(1)

analyzer = mod.NewDealRiskAnalyzer(api_key, benchmark_file={repr(str(BENCHMARK_FILE))})
analyzer.analyze_new_deal({repr(str(class_file))}, {repr(str(risk_dir))})
print('Risk analysis complete')
"""],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            # Risk analysis is optional — log but don't fail
            print(f"[mae_pipeline] Stage 7 warning: {result.stderr[:200]}")

        # ── Step 6: Run Stage 8 — compliance checks ──
        _write_status(deal_id, "running", "stage8_compliance")
        compliance_dir = work_dir / "compliance_output"
        compliance_dir.mkdir(exist_ok=True)
        result = subprocess.run(
            [_PYTHON, "-c", f"""
import sys, os
sys.path.insert(0, {repr(str(MAE_V2_DIR))})
os.chdir({repr(str(MAE_V2_DIR))})
from dotenv import load_dotenv
load_dotenv({repr(str(_PROJECT_ROOT / '.env'))})
load_dotenv({repr(str(MAE_PROJECT_DIR / '.env'))})

import importlib.util
_spec = importlib.util.spec_from_file_location('stage8', {repr(str(MAE_V2_DIR / '8_LLM_Check_against_risks.py'))})
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

api_key = os.getenv('ANTHROPIC_API_KEY')
if not api_key:
    print('ERROR: ANTHROPIC_API_KEY not set', file=sys.stderr)
    sys.exit(1)

checker = mod.ComplianceChecker(api_key)
checker.analyze_deal({repr(str(class_file))}, {repr(str(compliance_dir))})
print('Compliance check complete')
"""],
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0:
            # Compliance is optional — log but don't fail
            print(f"[mae_pipeline] Stage 8 warning: {result.stderr[:200]}")

        # ── Step 7: Generate dashboard HTML ──
        _write_status(deal_id, "running", "generating_dashboard")

        # Load the stage outputs
        classification = json.loads(class_file.read_text())
        actual_deal_name = classification.get("deal_name", deal_name)

        risk_analysis = None
        risk_files = sorted(risk_dir.glob(f"risk_analysis_{actual_deal_name}_*.json"),
                           key=lambda f: f.stat().st_mtime, reverse=True)
        if risk_files:
            risk_analysis = json.loads(risk_files[0].read_text())

        compliance = None
        comp_files = sorted(compliance_dir.glob(f"compliance_{actual_deal_name}_*.json"),
                           key=lambda f: f.stat().st_mtime, reverse=True)
        if comp_files:
            compliance = json.loads(comp_files[0].read_text())

        # Import dashboard generator and generate HTML
        import importlib.util
        _spec = importlib.util.spec_from_file_location('stage10', str(MAE_V2_DIR / '10_dashboard.py'))
        dash_mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(dash_mod)
        gen = dash_mod.HTMLDashboardGenerator(str(work_dir))
        html_content = gen._generate_html(classification, risk_analysis, compliance, actual_deal_name)

        # Save to output location
        MAE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output_path = MAE_OUTPUT_DIR / f"{deal_id}.html"
        output_path.write_text(html_content, encoding="utf-8")

        _write_status(deal_id, "complete", "done")

    except subprocess.TimeoutExpired:
        _write_status(deal_id, "error", "timeout", "Pipeline timed out")
    except Exception as e:
        import traceback
        _write_status(deal_id, "error", "unknown", f"{e}\n{traceback.format_exc()[:500]}")


def start_mae_pipeline(deal_id: str, url: str, deal_name: str = "") -> dict:
    """Launch the MAE pipeline in a background thread."""
    status = get_pipeline_status(deal_id)
    if status.get("status") == "running":
        return {"status": "already_running", "step": status.get("step", "")}

    thread = threading.Thread(
        target=run_mae_pipeline,
        args=(deal_id, url, deal_name),
        daemon=True,
    )
    thread.start()
    return {"status": "started"}
