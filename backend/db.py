"""
Centralized MongoDB client.
All modules should import get_db() from here instead of creating their own client.
"""

from pymongo import MongoClient
from pymongo.database import Database
from config import MONGODB_URI, MONGODB_DB

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
