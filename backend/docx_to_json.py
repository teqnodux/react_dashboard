#!/usr/bin/env python3
"""
DOCX to JSON Converter for DMA Summaries
Converts Word documents containing DMA clause information into JSON format for the dashboard.

Usage:
    python docx_to_json.py input.docx output.json [--deal-id D001]
    python docx_to_json.py input.docx --auto  # Auto-generates output filename

Requirements:
    pip install python-docx
"""

import argparse
import json
import re
from pathlib import Path
from typing import List, Dict, Any

try:
    from docx import Document
except ImportError:
    print("Error: python-docx not installed. Run: pip install python-docx")
    exit(1)


def extract_sections_from_docx(docx_path: str) -> List[Dict[str, Any]]:
    """
    Extract DMA sections and clauses from a Word document.

    Expected document structure:
    - Heading 1 or bold text = Section names (e.g., "Representations and Warranties")
    - Regular paragraphs = Clause text
    - Can have nested structure with topics/subclauses
    """
    doc = Document(docx_path)
    sections = []
    current_section = None
    current_clause = None

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue

        # Check if this is a section header (Heading 1 or bold + larger font)
        is_heading = (
            para.style.name.startswith('Heading 1') or
            (para.runs and para.runs[0].bold and len(text) < 100)
        )

        if is_heading:
            # Start new section
            if current_section and current_section['clauses']:
                sections.append(current_section)

            current_section = {
                'name': text,
                'clauses': []
            }
            current_clause = None

        elif current_section:
            # Check if this might be a topic/heading for a clause
            is_topic = (
                para.runs and para.runs[0].bold and
                len(text) < 200 and
                not text.endswith('.')
            )

            if is_topic:
                # Start new clause with this topic
                current_clause = {
                    'topic': text,
                    'concise': '',
                    'fulsome': '',
                    'clause_text': '',
                    'references': []
                }
                current_section['clauses'].append(current_clause)

            elif current_clause:
                # Add text to current clause
                # Heuristic: First paragraph = concise, rest = fulsome/clause_text
                if not current_clause['clause_text']:
                    current_clause['clause_text'] = text
                    current_clause['concise'] = text[:200] + '...' if len(text) > 200 else text
                else:
                    current_clause['clause_text'] += '\n\n' + text

                # Build fulsome description from all text
                if current_clause['fulsome']:
                    current_clause['fulsome'] += ' ' + text
                else:
                    current_clause['fulsome'] = text

            else:
                # No current clause, create one without a topic
                current_clause = {
                    'topic': 'General Provision',
                    'concise': text[:200] + '...' if len(text) > 200 else text,
                    'fulsome': text,
                    'clause_text': text,
                    'references': []
                }
                current_section['clauses'].append(current_clause)

    # Add last section
    if current_section and current_section['clauses']:
        sections.append(current_section)

    return sections


def extract_references(text: str) -> List[str]:
    """Extract section/article references from text."""
    # Look for patterns like "Section 5.1", "Article 3", etc.
    patterns = [
        r'Section\s+\d+\.?\d*',
        r'Article\s+[IVX]+',
        r'§\s*\d+\.?\d*'
    ]

    references = []
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        references.extend(matches)

    return list(set(references))  # Remove duplicates


def create_dma_json(sections: List[Dict], deal_id: str = None) -> Dict[str, Any]:
    """Create the full JSON structure for DMA data."""

    # Add references to clauses
    for section in sections:
        for clause in section['clauses']:
            if clause['clause_text']:
                clause['references'] = extract_references(clause['clause_text'])

    return {
        'deal_id': deal_id or 'UNKNOWN',
        'dma_sections': sections,
        'metadata': {
            'total_sections': len(sections),
            'total_clauses': sum(len(s['clauses']) for s in sections),
            'source': 'docx_converter'
        }
    }


def main():
    parser = argparse.ArgumentParser(
        description='Convert DOCX files to JSON format for DMA summaries'
    )
    parser.add_argument(
        'input',
        help='Input DOCX file path'
    )
    parser.add_argument(
        'output',
        nargs='?',
        help='Output JSON file path (optional if using --auto)'
    )
    parser.add_argument(
        '--deal-id',
        help='Deal ID to include in JSON (e.g., D001)'
    )
    parser.add_argument(
        '--auto',
        action='store_true',
        help='Auto-generate output filename based on input'
    )
    parser.add_argument(
        '--pretty',
        action='store_true',
        help='Pretty-print JSON output'
    )

    args = parser.parse_args()

    # Validate input file
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: Input file not found: {args.input}")
        return 1

    # Determine output path
    if args.auto:
        output_path = input_path.with_suffix('.json')
    elif args.output:
        output_path = Path(args.output)
    else:
        print("Error: Either provide output path or use --auto flag")
        return 1

    print(f"Reading DOCX: {input_path}")

    # Extract sections
    try:
        sections = extract_sections_from_docx(str(input_path))
    except Exception as e:
        print(f"Error reading DOCX: {e}")
        return 1

    if not sections:
        print("Warning: No sections found in document")
        print("Expected structure: Heading 1 for sections, regular paragraphs for clauses")

    print(f"Extracted {len(sections)} sections with {sum(len(s['clauses']) for s in sections)} total clauses")

    # Create JSON
    dma_data = create_dma_json(sections, args.deal_id)

    # Write output
    print(f"Writing JSON: {output_path}")
    with open(output_path, 'w', encoding='utf-8') as f:
        if args.pretty:
            json.dump(dma_data, f, indent=2, ensure_ascii=False)
        else:
            json.dump(dma_data, f, ensure_ascii=False)

    print("✓ Conversion complete!")
    print(f"\nSummary:")
    for section in sections:
        print(f"  - {section['name']}: {len(section['clauses'])} clauses")

    print(f"\nTo use in dashboard:")
    if args.deal_id:
        print(f"  1. Copy to: backend/data/details/{args.deal_id}.json")
    else:
        print(f"  1. Add deal_id to the JSON file")
        print(f"  2. Copy to: backend/data/details/[deal_id].json")
    print(f"  3. Restart the backend server")

    return 0


if __name__ == '__main__':
    exit(main())
