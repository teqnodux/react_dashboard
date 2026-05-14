"""
Centralized MongoDB client.
All modules should import get_db() from here instead of creating their own client.
"""

from pymongo import MongoClient
from pymongo.database import Database
from config import MONGODB_URI, MONGODB_DB, FEED_ITEMS_COLLECTION

_client: MongoClient | None = None


def get_client() -> MongoClient:
    global _client
    if _client is None:
        if not MONGODB_URI:
            raise RuntimeError("MONGODB_URI is not configured")
        _client = MongoClient(MONGODB_URI)
    return _client


def get_db() -> Database:
    return get_client()[MONGODB_DB]


# Convenience accessors
def get_users_col():
    return get_db()["users"]


def get_organizations_col():
    return get_db()["organizations"]


def get_email_recipients_col():
    return get_db()["organization_email_recipients"]


def get_invitations_col():
    return get_db()["invitations"]


def get_password_reset_tokens_col():
    return get_db()["password_reset_tokens"]


def get_feed_items_col():
    return get_db()[FEED_ITEMS_COLLECTION]


def feed_item_has_deal_id(doc: dict | None) -> bool:
    """True when feed document is tied to a deal (non-empty deal_id after trim)."""
    if not doc:
        return False
    raw = doc.get("deal_id")
    if raw is None:
        return False
    return bool(str(raw).strip())


def feed_items_deal_id_query() -> dict:
    """Mongo filter: deal_id present and non-empty (trimmed). Matches feed_item_has_deal_id."""
    return {
        "$expr": {
            "$gt": [
                {
                    "$strLenCP": {
                        "$trim": {
                            "input": {"$toString": {"$ifNull": ["$deal_id", ""]}}
                        }
                    }
                },
                0,
            ]
        }
    }
