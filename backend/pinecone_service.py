"""
Pinecone section fetcher for DMA Summary "Document References".

Given a deal_id, returns the actual contract-section text for every section stored
in Pinecone for that deal, so the frontend can expand each reference tag inline.

Design:
  - Metadata-only retrieval (zero vector) — no embeddings / OpenAI needed.
  - Pinecone `deal_id` metadata == the app's Mongo deal id (str), so filtering by
    deal_id is a direct join.
  - Section metadata is an array like ['Section 6.1']; combined_text holds the text.
  - Lazy singleton client (reused across requests). Fails soft to {} on any error.

Per product decision: NO caching — each DMA tab open triggers a fresh query.
"""

from __future__ import annotations

import os
import re
import logging
from collections import OrderedDict
from typing import Optional

logger = logging.getLogger(__name__)

_fetcher: Optional["PineconeSectionFetcher"] = None
_fetcher_failed = False


def _core_id(reference: str) -> Optional[str]:
    """
    Normalize a section reference to its core id:
      'Section 6.1 (d)' -> '6.1', 'SECTION 5' -> '5'.
    Returns None for non-section references (e.g. 'Definition > Company Tax Counsel'),
    which are keyed by their raw string instead.
    """
    if not reference:
        return None
    m = re.search(r"(\d+(?:\.\d+)+|\d+)", reference)
    return m.group(1) if m else None


class PineconeSectionFetcher:
    def __init__(self):
        from pinecone import Pinecone

        api_key = os.getenv("PINECONE_API_KEY")
        index_name = os.getenv("PINECONE_INDEX")
        host = os.getenv("PINECONE_HOST")
        if not api_key or not index_name:
            raise RuntimeError("Missing PINECONE_API_KEY or PINECONE_INDEX env vars")

        self.pc = Pinecone(api_key=api_key)
        self.index = self.pc.Index(index_name, host=host) if host else self.pc.Index(index_name)
        self.dim = int((os.getenv("PINECONE_DIM") or "3072").strip())
        self.default_top_k = int((os.getenv("PINECONE_TOP_K") or "500").strip())
        self.namespace = os.getenv("PINECONE_NAMESPACE") or None

    def get_sections_for_deal(self, deal_id: str) -> dict:
        """
        Return {key: {"section": raw, "label": str, "text": str}} for a deal, where
        `key` is both the raw section ("Section 6.1") and its core id ("6.1") so the
        frontend can look up either form. Definition/non-section refs are keyed by
        their raw string only.
        """
        if not deal_id:
            return {}

        vec = [0.0] * self.dim
        query_kwargs = dict(
            vector=vec,
            top_k=self.default_top_k,
            include_values=False,
            include_metadata=True,
            filter={"deal_id": deal_id},
        )
        if self.namespace:
            query_kwargs["namespace"] = self.namespace

        try:
            res = self.index.query(**query_kwargs)
        except Exception as e:
            logger.warning("[pinecone] query failed for deal %s: %s", deal_id, e)
            return {}

        # Group chunks by raw section, preserving chunk_index order within a section.
        groups: dict[str, dict] = OrderedDict()
        for match in getattr(res, "matches", None) or []:
            md = getattr(match, "metadata", None) or {}

            sec = md.get("Section")
            if isinstance(sec, list):
                sec = sec[0] if sec else None
            if not sec:
                continue

            text = (
                md.get("combined_text")
                or md.get("original_text")
                or md.get("text")
                or ""
            )
            ci = md.get("chunk_index")
            try:
                ci = float(ci) if ci is not None else 1e12
            except (TypeError, ValueError):
                ci = 1e12

            g = groups.setdefault(sec, {"label": md.get("label") or "", "chunks": []})
            g["chunks"].append((ci, text))

        out: dict[str, dict] = {}
        for sec_raw, g in groups.items():
            chunks = sorted(g["chunks"], key=lambda x: x[0])
            text = "\n\n".join(t for _, t in chunks if t).strip()
            entry = {"section": sec_raw, "label": g["label"], "text": text}
            out[sec_raw] = entry
            core = _core_id(sec_raw)
            if core and core not in out:
                out[core] = entry

        return out


def _get_fetcher() -> Optional[PineconeSectionFetcher]:
    global _fetcher, _fetcher_failed
    if _fetcher is not None:
        return _fetcher
    if _fetcher_failed:
        return None
    try:
        _fetcher = PineconeSectionFetcher()
    except Exception as e:
        _fetcher_failed = True
        logger.warning("[pinecone] fetcher init failed: %s", e)
        return None
    return _fetcher


def get_sections_for_deal(deal_id: str) -> dict:
    """Public entry point. Returns {} on any failure (missing keys, deps, network)."""
    fetcher = _get_fetcher()
    if fetcher is None:
        return {}
    return fetcher.get_sections_for_deal(deal_id)
