"""
10-K/10-Q Analysis Processor — parses overview, exec summary, and redline
txt files into structured JSON for the dashboard 10-K/10-Q tab.

THREE DOCUMENT TYPES:

1. Concise Overview (standalone filing):
   - Header: Company / Target (Ticker), Filing label
   - "Key Excerpts"
   - Numbered excerpts: N. [TAGS]   CATEGORY, Section: source, body text

2. Exec Summary (comparison):
   - Header: Company / Target (Ticker), transition (Q3 10-Q → FY 10-K)
   - One-line overview
   - CATEGORY sections with bullet items

3. Redline (comparison):
   - Header: Company / Target (Ticker), transition
   - "Current Filing: ... | Compared to: ..."
   - Numbered excerpts with significance, current/prior text, phrase changes, analysis

File naming: {TICKER}_{FILING_TYPE}_{doc_type}_{timestamp}.txt
Data dir: data/tenk_analysis/{deal_id}/
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from datetime import datetime

TENK_ANALYSIS_DIR = Path(__file__).parent / "data" / "tenk_analysis"


def _parse_header(lines: list[str]) -> dict:
    """Parse the first 2-3 lines: company/ticker, filing info or transition."""
    info = {
        "company": "",
        "ticker": "",
        "filing_type": "",
        "filing_label": "",
        "transition": "",
        "doc_type": "overview",
        "generated": "",
        "comparison_header": "",
    }

    # Line 0: "Nexstar Media Group, Inc. / TEGNA Inc. (NEXTSTAR)"
    # OR: "10-K Summary: Clearwater Analytics Holdings, Inc."
    if lines:
        line0 = lines[0].strip()
        # Handle "10-K Summary: Company Name" format
        sm = re.match(r'^(10-[KQ])\s+Summary:\s+(.+)', line0)
        if sm:
            info["filing_type"] = sm.group(1)
            info["company"] = sm.group(2).strip()
            info["filing_label"] = line0
        else:
            m = re.match(r'^(.+?)\s*\(([A-Z0-9]+)\)\s*$', line0)
            if m:
                info["company"] = m.group(1).strip()
                info["ticker"] = m.group(2).strip()
            else:
                info["company"] = line0

    # Check remaining header lines for Company/Period/Filing info
    for li in range(1, min(len(lines), 5)):
        line = lines[li].strip()
        if not line:
            continue
        # "Company: Clearwater Analytics Holdings, Inc. (CWAN)    Period: FY 2025"
        cm = re.match(r'^Company:\s+(.+?)\s*\(([A-Z0-9]+)\)', line)
        if cm:
            if not info["company"] or info["company"] == lines[0].strip():
                info["company"] = cm.group(1).strip()
            info["ticker"] = cm.group(2)
            pm = re.search(r'Period:\s+(.+?)(?:\s{2,}|$)', line)
            if pm:
                period = pm.group(1).strip()
                info["filing_label"] = f"{period} {info['filing_type']}" if info["filing_type"] else period
            continue
        # "Period End: 12/31/25    Filing Date: 02/18/26"
        if line.startswith("Period End:"):
            continue
        # "Filing: Q3 2025 10-Q" or label line
        if line.startswith("Filing:"):
            info["filing_label"] = line.replace("Filing:", "").strip()
            for ft in ("10-K", "10-Q"):
                if ft in info["filing_label"]:
                    info["filing_type"] = ft
                    break
            continue
        # "Q3 2025 10-Q → FY25 10-K"
        if "→" in line or "->" in line:
            info["transition"] = line
            parts = re.split(r'→|->', line)
            if len(parts) == 2:
                right = parts[1].strip()
                for ft in ("10-K", "10-Q"):
                    if ft in right:
                        info["filing_type"] = ft
                        break
            break

    return info


def _detect_doc_type(lines: list[str]) -> str:
    """Auto-detect document type from content."""
    text = "\n".join(lines[:20])
    if "Key Excerpts" in text:
        return "overview"
    if "Current Filing:" in text and "Compared to:" in text:
        return "redline"
    # Check for transition arrow (exec or redline)
    for line in lines[:5]:
        if "→" in line or "->" in line:
            return "exec"
    # Check for L1/L2/L3 format
    for line in lines[:15]:
        if line.strip().startswith("L1") and "Headline" in line:
            return "l123"
    # Check for category headers (TIMING, REGULATORY, etc.) with bullet items
    exec_headers = {"TIMING", "REGULATORY", "BUSINESS/RISK", "DEAL_TERMS", "RISK", "FINANCING", "OTHER"}
    has_header = False
    has_bullet = False
    for line in lines[:30]:
        stripped = line.strip()
        if stripped.upper() in exec_headers:
            has_header = True
        if stripped.startswith("•") or stripped.startswith("- "):
            has_bullet = True
        if has_header and has_bullet:
            return "exec"
    return "overview"


# ── Overview parsing ──

def _parse_overview(lines: list[str], info: dict) -> dict:
    """Parse a concise overview file with numbered key excerpts."""
    info["doc_type"] = "overview"
    excerpts = []

    # Find "Key Excerpts" marker
    start = 0
    for i, line in enumerate(lines):
        if line.strip().lower().startswith("key excerpts"):
            start = i + 1
            break

    # Parse numbered excerpts
    # Format: " 1. [TIMING + REGULATORY]   RISK"
    # Then:   "Section: ..."
    # Then:   body text until next numbered excerpt
    current = None
    body_lines = []

    for i in range(start, len(lines)):
        stripped = lines[i].strip()

        # New excerpt: " N. [TAGS]   CATEGORY"
        m = re.match(r'^\d+\.\s*\[([^\]]+)\]\s+(\S+.*)$', stripped)
        if m:
            # Save previous
            if current:
                current["text"] = " ".join(body_lines).strip()
                excerpts.append(current)
                body_lines = []

            tags_raw = m.group(1).strip()
            tags = [t.strip() for t in re.split(r'\s*\+\s*', tags_raw)]
            category = m.group(2).strip()
            number = int(re.match(r'^(\d+)', stripped).group(1))

            current = {
                "number": number,
                "tags": tags,
                "category": category,
                "section": "",
                "text": "",
            }
            continue

        # Section line
        if current and stripped.startswith("Section:"):
            current["section"] = stripped.replace("Section:", "").strip()
            continue

        # Body text
        if current and stripped:
            body_lines.append(stripped)

        # Empty line between excerpts — could be paragraph break in body
        if current and not stripped and body_lines:
            body_lines.append("")

    # Save last excerpt
    if current:
        current["text"] = " ".join(l for l in body_lines if l).strip()
        excerpts.append(current)

    info["excerpts"] = excerpts
    return info


# ── Exec Summary parsing ──

def _parse_exec(lines: list[str], info: dict) -> dict:
    """Parse an exec summary file with overview + category sections."""
    info["doc_type"] = "exec"

    # Find body start (after header lines)
    body_start = 2
    while body_start < len(lines) and not lines[body_start].strip():
        body_start += 1

    # Known exec section headers
    exec_section_names = {
        "TIMING", "REGULATORY", "BUSINESS/RISK", "DEAL_TERMS",
        "RISK", "FINANCING", "OTHER",
    }

    # First non-empty line after header = overview
    overview = ""
    sections = []
    current_section = None
    current_items = []
    i = body_start

    while i < len(lines):
        stripped = lines[i].strip()

        # Check if this is a section header (all caps, known name)
        if stripped.upper() in exec_section_names or stripped in exec_section_names:
            # First text before any section = overview
            if not current_section and not sections and not overview:
                # overview was already set, this is the first section
                pass
            if current_section:
                sections.append({"name": current_section, "items": current_items})
                current_items = []
            current_section = stripped.upper() if stripped.upper() in exec_section_names else stripped
            i += 1
            continue

        # Bullet item
        if stripped.startswith("•") or stripped.startswith("- "):
            bullet = stripped.lstrip("•-").strip()
            current_items.append(bullet)
            i += 1
            continue

        # Overview line (before first section)
        if not current_section and not sections and stripped:
            overview = stripped
            i += 1
            continue

        # Continuation of bullet
        if current_items and stripped and not stripped.startswith("•"):
            current_items[-1] += " " + stripped
            i += 1
            continue

        i += 1

    # Save last section
    if current_section:
        sections.append({"name": current_section, "items": current_items})

    info["overview"] = overview
    info["sections"] = sections
    return info


# ── Redline parsing ──

def _parse_redline(lines: list[str], info: dict) -> dict:
    """Parse a redline comparison file with numbered excerpts."""
    info["doc_type"] = "redline"

    # Find comparison header: "Current Filing: ... | Compared to: ..."
    body_start = 2
    for i, line in enumerate(lines[:10]):
        if "Current Filing:" in line and "Compared to:" in line:
            info["comparison_header"] = line.strip()
            body_start = i + 1
            break

    excerpts = []
    # Split into excerpt blocks by numbered pattern
    # " 1. [SIGNIFICANT]   TIMING  |  REGULATORY  —  Item 1. Business"
    excerpt_starts = []
    for i in range(body_start, len(lines)):
        stripped = lines[i].strip()
        m = re.match(r'^\d+\.\s*\[([A-Z]+)\]', stripped)
        if m:
            excerpt_starts.append(i)

    for idx, start_line in enumerate(excerpt_starts):
        end_line = excerpt_starts[idx + 1] if idx + 1 < len(excerpt_starts) else len(lines)
        block = lines[start_line:end_line]
        excerpt = _parse_redline_excerpt(block)
        if excerpt:
            excerpts.append(excerpt)

    info["redline_excerpts"] = excerpts
    return info


def _parse_redline_excerpt(block: list[str]) -> dict | None:
    """Parse a single redline excerpt block."""
    if not block:
        return None

    header = block[0].strip()

    # Parse header: "N. [SIGNIFICANCE]   TAG | TAG  —  Source"
    m = re.match(r'^(\d+)\.\s*\[([A-Z]+)\]\s+(.+?)(?:\s+—\s+(.+))?$', header)
    if not m:
        return None

    number = int(m.group(1))
    significance = m.group(2)
    tags_and_rest = m.group(3).strip()
    source = m.group(4).strip() if m.group(4) else ""

    # Parse tags from "TIMING  |  REGULATORY  |  LEGAL LANGUAGE"
    tags = [t.strip() for t in re.split(r'\s*\|\s*', tags_and_rest)]

    excerpt = {
        "number": number,
        "significance": significance,
        "tags": tags,
        "source": source,
        "current_label": "",
        "prior_label": "",
        "is_new": False,
        "current_text": "",
        "prior_text": "",
        "phrase_changes": [],
        "category_analysis": [],
    }

    # Find Current/Prior labels
    # "Current: FY25 10-K    Prior: Q3 2025 10-Q"
    # or "Current: FY25 10-K — New Disclosure"
    i = 1
    while i < len(block):
        stripped = block[i].strip()
        if stripped.startswith("Current:") and "Prior:" in stripped:
            parts = re.match(r'Current:\s*(.+?)\s+Prior:\s*(.+)', stripped)
            if parts:
                excerpt["current_label"] = parts.group(1).strip()
                excerpt["prior_label"] = parts.group(2).strip()
            i += 1
            break
        elif stripped.startswith("Current:") and "New Disclosure" in stripped:
            m2 = re.match(r'Current:\s*(.+?)(?:\s*—\s*New Disclosure)', stripped)
            if m2:
                excerpt["current_label"] = m2.group(1).strip()
            excerpt["is_new"] = True
            i += 1
            break
        i += 1

    # Parse body: current/prior text, phrase changes, category analysis
    # The text blocks are separated by markers
    phase = "text"  # text -> phrases -> analysis
    text_parts = []
    phrase_section_lines = []
    analysis_lines = []

    while i < len(block):
        stripped = block[i].strip()

        if stripped == "Specific Phrase Changes:":
            # Save accumulated text
            if text_parts:
                raw_text = " ".join(text_parts).strip()
                if excerpt["is_new"]:
                    excerpt["current_text"] = raw_text
                else:
                    _split_current_prior_text(raw_text, excerpt)
            phase = "phrases"
            i += 1
            continue

        # Category analysis bullet: "• TIMING: analysis..."
        if stripped.startswith("•") and ":" in stripped[:30]:
            phase = "analysis"
            cat_m = re.match(r'^•\s*([A-Z][A-Z /]+?):\s*(.*)', stripped)
            if cat_m:
                cat_name = cat_m.group(1).strip()
                cat_text = cat_m.group(2).strip()
                # Collect continuation lines
                j = i + 1
                while j < len(block):
                    next_s = block[j].strip()
                    if next_s.startswith("•") or not next_s:
                        break
                    cat_text += " " + next_s
                    j += 1
                excerpt["category_analysis"].append({
                    "category": cat_name,
                    "text": cat_text,
                })
                i = j
                continue

        if phase == "text":
            if stripped:
                text_parts.append(stripped)
        elif phase == "phrases":
            if stripped:
                phrase_section_lines.append(stripped)

        i += 1

    # If we never hit phrase changes, still split the text
    if phase == "text" and text_parts:
        raw_text = " ".join(text_parts).strip()
        if excerpt["is_new"]:
            excerpt["current_text"] = raw_text
        else:
            _split_current_prior_text(raw_text, excerpt)

    # Parse phrase changes
    if phrase_section_lines:
        excerpt["phrase_changes"] = _parse_phrase_changes(phrase_section_lines)

    return excerpt


def _split_current_prior_text(raw_text: str, excerpt: dict):
    """Split combined current/prior text block.
    The text has current text followed by prior text with large whitespace gap.
    In the txt format, they appear as consecutive text — we split roughly in half
    or at the point where the text repeats."""
    # The format has current and prior text separated by multiple spaces
    # Try to find the split point — look for 4+ spaces as separator
    parts = re.split(r'\s{4,}', raw_text, maxsplit=1)
    if len(parts) == 2:
        excerpt["current_text"] = parts[0].strip()
        excerpt["prior_text"] = parts[1].strip()
    else:
        # Fallback: put everything in current
        excerpt["current_text"] = raw_text
        excerpt["prior_text"] = ""


def _parse_phrase_changes(lines: list[str]) -> list[dict]:
    """Parse the Specific Phrase Changes section.
    Format: 'Current Phrase    Prior Phrase' header, then pairs separated by analysis text."""
    changes = []

    # Skip the header line "Current Phrase    Prior Phrase"
    start = 0
    for i, line in enumerate(lines):
        if "Current Phrase" in line and "Prior Phrase" in line:
            start = i + 1
            break

    # Parse phrase pairs and analysis
    # Phrases are in quotes, separated by large whitespace
    current_change = None
    analysis_parts = []

    for i in range(start, len(lines)):
        stripped = lines[i].strip()

        # Quoted phrase pair: "current phrase"    "prior phrase"
        if stripped.startswith('"'):
            # Save previous change
            if current_change:
                current_change["analysis"] = " ".join(analysis_parts).strip()
                changes.append(current_change)
                analysis_parts = []

            # Split on large whitespace between quoted strings
            parts = re.split(r'"\s{2,}"', stripped)
            if len(parts) == 2:
                current_phrase = parts[0].strip().strip('"')
                prior_phrase = parts[1].strip().strip('"')
                current_change = {
                    "current": current_phrase,
                    "prior": prior_phrase,
                    "analysis": "",
                }
            elif stripped.endswith('"') or not stripped.endswith('"'):
                # Single phrase (new disclosure — no prior)
                phrase = stripped.strip('"')
                current_change = {
                    "current": phrase,
                    "prior": "",
                    "analysis": "",
                }
        else:
            # Analysis text
            if stripped:
                analysis_parts.append(stripped)

    # Save last change
    if current_change:
        current_change["analysis"] = " ".join(analysis_parts).strip()
        changes.append(current_change)

    return changes


# ── L1/L2/L3 format parsing ──

def _parse_l123(lines: list[str], info: dict) -> dict:
    """Parse L1 — Headline / L2 — Brief / L3 — Detailed format."""
    info["doc_type"] = "l123"

    headline = ""
    brief = ""
    sections = []
    current_section = None
    current_items: list[str] = []
    phase = "header"  # header -> l1 -> l2 -> l3

    for line in lines:
        stripped = line.strip()

        # Detect L-markers
        if stripped.startswith("L1") and "Headline" in stripped:
            phase = "l1"
            continue
        if stripped.startswith("L2") and "Brief" in stripped:
            phase = "l2"
            continue
        if stripped.startswith("L3") and "Detailed" in stripped:
            phase = "l3"
            continue

        if phase == "header":
            continue

        if phase == "l1":
            if stripped.startswith("+"):
                headline = stripped.lstrip("+").strip()
            elif stripped:
                headline = stripped
            continue

        if phase == "l2":
            if stripped:
                brief = (brief + " " + stripped).strip() if brief else stripped
            continue

        if phase == "l3":
            if not stripped:
                continue
            # Bullet item
            if stripped.startswith("•") or stripped.startswith("- "):
                bullet = stripped.lstrip("•-").strip()
                current_items.append(bullet)
                continue
            # Key: Value line (e.g. "Revenue: $731.4 million...")
            kv = re.match(r'^([A-Z][A-Za-z &/\'-]+?):\s+(.+)', stripped)
            if kv and current_section and len(kv.group(1)) < 40:
                current_items.append(stripped)
                continue
            # Section header: short title-case line, no punctuation at end,
            # not too long (under 40 chars), not starting with a number/symbol
            is_header = (
                len(stripped) < 40
                and not stripped[-1] in '.,:;'
                and stripped[0].isupper()
                and not any(c in stripped for c in ['$', '%', '(', ')'])
            )
            if is_header:
                if current_section:
                    sections.append({"name": current_section, "items": current_items})
                    current_items = []
                current_section = stripped
                continue
            # Plain text paragraph — add as content item
            if current_section:
                current_items.append(stripped)
                continue

    # Save last section
    if current_section:
        sections.append({"name": current_section, "items": current_items})

    info["overview"] = brief
    info["headline"] = headline
    info["brief"] = brief
    info["sections"] = sections
    return info


# ── Public API ──

def parse_tenk_txt(filepath: str) -> dict:
    """Parse a 10-K/10-Q analysis txt file into structured JSON.
    Auto-detects doc type from content."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    lines = content.split("\n")
    info = _parse_header(lines)
    info["filename"] = os.path.basename(filepath)

    doc_type = _detect_doc_type(lines)

    if doc_type == "l123":
        return _parse_l123(lines, info)
    elif doc_type == "overview":
        return _parse_overview(lines, info)
    elif doc_type == "redline":
        return _parse_redline(lines, info)
    else:
        return _parse_exec(lines, info)


def get_tenk_analyses(deal_id: str) -> list[dict]:
    """Get all 10-K/10-Q analysis filings for a deal, sorted chronologically."""
    deal_dir = TENK_ANALYSIS_DIR / deal_id
    if not deal_dir.exists():
        return []

    results = []
    for f in deal_dir.glob("*.txt"):
        if f.name.startswith("~") or f.name.startswith("."):
            continue
        try:
            parsed = parse_tenk_txt(str(f))
            results.append(parsed)
        except Exception as e:
            print(f"[tenk] Error parsing {f.name}: {e}")
            continue

    # Sort by generated date (most recent first)
    def _parse_date(r):
        g = r.get("generated", "")
        for fmt in ("%B %d, %Y - %I:%M %p", "%B %d, %Y"):
            try:
                return datetime.strptime(g, fmt)
            except ValueError:
                continue
        # Fallback: try to extract from filename timestamp
        fname = r.get("filename", "")
        m = re.search(r'(\d{8}_\d{4})', fname)
        if m:
            try:
                return datetime.strptime(m.group(1), "%Y%m%d_%H%M")
            except ValueError:
                pass
        return datetime.min

    results.sort(key=_parse_date, reverse=True)
    return results


def save_tenk_txt(deal_id: str, filename: str, content: str) -> str:
    """Save 10-K/10-Q analysis txt content to the deal directory.
    Skips save if identical content already exists."""
    deal_dir = TENK_ANALYSIS_DIR / deal_id
    deal_dir.mkdir(parents=True, exist_ok=True)
    # Check for duplicate content
    content_stripped = content.strip()
    for existing in deal_dir.glob("*.txt"):
        if existing.read_text(encoding="utf-8").strip() == content_stripped:
            return str(existing)
    filepath = deal_dir / filename
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    return str(filepath)
