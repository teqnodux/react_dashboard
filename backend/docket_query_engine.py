"""
Docket Query Engine — Three-step hybrid query tool for STB docket filings.

Architecture:
  Step 0: Regex pre-scan (keyword extraction + grep across full content)
  Step 1: Enriched metadata scan (LLM decides: answer or request content)
  Step 2: Full content synthesis (fetch full text, produce final answer)

Designed for FastAPI streaming integration.
"""
from __future__ import annotations

import os
import re
import json
import html
from pathlib import Path
from typing import Optional, AsyncGenerator

import anthropic

# ─── Config ────────────────────────────────────────────────────────────────────
ENV_PATH = Path(__file__).parent.parent.parent / ".env"
MODELS = {
    "haiku": {"id": "claude-haiku-4-5-20251001", "input": 1.00 / 1_000_000, "output": 5.00 / 1_000_000},
    "sonnet": {"id": "claude-sonnet-4-5-20250929", "input": 3.00 / 1_000_000, "output": 15.00 / 1_000_000},
    "opus": {"id": "claude-opus-4-20250514", "input": 15.00 / 1_000_000, "output": 75.00 / 1_000_000},
}

# Content size thresholds
FULL_CONTENT_LIMIT = 50_000      # Send full text below this
TRUNCATED_LIMIT = 200_000        # Send first 50K + last 10K between these
# Above TRUNCATED_LIMIT: use tier1 summary if available, else truncate

# ─── Load env ──────────────────────────────────────────────────────────────────
def _load_env():
    path = ENV_PATH
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        line = line.removeprefix("export ")
        key, _, val = line.partition("=")
        val = val.strip().strip("'\"")
        os.environ.setdefault(key.strip(), val)

_load_env()

# ─── System prompts ───────────────────────────────────────────────────────────

SYSTEM_STEP1 = """You are a regulatory analyst specializing in Surface Transportation Board (STB) merger proceedings.

You are analyzing docket FD 36873: UNION PACIFIC CORPORATION / UNION PACIFIC RAILROAD COMPANY — CONTROL — NORFOLK SOUTHERN CORPORATION / NORFOLK SOUTHERN RAILWAY COMPANY.

You have ENRICHED metadata for ALL docket entries below. Each entry includes:
- Filing date, document type, filer name and role
- Position on deal (Support/Oppose/Neutral/Procedural)
- Opposition type (conditional/outright/ideological) and relief type
- Entry summary, key arguments (first 3), and conditions requested (first 3)
- Download link to the original PDF filing

Some entries are flagged with [KEYWORD MATCH] — this means the user's search terms appear in the full filing text. Pay special attention to these entries.

IMPORTANT RESPONSE FORMAT:
- If you can fully answer from the metadata alone, provide a complete answer with filer names, dates, filing types, and links. Format as clean markdown with tables or lists.
- If you need to read the full text of specific filings to answer accurately, respond with EXACTLY this JSON (nothing else):
{"need_content": ["310838", "310163", ...], "partial_answer": "What I can tell so far..."}

Only request content when the metadata genuinely isn't enough. The summaries and key arguments are quite detailed — for most analytical questions they are sufficient.

When entries are flagged [KEYWORD MATCH], strongly consider requesting their full content if the question is about a specific entity, topic, or state mentioned in that keyword.

Always include dates and links when available. Format links as markdown: [Filing #ID](url)"""

SYSTEM_STEP2 = """You are a regulatory analyst specializing in STB merger proceedings (FD 36873: UP/NS merger).

You previously scanned enriched metadata for all docket entries and identified filings that need closer examination. Below is the full text of those filings.

Using both the metadata context and the full filing text, provide a complete, accurate answer to the user's question.

Format your answer clearly with:
- Filer names and their roles (Party, Intervenor, Commission, etc.)
- Filing dates
- Filing type (Comments, Letter, Decision, Motion, etc.)
- Direct links to the documents as markdown links: [Filing #ID](url)
- Relevant excerpts or direct quotes from the text when useful
- Tables for structured comparisons when appropriate

Be thorough but concise. Cite specific filings for every factual claim."""


# ─── Cost Tracker ──────────────────────────────────────────────────────────────
class CostTracker:
    def __init__(self):
        self.total_cost_val = 0.0
        self.total_input = 0
        self.total_output = 0
        self.total_calls = 0

    def add(self, usage, model_key: str = "sonnet"):
        pricing = MODELS.get(model_key, MODELS["sonnet"])
        self.total_input += usage.input_tokens
        self.total_output += usage.output_tokens
        self.total_calls += 1
        cost = (usage.input_tokens * pricing["input"]) + (usage.output_tokens * pricing["output"])
        self.total_cost_val += cost
        return cost

    @property
    def total_cost(self):
        return self.total_cost_val

    def to_dict(self):
        return {
            "calls": self.total_calls,
            "input_tokens": self.total_input,
            "output_tokens": self.total_output,
            "cost": round(self.total_cost, 4),
        }


# ─── Query Engine ──────────────────────────────────────────────────────────────
class DocketQueryEngine:
    """Holds loaded docket data and runs the three-step query pipeline."""

    def __init__(self, enriched_path: str, raw_path: str, tier1_path: Optional[str] = None):
        """Load enriched extraction results and raw entry content."""
        # Enriched data (from stb_extract_results.json)
        with open(enriched_path) as f:
            self.enriched_entries = json.load(f)

        # Raw data (from stb_new_05_14.json) — indexed by displayId
        with open(raw_path) as f:
            raw_entries = json.load(f)
        self.raw_map = {str(e["displayId"]): e for e in raw_entries}

        # Tier1 summaries (optional, for massive entries)
        self.tier1_map = {}
        if tier1_path and os.path.exists(tier1_path):
            with open(tier1_path) as f:
                tier1_data = json.load(f)
            for entry in tier1_data:
                if "summary" in entry and entry.get("attachment"):
                    # Extract displayId from attachment URL
                    m = re.search(r'/(\d+)\.pdf', entry["attachment"])
                    if m:
                        self.tier1_map[m.group(1)] = entry["summary"]

        # Build enriched lookup by document_id
        self.enriched_map = {str(e["document_id"]): e for e in self.enriched_entries}

        # Build content index for regex pre-scan
        self._content_index = {}
        for e in self.enriched_entries:
            doc_id = str(e["document_id"])
            raw = self.raw_map.get(doc_id)
            if raw and raw.get("content"):
                self._content_index[doc_id] = raw["content"].lower()

        self.client = anthropic.Anthropic(timeout=120.0)

        print(f"[DocketQueryEngine] Loaded {len(self.enriched_entries)} enriched entries, "
              f"{len(self.raw_map)} raw entries, {len(self.tier1_map)} tier1 summaries")

    @classmethod
    def from_mongodb(cls, deal_id: str, db) -> "DocketQueryEngine":
        """
        Build engine from MongoDB docket + docket_dashboard collections.

        Join strategy:
          docket_dashboard.docket_entries[].docket_record_id  →  docket._id
          This gives us entry_no (what users see in the UI as #N)
          which becomes the document_id key throughout the engine,
          so focusEntry passed from DocketQuery maps correctly.
        """
        from bson import ObjectId
        instance = cls.__new__(cls)

        # ── Step 1: load docket_dashboard entries → build record_id → entry_no map
        record_id_to_entry_no: dict[str, str] = {}
        dd = db["docket_dashboard"].find_one({"deal_id": deal_id})
        if dd:
            for e in dd.get("docket_entries", []):
                rec_id = e.get("docket_record_id", "")
                eno = str(e.get("entry_no", ""))
                if rec_id and eno:
                    record_id_to_entry_no[str(rec_id)] = eno

        # ── Step 2: load docket docs whose _id is in the dashboard entries
        object_ids = [ObjectId(rid) for rid in record_id_to_entry_no if rid]
        docs = list(db["docket"].find(
            {"_id": {"$in": object_ids}, "enriched": {"$exists": True}},
            {"_id": 1, "metadata": 1, "enriched": 1, "content": 1, "summary": 1}
        ))

        enriched_entries = []
        raw_map: dict[str, dict] = {}
        tier1_map: dict[str, str] = {}

        for doc in docs:
            # Use entry_no as the key — matches what the UI displays (#N)
            key = record_id_to_entry_no.get(str(doc["_id"]), str(doc["_id"]))

            enriched = doc.get("enriched") or {}
            meta = doc.get("metadata") or {}

            date_val = meta.get("date", "")
            if hasattr(date_val, "strftime"):
                date_str = date_val.strftime("%Y-%m-%d")
            else:
                date_str = str(date_val)[:10] if date_val else ""

            filer = (enriched.get("filer_name") or
                     meta.get("on_behalf_of") or "Unknown")

            enriched_entry = {
                "document_id": key,
                "entry_no": key,
                "received_date": date_str,
                "document_type": meta.get("document_type", ""),
                "filer_name": filer,
                "on_behalf_of": filer,
                "filer_role": enriched.get("filer_role", ""),
                "position_on_deal": enriched.get("position_on_deal", ""),
                "opposition_type": enriched.get("opposition_type"),
                "relief_type": enriched.get("relief_type", ""),
                "relevance_level": enriched.get("relevance_level", ""),
                "download_link": meta.get("document_id", ""),
                "entry_summary": enriched.get("entry_summary", ""),
                "key_arguments_json": json.dumps(enriched.get("key_arguments") or []),
                "conditions_requested_json": json.dumps(enriched.get("conditions_requested") or []),
            }
            enriched_entries.append(enriched_entry)

            content = doc.get("content") or ""
            raw_map[key] = {
                "displayId": key,
                "content": content,
                "by": filer,
                "sortDate": date_str,
                "docType": meta.get("document_type", ""),
                "attachment": meta.get("document_id", ""),
            }

            summary = doc.get("summary") or ""
            if summary:
                tier1_map[key] = summary

        instance.enriched_entries = enriched_entries
        instance.raw_map = raw_map
        instance.tier1_map = tier1_map
        instance.enriched_map = {e["document_id"]: e for e in enriched_entries}
        instance._content_index = {
            key: raw_map[key]["content"].lower()
            for key in raw_map
            if raw_map[key].get("content")
        }
        instance.client = anthropic.Anthropic(timeout=120.0)

        print(f"[DocketQueryEngine.from_mongodb] deal={deal_id} — "
              f"{len(enriched_entries)} entries, {len(tier1_map)} with summaries")
        return instance

    # ── Step 0: Regex Pre-Scan ────────────────────────────────────────────────
    def _extract_keywords(self, question: str) -> list[str]:
        """Extract meaningful keywords/entities from the question for regex scan."""
        # Remove common question words and short words
        stop_words = {
            'what', 'who', 'where', 'when', 'why', 'how', 'which', 'does', 'did',
            'has', 'have', 'had', 'the', 'this', 'that', 'these', 'those', 'about',
            'with', 'from', 'for', 'and', 'but', 'not', 'are', 'was', 'were', 'been',
            'being', 'any', 'all', 'each', 'every', 'their', 'them', 'they', 'its',
            'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
            'said', 'say', 'says', 'tell', 'think', 'know', 'want', 'need',
            'merger', 'deal', 'docket', 'filing', 'filed', 'filings',
            'main', 'major', 'specific', 'regarding', 'concerning', 'related',
        }

        # Extract quoted phrases first
        quoted = re.findall(r'"([^"]+)"', question)

        # Split remaining into words, filter
        clean = re.sub(r'"[^"]*"', '', question)
        words = re.findall(r'[A-Za-z]+(?:\s+[A-Za-z]+)?', clean)
        keywords = []
        for w in words:
            w_lower = w.lower().strip()
            if len(w_lower) >= 4 and w_lower not in stop_words:
                keywords.append(w_lower)

        # Add proper nouns (capitalized words) even if short
        proper_nouns = re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', question)
        for pn in proper_nouns:
            if pn.lower() not in stop_words and len(pn) >= 3:
                keywords.append(pn.lower())

        # Combine with quoted phrases
        all_terms = list(dict.fromkeys(quoted + keywords))  # deduplicate, preserve order
        return all_terms

    def _extract_filing_ids(self, question: str) -> set[str]:
        """Detect explicit filing/entry references in the question (e.g. #310838, filing 310838, entry 42)."""
        ids = set()
        # Match #310838, filing 310838, entry 310838, ID 310838, document 310838
        for m in re.finditer(r'(?:#|filing\s*#?|entry\s*#?|id[:\s]*|document\s*#?)(\d{4,6})', question, re.IGNORECASE):
            doc_id = m.group(1)
            # Check if it's a valid document_id or entry_no
            if doc_id in self.enriched_map or doc_id in self.raw_map:
                ids.add(doc_id)
            else:
                # Could be an entry_no — look it up
                for e in self.enriched_entries:
                    if e.get("entry_no") == int(doc_id):
                        ids.add(str(e["document_id"]))
                        break
        return ids

    def _regex_prescan(self, question: str) -> set[str]:
        """Grep all entries' content for keywords from the question. Returns matching doc IDs."""
        keywords = self._extract_keywords(question)
        if not keywords:
            return set()

        hits = set()
        for doc_id, content_lower in self._content_index.items():
            for kw in keywords:
                if kw.lower() in content_lower:
                    hits.add(doc_id)
                    break  # One keyword match is enough to include this entry

        return hits

    # ── Step 1: Enriched Metadata Scan ────────────────────────────────────────
    def _build_metadata_block(self, regex_hits: set[str]) -> str:
        """Build the enriched metadata block for all entries."""
        lines = []
        for e in self.enriched_entries:
            doc_id = str(e.get("document_id", ""))
            filer = (e.get("filer_name") or e.get("on_behalf_of") or "Unknown")
            filer = html.unescape(filer)

            # Core metadata
            parts = [
                f'[ID:{doc_id}]',
                e.get("received_date", ""),
                f'| {e.get("document_type", "")}',
                f'| By: {filer}',
                f'| Role: {e.get("filer_role", "")}',
                f'| Position: {e.get("position_on_deal", "")}',
            ]

            # Add opposition/relief type if present
            if e.get("opposition_type"):
                parts.append(f'| Opposition: {e["opposition_type"]}')
            if e.get("relief_type") and e["relief_type"] not in ("Approve", "Procedural"):
                parts.append(f'| Relief: {e["relief_type"]}')

            parts.append(f'| Relevance: {e.get("relevance_level", "")}')
            parts.append(f'| Link: {e.get("download_link", "")}')

            line = " ".join(parts)

            # Add summary
            summary = e.get("entry_summary", "")
            if summary:
                line += f'\n  Summary: {summary[:500]}'

            # Add key arguments (first 3)
            args = e.get("key_arguments_json", "[]")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = []
            if args:
                line += f'\n  Key args: {"; ".join(str(a)[:150] for a in args[:3])}'

            # Add conditions (first 3)
            conds = e.get("conditions_requested_json", "[]")
            if isinstance(conds, str):
                try:
                    conds = json.loads(conds)
                except json.JSONDecodeError:
                    conds = []
            if conds:
                line += f'\n  Conditions: {"; ".join(str(c)[:150] for c in conds[:3])}'

            # Flag keyword matches
            if doc_id in regex_hits:
                line += '\n  [KEYWORD MATCH: search terms appear in full filing text]'

            lines.append(line)

        return "\n\n".join(lines)

    def _step1(self, question: str, metadata_block: str, history: list[dict], model_key: str = "sonnet") -> tuple[str, list[str]]:
        """Send enriched metadata + question to LLM. Returns (answer, content_ids_needed, usage)."""
        model_id = MODELS[model_key]["id"]
        messages = []

        # Add conversation history
        for msg in history:
            messages.append({"role": msg["role"], "content": msg["content"]})

        # Add current question with metadata
        messages.append({
            "role": "user",
            "content": (
                f"DOCKET METADATA ({len(self.enriched_entries)} entries):\n"
                f"{metadata_block}\n\n---\n"
                f"QUESTION: {question}"
            )
        })

        response = self.client.messages.create(
            model=model_id,
            max_tokens=4096,
            system=SYSTEM_STEP1,
            messages=messages,
        )

        text = response.content[0].text

        # Check if LLM needs content
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict) and "need_content" in parsed:
                ids = parsed["need_content"]
                partial = parsed.get("partial_answer", "")
                return partial, [str(i) for i in ids], response.usage
        except (json.JSONDecodeError, KeyError):
            pass

        # Also try extracting JSON from within markdown
        json_match = re.search(r'\{[^{}]*"need_content"[^{}]*\}', text, re.DOTALL)
        if json_match:
            try:
                parsed = json.loads(json_match.group())
                ids = parsed["need_content"]
                partial = parsed.get("partial_answer", "")
                return partial, [str(i) for i in ids], response.usage
            except (json.JSONDecodeError, KeyError):
                pass

        return text, [], response.usage

    # ── Step 2: Full Content Synthesis ────────────────────────────────────────
    def _get_content(self, doc_id: str) -> str:
        """Get content for an entry, respecting size limits."""
        raw = self.raw_map.get(str(doc_id))
        if not raw:
            return ""

        content = raw.get("content", "")
        if not content:
            return ""

        content_len = len(content)

        if content_len <= FULL_CONTENT_LIMIT:
            return content
        elif content_len <= TRUNCATED_LIMIT:
            return (
                content[:FULL_CONTENT_LIMIT]
                + f"\n\n[... {content_len - FULL_CONTENT_LIMIT - 10_000:,} characters truncated ...]\n\n"
                + content[-10_000:]
            )
        else:
            # Check for tier1 summary
            tier1 = self.tier1_map.get(str(doc_id))
            if tier1:
                return f"[TIER-1 SUMMARY — original filing is {content_len:,} characters]\n{tier1}"
            # Fallback: truncate heavily
            return (
                content[:FULL_CONTENT_LIMIT]
                + f"\n\n[... {content_len - FULL_CONTENT_LIMIT:,} characters omitted — filing too large ...]\n"
            )

    def _step2(self, question: str, partial_answer: str, content_ids: list[str],
               history: list[dict], model_key: str = "sonnet") -> tuple[str, object]:
        """Fetch full content for requested entries and synthesize final answer."""
        content_parts = []
        for doc_id in content_ids:
            enriched = self.enriched_map.get(str(doc_id), {})
            raw = self.raw_map.get(str(doc_id))
            if not raw:
                continue

            filer = html.unescape(raw.get("by", "") or enriched.get("filer_name", "Unknown"))
            content = self._get_content(doc_id)

            content_parts.append(
                f"--- ENTRY {doc_id} ---\n"
                f"Date: {raw.get('sortDate', enriched.get('received_date', ''))} "
                f"| Type: {raw.get('docType', enriched.get('document_type', ''))} "
                f"| By: {filer}\n"
                f"| Role: {enriched.get('filer_role', '')} "
                f"| Position: {enriched.get('position_on_deal', '')}\n"
                f"Link: {raw.get('attachment', enriched.get('download_link', ''))}\n"
                f"Content:\n{content}\n"
            )

        if not content_parts:
            return partial_answer or "No matching entries found.", None

        entries_text = "\n".join(content_parts)
        context = f"PARTIAL ANALYSIS FROM METADATA SCAN:\n{partial_answer}\n\n" if partial_answer else ""

        messages = []
        for msg in history:
            messages.append({"role": msg["role"], "content": msg["content"]})

        messages.append({
            "role": "user",
            "content": f"{context}FULL TEXT OF SELECTED ENTRIES:\n{entries_text}\n\n---\nQUESTION: {question}"
        })

        response = self.client.messages.create(
            model=MODELS[model_key]["id"],
            max_tokens=8192,
            system=SYSTEM_STEP2,
            messages=messages,
        )

        return response.content[0].text, response.usage

    # ── Main query (non-streaming) ────────────────────────────────────────────
    def query(self, question: str, history: list[dict] | None = None, model: str = "sonnet", focus_entry: str | None = None) -> dict:
        """Run the full three-step query pipeline. Returns dict with answer + metadata."""
        history = history or []
        model_key = model if model in MODELS else "sonnet"
        costs = CostTracker()

        # Detect explicit filing IDs in question + focus entry from UI
        forced_ids = self._extract_filing_ids(question)
        if focus_entry:
            forced_ids.add(str(focus_entry))

        # Step 0: Regex pre-scan
        regex_hits = self._regex_prescan(question)

        # Step 1: Enriched metadata scan
        metadata_block = self._build_metadata_block(regex_hits)
        answer, content_ids, usage1 = self._step1(question, metadata_block, history, model_key)
        costs.add(usage1, model_key)

        # Merge forced IDs into content request
        all_content_ids = list(dict.fromkeys(list(forced_ids) + content_ids))

        step1_info = {
            "answered_from_metadata": len(all_content_ids) == 0,
            "regex_hits": len(regex_hits),
            "content_requested": len(all_content_ids),
            "forced_ids": len(forced_ids),
        }

        # Step 2: Full content synthesis (if needed)
        if all_content_ids:
            answer, usage2 = self._step2(question, answer, all_content_ids, history, model_key)
            if usage2:
                costs.add(usage2, model_key)

        return {
            "answer": answer,
            "cost": costs.to_dict(),
            "step1": step1_info,
        }

    # ── Streaming query ───────────────────────────────────────────────────────
    async def query_stream(self, question: str, history: list[dict] | None = None, model: str = "sonnet", focus_entry: str | None = None) -> AsyncGenerator[dict, None]:
        """Stream the query response. Yields dicts: {"type": "chunk/status/done", ...}"""
        history = history or []
        model_key = model if model in MODELS else "sonnet"
        costs = CostTracker()

        # Detect explicit filing IDs in question + focus entry from UI
        forced_ids = self._extract_filing_ids(question)
        if focus_entry:
            forced_ids.add(str(focus_entry))

        # Step 0: Regex pre-scan
        regex_hits = self._regex_prescan(question)
        yield {"type": "status", "message": f"Scanned {len(self.enriched_entries)} entries — {len(regex_hits)} keyword matches"}

        # Build metadata
        metadata_block = self._build_metadata_block(regex_hits)

        # Step 1: Metadata scan (non-streaming to check if we need content)
        yield {"type": "status", "message": f"Analyzing metadata ({model_key})..."}
        answer, content_ids, usage1 = self._step1(question, metadata_block, history, model_key)
        costs.add(usage1, model_key)

        # Merge forced IDs (from question or UI focus) into content request
        all_content_ids = list(dict.fromkeys(list(forced_ids) + content_ids))

        if not all_content_ids:
            # Answer from metadata — stream it out
            yield {"type": "status", "message": "Answered from metadata"}
            yield {"type": "answer", "content": answer}
            yield {"type": "done", "cost": costs.to_dict(), "step1": {"answered_from_metadata": True, "regex_hits": len(regex_hits), "content_requested": 0}}
            return

        # Step 2: Need full content — stream the synthesis
        yield {"type": "status", "message": f"Fetching full text for {len(all_content_ids)} entries..."}

        # Build content payload
        content_parts = []
        for doc_id in all_content_ids:
            enriched = self.enriched_map.get(str(doc_id), {})
            raw = self.raw_map.get(str(doc_id))
            if not raw:
                continue

            filer = html.unescape(raw.get("by", "") or enriched.get("filer_name", "Unknown"))
            content = self._get_content(doc_id)

            content_parts.append(
                f"--- ENTRY {doc_id} ---\n"
                f"Date: {raw.get('sortDate', enriched.get('received_date', ''))} "
                f"| Type: {raw.get('docType', enriched.get('document_type', ''))} "
                f"| By: {filer}\n"
                f"| Role: {enriched.get('filer_role', '')} "
                f"| Position: {enriched.get('position_on_deal', '')}\n"
                f"Link: {raw.get('attachment', enriched.get('download_link', ''))}\n"
                f"Content:\n{content}\n"
            )

        if not content_parts:
            yield {"type": "answer", "content": answer or "No matching entries found."}
            yield {"type": "done", "cost": costs.to_dict(), "step1": {"answered_from_metadata": False, "regex_hits": len(regex_hits), "content_requested": len(all_content_ids)}}
            return

        entries_text = "\n".join(content_parts)
        context = f"PARTIAL ANALYSIS FROM METADATA SCAN:\n{answer}\n\n" if answer else ""

        messages = []
        for msg in history:
            messages.append({"role": msg["role"], "content": msg["content"]})
        messages.append({
            "role": "user",
            "content": f"{context}FULL TEXT OF SELECTED ENTRIES:\n{entries_text}\n\n---\nQUESTION: {question}"
        })

        yield {"type": "status", "message": "Synthesizing answer from full content..."}

        # Stream Step 2 response
        with self.client.messages.stream(
            model=MODELS[model_key]["id"],
            max_tokens=8192,
            system=SYSTEM_STEP2,
            messages=messages,
        ) as stream:
            for text in stream.text_stream:
                yield {"type": "chunk", "content": text}

            # Get final usage
            response = stream.get_final_message()
            costs.add(response.usage, model_key)

        yield {"type": "done", "cost": costs.to_dict(), "step1": {"answered_from_metadata": False, "regex_hits": len(regex_hits), "content_requested": len(all_content_ids)}}


# ─── Engine cache (one per deal) ───────────────────────────────────────────────
_engines: dict[str, DocketQueryEngine] = {}

# Data source config per deal_id
# enriched = pre-processed extraction results (relative to repo root)
# raw      = raw STB docket JSON with full filing content — update path to your local copy
# tier1    = optional pre-summarised content for very large filings
_DEAL_DATA_SOURCES = {
    "D088": {
        "enriched": str(Path(__file__).parent.parent / "Docket Review Norfolk Southern" / "stb_extract_results.json"),
        "raw": str(Path(__file__).parent.parent / "data" / "stb_new_05_14.json"),
        "tier1": str(Path(__file__).parent.parent / "data" / "stb_tier1.json"),
    }
}


def get_engine(deal_id: str) -> Optional[DocketQueryEngine]:
    """Get or create a query engine for a deal. Returns None if no data configured."""
    if deal_id in _engines:
        return _engines[deal_id]

    sources = _DEAL_DATA_SOURCES.get(deal_id)
    if not sources:
        return None

    if not os.path.exists(sources["enriched"]) or not os.path.exists(sources["raw"]):
        return None

    engine = DocketQueryEngine(
        enriched_path=sources["enriched"],
        raw_path=sources["raw"],
        tier1_path=sources.get("tier1"),
    )
    _engines[deal_id] = engine
    return engine


def get_engine_for_deal(deal_id: str, db=None) -> Optional[DocketQueryEngine]:
    """
    Get or create a query engine for a deal.

    - db=None  → file-based lookup via _DEAL_DATA_SOURCES (static mode)
    - db=<pymongo db>  → load from MongoDB `docket` collection (mongodb mode)

    Engines are cached in _engines to avoid reloading on every request.
    Cache key includes 'mongo:' prefix in MongoDB mode to avoid collisions.
    """
    if db is None:
        return get_engine(deal_id)

    cache_key = f"mongo:{deal_id}"
    if cache_key in _engines:
        return _engines[cache_key]

    count = db["docket"].count_documents(
        {"deal_id": deal_id, "enriched": {"$exists": True}},
        limit=1
    )
    if not count:
        return None

    engine = DocketQueryEngine.from_mongodb(deal_id, db)
    _engines[cache_key] = engine
    return engine
