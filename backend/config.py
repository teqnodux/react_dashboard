"""
Data source configuration.
Switch between static JSON files and MongoDB (Deal_DB_New).

Set DATA_SOURCE env variable or change the default here:
  "static"  → reads from /data/deals.json (original behaviour)
  "mongodb" → reads from Deal_DB_New via MongoDB
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

MONGODB_URI = os.getenv(
    "MONGODB_URI",
    ""
)
MONGODB_DB = "Deal_DB"
