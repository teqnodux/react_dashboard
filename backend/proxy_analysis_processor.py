"""
Proxy Analysis Processor — parses proxy summary and changes txt files
into structured JSON for the dashboard Proxy tab.

TWO DISTINCT FORMATS:

1. Initial Filing (summary) — PREM14A, S-4, F-4:
   - Header (========)
   - Overview paragraph
   - Structured sections (DATES, CONSIDERATION, etc.) with [SOURCE TEXT] — NOT displayed
   - "Proxy Summary" marker
   - 5 Q&A pairs (question ending in ?, answer starting with +) — DISPLAYED
   - "Merger Background Analysis" section — DISPLAYED
   - Footer (Format Validation, Extraction) — NOT displayed

2. Subsequent Filing (changes) — DEFM14A, S-4/A, F-4/A:
   - Header (========)
   - Overview paragraph — DISPLAYED
   - Per-section changes with Was/Now and [NEW] tags — DISPLAYED

File naming: {TICKER}_{FILING_TYPE}_{summary|changes}_{timestamp}.txt
Data dir: data/proxy_analysis/{deal_id}/
"""

from __future__ import annotations

import os
import re
from pathlib import Path

PROXY_ANALYSIS_DIR = Path(__file__).parent / "data" / "proxy_analysis"


def _parse_header(lines: list[str]) -> dict:
    """Parse the ======== delimited header block.
    Also scans full text for format clues if no header found."""
    info = {"ticker": "", "company": "", "filing_type": "", "generated": "",
            "doc_type": "summary", "transition": ""}

    # Check if there's a ======== header block
    has_header = any(line.strip().startswith("====") for line in lines[:5])

    if has_header:
        for line in lines[:10]:
            line = line.strip()
            if not line or line.startswith("="):
                continue

            # "IMXI -- International Money Express, Inc."
            if " -- " in line and not info["ticker"]:
                parts = line.split(" -- ", 1)
                info["ticker"] = parts[0].strip()
                info["company"] = parts[1].strip()

            # "Changes: Preliminary Proxy (PREM14A) -> Definitive Proxy (DEFM14A)"
            elif "Changes:" in line:
                info["doc_type"] = "changes"
                info["transition"] = line.replace("Changes:", "").strip()
                m = re.search(r'\(([A-Z0-9/\-]+)\)\s*$', line)
                if m:
                    info["filing_type"] = m.group(1)

            elif "(" in line and ")" in line and not info["filing_type"]:
                m = re.search(r'\(([A-Z0-9/\-]+)\)', line)
                if m:
                    info["filing_type"] = m.group(1)

            elif line.startswith("Generated:"):
                info["generated"] = line.replace("Generated:", "").strip()
    else:
        # No header — auto-detect format from content
        full_text = "\n".join(lines).lower()
        if "was:" in full_text and "now:" in full_text:
            info["doc_type"] = "changes"
        # Try to detect filing type from content
        for ft in ("DEFM14A", "PREM14A", "S-4/A", "S-4", "F-4/A", "F-4"):
            if ft.lower() in full_text or f"({ft})" in "\n".join(lines):
                info["filing_type"] = ft
                break

    return info


def _find_body_start(lines: list[str]) -> int:
    """Find the line index after the second ======== line.
    If no header block exists, returns 0."""
    eq_count = 0
    for i, line in enumerate(lines):
        if line.strip().startswith("===="):
            eq_count += 1
            if eq_count >= 2:
                return i + 1
    return 0


def _extract_overview(lines: list[str]) -> tuple[str, int]:
    """Extract the overview paragraph (text before first uppercase section header).
    Returns (overview_text, next_line_index)."""
    overview_parts = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        # Stop at first section-like header (all caps, no leading punctuation)
        if stripped and _is_section_header(stripped):
            return " ".join(overview_parts).strip(), i
        if stripped:
            overview_parts.append(stripped)
    return " ".join(overview_parts).strip(), len(lines)


def _is_section_header(line: str) -> bool:
    """Check if a line is an all-caps section header (DATES, CONSIDERATION, etc.)."""
    stripped = line.strip()
    if not stripped or len(stripped) < 3:
        return False
    if stripped.startswith("-") or stripped.startswith("+") or stripped.startswith("["):
        return False
    # Must be mostly uppercase letters with allowed punctuation
    if re.match(r'^[A-Z][A-Z &\-/\']+$', stripped):
        return True
    return False


# ── Summary format parsing ──

def _parse_qa_section(lines: list[str], start: int) -> list[dict]:
    """Parse the Q&A pairs after 'Proxy Summary' marker.
    Questions end with ?, answers start with +.
    Questions may span multiple lines — accumulate until we see a line ending with ?."""
    qa_items = []
    current_q_parts: list[str] = []
    current_a_parts: list[str] = []
    in_answer = False
    i = start

    while i < len(lines):
        stripped = lines[i].strip()

        # Stop markers
        if stripped.lower().startswith("merger background analysis"):
            break
        if stripped.startswith("✓") or stripped.lower().startswith("extraction of other"):
            break

        # Answer line (starts with +)
        if stripped.startswith("+"):
            # If we were accumulating question parts, finalize question
            if current_q_parts and not in_answer:
                in_answer = True
            answer_text = stripped.lstrip("+").strip()
            if answer_text:
                current_a_parts.append(answer_text)
            in_answer = True

        # Empty line — could be gap between Q&A pairs
        elif not stripped:
            if in_answer and current_q_parts and current_a_parts:
                # Save completed Q&A pair
                qa_items.append({"question": " ".join(
                    current_q_parts), "answer": " ".join(current_a_parts)})
                current_q_parts = []
                current_a_parts = []
                in_answer = False

        # Non-answer, non-empty line
        else:
            if in_answer:
                # Continuation of answer (text without + prefix)
                current_a_parts.append(stripped)
            else:
                # Part of question (accumulate until we see answer)
                current_q_parts.append(stripped)

        i += 1

    # Don't forget last pair
    if current_q_parts and current_a_parts:
        qa_items.append({"question": " ".join(current_q_parts),
                        "answer": " ".join(current_a_parts)})

    return qa_items


def _parse_background_section(lines: list[str], start: int) -> dict:
    """Parse the Merger Background Analysis section.
    Returns {header, chronological_summary, items[]}."""
    bg = {"header": "", "chronological_summary": "", "items": []}
    i = start

    # Skip the header line itself
    if i < len(lines):
        bg["header"] = lines[i].strip()
        i += 1

    # Skip "Chronological Summary" subheader and empty lines
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.lower() == "chronological summary":
            i += 1
            continue
        if not stripped:
            i += 1
            continue
        break

    # Next paragraph(s) before numbered items = chronological_summary
    summary_parts = []
    while i < len(lines):
        stripped = lines[i].strip()
        # Stop at numbered item
        if re.match(r'^\d+\.', stripped):
            break
        # Stop at footer markers
        if stripped.startswith("✓") or stripped.lower().startswith("extraction of other"):
            break
        if not stripped:
            if summary_parts:
                break  # End of summary paragraph
            i += 1
            continue
        summary_parts.append(stripped)
        i += 1

    bg["chronological_summary"] = " ".join(summary_parts)

    # Parse numbered items
    current_item = None
    while i < len(lines):
        stripped = lines[i].strip()
        # Stop at footer markers
        if stripped.startswith("✓") or stripped.lower().startswith("extraction of other"):
            break
        if stripped.startswith("===="):
            break
        if not stripped:
            if current_item:
                bg["items"].append(current_item)
                current_item = None
            i += 1
            continue

        # Numbered item: "1. Text..."
        m = re.match(r'^(\d+)\.\s+(.*)', stripped)
        if m:
            if current_item:
                bg["items"].append(current_item)
            current_item = {"number": int(m.group(1)), "text": m.group(2)}
        elif current_item:
            current_item["text"] += " " + stripped
        i += 1

    if current_item:
        bg["items"].append(current_item)

    return bg


def _parse_summary_sections(body: list[str]) -> list[dict]:
    """Parse the structured sections (DATES, CONSIDERATION, etc.) from a summary file.
    Stops at 'Proxy Summary' marker or end of file."""
    sections = []
    current_section = None
    current_lines = []

    # Known stop markers (not section headers)
    stop_markers = {"proxy summary", "proxy summary:", "merger background analysis",
                    "merger background analysis - client deliverables"}

    for line in body:
        stripped = line.strip()
        if stripped.lower() in stop_markers:
            break
        if stripped.startswith("===="):
            continue

        if _is_section_header(stripped):
            if current_section:
                # Collect text before [SOURCE TEXT], skip source text blocks
                summary_text = _extract_section_summary(current_lines)
                sections.append({
                    "name": current_section,
                    "has_changes": True,
                    "items": [],
                    "raw_text": summary_text,
                })
            current_section = stripped
            current_lines = []
        else:
            current_lines.append(line)

    if current_section:
        summary_text = _extract_section_summary(current_lines)
        sections.append({
            "name": current_section,
            "has_changes": True,
            "items": [],
            "raw_text": summary_text,
        })

    return sections


def _extract_section_summary(lines: list[str]) -> str:
    """Extract the summary portion of a section, stopping at [SOURCE TEXT] marker."""
    parts = []
    for line in lines:
        stripped = line.strip()
        if stripped == "[SOURCE TEXT]":
            break
        if stripped:
            parts.append(stripped)
    return "\n".join(parts).strip()


def _parse_summary_file(lines: list[str], info: dict) -> dict:
    """Parse an initial filing (summary) txt file.
    Extracts overview, structured sections, Q&A pairs, and Background.
    Flexible: works with or without header block and 'Proxy Summary' marker."""
    body_start = _find_body_start(lines)

    # Skip empty lines after header
    while body_start < len(lines) and not lines[body_start].strip():
        body_start += 1

    body = lines[body_start:]

    # Try to find structured sections (DATES, CONSIDERATION, etc.)
    # Only extract overview if there are structured sections
    has_structured = any(_is_section_header(l.strip()) for l in body[:30])
    if has_structured:
        overview, section_start = _extract_overview(body)
        info["overview"] = overview
        info["sections"] = _parse_summary_sections(body[section_start:])
    else:
        info["overview"] = ""
        info["sections"] = []

    # Find Q&A section — try "Proxy Summary" marker first, then scan for Q&A patterns
    qa_items = []
    qa_start = None

    # Method 1: explicit "Proxy Summary" marker
    for i, line in enumerate(lines):
        if line.strip().lower() in ("proxy summary", "proxy summary:"):
            qa_start = i + 1
            break

    # Method 2: no marker — find first question/answer pattern (line with ?, followed by + line)
    if qa_start is None:
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.endswith("?") and not stripped.startswith("+"):
                # Check if a + answer line follows within next few lines
                for j in range(i + 1, min(i + 5, len(lines))):
                    if lines[j].strip().startswith("+"):
                        qa_start = i
                        break
                if qa_start is not None:
                    break

    if qa_start is not None:
        while qa_start < len(lines) and not lines[qa_start].strip():
            qa_start += 1
        qa_items = _parse_qa_section(lines, qa_start)

    info["qa_items"] = qa_items

    # Find "Merger Background Analysis" marker (flexible matching)
    background = None
    for i, line in enumerate(lines):
        lower = line.strip().lower()
        if "merger background analysis" in lower or "background analysis" in lower:
            background = _parse_background_section(lines, i)
            break

    info["background"] = background

    # Parse detail sections after background (fulsome format)
    # Look for "Extraction of other client deliverable sections" or numbered headers
    info["detail_sections"] = _parse_detail_sections(lines)

    return info


def _parse_detail_sections(lines: list[str]) -> list[dict]:
    """Parse numbered detail sections from fulsome proxy summaries.
    These appear after the background section, often preceded by
    'Extraction of other client deliverable sections'.
    Format: ' N. Section Title' followed by content."""
    # Find start: either the marker line or first numbered section after background
    start = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.lower().startswith("extraction of other"):
            start = i + 1
            break
        # Also detect if we see "✓ Format Validation" — sections follow
        if stripped.startswith("✓"):
            start = i + 1
            break

    if start is None:
        return []

    # Parse numbered section headers: "N. Title" or " N. Title"
    sections = []
    current: dict | None = None
    current_lines: list[str] = []

    for i in range(start, len(lines)):
        line = lines[i]
        stripped = line.strip()

        # Stop at closing ======== or end
        if stripped.startswith("===="):
            break

        # Skip validation/extraction markers
        if stripped.startswith("✓") or stripped.lower().startswith("extraction of other"):
            continue

        # Check for numbered section header: "N. Title" or " N. Title"
        # Distinguish from numbered list items by: short title (<=6 words),
        # no trailing period, and title doesn't start with a digit
        m = re.match(r'^ ?(\d+)\.\s+(.+)', line)
        if (m and len(m.group(2)) > 2 and not m.group(2)[0].isdigit()
                and len(m.group(2).split()) <= 6 and not stripped.endswith('.')):
            # Save previous section
            if current:
                current["content"] = "\n".join(current_lines).strip()
                if current["content"]:
                    sections.append(current)
            current = {
                "number": int(m.group(1)),
                "title": m.group(2).strip(),
                "content": "",
            }
            current_lines = []
        elif current is not None:
            current_lines.append(line.rstrip())

    # Save last section
    if current:
        current["content"] = "\n".join(current_lines).strip()
        if current["content"]:
            sections.append(current)

    return sections


# ── Changes format parsing ──

def _is_changes_section_header(line: str) -> bool:
    """Check if a line is a section header in a changes file.
    These are title-case or uppercase single-word/short headers like
    'Dates', 'Consideration', 'Financing', 'HSR', 'SH Approval', etc."""
    stripped = line.strip()
    if not stripped:
        return False
    if stripped.startswith("-") or stripped.startswith("+") or stripped.startswith("["):
        return False
    # Match known changes section patterns
    changes_sections = {
        "dates", "consideration", "financing", "sh approval",
        "hsr", "other regulatory", "closing", "termination & fees",
        "background", "conditions", "conditions to closing",
    }
    if stripped.lower() in changes_sections:
        return True
    # Also match the uppercase version
    if _is_section_header(stripped):
        return True
    # Title case versions
    if stripped in ("Dates", "Consideration", "Financing", "SH Approval",
                    "HSR", "Other Regulatory", "Closing", "Termination & Fees",
                    "Background", "Conditions", "Conditions to Closing"):
        return True
    return False


def _parse_changes_section_items(section_lines: list[str]) -> tuple[list[dict], str | None]:
    """Parse items within a changes section.
    Returns (items, raw_text_if_no_items)."""
    items = []
    current_item = None
    raw_parts = []

    for line in section_lines:
        stripped = line.strip()
        if not stripped:
            if current_item:
                items.append(current_item)
                current_item = None
            continue

        raw_parts.append(stripped)

        # Bullet item: "- Label: Value" or "- ADDED: ..." or "- REMOVED: ..."
        if stripped.startswith("- "):
            if current_item:
                items.append(current_item)
            content = stripped[2:]
            tag = None
            if "[NEW]" in content:
                tag = "NEW"
                content = content.replace("[NEW]", "").strip()
            if ":" in content:
                label, value = content.split(":", 1)
                current_item = {"label": label.strip(
                ), "value": value.strip(), "tag": tag}
            else:
                current_item = {
                    "label": content.strip(), "value": "", "tag": tag}

        # Was/Now blocks
        elif stripped.startswith("Was:"):
            if current_item:
                current_item["was"] = stripped[4:].strip()
        elif stripped.startswith("Now:"):
            if current_item:
                current_item["now"] = stripped[4:].strip()

        # Continuation lines
        else:
            if current_item:
                if current_item.get("was") is not None and not current_item.get("now"):
                    current_item["was"] += " " + stripped
                elif current_item.get("now") is not None:
                    current_item["now"] += " " + stripped
                elif current_item["value"]:
                    current_item["value"] += " " + stripped
                else:
                    current_item["value"] = stripped
            else:
                current_item = {"label": "", "value": stripped, "tag": None}

    if current_item:
        items.append(current_item)

    raw_text = "\n".join(raw_parts).strip() if not items else None
    return items, raw_text


def _parse_changes_file(lines: list[str], info: dict) -> dict:
    """Parse a changes (amendment) txt file.
    Extracts overview + per-section changes with Was/Now and [NEW] tags."""
    body_start = _find_body_start(lines)

    while body_start < len(lines) and not lines[body_start].strip():
        body_start += 1

    body = lines[body_start:]

    # Extract overview (text before first section header)
    overview_parts = []
    content_start = 0
    for i, line in enumerate(body):
        stripped = line.strip()
        if _is_changes_section_header(stripped):
            content_start = i
            break
        if stripped:
            overview_parts.append(stripped)

    info["overview"] = " ".join(overview_parts).strip()

    # Parse sections
    sections = []
    current_section = None
    current_lines = []
    remaining = body[content_start:]

    for line in remaining:
        stripped = line.strip()
        if stripped.startswith("===="):
            continue

        if _is_changes_section_header(stripped):
            if current_section:
                raw_text = "\n".join(l.strip() for l in current_lines).strip()
                no_changes = raw_text.lower() in (
                    "no changes.", "no material changes.",
                    "no changes", "no material changes"
                )
                if no_changes:
                    sections.append({
                        "name": current_section,
                        "has_changes": False,
                        "items": [],
                        "raw_text": None,
                    })
                else:
                    items, raw = _parse_changes_section_items(current_lines)
                    sections.append({
                        "name": current_section,
                        "has_changes": True,
                        "items": items,
                        "raw_text": raw,
                    })
            current_section = stripped
            current_lines = []
        else:
            current_lines.append(line)

    # Last section
    if current_section:
        raw_text = "\n".join(l.strip() for l in current_lines).strip()
        no_changes = raw_text.lower() in (
            "no changes.", "no material changes.",
            "no changes", "no material changes"
        )
        if no_changes:
            sections.append({
                "name": current_section,
                "has_changes": False,
                "items": [],
                "raw_text": None,
            })
        else:
            items, raw = _parse_changes_section_items(current_lines)
            sections.append({
                "name": current_section,
                "has_changes": True,
                "items": items,
                "raw_text": raw,
            })

    info["sections"] = sections
    info["qa_items"] = []
    info["background"] = None

    return info


# ── Public API ──

def parse_proxy_txt(filepath: str) -> dict:
    """Parse a proxy analysis txt file into structured JSON.
    Auto-detects summary vs changes format from header."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    lines = content.split("\n")
    info = _parse_header(lines)
    info["filename"] = os.path.basename(filepath)

    if info["doc_type"] == "changes":
        result = _parse_changes_file(lines, info)
    else:
        result = _parse_summary_file(lines, info)

    # Auto-detect view_type purely from content
    if result.get("detail_sections"):
        result["view_type"] = "fulsome"
    else:
        result["view_type"] = "concise"

    return result


def parse_proxy_content(content: str, filename: str = "") -> dict:
    """
    Parse proxy analysis from raw text content.

    This is the same output schema as `parse_proxy_txt`, but avoids needing
    a local file on disk (useful when the source is downloaded from Mongo / S3).
    """
    if content is None:
        content = ""
    lines = content.split("\n")

    print("lines:", lines)
    info = _parse_header(lines)
    info["filename"] = filename or info.get("filename", "") or "proxy.txt"

    if info["doc_type"] == "changes":
        result = _parse_changes_file(lines, info)
    else:
        result = _parse_summary_file(lines, info)

    # Auto-detect view_type purely from content
    if result.get("detail_sections"):
        result["view_type"] = "fulsome"
    else:
        result["view_type"] = "concise"

    return result


def get_proxy_analyses(deal_id: str) -> list[dict]:
    """Get all proxy analysis filings for a deal, sorted chronologically."""
    deal_dir = PROXY_ANALYSIS_DIR / deal_id
    if not deal_dir.exists():
        return []

    results = []
    for f in deal_dir.glob("*.txt"):
        if f.name.startswith("~") or f.name.startswith("."):
            continue
        try:
            parsed = parse_proxy_txt(str(f))
            results.append(parsed)
        except Exception as e:
            print(f"[proxy] Error parsing {f.name}: {e}")
            continue

    # Consolidate: for summary filings with the same filing_type, prefer fulsome
    summaries_by_type: dict[str, list[dict]] = {}
    changes = []
    for r in results:
        if r.get("doc_type") == "changes":
            changes.append(r)
        else:
            ft = r.get("filing_type", "")
            summaries_by_type.setdefault(ft, []).append(r)

    consolidated = list(changes)
    for ft, group in summaries_by_type.items():
        fulsome = [g for g in group if g.get("view_type") == "fulsome"]
        if fulsome:
            consolidated.append(fulsome[0])  # take best fulsome
        else:
            consolidated.append(group[0])  # take the concise

    # Sort chronologically (oldest first — PREM14A before DEFM14A)
    def _parse_date(r):
        from datetime import datetime
        g = r.get("generated", "")
        for fmt in ("%B %d, %Y - %I:%M %p", "%B %d, %Y"):
            try:
                return datetime.strptime(g, fmt)
            except ValueError:
                continue
        return datetime.min
    consolidated.sort(key=_parse_date, reverse=True)
    return consolidated


def save_proxy_txt(deal_id: str, filename: str, content: str) -> str:
    """Save proxy analysis txt content to the deal directory.
    Skips save if identical content already exists."""
    deal_dir = PROXY_ANALYSIS_DIR / deal_id
    deal_dir.mkdir(parents=True, exist_ok=True)
    # Check for duplicate content
    content_stripped = content.strip()
    for existing in deal_dir.glob("*.txt"):
        if existing.read_text(encoding="utf-8").strip() == content_stripped:
            return str(existing)  # Already exists, return existing path
    filepath = deal_dir / filename
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    return str(filepath)
