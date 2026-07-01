"""
Consideration normalizer.

Extracts per-share merger consideration components (cash, exchange ratio, CVR,
special dividend) from a deal's schema_results consideration text using Claude
Haiku with a forced tool-use schema, so the result is always well-typed.

This replaces brittle regex scraping for the hard cases where the ratio/cash is
phrased in ways the regex can't catch (e.g. "0.14625 shares of X plus $3.50 in
cash", "Exchange Ratio defined as 0.1574").

Caching:
  - In-memory (process lifetime) + on-disk JSON per deal, keyed by a hash of the
    source text. The LLM is called at most once per deal per text version.
  - The disk cache lives under backend/data/consideration_cache/ — NOT MongoDB.
    Nothing here writes to Mongo.

All failures (missing key, network, bad output) degrade gracefully to an empty
result so callers can fall back to their regex-derived values.
"""

from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Optional

_CACHE_DIR = Path(__file__).parent / "data" / "consideration_cache"
_MODEL = "claude-haiku-4-5-20251001"

# Process-lifetime cache: deal_id -> {"hash": str, "data": dict}
_mem_cache: dict[str, dict] = {}

_TOOL = {
    "name": "record_consideration",
    "description": "Record the fixed per-share merger consideration a target "
                   "shareholder receives for each share.",
    "input_schema": {
        "type": "object",
        "properties": {
            "cash_per_share": {
                "type": "number",
                "description": "Fixed cash amount in USD per target share. 0 if none.",
            },
            "exchange_ratio": {
                "type": "number",
                "description": "Fixed number of ACQUIRER shares issued per TARGET "
                               "share. 0 if all-cash or if the ratio floats (see "
                               "is_floating_ratio).",
            },
            "cvr_per_share": {
                "type": "number",
                "description": "Contingent value right (CVR) value in USD per share. 0 if none.",
            },
            "special_div": {
                "type": "number",
                "description": "Special/one-time dividend in USD per share tied to the "
                               "deal. 0 if none. Do NOT include ordinary dividends.",
            },
            "is_floating_ratio": {
                "type": "boolean",
                "description": "True if the exchange ratio is floating/collared "
                               "(determined by VWAP near close) with no single fixed "
                               "number. When true, set exchange_ratio to 0.",
            },
        },
        "required": ["cash_per_share", "exchange_ratio", "cvr_per_share",
                     "special_div", "is_floating_ratio"],
    },
}

_SYSTEM = (
    "You extract the per-share merger consideration from M&A deal text. "
    "Report ONLY the consideration a holder of one target share receives at "
    "closing: the fixed cash, the fixed acquirer-share exchange ratio, any CVR, "
    "and any special dividend. Ignore fractional-share cash-in-lieu, RSU/option "
    "conversion mechanics, and aggregate deal value. If a component is absent, "
    "report 0. Call the record_consideration tool exactly once."
)


def _empty() -> dict:
    return {"cash_per_share": 0.0, "exchange_ratio": 0.0, "cvr_per_share": 0.0,
            "special_div": 0.0, "is_floating_ratio": False}


def _consideration_text(sr: dict) -> str:
    """Gather the most relevant consideration answer fields into one blob."""
    if not sr:
        return ""
    ccd = sr.get("complex_consideration_and_dividends", {}) or {}
    dc = ccd.get("deal_consideration", {}) or {}
    er = ccd.get("exchange_ratio", {}) or {}
    parts = []
    for node in (
        dc.get("deal_consideration_overview"),
        dc.get("deal_consideration_details"),
        er.get("exchange_ratio_summary"),
    ):
        if isinstance(node, dict):
            ans = node.get("answer")
            if ans:
                parts.append(str(ans))
    return "\n".join(parts).strip()


# Plausibility caps — anything beyond these is an extraction misread (e.g. an
# aggregate deal value or SPAC trust amount pulled into a per-share field) and is
# dropped to 0. Real per-share consideration is never this large.
_MAX_CASH_PER_SHARE = 10_000.0   # per-share cash/CVR/dividend in USD
_MAX_EXCHANGE_RATIO = 20.0       # acquirer shares per target share


def _coerce(raw: dict) -> dict:
    out = _empty()
    for k in ("cash_per_share", "cvr_per_share", "special_div"):
        try:
            v = float(raw.get(k) or 0.0)
        except (TypeError, ValueError):
            v = 0.0
        out[k] = v if 0.0 <= v <= _MAX_CASH_PER_SHARE else 0.0

    try:
        ratio = float(raw.get("exchange_ratio") or 0.0)
    except (TypeError, ValueError):
        ratio = 0.0
    out["exchange_ratio"] = ratio if 0.0 <= ratio <= _MAX_EXCHANGE_RATIO else 0.0

    out["is_floating_ratio"] = bool(raw.get("is_floating_ratio"))
    # A floating ratio has no fixed number to display.
    if out["is_floating_ratio"]:
        out["exchange_ratio"] = 0.0
    return out


def _call_llm(text: str) -> Optional[dict]:
    try:
        import anthropic
    except Exception:
        return None
    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model=_MODEL,
            max_tokens=512,
            system=_SYSTEM,
            tools=[_TOOL],
            tool_choice={"type": "tool", "name": "record_consideration"},
            messages=[{"role": "user", "content": text}],
        )
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use":
                return _coerce(block.input)
    except Exception as e:
        print(f"[consideration_normalizer] LLM call failed: {e}")
    return None


def normalize_consideration(deal_id: str, sr: dict) -> dict:
    """
    Return {cash_per_share, exchange_ratio, cvr_per_share, special_div,
    is_floating_ratio} for a deal. Cached in memory and on disk keyed by the
    source-text hash. Returns an all-zero result on any failure.
    """
    text = _consideration_text(sr)
    if not text:
        return _empty()

    h = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]

    cached = _mem_cache.get(deal_id)
    if cached and cached.get("hash") == h:
        return cached["data"]

    fp = _CACHE_DIR / f"{deal_id}.json"
    if fp.exists():
        try:
            disk = json.loads(fp.read_text())
            if disk.get("hash") == h and isinstance(disk.get("data"), dict):
                # Re-coerce on read so clamps/validation always apply, even to
                # entries cached before the current rules existed.
                data = _coerce(disk["data"])
                _mem_cache[deal_id] = {"hash": h, "data": data}
                return data
        except Exception:
            pass  # corrupt/stale cache — fall through and re-derive

    data = _call_llm(text)
    if data is None:
        # Don't cache failures — allow a retry on the next load.
        return _empty()

    _mem_cache[deal_id] = {"hash": h, "data": data}
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        fp.write_text(json.dumps({"hash": h, "data": data, "text": text}, indent=2))
    except Exception:
        pass  # cache write is best-effort

    return data
