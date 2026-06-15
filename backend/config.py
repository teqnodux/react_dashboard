"""
Data source configuration.
Switch between static JSON files and MongoDB (Deal_DB_New).

Set DATA_SOURCE env variable or change the default here:
  "static"  → reads from /data/deals.json (original behaviour)
  "mongodb" → reads from Deal_DB via MongoDB

Set QUOTE_SOURCE env variable or change the default here:
  "yfinance" → uses yfinance (free, unofficial, may 429)
  "polygon"  → uses Polygon.io (requires POLYGON_API_KEY)
"""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

_ENV_PATH = Path(__file__).with_name(".env")
if load_dotenv and _ENV_PATH.exists():
    load_dotenv(_ENV_PATH)

DATA_SOURCE = os.getenv("DATA_SOURCE", "mongodb")

MONGODB_URI = os.getenv("MONGODB_URI", "")
MONGODB_DB = "Deal_DB"

# Mongo collection names (code constants — edit here if your Atlas names differ).
FEED_ITEMS_COLLECTION = "feed_items"
SEC_FILING_SUMMARY_COLLECTION = "sec_filing_summary"

QUOTE_SOURCE = os.getenv("QUOTE_SOURCE", "yfinance")  # "yfinance" or "polygon"
POLYGON_API_KEY = os.getenv("POLYGON_API_KEY", "")

# JWT auth settings
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "KEEP_THIS_SECRET")
ACCESS_TOKEN_EXPIRE_MINUTES = int(
    os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))


EMAIL_REPORT_TYPES = {
    "sec_form_type_proxy_10k_q_425": "SEC Form Type Proxy, 10K/Q, 425 (l1,l2,l3)",
    "sec_all_other_forms": "SEC All Other Forms (l1,l2,l3)",
    "sec_comparison_summary_10k": "SEC 10-K Comparison Summary",
    "sec_comparison_summary_proxy": "SEC Proxy Comparison Summary",
    "sec_background_summary_proxy": "SEC Proxy Background Summary",
    "sec_new_deal_announcement": "SEC New Deal Announcement",

    "sec_new_deal_probably_announced": "SEC New Deal Probably Announced",
    "sec_new_deal_announced_without_threshold": "SEC New Deal Announced With Threshold",
    "sec_dma_press_release_extraction": "SEC DMA/Press Release Extraction",
    "sec_dma_summary": "SEC DMA Summary",
    "newswire_acquire": "Newswire Acquire",
    "newswire_target": "Newswire Target",
    "newswire_both": "Newswire Both",
    "newswire_new_deal_without_threshold": "Newswire New Deal Without Threshold",
    "newswire_new_deal_with_threshold": "Newswire New Deal With Threshold",
    "newswire_rss_match": "Newswire RSS Match Deal",
    "other_newswire": "Other Newswire",
    "foreign_regulatory_us_deal": "Foreign Regulatory US Deal",
    "foreign_regulatory_matched_deal": "Foreign Regulatory Matched Deal"
}
