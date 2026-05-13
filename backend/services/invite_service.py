"""
Invitation token generation and validation.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import HTTPException


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def create_invite(db, org_id: str, invited_by_id: str, email: str, role: str) -> str:
    """
    Create an invitation record and return the raw token (to embed in email link).
    The stored token is sha256-hashed.
    """
    raw_token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=48)

    db["invitations"].insert_one({
        "token": _hash_token(raw_token),
        "email": email.lower().strip(),
        "organization_id": org_id,
        "invited_by": invited_by_id,
        "role": role,
        "status": "pending",
        "expires_at": expires_at,
        "created_at": datetime.now(timezone.utc),
    })
    return raw_token


def validate_invite(db, raw_token: str) -> dict:
    """
    Validate an invitation token.
    Returns the invitation document on success, raises HTTPException otherwise.
    """
    token_hash = _hash_token(raw_token)
    invite = db["invitations"].find_one({"token": token_hash})

    if not invite:
        raise HTTPException(status_code=400, detail="Invalid invitation token")
    if invite.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Invitation already used or expired")
    if invite["expires_at"].replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Invitation has expired")

    return invite


def mark_invite_accepted(db, invite_id):
    db["invitations"].update_one(
        {"_id": ObjectId(invite_id)},
        {"$set": {"status": "accepted"}},
    )
