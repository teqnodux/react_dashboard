#!/usr/bin/env python3
"""
DMA Document Processor - Two-Pass Format
Handles documents with separate "Concise Summary" and "Fulsome Summary" sections.

Usage:
    python process_dma_two_pass.py input.docx --deal-id D001
    python process_dma_two_pass.py "Great Lakes Dredge.docx" --auto
"""

import argparse
import json
import re
from pathlib import Path
from typing import List, Dict, Any, Optional

try:
    from docx import Document
except ImportError:
    print("Error: python-docx not installed. Run: pip install python-docx")
    exit(1)


def extract_sections_two_pass(docx_path: str) -> List[Dict[str, Any]]:
    """
    Extract sections from two-pass format:
    1. "Concise Summary" with all sections
    2. "Fulsome Summary" with all sections

    Matches them up by section name (Heading 2).
    """
    doc = Document(docx_path)

    # Storage for sections
    concise_sections = {}  # {section_name: [clauses]}
    fulsome_sections = {}  # {section_name: [clauses]}

    # State tracking
    current_mode = None  # 'concise' or 'fulsome'
    current_section = None
    current_clauses = []

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue

        # Check for mode markers
        if 'concise summary' in text.lower() and para.runs and para.runs[0].bold:
            current_mode = 'concise'
            current_section = None
            continue

        if 'fulsome summary' in text.lower() and para.runs and para.runs[0].bold:
            # Save any pending concise section
            if current_section and current_clauses:
                concise_sections[current_section] = current_clauses

            current_mode = 'fulsome'
            current_section = None
            current_clauses = []
            continue

        if not current_mode:
            continue

        # Check for section header (Heading 2)
        if para.style.name == 'Heading 2':
            # Save previous section
            if current_section and current_clauses:
                if current_mode == 'concise':
                    concise_sections[current_section] = current_clauses
                else:
                    fulsome_sections[current_section] = current_clauses

            # Start new section
            current_section = text
            current_clauses = []
            continue

        # Collect clause text (lines starting with +, or all content)
        if current_section:
            # Clean up bullet markers
            cleaned = text
            if text.startswith('+'):
                cleaned = text[1:].strip()
            elif text.startswith('○'):
                # This is a reference line - append to last clause
                if current_clauses:
                    if 'references' not in current_clauses[-1]:
                        current_clauses[-1]['references'] = []
                    ref_text = cleaned[1:].strip() if cleaned.startswith('○') else cleaned
                    current_clauses[-1]['references'].append(ref_text)
                continue

            if cleaned:
                current_clauses.append({
                    'text': cleaned,
                    'references': []
                })

    # Save last section
    if current_section and current_clauses:
        if current_mode == 'fulsome':
            fulsome_sections[current_section] = current_clauses
        else:
            concise_sections[current_section] = current_clauses

    # Merge concise and fulsome by section name
    merged_sections = []
    all_section_names = set(concise_sections.keys()) | set(fulsome_sections.keys())

    for section_name in sorted(all_section_names):
        concise_clauses = concise_sections.get(section_name, [])
        fulsome_clauses = fulsome_sections.get(section_name, [])

        # Match up clauses (assume same order and count)
        max_clauses = max(len(concise_clauses), len(fulsome_clauses))

        merged_clauses = []
        for i in range(max_clauses):
            concise_text = concise_clauses[i]['text'] if i < len(concise_clauses) else ''
            concise_refs = concise_clauses[i].get('references', []) if i < len(concise_clauses) else []

            fulsome_text = fulsome_clauses[i]['text'] if i < len(fulsome_clauses) else ''
            fulsome_refs = fulsome_clauses[i].get('references', []) if i < len(fulsome_clauses) else []

            # Combine references
            all_refs = list(set(concise_refs + fulsome_refs))

            # Extract clean references
            clean_refs = extract_references(' '.join(all_refs))

            merged_clauses.append({
                'topic': f'Clause {i+1}',  # Generic topic since not explicitly labeled
                'concise': concise_text or fulsome_text,
                'fulsome': fulsome_text or concise_text,
                'clause_text': fulsome_text or concise_text,
                'references': clean_refs
            })

        merged_sections.append({
            'name': section_name,
            'clauses': merged_clauses
        })

    return merged_sections


def _is_section_header(line: str) -> bool:
    """
    Determine whether a plain-text line is a section header vs wrapped clause text.
    Section headers are short, title-cased labels like "Consideration",
    "Competing Bid - Company", "Termination Fee Amounts", etc.
    Continuation lines are typically lowercase fragments ending with periods.
    """
    # Too long to be a header
    if len(line) > 60:
        return False
    # Ends with period/comma/semicolon — continuation text, not a header
    if line.rstrip().endswith((".", ";", ",")):
        return False
    # Starts with lowercase — continuation text
    if line[0].islower():
        return False
    # Contains "From :" pattern — it's a source tag, not a header
    if "From :" in line or "From:" in line:
        return False
    # Contains "=" or ":" followed by content — inline label, not a header
    # e.g. "Parent = Boston Scientific Corporation", "Company: Penumbra, Inc."
    if "=" in line or (": " in line and not line.endswith(":")):
        return False
    # Known header patterns: short, title-like, no trailing punctuation
    return True


def extract_sections_from_text(raw_text: str) -> Dict[str, Any]:
    """
    Parse concise/fulsome sections from plain text (same format as DOCX output).
    Returns {"concise_sections": [...], "fulsome_sections": [...]}.
    Lines starting with '+' are clauses, lines starting with '○' are references,
    lines matching section header heuristics become headers,
    all other lines are continuation text appended to the previous clause.
    """
    concise_sections: Dict[str, list] = {}
    fulsome_sections: Dict[str, list] = {}

    current_mode = None
    current_section = None
    current_clauses: list = []

    for raw_line in raw_text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        low = line.lower()

        # Mode markers
        if "concise summary" in low and not line.startswith("+") and not line.startswith("○"):
            current_mode = "concise"
            current_section = None
            current_clauses = []
            continue

        if "fulsome summary" in low and not line.startswith("+") and not line.startswith("○"):
            if current_section and current_clauses:
                concise_sections[current_section] = current_clauses
            current_mode = "fulsome"
            current_section = None
            current_clauses = []
            continue

        if not current_mode:
            continue

        # Reference line (○ or "From :" tag)
        if line.startswith("○"):
            ref_text = line[1:].strip()
            # strip "References:" prefix
            if ref_text.lower().startswith("references:"):
                ref_text = ref_text[len("references:"):].strip()
            if current_clauses and ref_text:
                current_clauses[-1].setdefault("references", []).append(ref_text)
            continue

        # "From :" source tags — attach as metadata, skip
        if line.startswith("From :") or line.startswith("From:"):
            continue

        # Clause line
        if line.startswith("+") or line.startswith("\t+"):
            cleaned = line.lstrip("+\t ").strip()
            if cleaned and current_section:
                current_clauses.append({"text": cleaned, "references": []})
            continue

        # Section header vs continuation text
        if _is_section_header(line):
            # Save previous section
            if current_section and current_clauses:
                if current_mode == "concise":
                    concise_sections[current_section] = current_clauses
                else:
                    fulsome_sections[current_section] = current_clauses
            current_section = line
            current_clauses = []
        else:
            # Continuation of previous clause — append text
            if current_clauses:
                current_clauses[-1]["text"] += " " + line
            # If no clause yet but we have a section, start one
            elif current_section:
                current_clauses.append({"text": line, "references": []})

    # Save last section
    if current_section and current_clauses:
        if current_mode == "fulsome":
            fulsome_sections[current_section] = current_clauses
        else:
            concise_sections[current_section] = current_clauses

    # Build output arrays preserving section order
    concise_out = [{"name": name, "clauses": clauses} for name, clauses in concise_sections.items()]
    fulsome_out = [{"name": name, "clauses": clauses} for name, clauses in fulsome_sections.items()]

    return {"concise_sections": concise_out, "fulsome_sections": fulsome_out}


def save_detail_sections(deal_id: str, sections_data: Dict[str, Any]) -> Path:
    """Save parsed sections to backend/data/details/{deal_id}.json.
    Merges with existing detail file if present."""
    details_dir = Path(__file__).parent / "data" / "details"
    details_dir.mkdir(parents=True, exist_ok=True)
    detail_path = details_dir / f"{deal_id}.json"

    existing = {}
    if detail_path.exists():
        with open(detail_path) as f:
            existing = json.load(f)

    existing["deal_id"] = deal_id
    existing["concise_sections"] = sections_data["concise_sections"]
    existing["fulsome_sections"] = sections_data["fulsome_sections"]

    with open(detail_path, "w") as f:
        json.dump(existing, f, indent=2, ensure_ascii=False)

    return detail_path


def extract_references(text: str) -> List[str]:
    """Extract clean section references."""
    patterns = [
        r'Section\s+\d+\.?\d*(?:\.\d+)?(?:\s*\([a-z]\))?',
        r'Article\s+[IVX]+',
        r'Definition\s*>\s*[\w\s]+',
        r'Preamble'
    ]

    references = []
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        references.extend(matches)

    return list(set(references))[:10]  # Limit to 10 unique refs


def extract_deal_id(filename: str) -> Optional[str]:
    """Try to extract deal ID from filename."""
    # Check for D### pattern
    match = re.search(r'[dD](\d+)', filename)
    if match:
        return f"D{match.group(1)}"

    # Extract company name for manual mapping
    name = filename.lower()
    if 'great lakes' in name or 'dredge' in name:
        return 'D???'  # User needs to specify

    return None


def main():
    parser = argparse.ArgumentParser(description='Convert two-pass DMA DOCX to JSON')
    parser.add_argument('input', help='Input DOCX file')
    parser.add_argument('--deal-id', help='Deal ID (e.g., D001)')
    parser.add_argument('--auto', action='store_true', help='Auto-generate output filename')
    parser.add_argument('--output', help='Output JSON file')

    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: File not found: {args.input}")
        return 1

    print(f"\nProcessing: {input_path.name}")
    print("=" * 60)

    # Determine deal ID
    deal_id = args.deal_id or extract_deal_id(input_path.stem)
    if not deal_id or '?' in deal_id:
        print("⚠️  Could not auto-detect deal ID")
        print("Please specify with: --deal-id D001")
        return 1

    print(f"Deal ID: {deal_id}")

    # Extract sections
    try:
        sections = extract_sections_two_pass(str(input_path))
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return 1

    clause_count = sum(len(s['clauses']) for s in sections)
    print(f"\nExtracted:")
    print(f"  • {len(sections)} sections")
    print(f"  • {clause_count} total clauses")

    print(f"\nSections:")
    for section in sections:
        print(f"  - {section['name']}: {len(section['clauses'])} clauses")

    # Create JSON
    output_data = {
        'deal_id': deal_id,
        'dma_sections': sections,
        'metadata': {
            'total_sections': len(sections),
            'total_clauses': clause_count,
            'source_file': input_path.name,
            'format': 'two-pass'
        }
    }

    # Determine output path
    if args.output:
        output_path = Path(args.output)
    elif args.auto:
        output_path = input_path.with_suffix('.json')
    else:
        # Default to project-level details folder (not backend/data)
        base_dir = Path(__file__).parent.parent  # Go up from backend/ to project root
        output_path = base_dir / 'data' / 'details' / f'{deal_id}.json'
        output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write JSON
    print(f"\nWriting to: {output_path}")
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)

    print("✓ Done!")
    print(f"\nNext steps:")
    print(f"  1. Review the JSON: {output_path}")
    print(f"  2. If it looks good, restart the backend server")
    print(f"  3. View in dashboard under deal {deal_id} > MAE tab")

    return 0


if __name__ == '__main__':
    exit(main())
