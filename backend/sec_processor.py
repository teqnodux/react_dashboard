"""
SEC Filing Processor
Reads pre-processed AI summaries from data/sec_filings/ and optionally
processes new filing URLs via the 8K Test filing_router pipeline.
"""

from __future__ import annotations

import json
import re
import sys
import hashlib
import importlib.util
from pathlib import Path

_BACKEND_DIR = Path(__file__).parent
SEC_FILINGS_DIR = _BACKEND_DIR / "data" / "sec_filings"

# Path to the 8K Test summarizer code
_SUMMARIZERS_DIR = (
    Path(__file__).parent.parent.parent / "8K Test" / "SEC Summarizers"
)


# ── Read-only functions ──────────────────────────────────────────────


def get_company_slugs() -> list[str]:
    """List all company slugs that have filing data."""
    if not SEC_FILINGS_DIR.exists():
        return []
    return sorted(d.name for d in SEC_FILINGS_DIR.iterdir() if d.is_dir())


def get_filing_index(company_slug: str) -> dict | None:
    """Load the filing_index.json for a company, or None."""
    index_path = SEC_FILINGS_DIR / company_slug / "filing_index.json"
    if not index_path.exists():
        return None
    return json.loads(index_path.read_text())


def get_all_filing_indexes() -> list[dict]:
    """Load all filing indexes across all companies."""
    results = []
    for slug in get_company_slugs():
        index = get_filing_index(slug)
        if index:
            index["_slug"] = slug
            results.append(index)
    return results


# ── Internal helpers ─────────────────────────────────────────────────


def _extract_uid(url: str) -> str:
    """Extract CIK+accession-based UID from SEC URL.

    Includes CIK to prevent collisions between different filers
    (e.g. multiple insiders filing Form 4s with similar accession numbers).
    """
    m = re.search(r'/Archives/edgar/data/(\d+)/(\d+)/', url)
    if m:
        cik = m.group(1)
        acc = m.group(2).lstrip('0') or '0'
        # Use last 4 of CIK + last 8 of accession = 12 char UID
        return f"{cik[-4:]}_{acc[-8:]}"
    return hashlib.md5(url.encode()).hexdigest()[:12]


def _slugify(company_name: str) -> str:
    """Convert company name to folder slug."""
    name = company_name.lower()
    for suffix in [', inc.', ', inc', ' inc.', ' inc', ', corp.', ', corp',
                   ' corp.', ' corp', ', llc', ' llc', ', ltd', ' ltd',
                   ' holdings', ' corporation']:
        name = name.replace(suffix, '')
    name = re.sub(r'[^a-z0-9]+', '-', name).strip('-')
    return name


def _find_existing_folder_for_ticker(ticker: str) -> str | None:
    """
    Look through existing company folders to find one that already
    contains filings for this ticker. Returns the slug or None.
    """
    if not ticker or not SEC_FILINGS_DIR.exists():
        return None
    ticker_upper = ticker.upper()
    for slug in get_company_slugs():
        index = get_filing_index(slug)
        if not index:
            continue
        # Check if any filing in this index has the same ticker
        for r in index.get("results", []):
            if r.get("ticker", "").upper() == ticker_upper:
                return slug
            summary = r.get("summary", {})
            if summary.get("ticker", "").upper() == ticker_upper:
                return slug
            # SC TO / SC 14D-9 filings use target_ticker instead of ticker
            if summary.get("target_ticker", "").upper() == ticker_upper:
                return slug
    return None


def _check_duplicate(company_slug: str, url: str) -> bool:
    """Check if a filing with this exact URL already exists.

    NOTE: We intentionally do NOT dedup by accession UID because a single
    SEC accession can contain multiple distinct documents (e.g. 8-K + 99.1 +
    SC 14D-9C) that should each be indexed separately.
    """
    index = get_filing_index(company_slug)
    if not index:
        return False

    for r in index.get("results", []):
        if r.get("url", "") == url:
            return True

    return False


# ── URL processing (requires 8K Test code + API key) ────────────────


def process_filing_url(url: str, company_slug: str | None = None) -> dict:
    """
    Process a single SEC filing URL through the filing_router pipeline.
    Returns the summary dict with filing_type injected.
    """
    import os
    from dotenv import load_dotenv

    router_path = _SUMMARIZERS_DIR / "filing_router.py"
    if not router_path.exists():
        raise RuntimeError(f"SEC filing router not found at {router_path}")

    # Pre-load .env so filing_router's module-level check finds the key
    env_path = Path.home() / "Downloads" / "Course+Materials" / "Merger Scraper" / ".env"
    if env_path.exists():
        load_dotenv(env_path)
    if not os.getenv("ANTHROPIC_API_KEY_TEST"):
        raise RuntimeError("ANTHROPIC_API_KEY_TEST not found in environment. Check your .env file.")

    # Add summarizers dir to sys.path for internal imports
    summarizers_str = str(_SUMMARIZERS_DIR)
    if summarizers_str not in sys.path:
        sys.path.insert(0, summarizers_str)

    # Import the router module
    spec = importlib.util.spec_from_file_location("filing_router", str(router_path))
    router_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(router_mod)

    # Step 1: Detect filing type BEFORE summarizing (so we can inject it)
    filing_type = router_mod.detect_from_url(url)
    if not filing_type:
        preview = router_mod.fetch_preview(url)
        filing_type = router_mod.classify_with_claude(preview)

    # Step 2: Resolve company slug early so we can check for duplicates
    ticker_from_url = _guess_ticker_from_url(url)
    if not company_slug and ticker_from_url:
        company_slug = _find_existing_folder_for_ticker(ticker_from_url)

    # Step 3: Check for duplicates if we know the company
    if company_slug and _check_duplicate(company_slug, url):
        # Return existing data instead of re-processing
        uid = _extract_uid(url)
        index = get_filing_index(company_slug)
        if index:
            for r in index.get("results", []):
                if _extract_uid(r.get("url", "")) == uid:
                    return r.get("summary", {})

    # Step 4: Run the summarizer
    result = router_mod.route_and_summarize(url)

    if not result:
        raise RuntimeError(f"Filing router returned no result for {url}")

    # Step 5: Inject filing_type into result (summarizers don't always include it)
    if filing_type and "filing_type" not in result:
        result["filing_type"] = filing_type

    # Step 6: Determine company slug from result if still not resolved
    if not company_slug:
        ticker = result.get("ticker", "") or result.get("target_ticker", "")
        issuer = (result.get("issuer", "") or result.get("subject_company", "")
                  or result.get("target", ""))

        # Try to find existing folder by ticker
        if ticker:
            company_slug = _find_existing_folder_for_ticker(ticker)

        # If no existing folder, create slug from issuer or ticker
        if not company_slug:
            if issuer:
                company_slug = _slugify(issuer)
            elif ticker:
                company_slug = ticker.lower()
            else:
                company_slug = "unknown"

    _save_filing_result(company_slug, url, result, filing_type)
    return result


def _guess_ticker_from_url(url: str) -> str | None:
    """Try to extract a ticker from an SEC EDGAR URL (e.g., espr-20260302.htm → ESPR)."""
    # Pattern: /data/CIK/accession/ticker-date.htm
    m = re.search(r'/(\d+)/([a-z]{2,6})-\d{8}\.htm', url.lower())
    if m:
        return m.group(2).upper()
    return None


def _save_filing_result(company_slug: str, url: str, summary: dict, filing_type: str = ""):
    """Save a processed filing to the sec_filings data directory."""
    company_dir = SEC_FILINGS_DIR / company_slug
    company_dir.mkdir(parents=True, exist_ok=True)

    uid = _extract_uid(url)

    # Use the detected filing type for the filename
    ft = filing_type or summary.get("filing_type", "") or summary.get("form_type", "")
    ft_clean = ft.lower().replace(" ", "").replace("/", "").replace("-", "")
    if not ft_clean:
        ft_clean = "filing"
    filename = f"{ft_clean}_summary_{uid}.json"

    # Save individual summary
    (company_dir / filename).write_text(json.dumps(summary, indent=2))

    # Update filing_index.json
    _update_index(company_slug, url, summary, filename, filing_type)


def _update_index(company_slug: str, url: str, summary: dict, filename: str, filing_type: str = ""):
    """Add or update an entry in the company's filing_index.json."""
    index_path = SEC_FILINGS_DIR / company_slug / "filing_index.json"

    if index_path.exists():
        index = json.loads(index_path.read_text())
    else:
        # New company — use a nice name if available
        company_name = (
            summary.get("issuer", "") or
            summary.get("subject_company", "") or
            summary.get("target", "") or
            company_slug
        )
        index = {
            "company": company_name,
            "total_filings": 0,
            "successful": 0,
            "failed": 0,
            "results": [],
            "failures": []
        }

    # Check for duplicates by exact URL only (not accession UID — a single
    # accession can contain multiple distinct documents like 8-K + 99.1 + SC 14D-9C)
    for r in index.get("results", []):
        if r.get("url", "") == url:
            return  # Already indexed

    # Use detected filing_type, falling back to what's in the summary
    form_type = filing_type or summary.get("filing_type", "") or summary.get("form_type", "")

    new_entry = {
        "index": index["total_filings"] + 1,
        "date": summary.get("filing_date", ""),
        "form_type": form_type,
        "url": url,
        "status": "success",
        "ticker": summary.get("ticker", "") or summary.get("target_ticker", ""),
        "summary": summary,
        "_filename": filename
    }

    index["results"].insert(0, new_entry)
    index["total_filings"] += 1
    index["successful"] += 1

    index_path.write_text(json.dumps(index, indent=2))
