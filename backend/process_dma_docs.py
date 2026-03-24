#!/usr/bin/env python3
"""
Batch DMA Document Processor
Processes multiple DOCX files and links them to deals in the dashboard.

Usage:
    1. Put your DOCX files in: data/dma_docs/input/
    2. Name files like: "D001_DMA.docx" or "Astria_DMA.docx"
    3. Run: python process_dma_docs.py
    4. Files will be processed to: data/details/[deal_id].json

Requirements:
    pip install python-docx
"""

import json
import re
from pathlib import Path
from typing import List, Dict, Any, Optional

try:
    from docx import Document
    from docx.text.paragraph import Paragraph
except ImportError:
    print("Error: python-docx not installed. Run: pip install python-docx")
    exit(1)


# Mapping file names to deal IDs
DEAL_MAPPING = {
    # Example mappings - add your deals here:
    'astria': 'D001',
    'brookfield': 'D002',
    'civitas': 'D003',
    'cyberark': 'D004',
    # Add more as needed
}


def extract_deal_id_from_filename(filename: str) -> Optional[str]:
    """Extract deal ID from filename."""
    filename_lower = filename.lower()

    # Check if filename starts with deal ID pattern
    match = re.match(r'(d\d+)', filename_lower)
    if match:
        return match.group(1).upper()

    # Check mapping dictionary
    for key, deal_id in DEAL_MAPPING.items():
        if key in filename_lower:
            return deal_id

    return None


def is_heading(para: Paragraph) -> bool:
    """Determine if paragraph is a heading."""
    if para.style.name.startswith('Heading'):
        return True

    # Check if bold and short
    if para.runs and para.runs[0].bold:
        text = para.text.strip()
        if len(text) < 100 and not text.endswith('.'):
            return True

    return False


def extract_dma_sections(docx_path: str) -> List[Dict[str, Any]]:
    """
    Extract DMA sections with concise and fulsome versions.

    Expected structure:
    - Section headers (Heading 1): "Representations and Warranties"
    - Clause topic (bold): Specific topic
    - Concise paragraph(s): Brief description
    - [Optional separator or "Fulsome:" label]
    - Fulsome paragraph(s): Detailed description
    """
    doc = Document(docx_path)
    sections = []
    current_section = None
    current_clause = None
    reading_fulsome = False

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue

        # Check for section header
        if para.style.name.startswith('Heading 1'):
            # Save previous section
            if current_section and current_section['clauses']:
                sections.append(current_section)

            # Start new section
            current_section = {
                'name': text,
                'clauses': []
            }
            current_clause = None
            reading_fulsome = False
            continue

        if not current_section:
            continue

        # Check for clause topic (Heading 2 or bold text)
        if para.style.name.startswith('Heading 2') or (
            para.runs and para.runs[0].bold and
            len(text) < 150 and
            not text.endswith('.') and
            not text.lower().startswith('fulsome')
        ):
            # Save previous clause
            if current_clause:
                current_section['clauses'].append(current_clause)

            # Start new clause
            current_clause = {
                'topic': text,
                'concise': '',
                'fulsome': '',
                'clause_text': '',
                'references': []
            }
            reading_fulsome = False
            continue

        if not current_clause:
            continue

        # Check if this marks start of fulsome section
        if text.lower().startswith('fulsome') or text.lower() == 'detailed:':
            reading_fulsome = True
            continue

        # Detect transition to fulsome (common patterns)
        if not reading_fulsome and current_clause['concise']:
            # Check for visual separators or second paragraph after concise
            if text.startswith('---') or text.startswith('___'):
                reading_fulsome = True
                continue

            # If we already have concise and this is a new substantial paragraph
            if len(text) > 100:
                reading_fulsome = True

        # Add text to appropriate section
        if reading_fulsome:
            if current_clause['fulsome']:
                current_clause['fulsome'] += '\n\n' + text
            else:
                current_clause['fulsome'] = text
        else:
            if current_clause['concise']:
                current_clause['concise'] += '\n\n' + text
            else:
                current_clause['concise'] = text

        # Add to full clause text
        if current_clause['clause_text']:
            current_clause['clause_text'] += '\n\n' + text
        else:
            current_clause['clause_text'] = text

    # Save last clause and section
    if current_clause:
        current_section['clauses'].append(current_clause)
    if current_section and current_section['clauses']:
        sections.append(current_section)

    # Clean up clauses: if no fulsome, use concise for both
    for section in sections:
        for clause in section['clauses']:
            if not clause['fulsome'] and clause['concise']:
                clause['fulsome'] = clause['concise']
            elif not clause['concise'] and clause['fulsome']:
                clause['concise'] = clause['fulsome'][:200] + '...' if len(clause['fulsome']) > 200 else clause['fulsome']

            # Extract references
            clause['references'] = extract_references(clause['clause_text'])

    return sections


def extract_references(text: str) -> List[str]:
    """Extract section references from text."""
    patterns = [
        r'Section\s+\d+\.?\d*(?:\.\d+)?',
        r'Article\s+[IVX]+',
        r'§\s*\d+\.?\d*'
    ]

    references = []
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        references.extend(matches)

    return list(set(references))


def process_docx_file(input_path: Path, output_dir: Path) -> Dict[str, Any]:
    """Process a single DOCX file."""
    print(f"\nProcessing: {input_path.name}")

    # Extract deal ID
    deal_id = extract_deal_id_from_filename(input_path.stem)
    if not deal_id:
        print(f"  ⚠️  Could not determine deal ID from filename: {input_path.name}")
        print(f"  Tip: Name file like 'D001_DMA.docx' or add to DEAL_MAPPING")
        return None

    print(f"  Deal ID: {deal_id}")

    # Extract sections
    try:
        sections = extract_dma_sections(str(input_path))
    except Exception as e:
        print(f"  ❌ Error reading file: {e}")
        return None

    if not sections:
        print(f"  ⚠️  No sections found")
        return None

    clause_count = sum(len(s['clauses']) for s in sections)
    print(f"  ✓ Extracted {len(sections)} sections, {clause_count} clauses")

    # Create JSON structure
    dma_data = {
        'deal_id': deal_id,
        'dma_sections': sections,
        'metadata': {
            'total_sections': len(sections),
            'total_clauses': clause_count,
            'source_file': input_path.name
        }
    }

    # Write to output
    output_path = output_dir / f"{deal_id}.json"
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(dma_data, f, indent=2, ensure_ascii=False)

    print(f"  ✓ Saved to: {output_path}")

    return {
        'deal_id': deal_id,
        'sections': len(sections),
        'clauses': clause_count,
        'output_path': str(output_path)
    }


def main():
    # Setup paths
    base_dir = Path(__file__).parent
    input_dir = base_dir / 'data' / 'dma_docs' / 'input'
    output_dir = base_dir / 'data' / 'details'

    # Create directories if needed
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("DMA Document Processor")
    print("=" * 60)
    print(f"Input folder: {input_dir}")
    print(f"Output folder: {output_dir}")

    # Find all DOCX files
    docx_files = list(input_dir.glob('*.docx'))
    if not docx_files:
        print(f"\n⚠️  No DOCX files found in {input_dir}")
        print(f"\nUsage:")
        print(f"  1. Place your DMA Word documents in: {input_dir}")
        print(f"  2. Name them like: D001_DMA.docx or Astria_DMA.docx")
        print(f"  3. Run this script again")
        return 1

    print(f"\nFound {len(docx_files)} file(s) to process")

    # Process each file
    results = []
    for docx_file in docx_files:
        result = process_docx_file(docx_file, output_dir)
        if result:
            results.append(result)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Processed: {len(results)}/{len(docx_files)} files")

    if results:
        print("\nDeals updated:")
        for r in results:
            print(f"  • {r['deal_id']}: {r['sections']} sections, {r['clauses']} clauses")

        print("\n✓ Done! Restart the backend server to load the new data.")

    return 0


if __name__ == '__main__':
    exit(main())
