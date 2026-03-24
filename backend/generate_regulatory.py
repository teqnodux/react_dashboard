"""
Regulatory Approval Tracker

Extracts and incrementally tracks regulatory approvals from any SEC filing
(8-K, PREM14A, DEFM14A, S-4, F-4, SC 13E-3, etc.) using Claude.

Core functions:
  seed_from_timeline_json(deal_id, json_path)   — seed D###_regulatory.json from existing timeline JSON
  process_edgar_filing(deal_id, url, doc_date)   — fetch EDGAR URL, extract approvals, merge + return diff
  load_regulatory(deal_id)                        — load current regulatory state
  manual_update(deal_id, approval_id, fields)    — manual status/date override
"""

import json
import os
import re
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional

# ── Path setup ────────────────────────────────────────────────────────────────

_BACKEND_DIR  = Path(__file__).parent
TIMELINES_DIR = _BACKEND_DIR / "data" / "timelines"
_ENV_PATH     = _BACKEND_DIR.parent.parent / ".env"

try:
    from dotenv import load_dotenv
    load_dotenv(_ENV_PATH)
except ImportError:
    pass

# ── Key helpers ───────────────────────────────────────────────────────────────

def _tk(name: str) -> str:
    """Sanitize a name into a snake_case key (matches generate_timeline.py)."""
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


def _approval_id(authority_short: str) -> str:
    """Stable ID for an approval entry."""
    if re.search(r'\bhsr\b', authority_short, re.I):
        return "hsr"
    return f"reg_{_tk(authority_short)}"


def _filing_key(authority_short: str) -> str:
    """Key that maps back to the tracking layer (D###_tracking.json events)."""
    if re.search(r'\bhsr\b', authority_short, re.I):
        return "hsr_filed"
    return f"reg_{_tk(authority_short)}"


# Lookup tables for jurisdiction + category inference from authority name
_JURISDICTION_MAP = {
    "hsr": "United States", "ftc": "United States", "doj": "United States",
    "cfius": "United States", "ferc": "United States", "fcc": "United States",
    "samr": "China", "mofcom": "China",
    "ec": "European Union", "eu": "European Union", "european": "European Union",
    "accc": "Australia", "firb": "Australia", "fata": "Australia",
    "cma": "United Kingdom", "uk": "United Kingdom",
    "tca": "Turkey", "turkish": "Turkey",
    "cade": "Brazil", "brazil": "Brazil",
    "comesa": "Africa",
    "investment canada": "Canada", "canada": "Canada",
    "kftc": "South Korea", "korea": "South Korea",
    "jftc": "Japan", "japan": "Japan",
    "cci": "India", "india": "India",
    "bafin": "Germany", "gwb": "Germany", "bundeskartellamt": "Germany",
    "autorité": "France", "france": "France",
    "cnmc": "Spain",
    "agcm": "Italy",
    "israel": "Israel", "companies registrar": "Israel",
    "nasdaq": "United States",
}

_CATEGORY_MAP = {
    # Foreign investment screening
    "cfius": "foreign_investment", "firb": "foreign_investment",
    "fata": "foreign_investment", "investment canada": "foreign_investment",
    # Sector-specific
    "ferc": "sector_specific", "fcc": "sector_specific",
    "finra": "sector_specific", "fdic": "sector_specific",
    "occ": "sector_specific", "fed": "sector_specific",
    # Everything else is antitrust
}


def _infer_jurisdiction(authority_short: str) -> Optional[str]:
    s = authority_short.lower()
    for key, jur in _JURISDICTION_MAP.items():
        if key in s:
            return jur
    return None


def _infer_category(authority_short: str) -> str:
    s = authority_short.lower()
    for key, cat in _CATEGORY_MAP.items():
        if key in s:
            return cat
    return "antitrust"


# ── File I/O ──────────────────────────────────────────────────────────────────

def _regulatory_path(deal_id: str) -> Path:
    return TIMELINES_DIR / f"{deal_id}_regulatory.json"


def load_regulatory(deal_id: str) -> dict:
    p = _regulatory_path(deal_id)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {
        "deal_id":            deal_id,
        "last_updated":       date.today().isoformat(),
        "approvals":          [],
        "documents_processed": [],
        "change_log":         [],
    }


def save_regulatory(deal_id: str, data: dict) -> None:
    TIMELINES_DIR.mkdir(parents=True, exist_ok=True)
    data["last_updated"] = date.today().isoformat()
    _regulatory_path(deal_id).write_text(json.dumps(data, indent=2), encoding="utf-8")


def _write_tracking_date(deal_id: str, filing_key: str, cleared_date: str, source: str) -> None:
    """Write a cleared date back to the tracking JSON so downstream chains auto-calculate."""
    tracking_path = TIMELINES_DIR / f"{deal_id}_tracking.json"
    if tracking_path.exists():
        tracking = json.loads(tracking_path.read_text(encoding="utf-8"))
    else:
        tracking = {"events": {}}
    events = tracking.setdefault("events", {})
    if filing_key not in events:
        events[filing_key] = {}
    if not events[filing_key].get("date"):  # don't overwrite existing
        events[filing_key]["date"]   = cleared_date
        events[filing_key]["source"] = source
        tracking_path.write_text(json.dumps(tracking, indent=2), encoding="utf-8")


# ── Seeding from timeline JSON ────────────────────────────────────────────────

def seed_from_timeline_json(deal_id: str, json_path: Path) -> None:
    """
    Create D###_regulatory.json from an already-generated D###.json.
    Called by main.py after build_timeline() completes.
    No-op if the regulatory JSON already exists.
    """
    reg_path = _regulatory_path(deal_id)
    if reg_path.exists():
        return

    deal = json.loads(json_path.read_text(encoding="utf-8"))
    now  = datetime.utcnow().isoformat() + "Z"
    today = date.today().isoformat()

    approvals = []

    # Always add HSR as the first approval
    approvals.append({
        "id":                   "hsr",
        "master_id":            "hsr_filing",
        "jurisdiction":         "United States",
        "authority_short":      "HSR / FTC+DOJ",
        "authority_full":       "Federal Trade Commission / Department of Justice",
        "statute":              "Hart-Scott-Rodino Antitrust Improvements Act",
        "category":             "antitrust",
        "status":               "pending",
        "status_detail":        "Not Filed",
        "filing_key":           "hsr_filed",
        "filed_date":           None,
        "cleared_date":         None,
        "expected_filing_period": None,
        "conditions":           None,
        "notes":                "HSR pre-merger notification filing required",
        "source_doc":           "Initial Summary",
        "source_doc_type":      "summary",
        "source_doc_url":       None,
        "first_seen_date":      today,
        "status_history":       [{
            "status":           "Not Filed",
            "status_legacy":    "pending",
            "date":             today,
            "source_doc":       "Initial Summary",
            "source_doc_type":  "summary",
            "source_url":       None,
            "excerpt":          None,
            "detected_at":      now,
        }],
        "conflicts":            [],
        "tracker_fields":       {},
    })

    # Add additional named regulators from regulatory_approvals
    # Try to map to master IDs for state-machine tracking
    try:
        from approval_master import map_existing_to_master
        _has_master = True
    except ImportError:
        _has_master = False

    for ra in deal.get("regulatory_approvals", []):
        ra_name = ra.get("name", "")
        if not ra_name:
            continue
        aid = _approval_id(ra_name)
        fk  = _filing_key(ra_name)
        master_id = map_existing_to_master(aid) if _has_master else None
        approvals.append({
            "id":                   aid,
            "master_id":            master_id,
            "jurisdiction":         _infer_jurisdiction(ra_name),
            "authority_short":      ra_name,
            "authority_full":       ra_name,
            "statute":              None,
            "category":             _infer_category(ra_name),
            "status":               "pending",
            "status_detail":        None,
            "filing_key":           fk,
            "filed_date":           None,
            "cleared_date":         None,
            "expected_filing_period": None,
            "conditions":           None,
            "notes":                ra.get("notes", ""),
            "source_doc":           "Initial Summary",
            "source_doc_type":      "summary",
            "source_doc_url":       None,
            "first_seen_date":      today,
            "status_history":       [{
                "status":           "pending",
                "status_legacy":    "pending",
                "date":             today,
                "source_doc":       "Initial Summary",
                "source_doc_type":  "summary",
                "source_url":       None,
                "excerpt":          None,
                "detected_at":      now,
            }],
            "conflicts":            [],
            "tracker_fields":       {},
        })

    reg_data = {
        "deal_id":      deal_id,
        "last_updated": today,
        "approvals":    approvals,
        "documents_processed": [{
            "doc_type":       "summary",
            "doc_date":       deal.get("signing_date"),
            "doc_url":        None,
            "processed_at":   now,
            "approvals_found": len(approvals),
            "additions":       [a["id"] for a in approvals],
            "status_changes":  [],
        }],
        "change_log": [{
            "timestamp":       now,
            "source_doc":      "Initial Summary",
            "source_doc_type": "summary",
            "changes": [
                {"type": "added", "approval_id": a["id"],
                 "detail": f"{a['authority_short']} added from initial deal summary"}
                for a in approvals
            ],
        }],
    }

    save_regulatory(deal_id, reg_data)
    print(f"[regulatory] Seeded {deal_id}_regulatory.json ({len(approvals)} approvals)")


# ── EDGAR fetching ────────────────────────────────────────────────────────────

def _detect_doc_type(url: str, html_text: str) -> str:
    """Detect SEC filing type from URL or page content."""
    url_lower = url.lower()
    for form, variants in [
        ("PREM14A",  ["prem14a"]),
        ("DEFM14A",  ["defm14a"]),
        ("DEFC14A",  ["defc14a"]),
        ("SC 13E-3", ["sc13e3", "sc-13e-3", "sch13e3"]),
        ("S-4",      ["/s-4", "s4/"]),
        ("F-4",      ["/f-4", "f4/"]),
        ("8-K",      ["/8-k", "8k/"]),
        ("SC TO-T",  ["sctot", "sc-to-t"]),
    ]:
        if any(v in url_lower for v in variants):
            return form
    # Try HTML content
    if "preliminary proxy" in html_text[:5000].lower():
        return "PREM14A"
    if "definitive proxy" in html_text[:5000].lower():
        return "DEFM14A"
    return "filing"


def _find_main_document_url(index_html: str, base_url: str) -> Optional[str]:
    """
    From an EDGAR filing index page, find the URL of the main document
    (the largest .htm file — typically the actual filing).
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return None

    soup = BeautifulSoup(index_html, "html.parser")
    candidates = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.endswith(".htm") or href.endswith(".html"):
            # Resolve relative URLs
            if href.startswith("/"):
                href = "https://www.sec.gov" + href
            elif not href.startswith("http"):
                # Relative to base
                href = base_url.rsplit("/", 1)[0] + "/" + href
            candidates.append(href)
    # Prefer the largest/most relevant
    if not candidates:
        return None
    return candidates[0]


def _extract_proxy_regulatory_section(html: str) -> Optional[str]:
    """
    For PREM14A / DEFM14A / S-4 / SC 13E-3:
    Use the document's named-anchor TOC to find ALL regulatory approval sections
    and concatenate them. Different filings split regulatory content across
    1, 2, or 3 separate sections (e.g. one for US/HSR, another for
    "Regulatory Approvals and Related Matters" covering non-US jurisdictions).

    Strategy:
      1. Collect ALL TOC <a href="#xxx"> links whose text mentions
         "regulatory" + "approv" (or "antitrust")
      2. For each anchor, extract the HTML between it and the next named anchor
      3. Concatenate all sections — Claude handles the combined text
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return None

    soup = BeautifulSoup(html, "html.parser")

    # Build ordered list of ALL named anchors in the document
    all_named = [a.get("name") for a in soup.find_all("a", attrs={"name": True}) if a.get("name")]
    anchor_index = {name: i for i, name in enumerate(all_named)}

    # Step 1 — collect all TOC links that mention regulatory approvals
    seen_anchors = set()
    reg_anchors = []  # ordered list of anchor names to extract
    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        text_content = a.get_text() or ""
        if href.startswith("#") and re.search(
            r"regulatory\s+(approv|matters|clearance)|antitrust\s+approv",
            text_content, re.I
        ):
            anchor_name = href[1:]
            if anchor_name and anchor_name not in seen_anchors and anchor_name in anchor_index:
                seen_anchors.add(anchor_name)
                reg_anchors.append(anchor_name)

    if not reg_anchors:
        print("[regulatory] No 'Regulatory Approvals' TOC links found in proxy HTML")
        return None

    print(f"[regulatory] Found {len(reg_anchors)} regulatory section(s): {reg_anchors}")

    # Step 2 — for each matched anchor, extract HTML to the next named anchor
    sections = []
    for anchor_name in reg_anchors:
        idx = anchor_index.get(anchor_name)
        if idx is None:
            continue

        # Next named anchor = section boundary
        next_anchor_name = all_named[idx + 1] if idx + 1 < len(all_named) else None

        m_start = re.search(rf'(?i)name="{re.escape(anchor_name)}"', html)
        if not m_start:
            continue
        start_pos = m_start.start()

        if next_anchor_name:
            m_end = re.search(rf'(?i)name="{re.escape(next_anchor_name)}"', html)
            end_pos = m_end.start() if m_end else len(html)
        else:
            end_pos = min(start_pos + 40000, len(html))

        section_html = html[start_pos:end_pos]
        sec_soup = BeautifulSoup(section_html, "html.parser")
        text = sec_soup.get_text(separator="\n", strip=True)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r" {2,}", " ", text)

        if len(text.strip()) > 100:   # skip near-empty anchors
            sections.append(text)
            print(f"[regulatory]   #{anchor_name}: {len(text)} chars")

    if not sections:
        return None

    combined = "\n\n---\n\n".join(sections)
    print(f"[regulatory] Total regulatory text: {len(combined)} chars across {len(sections)} section(s)")
    return combined


def _edgar_filing_date(url: str) -> Optional[str]:
    """
    Try to extract the filing date from an EDGAR URL.
    Parses the CIK + accession number from the URL and queries the EDGAR submissions API.
    Returns ISO date string or None.
    """
    try:
        import requests
        # Extract CIK and accession from URL pattern:
        # /Archives/edgar/data/{CIK}/{ACCESSION_NODASH}/...
        m = re.search(r'/edgar/data/(\d+)/(\d{18})/', url)
        if not m:
            return None
        cik, acc_nodash = m.group(1), m.group(2)
        # Format accession as XXXXXXXXXX-YY-ZZZZZZ
        acc = f"{acc_nodash[:10]}-{acc_nodash[10:12]}-{acc_nodash[12:]}"
        headers = {"User-Agent": "MergerArbDashboard/1.0 (research@example.com)"}
        subm_url = f"https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json"
        resp = requests.get(subm_url, headers=headers, timeout=15)
        if not resp.ok:
            return None
        data = resp.json()
        # Search recent + older filings
        for bucket in (data.get("filings", {}).get("recent", {}),):
            accessions = bucket.get("accessionNumber", [])
            dates      = bucket.get("filingDate", [])
            for a, d in zip(accessions, dates):
                if a == acc:
                    return d   # already YYYY-MM-DD
        return None
    except Exception:
        return None


def fetch_edgar_text(url: str) -> tuple[str, str]:
    """
    Fetch an EDGAR filing and return (text, doc_type) for Claude extraction.

    Proxy documents (PREM14A, DEFM14A, S-4, F-4, SC 13E-3):
      Uses the HTML named-anchor TOC to extract just the Regulatory Approvals
      section — precise and efficient.

    8-K and other short filings:
      Returns the full text (capped at 8 000 words — 8-Ks are 2–5 pages).
    """
    try:
        import requests
        from bs4 import BeautifulSoup
    except ImportError:
        raise RuntimeError("requests and beautifulsoup4 must be installed: pip install requests beautifulsoup4")

    headers = {"User-Agent": "MergerArbDashboard/1.0 (research@example.com)"}

    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    html = resp.text

    # Resolve filing index pages to the main document
    if "index.htm" in url.lower() or "filing-index" in url.lower() or (
        "Documents" in html[:3000] and "Sequence" in html[:3000]
    ):
        main_url = _find_main_document_url(html, url)
        if main_url and main_url != url:
            resp2 = requests.get(main_url, headers=headers, timeout=30)
            resp2.raise_for_status()
            html = resp2.text
            url  = main_url

    doc_type = _detect_doc_type(url, html)
    print(f"[regulatory] Fetched {len(html)} bytes, doc_type={doc_type}")

    # ── Proxy / S-4 / SC 13E-3: anchor-based section extraction ──────────────
    if doc_type in ("PREM14A", "DEFM14A", "S-4", "F-4", "SC 13E-3"):
        section = _extract_proxy_regulatory_section(html)
        if section:
            return section, doc_type
        raise RuntimeError(
            f"Could not locate 'Regulatory Approvals' section in this {doc_type}. "
            "The document may use a non-standard structure or the TOC anchor is missing. "
            "Check that you are providing the direct .htm document URL (not an index page)."
        )

    # ── 8-K and other short filings: full text ────────────────────────────────
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "meta", "link"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r" {2,}", " ", text)

    words = text.split()
    print(f"[regulatory] Full text: {len(words)} words")
    if len(words) > 8000:
        text = " ".join(words[:8000])
        print("[regulatory] Truncated to 8000 words")

    return text, doc_type


# ── Claude extraction ─────────────────────────────────────────────────────────

_EXTRACT_PROMPT = """\
You are an expert merger arbitrage analyst. Extract ALL regulatory approval requirements \
from the following filing text.

For EACH regulatory approval found, output one JSON object with these fields:
- "jurisdiction"         : country or region (e.g., "United States", "China", "European Union", \
"Australia", "Turkey", "United Kingdom")
- "authority_short"      : short name (e.g., "HSR/FTC+DOJ", "SAMR", "EC", "ACCC", "TCA", "FIRB", \
"CFIUS", "UK CMA")
- "authority_full"       : full official name (e.g., "Australian Competition and Consumer Commission")
- "statute"              : specific law or regulation cited (e.g., "Hart-Scott-Rodino Antitrust \
Improvements Act", "Anti-Monopoly Law of the People's Republic of China", \
"Competition and Consumer Act 2010 (Cth), Section 50")
- "category"             : "antitrust" for competition law (HSR, SAMR, EC, UK CMA, ACCC, CADE, etc.), \
"foreign_investment" for FDI screening (CFIUS, FIRB, Investment Canada, etc.), \
"sector_specific" for industry regulators (FCC, FERC, banking, etc.), "other" otherwise
- "status"               : use "cleared" if the document says clearance/early termination was \
granted; "filing_intent" if parties intend to file but haven't yet; \
"filed" if filed but awaiting decision; "pending" if not yet addressed; \
"not_required" if specifically determined not to apply
- "filed_date"           : ISO date (YYYY-MM-DD) if an actual filing date is mentioned, else null
- "cleared_date"         : ISO date (YYYY-MM-DD) if clearance was granted on a specific date, else null
- "expected_filing_period": string like "Q1 2026" or "within 10 days" if mentioned, else null
- "conditions"           : describe any imposed remedies/conditions (for cleared_with_conditions), else null
- "notes"                : one sentence: what specific approval is needed and any notable detail

CRITICAL RULES:
1. INCLUDE HSR (U.S. Hart-Scott-Rodino) — do not skip it.
2. Include both antitrust AND foreign investment approvals (e.g., FIRB is separate from ACCC).
3. Only include approvals that are SPECIFICALLY NAMED — not boilerplate like "all applicable \
antitrust clearances".
4. If the text says "Early termination of the HSR waiting period was granted effective [date]", \
set status="cleared" and cleared_date to that date.
5. If parties say "intend to file in Q1 2026", set status="filing_intent" and \
expected_filing_period="Q1 2026".

Respond with ONLY a valid JSON array (no markdown fences, no explanation):
[{ ... }, { ... }]

FILING TEXT:
"""


def extract_approvals(text: str, doc_type: str) -> list[dict]:
    """
    Call Claude to extract regulatory approvals from filing text.
    Returns a list of approval dicts (empty list if none found).
    """
    if not text or len(text.strip()) < 100:
        raise RuntimeError(
            f"Extracted text is too short ({len(text)} chars) — "
            "the URL may not point to a readable filing document. "
            "Try the direct .htm document URL rather than a search or index page."
        )

    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic must be installed: pip install anthropic")

    client = anthropic.Anthropic()
    prompt = _EXTRACT_PROMPT + "\n\n" + text

    response = client.messages.create(
        model      = "claude-sonnet-4-6",
        max_tokens = 2048,
        messages   = [{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    print(f"[regulatory] Claude raw response ({len(raw)} chars): {raw[:200]}")

    if not raw:
        return []

    # Strip markdown fences
    raw = re.sub(r"^```json\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```\s*$",  "", raw, flags=re.MULTILINE)
    raw = raw.strip()

    # Try direct parse first
    if raw.startswith("["):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass

    # Search for a JSON array anywhere in the response
    m = re.search(r'\[[\s\S]*\]', raw)
    if m:
        try:
            result = json.loads(m.group(0))
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    # Try as object
    if raw.startswith("{"):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return parsed
            if isinstance(parsed, dict):
                for v in parsed.values():
                    if isinstance(v, list):
                        return v
        except json.JSONDecodeError:
            pass

    # Claude said something like "No approvals found" — treat as empty
    lower = raw.lower()
    if any(phrase in lower for phrase in ("no regulatory", "no approvals", "none found", "not found", "no filings")):
        print("[regulatory] Claude indicated no approvals found — returning empty list")
        return []

    raise RuntimeError(
        f"Could not parse Claude response as JSON. "
        f"First 300 chars: {raw[:300]}"
    )


# ── Linked document helpers ───────────────────────────────────────────────────

def _make_linked_doc(doc_type: str, doc_date: str, doc_url: Optional[str],
                     doc_summary: dict) -> dict:
    """Create a linked_doc entry from a source document summary."""
    return {
        "doc_type": doc_type,
        "doc_date": doc_date,
        "doc_url": doc_url,
        "summary": doc_summary.get("summary") or doc_summary.get("text", ""),
        "L1": doc_summary.get("L1") or doc_summary.get("L1_headline"),
        "L2": doc_summary.get("L2") or doc_summary.get("L2_brief"),
        "L3": doc_summary.get("L3") or doc_summary.get("L3_detailed"),
    }


# ── Merge logic ───────────────────────────────────────────────────────────────

def merge_approvals(
    deal_id:        str,
    new_list:       list[dict],
    source_doc:     str,
    source_doc_type: str,
    source_doc_date: str,
    source_url:     str,
    doc_summary:    Optional[dict] = None,
) -> dict:
    """
    Merge a fresh list of extracted approvals into the deal's regulatory JSON.
    Updates statuses, adds new entries, tracks changes.

    Returns a diff dict:
      {
        "added":          [approval_id, ...],
        "status_changes": [{"id": ..., "from": ..., "to": ...}, ...],
        "date_updates":   [{"id": ..., "field": ..., "value": ...}, ...],
        "no_change":      [approval_id, ...],
      }
    """
    now  = datetime.utcnow().isoformat() + "Z"
    data = load_regulatory(deal_id)

    existing_map = {a["id"]: a for a in data.get("approvals", [])}
    changes  = []
    added    = []
    status_changes = []
    date_updates   = []
    no_change      = []

    for new_ap in new_list:
        auth_short = new_ap.get("authority_short", "")
        ap_id  = _approval_id(auth_short)
        fk     = _filing_key(auth_short)
        today  = date.today().isoformat()

        # Enrich inferred fields if Claude left them null
        if not new_ap.get("jurisdiction"):
            new_ap["jurisdiction"] = _infer_jurisdiction(auth_short)
        if not new_ap.get("category"):
            new_ap["category"] = _infer_category(auth_short)

        if ap_id not in existing_map:
            # New approval discovered
            # Try to map to master ID
            try:
                from approval_master import map_existing_to_master as _m2m
                master_id = _m2m(ap_id)
            except ImportError:
                master_id = None

            initial_status = new_ap.get("status", "pending")
            entry = {
                "id":                    ap_id,
                "master_id":             master_id,
                "jurisdiction":          new_ap.get("jurisdiction"),
                "authority_short":       auth_short,
                "authority_full":        new_ap.get("authority_full", auth_short),
                "statute":               new_ap.get("statute"),
                "category":              new_ap.get("category", "antitrust"),
                "status":                initial_status,
                "status_detail":         new_ap.get("status_detail"),
                "filing_key":            fk,
                "filed_date":            new_ap.get("filed_date"),
                "cleared_date":          new_ap.get("cleared_date"),
                "expected_filing_period": new_ap.get("expected_filing_period"),
                "conditions":            new_ap.get("conditions"),
                "notes":                 new_ap.get("notes", ""),
                "source_doc":            source_doc,
                "source_doc_type":       source_doc_type,
                "source_doc_url":        source_url,
                "first_seen_date":       today,
                "status_history":        [{
                    "status":           initial_status,
                    "status_legacy":    initial_status,
                    "date":             today,
                    "source_doc":       source_doc,
                    "source_doc_type":  source_doc_type,
                    "source_url":       source_url,
                    "excerpt":          new_ap.get("notes", "")[:200] or None,
                    "detected_at":      now,
                }],
                "conflicts":             [],
                "tracker_fields":        {},
            }
            data["approvals"].append(entry)
            existing_map[ap_id] = entry
            added.append(ap_id)
            # Attach source document summary
            if doc_summary:
                entry.setdefault("linked_docs", []).append(_make_linked_doc(
                    source_doc_type, source_doc_date, source_url, doc_summary
                ))
            changes.append({
                "type":        "added",
                "approval_id": ap_id,
                "detail":      f"{auth_short} newly required — first seen in {source_doc_type}",
            })

            # Write cleared_date to tracking if already cleared
            if entry.get("cleared_date"):
                _write_tracking_date(deal_id, fk, entry["cleared_date"], source_doc)

        else:
            existing = existing_map[ap_id]
            changed_this = False

            # Status change
            new_status = new_ap.get("status")
            if new_status and new_status != existing.get("status"):
                old_status = existing["status"]
                existing["status"] = new_status
                status_changes.append({"id": ap_id, "from": old_status, "to": new_status})
                changes.append({
                    "type":        "status_change",
                    "approval_id": ap_id,
                    "from":        old_status,
                    "to":          new_status,
                    "detail":      f"{auth_short} status: {old_status} → {new_status}",
                })
                changed_this = True

            # Enrich missing fields
            for field in ("authority_full", "statute", "jurisdiction", "category"):
                if new_ap.get(field) and not existing.get(field):
                    existing[field] = new_ap[field]
                    changed_this = True

            # Date updates (only fill in, never overwrite)
            for date_field in ("filed_date", "cleared_date", "expected_filing_period"):
                if new_ap.get(date_field) and not existing.get(date_field):
                    existing[date_field] = new_ap[date_field]
                    date_updates.append({"id": ap_id, "field": date_field, "value": new_ap[date_field]})
                    changes.append({
                        "type":        "date_update",
                        "approval_id": ap_id,
                        "field":       date_field,
                        "value":       new_ap[date_field],
                        "detail":      f"{auth_short} {date_field} → {new_ap[date_field]}",
                    })
                    changed_this = True

            # Write cleared_date to tracking if newly set
            if new_ap.get("cleared_date") and not existing_map[ap_id].get("cleared_date"):
                _write_tracking_date(deal_id, fk, new_ap["cleared_date"], source_doc)

            # Attach source document summary
            if doc_summary:
                existing.setdefault("linked_docs", [])
                ld = _make_linked_doc(source_doc_type, source_doc_date, source_url, doc_summary)
                # Deduplicate by doc_type+doc_date
                if not any(d.get("doc_type") == ld["doc_type"] and d.get("doc_date") == ld["doc_date"]
                          for d in existing["linked_docs"]):
                    existing["linked_docs"].append(ld)
                    changed_this = True

            if not changed_this:
                no_change.append(ap_id)

    # Record the document as processed
    data.setdefault("documents_processed", []).append({
        "doc_type":        source_doc_type,
        "doc_date":        source_doc_date,
        "doc_url":         source_url,
        "processed_at":    now,
        "approvals_found": len(new_list),
        "additions":       added,
        "status_changes":  [f"{sc['id']}: {sc['from']}→{sc['to']}" for sc in status_changes],
    })

    # Append change log entry only if something changed
    if changes:
        data.setdefault("change_log", []).append({
            "timestamp":       now,
            "source_doc":      source_doc,
            "source_doc_type": source_doc_type,
            "changes":         changes,
        })

    save_regulatory(deal_id, data)

    diff = {
        "added":          added,
        "status_changes": status_changes,
        "date_updates":   date_updates,
        "no_change":      no_change,
        "total_now":      len(data["approvals"]),
    }
    print(f"[regulatory] {deal_id} — +{len(added)} added, {len(status_changes)} status changes from {source_doc}")
    return diff


# ── Time-based status transitions ────────────────────────────────────────────

def check_time_based_transitions(deal_id: str, approvals: list) -> bool:
    """
    Check for status transitions that happen by passage of time, not documents.
    Currently handles:
      - HSR: 30 calendar days after filing with no second request → Cleared (Expiration)

    Returns True if any approval was updated (caller should save).
    If a later document contradicts this (e.g., second request), the normal
    monitor pipeline will create a conflict entry.
    """
    today = date.today()
    changed = False

    for ap in approvals:
        status = ap.get("status", "")
        filed = _parse_date_safe(ap.get("filed_date"))
        cleared = _parse_date_safe(ap.get("cleared_date"))

        # HSR: 30 calendar days after filing → cleared by expiration
        # Day 0 = filing date, waiting period expires end of day 30
        if (ap.get("id") == "hsr"
                and filed
                and not cleared
                and status not in ("cleared", "cleared_with_conditions")
                and today > filed + timedelta(days=30)):

            expiration_date = (filed + timedelta(days=30)).isoformat()

            # Update status
            ap["status"] = "cleared"
            ap["status_detail"] = "Cleared — Waiting Period Expired"
            ap["cleared_date"] = expiration_date

            # Append to status_history
            ap.setdefault("status_history", []).append({
                "status": "Cleared — Waiting Period Expired",
                "status_legacy": "cleared",
                "date": expiration_date,
                "source_doc": "Time-based inference",
                "source_doc_type": "system",
                "source_url": None,
                "excerpt": f"HSR 30-day waiting period expired on {expiration_date} with no second request or litigation detected.",
                "detected_at": datetime.utcnow().isoformat() + "Z",
            })

            # Write cleared date to tracking layer for cascade
            fk = ap.get("filing_key", "")
            if fk:
                _write_tracking_date(deal_id, fk, expiration_date, "HSR waiting period expiration")

            changed = True

    return changed


# ── Deadline computation ──────────────────────────────────────────────────────

def compute_deadlines(deal_id: str, approvals: list) -> list:
    """
    Enrich each approval with computed deadline fields.
    Reads timeline JSON for signing_date, outside_date; tracking JSON for trigger dates.
    """
    timeline_path = TIMELINES_DIR / f"{deal_id}.json"
    tracking_path = TIMELINES_DIR / f"{deal_id}_tracking.json"

    signing_date = None
    outside_date = None
    if timeline_path.exists():
        tl = json.loads(timeline_path.read_text())
        signing_date = _parse_date_safe(tl.get("signing_date"))
        outside_date = _parse_date_safe(tl.get("outside_date_initial"))

    tracking = {}
    if tracking_path.exists():
        tk = json.loads(tracking_path.read_text())
        tracking = tk.get("events", {})

    today = date.today()

    for ap in approvals:
        dl = {}

        # Days since first seen
        first_seen = _parse_date_safe(ap.get("first_seen_date"))
        if first_seen:
            dl["days_in_status"] = (today - first_seen).days

        # Days until outside date
        if outside_date:
            delta = (outside_date - today).days
            dl["days_until_outside"] = delta

        # Days in review (since filed_date)
        filed = _parse_date_safe(ap.get("filed_date"))
        cleared = _parse_date_safe(ap.get("cleared_date"))

        if filed and not cleared:
            dl["days_in_review"] = (today - filed).days
        elif filed and cleared:
            dl["days_to_clear"] = (cleared - filed).days

        # HSR special: expected filing ~25 business days after signing
        status = ap.get("status", "")
        if ap.get("id") == "hsr" and signing_date and not filed and status == "pending":
            # 25 business days ≈ 35 calendar days
            expected_hsr_filing = signing_date + timedelta(days=35)
            if today > expected_hsr_filing:
                dl["is_overdue"] = True
                dl["overdue_days"] = (today - expected_hsr_filing).days
                dl["overdue_reason"] = "HSR filing expected ~25 business days after signing"

        # HSR clearance: 30 calendar days after filing
        if ap.get("id") == "hsr" and filed and not cleared and status not in ("cleared", "cleared_with_conditions"):
            expected_clearance = filed + timedelta(days=30)
            dl["expected_decision_by"] = expected_clearance.isoformat()
            dl["days_remaining_hsr"] = (expected_clearance - today).days

        # General: if expected_filing_period contains a quarter, estimate
        efp = ap.get("expected_filing_period") or ""
        if efp and not filed and status in ("pending", "filing_intent"):
            quarter_end = _parse_quarter_end(efp)
            if quarter_end and today > quarter_end:
                dl["is_overdue"] = True
                dl["overdue_days"] = (today - quarter_end).days
                dl["overdue_reason"] = f"Expected filing by {efp}"

        ap["_deadline"] = dl

    return approvals


def _parse_date_safe(s) -> Optional[date]:
    """Parse YYYY-MM-DD string to date, return None on failure."""
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except (ValueError, TypeError):
        return None


def _parse_quarter_end(s: str) -> Optional[date]:
    """Parse 'Q1 2026' etc. to end-of-quarter date."""
    import re as _re
    m = _re.match(r'Q(\d)\s*(\d{4})', s)
    if not m:
        return None
    q, y = int(m.group(1)), int(m.group(2))
    month = {1: 3, 2: 6, 3: 9, 4: 12}.get(q, 12)
    day = {3: 31, 6: 30, 9: 30, 12: 31}.get(month, 30)
    return date(y, month, day)


# ── Main entry point: process an EDGAR filing URL ────────────────────────────

def process_edgar_filing(
    deal_id:  str,
    url:      str,
    doc_date: Optional[str] = None,   # YYYY-MM-DD; auto-detected from EDGAR if omitted
) -> dict:
    """
    Full pipeline: fetch EDGAR URL → extract approvals via Claude → merge → return diff.
    """
    print(f"[regulatory] Fetching {url} ...")
    text, doc_type = fetch_edgar_text(url)
    print(f"[regulatory] Detected doc_type={doc_type}, text length={len(text)}")

    # Auto-detect filing date if not supplied
    if not doc_date:
        doc_date = _edgar_filing_date(url)
        if doc_date:
            print(f"[regulatory] Auto-detected filing date: {doc_date}")
        else:
            doc_date = date.today().isoformat()
            print(f"[regulatory] Could not detect filing date — using today: {doc_date}")

    print(f"[regulatory] Extracting approvals via Claude ...")
    new_list = extract_approvals(text, doc_type)
    print(f"[regulatory] Found {len(new_list)} approvals in document")

    source_doc = f"{doc_type} {doc_date}"
    diff = merge_approvals(
        deal_id        = deal_id,
        new_list       = new_list,
        source_doc     = source_doc,
        source_doc_type = doc_type,
        source_doc_date = doc_date,
        source_url     = url,
    )
    diff["doc_type"] = doc_type
    diff["approvals_in_doc"] = len(new_list)
    return diff


# ── Manual update ─────────────────────────────────────────────────────────────

def manual_update(deal_id: str, approval_id: str, fields: dict) -> dict:
    """
    Manually update fields on a specific approval.
    Allowed fields: status, status_detail, filed_date, cleared_date,
                    expected_filing_period, conditions, notes, authority_full, statute.
    """
    data     = load_regulatory(deal_id)
    now      = datetime.utcnow().isoformat() + "Z"
    approval = next((a for a in data.get("approvals", []) if a["id"] == approval_id), None)

    if approval is None:
        raise KeyError(f"Approval '{approval_id}' not found in {deal_id}")

    allowed = {"status", "status_detail", "filed_date", "cleared_date",
               "expected_filing_period", "conditions", "notes", "authority_full", "statute"}
    changes = []
    for k, v in fields.items():
        if k not in allowed:
            continue
        old_v = approval.get(k)
        if old_v != v:
            approval[k] = v
            changes.append({"type": "manual_update", "approval_id": approval_id,
                             "field": k, "from": old_v, "to": v,
                             "detail": f"Manual: {k} → {v}"})

    # If status_detail was set, sync the legacy status and append to status_history
    if "status_detail" in fields and fields["status_detail"]:
        try:
            from approval_master import master_status_to_legacy
            approval["status"] = master_status_to_legacy(fields["status_detail"])
        except ImportError:
            pass
        approval.setdefault("status_history", []).append({
            "status": fields["status_detail"],
            "status_legacy": approval.get("status", "pending"),
            "date": date.today().isoformat(),
            "source_doc": "Manual Entry",
            "source_doc_type": "manual",
            "source_url": None,
            "excerpt": None,
            "detected_at": now,
        })

    # Write cleared_date to tracking if set
    if fields.get("cleared_date") and not data.get("tracking_written"):
        fk = approval.get("filing_key", _filing_key(approval.get("authority_short", "")))
        _write_tracking_date(deal_id, fk, fields["cleared_date"], "manual entry")

    if changes:
        data.setdefault("change_log", []).append({
            "timestamp":       now,
            "source_doc":      "Manual Entry",
            "source_doc_type": "manual",
            "changes":         changes,
        })

    save_regulatory(deal_id, data)
    return {"updated": [c["field"] for c in changes]}
