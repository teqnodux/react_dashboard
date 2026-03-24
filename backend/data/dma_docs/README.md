# DMA Documents Processing Guide

## Quick Start

### 1. Prepare Your Documents

Place your DMA Word documents in the `input/` folder with clear names:

```
input/
├── D001_DMA.docx          (Deal ID in filename)
├── Astria_DMA.docx        (Company name - will map to D001)
├── D002_Brookfield.docx
└── CyberArk_Merger.docx
```

### 2. Document Structure

Your Word documents should follow this structure:

```
Heading 1: Section Name (e.g., "Representations and Warranties")

  Bold Text: Clause Topic (e.g., "Organization and Standing")

  First paragraph(s): CONCISE version

  [Optional: "Fulsome:" label or separator line]

  Following paragraph(s): FULSOME version

Heading 1: Next Section...
```

**Example:**

```
REPRESENTATIONS AND WARRANTIES

Financial Statements

The Company has delivered true and complete copies of its financial statements for the past three years.

Fulsome:

The Company has delivered to the Acquirer true, correct and complete copies of: (a) the audited consolidated balance sheets and statements of income, stockholders' equity and cash flows of the Company as of and for the fiscal years ended December 31, 2023, 2022 and 2021, together with the reports thereon of [Auditor Name]...
```

### 3. Run the Processor

From the `backend/` directory:

```bash
# Make sure python-docx is installed
pip install python-docx

# Run the processor
python process_dma_docs.py
```

### 4. Deal ID Mapping

The script will try to match filenames to deals:

**Automatic matching:**
- `D001_*.docx` → Deal D001
- `D002_*.docx` → Deal D002
- etc.

**Company name matching (edit DEAL_MAPPING in script):**
```python
DEAL_MAPPING = {
    'astria': 'D001',
    'brookfield': 'D002',
    'civitas': 'D003',
    'cyberark': 'D004',
}
```

### 5. Output

Processed files will be created in the project root `data/details/` directory:
- `REACT Dashboard/data/details/D001.json`
- `REACT Dashboard/data/details/D002.json`
- etc.

Note: Files are saved to the project-level data folder, not `backend/data/`

### 6. Activate in Dashboard

Restart the backend server:
```bash
python main.py
```

The DMA data will now appear in each deal's "MAE" tab!

## Tips

- **Concise vs Fulsome:** If your doc only has one version, it will be used for both
- **No clear separation?** The script will try to detect where concise ends and fulsome begins
- **Testing:** Process one file first to check the output looks correct
- **Editing:** You can manually edit the JSON files if needed

## Troubleshooting

**"Could not determine deal ID"**
- Rename file to include deal ID: `D001_DMA.docx`
- Or add company name to DEAL_MAPPING in the script

**"No sections found"**
- Check your document uses Heading 1 for main sections
- Or at least use bold text for section headers

**Sections look wrong?**
- Check the output JSON in `data/details/`
- Adjust your document structure
- Or manually edit the JSON
