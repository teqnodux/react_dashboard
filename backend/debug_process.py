#!/usr/bin/env python3
"""Debug version of the DMA processor to see what's being extracted"""
from docx import Document
from pathlib import Path

docx_path = Path(__file__).parent / 'data' / 'dma_docs' / 'input' / 'D001_DMA.docx'
doc = Document(str(docx_path))

# Storage for sections
concise_sections = {}  # {section_name: [clauses]}
fulsome_sections = {}  # {section_name: [clauses]}

# State tracking
current_mode = None  # 'concise' or 'fulsome'
current_section = None
current_clauses = []

for i, para in enumerate(doc.paragraphs):
    text = para.text.strip()
    if not text:
        continue

    # Check for mode markers
    if 'concise summary' in text.lower() and para.runs and para.runs[0].bold:
        print(f"\n✓ Found CONCISE marker at paragraph {i}")
        current_mode = 'concise'
        current_section = None
        continue

    if 'fulsome summary' in text.lower() and para.runs and para.runs[0].bold:
        print(f"\n✓ Found FULSOME marker at paragraph {i}")
        # Save any pending concise section
        if current_section and current_clauses:
            concise_sections[current_section] = current_clauses
            print(f"  Saved concise section '{current_section}' with {len(current_clauses)} clauses")

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
                print(f"  Concise: {current_section} = {len(current_clauses)} clauses")
            else:
                fulsome_sections[current_section] = current_clauses
                print(f"  Fulsome: {current_section} = {len(current_clauses)} clauses")

        # Start new section
        current_section = text
        current_clauses = []
        continue

    # Collect clause text
    if current_section:
        cleaned = text
        if text.startswith('+'):
            cleaned = text[1:].strip()
            if cleaned:
                current_clauses.append({'text': cleaned, 'references': []})

print(f"\n" + "=" * 80)
print(f"CONCISE sections: {len(concise_sections)}")
print(f"FULSOME sections: {len(fulsome_sections)}")
print("=" * 80)

# Show first section from each
if concise_sections:
    first_concise = list(concise_sections.items())[0]
    print(f"\nFirst CONCISE section: {first_concise[0]}")
    print(f"  Clauses: {len(first_concise[1])}")
    if first_concise[1]:
        print(f"  First clause: {first_concise[1][0]['text'][:100]}")

if fulsome_sections:
    first_fulsome = list(fulsome_sections.items())[0]
    print(f"\nFirst FULSOME section: {first_fulsome[0]}")
    print(f"  Clauses: {len(first_fulsome[1])}")
    if first_fulsome[1]:
        print(f"  First clause: {first_fulsome[1][0]['text'][:100]}")
