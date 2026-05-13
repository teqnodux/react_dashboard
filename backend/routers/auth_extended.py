"""
Extended auth routes:
  POST /api/auth/forgot-password
  POST /api/auth/reset-password
  POST /api/auth/change-password
  POST /api/auth/accept-invite
"""

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr

from auth import (
    get_current_user,
    hash_password,
    verify_password,
    build_token_payload,
    create_access_token,
    create_refresh_token,
)
from db import get_db
from services.email_service import send_password_reset_email
from services.invite_service import validate_invite, mark_invite_accepted

router = APIRouter(prefix="/api/auth", tags=["auth-extended"])

FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")


# ── Check invite token (public) ───────────────────────────────────────────────

@router.get("/invite/check")
def check_invite(token: str):
    """
    Pre-validate an invite token before showing the accept form.
    Returns: { status: "valid" | "accepted" | "expired" | "invalid" }
    """
    db = get_db()
    token_hash = _hash_token(token)
    invite = db["invitations"].find_one({"token": token_hash})

    if not invite:
        return {"status": "invalid"}

    if invite.get("status") == "accepted":
        return {"status": "accepted"}

    expires_at = invite.get("expires_at")
    if expires_at:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            return {"status": "expired"}

    if invite.get("status") != "pending":
        return {"status": "expired"}

    return {"status": "valid", "email": invite.get("email")}


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _validate_password_strength(password: str):
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if not any(c.isupper() for c in password):
        raise HTTPException(status_code=400, detail="Password must contain at least one uppercase letter")
    if not any(c.isdigit() for c in password):
        raise HTTPException(status_code=400, detail="Password must contain at least one digit")


# ── Forgot password ───────────────────────────────────────────────────────────

class ForgotPasswordRequest(BaseModel):
    email: EmailStr


@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordRequest):
    db = get_db()
    email = body.email.lower().strip()
    user = db["users"].find_one({"email": email})

    # Always return 200 — do not reveal if email exists
    if not user:
        return {"detail": "If that email is registered, you will receive a reset link"}

    raw_token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    db["password_reset_tokens"].insert_one({
        "user_id": str(user["_id"]),
        "token_hash": _hash_token(raw_token),
        "expires_at": expires_at,
        "used": False,
        "created_at": datetime.now(timezone.utc),
    })

    reset_link = f"{FRONTEND_BASE_URL}/reset-password?token={raw_token}"
    send_password_reset_email(email, reset_link)

    return {"detail": "If that email is registered, you will receive a reset link"}


# ── Reset password (email flow) ───────────────────────────────────────────────

class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


@router.post("/reset-password")
def reset_password(body: ResetPasswordRequest):
    _validate_password_strength(body.new_password)

    db = get_db()
    token_hash = _hash_token(body.token)
    record = db["password_reset_tokens"].find_one({"token_hash": token_hash, "used": False})

    if not record:
        raise HTTPException(status_code=400, detail="Invalid or already used reset token")

    expires_at = record["expires_at"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Reset token has expired")

    user_oid = ObjectId(record["user_id"])
    db["users"].update_one(
        {"_id": user_oid},
        {"$set": {
            "password": hash_password(body.new_password),
            "force_password_reset": False,
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    db["password_reset_tokens"].update_one(
        {"_id": record["_id"]},
        {"$set": {"used": True}},
    )

    return {"detail": "Password updated successfully"}


# ── Change password (authenticated — admin-forced or self-service) ────────────

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
async def change_password(body: ChangePasswordRequest, request: Request):
    current_user = await get_current_user(request)
    _validate_password_strength(body.new_password)

    db = get_db()
    user = db["users"].find_one({"_id": ObjectId(current_user["user_id"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if not verify_password(body.current_password, user["password"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    db["users"].update_one(
        {"_id": user["_id"]},
        {"$set": {
            "password": hash_password(body.new_password),
            "force_password_reset": False,
            "updated_at": datetime.now(timezone.utc),
        }},
    )

    # Issue fresh tokens with force_reset=False so the frontend can proceed
    updated_user = db["users"].find_one({"_id": user["_id"]})
    payload = build_token_payload(updated_user)
    return {
        "detail": "Password changed successfully",
        "access": create_access_token(payload),
        "refresh": create_refresh_token(payload),
    }


# ── Accept invitation ─────────────────────────────────────────────────────────

class AcceptInviteRequest(BaseModel):
    token: str
    password: str
    name: str = ""


@router.post("/accept-invite")
def accept_invite(body: AcceptInviteRequest):
    _validate_password_strength(body.password)

    db = get_db()
    invite = validate_invite(db, body.token)

    email = invite["email"]
    if db["users"].find_one({"email": email}):
        raise HTTPException(status_code=409, detail="An account with this email already exists")

    now = datetime.now(timezone.utc)
    new_user = {
        "email": email,
        "password": hash_password(body.password),
        "role": invite.get("role", "user"),
        "status": "active",
        "organization_id": invite.get("organization_id"),
        "is_individual": False,
        "force_password_reset": False,
        "invited_by": invite.get("invited_by"),
        "name": body.name,
        "created_at": now,
        "updated_at": now,
    }
    result = db["users"].insert_one(new_user)
    new_user["_id"] = result.inserted_id

    mark_invite_accepted(db, str(invite["_id"]))

    payload = build_token_payload(new_user)
    return {
        "detail": "Account created successfully",
        "access": create_access_token(payload),
        "refresh": create_refresh_token(payload),
        "user_id": str(new_user["_id"]),
        "email": email,
        "role": new_user["role"],
    }
