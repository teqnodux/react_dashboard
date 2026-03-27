"""
Real-time quote fetcher using yfinance — with in-memory cache to avoid 429s
"""
import yfinance as yf
from typing import Dict, Optional
from datetime import datetime
import time

# Simple cache: {ticker: (quote_data, timestamp)}
_cache: Dict[str, tuple] = {}
CACHE_TTL_SECONDS = 120  # serve cached quotes for 2 minutes


def _safe(val):
    """Return None for NaN or missing values."""
    if val is None:
        return None
    try:
        import math
        if isinstance(val, float) and math.isnan(val):
            return None
    except Exception:
        pass
    return val


def _safe_attr(obj, attr):
    """Return None if accessing a fast_info attribute raises any exception."""
    try:
        return _safe(getattr(obj, attr))
    except Exception:
        return None


def get_live_quote(ticker: str) -> Optional[Dict]:
    """
    Fetch real-time quote data for a given ticker.
    Returns cached data if fetched within the last CACHE_TTL_SECONDS.
    """
    now = time.time()

    # Return cached quote if fresh enough
    if ticker in _cache:
        cached_data, cached_at = _cache[ticker]
        if now - cached_at < CACHE_TTL_SECONDS:
            return cached_data

    try:
        stock = yf.Ticker(ticker)
        fi = stock.fast_info  # lightweight — avoids 429 rate limiting

        current_price = _safe_attr(fi, 'last_price')
        previous_close = _safe_attr(fi, 'previous_close')

        price_change = None
        percent_change = None
        if current_price and previous_close:
            price_change = current_price - previous_close
            percent_change = (price_change / previous_close) * 100

        quote_data = {
            'ticker': ticker,
            'current_price': round(current_price, 4) if current_price else None,
            'bid': None,
            'ask': None,
            'bid_size': None,
            'ask_size': None,
            'volume': _safe_attr(fi, 'last_volume'),
            'average_volume': None,
            'day_high': _safe_attr(fi, 'day_high'),
            'day_low': _safe_attr(fi, 'day_low'),
            'previous_close': round(previous_close, 4) if previous_close else None,
            'price_change': round(price_change, 4) if price_change else None,
            'percent_change': round(percent_change, 4) if percent_change else None,
            'market_cap': _safe_attr(fi, 'market_cap'),
            'shares_outstanding': _safe_attr(fi, 'shares'),
            'timestamp': datetime.now().isoformat(),
            'market_state': 'REGULAR'
        }

        print(f"[quote_fetcher] {ticker}: price={quote_data['current_price']}, mcap={quote_data['market_cap']}, shares={quote_data['shares_outstanding']}")
        _cache[ticker] = (quote_data, now)
        return quote_data

    except Exception as e:
        print(f"[quote_fetcher] WARNING: could not fetch quote for '{ticker}': {e}")
        # Cache None briefly to avoid hammering yfinance for bad tickers
        _cache[ticker] = (None, now)
        return None


def get_deal_quotes(target_ticker: str, acquirer_ticker: Optional[str] = None) -> Dict:
    """
    Fetch quotes for both target and acquirer (if applicable)
    """
    result = {
        'target_quote': None,
        'acquirer_quote': None,
        'timestamp': datetime.now().isoformat()
    }

    if target_ticker:
        result['target_quote'] = get_live_quote(target_ticker)

    if acquirer_ticker and acquirer_ticker.upper() not in ['N/A', 'PRIVATE', '']:
        result['acquirer_quote'] = get_live_quote(acquirer_ticker)

    return result
