"""
JWT authentication module.
Handles password hashing, token creation/validation, and the FastAPI
dependency that protects routes.
"""

from datetime import datetime, timedelta, timezone
from functools import wraps

import jwt
from fastapi import Depends, HTTPException, Request
from passlib.context import CryptContext

from config import (
    JWT_SECRET_KEY,
    ACCESS_TOKEN_EXPIRE_MINUTES,
    REFRESH_TOKEN_EXPIRE_DAYS,
)

ALGORITHM = "HS256"

_pwd_ctx = CryptContext(
    schemes=["django_pbkdf2_sha256", "bcrypt"],
    deprecated="auto",
)

# ── Backward-compatible shim — use db.py for new code ────────────────────────

def get_users_collection():
    """Kept for backward compatibility with existing main.py login route."""
    from db import get_users_col
    return get_users_col()


# ── Password helpers ─────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return _pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_ctx.verify(plain, hashed)


# ── Token helpers ─────────────────────────────────────────────────────────────

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


def build_token_payload(user: dict) -> dict:
    """Build the standard JWT payload from a user document."""
    return {
        "user_id": str(user["_id"]),
        "email": user["email"],
        "role": user.get("role", "user"),
        "org_id": str(user["organization_id"]) if user.get("organization_id") else None,
        "is_individual": user.get("is_individual", False),
        "force_reset": user.get("force_password_reset", False),
    }


# ── FastAPI dependency ────────────────────────────────────────────────────────

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


# ── Role-based access control ─────────────────────────────────────────────────

def require_roles(*allowed_roles: str):
    """
    FastAPI Depends factory for role-based access control.

    Usage:
        @router.get("/admin-only")
        def view(user=Depends(require_roles("super_admin", "admin"))):
            ...
    """
    async def dependency(request: Request) -> dict:
        user = await get_current_user(request)
        if user.get("role") not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return dependency


def require_super_admin(request: Request):
    return require_roles("super_admin")(request)


def require_admin_or_above(request: Request):
    return require_roles("super_admin", "admin")(request)
