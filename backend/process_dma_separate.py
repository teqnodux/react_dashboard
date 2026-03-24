#!/usr/bin/env python3
"""
DMA Document Processor - Separate Concise/Fulsome Views
Treats concise and fulsome as completely independent section lists.

Usage:
    python process_dma_separate.py input.docx --deal-id D001
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


def extract_sections_separate(docx_path: str) -> Dict[str, List[Dict[str, Any]]]:
    """
    Extract sections as separate concise and fulsome lists.
    No matching - they're independent.
    """
    doc = Document(docx_path)

    # Storage for sections
    concise_sections = []  # List of sections
    fulsome_sections = []  # List of sections

    # State tracking
    current_mode = None  # 'concise' or 'fulsome'
    current_section_name = None
    current_clauses = []

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue

        # Check for mode markers
        if 'concise summary' in text.lower() and para.runs and para.runs[0].bold:
            current_mode = 'concise'
            current_section_name = None
            continue

        if 'fulsome summary' in text.lower() and para.runs and para.runs[0].bold:
            # Save any pending concise section
            if current_section_name and current_clauses:
                concise_sections.append({
                    'name': current_section_name,
                    'clauses': current_clauses
                })

            current_mode = 'fulsome'
            current_section_name = None
            current_clauses = []
            continue

        if not current_mode:
            continue

        # Check for section header (Heading 2)
        if para.style.name == 'Heading 2':
            # Save previous section
            if current_section_name and current_clauses:
                section_data = {
                    'name': current_section_name,
                    'clauses': current_clauses
                }
                if current_mode == 'concise':
                    concise_sections.append(section_data)
                else:
                    fulsome_sections.append(section_data)

            # Start new section
            current_section_name = text
            current_clauses = []
            continue

        # Collect clause text (lines starting with +)
        if current_section_name:
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

            if cleaned and text.startswith('+'):
                # Extract clean references from the text
                refs = extract_references(cleaned)
                current_clauses.append({
                    'text': cleaned,
                    'references': refs
                })

    # Save last section
    if current_section_name and current_clauses:
        section_data = {
            'name': current_section_name,
            'clauses': current_clauses
        }
        if current_mode == 'fulsome':
            fulsome_sections.append(section_data)
        else:
            concise_sections.append(section_data)

    return {
        'concise': concise_sections,
        'fulsome': fulsome_sections
    }


def extract_references(text: str) -> List[str]:
    """Extract clean section references."""
    patterns = [
        r'Section\s+\d+\.?\d*(?:\.\d+)?(?:\s*\([a-z]\))?',
        r'Article\s+[IVX]+',
        r'Definition\s*>\\s*[\\w\\s]+',
        r'Preamble'
    ]

    references = []
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        references.extend(matches)

    return list(set(references))[:10]  # Limit to 10 unique refs


def extract_deal_id(filename: str) -> Optional[str]:
    """Try to extract deal ID from filename."""
    match = re.search(r'[dD](\\d+)', filename)
    if match:
        return f"D{match.group(1)}"
    return None


def main():
    parser = argparse.ArgumentParser(description='Convert DMA DOCX to separate concise/fulsome JSON')
    parser.add_argument('input', help='Input DOCX file')
    parser.add_argument('--deal-id', help='Deal ID (e.g., D001)')
    parser.add_argument('--output', help='Output JSON file')

    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: File not found: {args.input}")
        return 1

    print(f"\\nProcessing: {input_path.name}")
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
        sections_data = extract_sections_separate(str(input_path))
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return 1

    concise_sections = sections_data['concise']
    fulsome_sections = sections_data['fulsome']

    concise_clause_count = sum(len(s['clauses']) for s in concise_sections)
    fulsome_clause_count = sum(len(s['clauses']) for s in fulsome_sections)

    print(f"\\nExtracted:")
    print(f"  • Concise: {len(concise_sections)} sections, {concise_clause_count} clauses")
    print(f"  • Fulsome: {len(fulsome_sections)} sections, {fulsome_clause_count} clauses")

    print(f"\\nConcise Sections:")
    for section in concise_sections:
        print(f"  - {section['name']}: {len(section['clauses'])} clauses")

    print(f"\\nFulsome Sections:")
    for section in fulsome_sections:
        print(f"  - {section['name']}: {len(section['clauses'])} clauses")

    # Create JSON
    output_data = {
        'deal_id': deal_id,
        'concise_sections': concise_sections,
        'fulsome_sections': fulsome_sections,
        'metadata': {
            'concise_section_count': len(concise_sections),
            'concise_clause_count': concise_clause_count,
            'fulsome_section_count': len(fulsome_sections),
            'fulsome_clause_count': fulsome_clause_count,
            'source_file': input_path.name,
            'format': 'separate_views'
        }
    }

    # Determine output path
    if args.output:
        output_path = Path(args.output)
    else:
        # Default to project-level details folder
        base_dir = Path(__file__).parent.parent
        output_path = base_dir / 'data' / 'details' / f'{deal_id}.json'
        output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write JSON
    print(f"\\nWriting to: {output_path}")
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)

    print("✓ Done!")
    print(f"\\nNext steps:")
    print(f"  1. Review the JSON: {output_path}")
    print(f"  2. Restart the backend server")
    print(f"  3. View in dashboard under deal {deal_id} > DMA tab")

    return 0


if __name__ == '__main__':
    exit(main())
