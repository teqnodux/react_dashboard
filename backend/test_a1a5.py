import json, os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv("/Users/joshuatackel/Downloads/Course+Materials/Merger Scraper/.env")
from anthropic import Anthropic

proxy_dir = Path("data/proxy_analysis/D004")
files = sorted(proxy_dir.glob("*.txt"), key=lambda f: f.stat().st_mtime, reverse=True)
proxy_text = files[0].read_text() if files else ""

dma_path = Path("data/dma_extract/D004.json")
dma_data = json.loads(dma_path.read_text()) if dma_path.exists() else {}
dma_source = dma_data.get("source_text", "")[:3000]

prompt = f"""You are a merger arbitrage analyst. Answer these 5 questions using the proxy background and deal data below.

RULES:
- SHORTEST possible answer. One word or one short phrase.
- Numbers, dates, dollar amounts where possible.
- Do NOT explain or caveat.

PROXY TEXT:
{proxy_text[:8000]}

DMA EXTRACT:
{dma_source}

Return ONLY this JSON:
{{
  "A1_who_initiated": "<who made first contact — Buyer/Target/Mutual/Banker>",
  "A2_nda_to_signing_days": "<days from first contact/NDA to signing>",
  "A3_competitive_process": "<Bilateral/Market check/Formal auction>",
  "A4_target_standalone": "<Strong/Moderate/Distressed>",
  "A5_buyer_universe": "<count of credible buyers mentioned or implied>"
}}"""

client = Anthropic()
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=500,
    messages=[{"role": "user", "content": prompt}],
)

raw = response.content[0].text.strip()
out = Path("test_a1a5_output.json")
out.write_text(raw)
