"""
Real-time quote fetcher using Polygon.io REST API.
Drop-in replacement for quote_fetcher.py — identical public interface.

Endpoints used:
  Live quote   : GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}
  Historical   : GET /v2/aggs/ticker/{ticker}/range/1/day/{date}/{date}
  Dividends    : GET /v3/reference/dividends?ticker={ticker}&limit=50
"""
import time
import math
from datetime import date, datetime, timedelta
from typing import Dict, Optional

import requests

from config import POLYGON_API_KEY

_BASE = "https://api.polygon.io"

# In-memory caches
_cache: Dict[str, tuple] = {}          # live quotes  {ticker: (data, ts)}
_hist_cache: Dict[str, float] = {}     # historical   {ticker|date: price}
_div_cache: Dict[str, float] = {}      # dividends    {ticker: annual_div}

CACHE_TTL_SECONDS = 120


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get(path: str, params: dict = {}) -> Optional[dict]:
    """GET request to Polygon REST API. Returns parsed JSON or None on error."""
    try:
        params = {**params, "apiKey": POLYGON_API_KEY}
        r = requests.get(f"{_BASE}{path}", params=params, timeout=8)
        if r.status_code == 200:
            return r.json()
        print(f"[polygon_fetcher] {r.status_code} for {path}: {r.text[:120]}")
        return None
    except Exception as e:
        print(f"[polygon_fetcher] Request error for {path}: {e}")
        return None


def _safe(val):
    if val is None:
        return None
    try:
        if isinstance(val, float) and math.isnan(val):
            return None
    except Exception:
        pass
    return val


# ---------------------------------------------------------------------------
# Live quote
# ---------------------------------------------------------------------------

def get_live_quote(ticker: str) -> Optional[Dict]:
    """
    Fetch real-time snapshot for a ticker via Polygon.
    Returns cached data if fetched within CACHE_TTL_SECONDS.
    """
    now = time.time()

    if ticker in _cache:
        cached_data, cached_at = _cache[ticker]
        if now - cached_at < CACHE_TTL_SECONDS:
            return cached_data

    data = _get(f"/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}")
    if not data or data.get("status") == "ERROR" or not data.get("ticker"):
        print(f"[polygon_fetcher] WARNING: no snapshot for '{ticker}'")
        _cache[ticker] = (None, now)
        return None

    t = data["ticker"]
    day = t.get("day", {})
    prev = t.get("prevDay", {})
    last_quote = t.get("lastQuote", {})
    last_trade = t.get("lastTrade", {})

    # Use last trade price; fall back to today's close then prev close for closed/delisted tickers
    previous_close = _safe(prev.get("c"))
    current_price = _safe(last_trade.get("p")) or _safe(day.get("c")) or previous_close

    price_change = None
    percent_change = None
    if current_price and previous_close:
        price_change = current_price - previous_close
        percent_change = (price_change / previous_close) * 100

    quote_data = {
        "ticker": ticker,
        "current_price": round(current_price, 4) if current_price else None,
        "bid": _safe(last_quote.get("P")),
        "ask": _safe(last_quote.get("p")),
        "bid_size": _safe(last_quote.get("S")),
        "ask_size": _safe(last_quote.get("s")),
        "volume": _safe(day.get("v")),
        "average_volume": _safe(t.get("todaysChangePerc")),
        "day_high": _safe(day.get("h")),
        "day_low": _safe(day.get("l")),
        "previous_close": round(previous_close, 4) if previous_close else None,
        "price_change": round(price_change, 4) if price_change else None,
        "percent_change": round(percent_change, 4) if percent_change else None,
        "market_cap": None,
        "shares_outstanding": None,
        "timestamp": datetime.now().isoformat(),
        "market_state": "REGULAR",
    }

    print(f"[polygon_fetcher] {ticker}: price={quote_data['current_price']}, prev_close={quote_data['previous_close']}")
    _cache[ticker] = (quote_data, now)
    return quote_data


def get_deal_quotes(target_ticker: str, acquirer_ticker: Optional[str] = None) -> Dict:
    """Fetch quotes for target and acquirer (if applicable)."""
    result = {
        "target_quote": None,
        "acquirer_quote": None,
        "timestamp": datetime.now().isoformat(),
    }
    if target_ticker:
        result["target_quote"] = get_live_quote(target_ticker)
    if acquirer_ticker and acquirer_ticker.upper() not in ["N/A", "PRIVATE", ""]:
        result["acquirer_quote"] = get_live_quote(acquirer_ticker)
    return result


# ---------------------------------------------------------------------------
# Historical close (for unaffected price)
# ---------------------------------------------------------------------------

def get_historical_close(ticker: str, on_date: date) -> Optional[float]:
    """
    Return the closing price for ticker on the given date.
    Tries up to 5 prior trading days if the exact date is a non-trading day.
    """
    cache_key = f"{ticker}|{on_date}"
    if cache_key in _hist_cache:
        return _hist_cache[cache_key]

    for offset in range(5):
        check_date = on_date - timedelta(days=offset)
        date_str = check_date.strftime("%Y-%m-%d")
        data = _get(
            f"/v2/aggs/ticker/{ticker}/range/1/day/{date_str}/{date_str}",
            {"adjusted": "true", "sort": "desc", "limit": 1},
        )
        if data and data.get("resultsCount", 0) > 0:
            close = _safe(data["results"][0].get("c"))
            if close:
                _hist_cache[cache_key] = close
                return close

    print(f"[polygon_fetcher] WARNING: no historical close for '{ticker}' around {on_date}")
    _hist_cache[cache_key] = 0.0
    return 0.0


# ---------------------------------------------------------------------------
# Annual dividend
# ---------------------------------------------------------------------------

def get_annual_dividend(ticker: str) -> float:
    """
    Sum of cash dividends paid in the last 12 months for ticker.
    """
    if ticker in _div_cache:
        return _div_cache[ticker]

    cutoff = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
    data = _get(
        "/v3/reference/dividends",
        {"ticker": ticker, "limit": 50, "ex_dividend_date.gte": cutoff, "sort": "ex_dividend_date"},
    )

    total = 0.0
    if data and data.get("results"):
        for div in data["results"]:
            if div.get("dividend_type") == "CD":  # cash dividend
                total += div.get("cash_amount", 0.0)

    _div_cache[ticker] = total
    return total
