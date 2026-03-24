"""
Data source configuration.
Switch between static JSON files and MongoDB (Deal_DB_New).

Set DATA_SOURCE env variable or change the default here:
  "static"  → reads from /data/deals.json (original behaviour)
  "mongodb" → reads from Deal_DB_New via MongoDB
"""
import os

DATA_SOURCE = os.getenv("DATA_SOURCE", "mongodb")

MONGODB_URI = os.getenv(
    "MONGODB_URI",
    "mongodb+srv://aaron:TeqnoDux%40888@cluster0.ywhjxjd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
)
MONGODB_DB = "Deal_DB_New"
