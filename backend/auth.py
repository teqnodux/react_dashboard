"""
JWT authentication module.
Handles password hashing, token creation/validation, and the FastAPI
dependency that protects routes.
"""

from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, Request
from passlib.context import CryptContext
from pymongo import MongoClient

from config import (
    JWT_SECRET_KEY,
    ACCESS_TOKEN_EXPIRE_MINUTES,
    REFRESH_TOKEN_EXPIRE_DAYS,
    MONGODB_URI,
    MONGODB_DB,
)

ALGORITHM = "HS256"

_pwd_ctx = CryptContext(
    schemes=["django_pbkdf2_sha256", "bcrypt"],
    deprecated="auto",
)

# ── MongoDB users collection ─────────────────────────────────────────────

_mongo_client: MongoClient | None = None


def get_users_collection():
    global _mongo_client
    if _mongo_client is None:
        if not MONGODB_URI:
            raise RuntimeError("MONGODB_URI is not configured")
        _mongo_client = MongoClient(MONGODB_URI)
    return _mongo_client[MONGODB_DB]["users"]


# ── Password helpers ─────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return _pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_ctx.verify(plain, hashed)


# ── Token helpers ────────────────────────────────────────────────────────

def _check_secret():
    if not JWT_SECRET_KEY:
        raise RuntimeError(
            "JWT_SECRET_KEY is not set. Add it to your backend/.env file."
        )


def create_access_token(payload: dict) -> str:
    _check_secret()
    data = payload.copy()
    data["exp"] = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    data["type"] = "access"
    return jwt.encode(data, JWT_SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(payload: dict) -> str:
    _check_secret()
    data = payload.copy()
    data["exp"] = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    data["type"] = "refresh"
    return jwt.encode(data, JWT_SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    _check_secret()
    try:
        return jwt.decode(token, JWT_SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


# ── FastAPI dependency ───────────────────────────────────────────────────

async def get_current_user(request: Request) -> dict:
    """Extract and validate the Bearer token from the Authorization header."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = auth_header[7:]
    payload = decode_token(token)

    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")

    return payload
