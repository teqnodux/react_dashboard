"""
Org-admin routes — scoped to the admin's own organization.
All routes require role = admin (or super_admin).
"""

import os
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr

from auth import require_roles, get_current_user
from db import get_db
from services.org_service import check_user_cap, get_org_or_404
from services.invite_service import create_invite
from services.email_service import send_invite_email

router = APIRouter(prefix="/api/org", tags=["org-admin"])

_require_admin = Depends(require_roles("super_admin", "admin"))

FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")


def _user_to_dict(u: dict) -> dict:
    return {
        "id": str(u["_id"]),
        "email": u.get("email"),
        "role": u.get("role"),
        "status": u.get("status"),
        "is_individual": u.get("is_individual", False),
        "force_password_reset": u.get("force_password_reset", False),
        "created_at": u.get("created_at").isoformat() if u.get("created_at") else None,
    }


def _scoped_org_id(current_user: dict) -> str:
    """
    Super admins must pass ?org_id=... query param.
    Regular admins use their own org_id from the token.
    """
    org_id = current_user.get("org_id")
    if not org_id:
        raise HTTPException(
            status_code=400,
            detail="No organization associated with your account",
        )
    return org_id


# ── User management ───────────────────────────────────────────────────────────

@router.get("/users")
def list_users(current_user=_require_admin):
    """Returns active/inactive/suspended users + pending invitations combined."""
    org_id = _scoped_org_id(current_user)
    db = get_db()

    users = [_user_to_dict(u) for u in db["users"].find({"organization_id": org_id})]

    # Append pending + expired invitations so admins can see/resend/remove them
    invites = db["invitations"].find({
        "organization_id": org_id,
        "status": {"$in": ["pending", "expired"]},
    })
    for inv in invites:
        inv_status = inv.get("status")
        # Map DB status to display status
        display_status = "invited" if inv_status == "pending" else "expired"
        users.append({
            "id": str(inv["_id"]),
            "email": inv.get("email"),
            "role": inv.get("role", "user"),
            "status": display_status,
            "is_individual": False,
            "force_password_reset": False,
            "created_at": inv.get("created_at").isoformat() if inv.get("created_at") else None,
            "_is_invite": True,
        })

    return users


class InviteRequest(BaseModel):
    email: EmailStr
    role: str = "user"   # admin | user


@router.post("/invite")
def invite_user(body: InviteRequest, current_user=_require_admin):
    org_id = _scoped_org_id(current_user)
    db = get_db()

    # Guard: org must exist and be active
    org = get_org_or_404(org_id, db)
    if org.get("status") != "active":
        raise HTTPException(status_code=403, detail="Organization is not active")

    # Guard: user cap
    check_user_cap(org_id, db)

    # Guard: no duplicate active invite or existing user
    email = body.email.lower().strip()
    if db["users"].find_one({"email": email}):
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    if db["invitations"].find_one({"email": email, "organization_id": org_id, "status": "pending"}):
        raise HTTPException(status_code=409, detail="An active invitation already exists for this email")

    raw_token = create_invite(db, org_id, current_user["user_id"], email, body.role)
    invite_link = f"{FRONTEND_BASE_URL}/accept-invite?token={raw_token}"
    send_invite_email(email, org.get("name", ""), invite_link)

    return {"detail": "Invitation sent", "email": email}


@router.patch("/users/{user_id}/suspend")
def suspend_user(user_id: str, current_user=_require_admin):
    org_id = _scoped_org_id(current_user)
    db = get_db()

    # Prevent admin from suspending themselves
    if user_id == current_user.get("user_id"):
        raise HTTPException(status_code=400, detail="You cannot suspend your own account")

    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    user = db["users"].find_one({"_id": oid, "organization_id": org_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found in your organization")

    db["users"].update_one(
        {"_id": oid},
        {"$set": {"status": "suspended", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"detail": "User suspended"}


@router.patch("/users/{user_id}/reactivate")
def reactivate_user(user_id: str, current_user=_require_admin):
    org_id = _scoped_org_id(current_user)
    db = get_db()
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    user = db["users"].find_one({"_id": oid, "organization_id": org_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found in your organization")

    if user.get("status") == "active":
        raise HTTPException(status_code=400, detail="User is already active")

    db["users"].update_one(
        {"_id": oid},
        {"$set": {"status": "active", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"detail": "User reactivated"}


@router.delete("/users/{user_id}")
def remove_user(user_id: str, current_user=_require_admin):
    """
    Removes a user OR cancels a pending invitation.
    The frontend passes the MongoDB _id of either a user doc or an invitation doc.
    """
    org_id = _scoped_org_id(current_user)
    db = get_db()

    if user_id == current_user.get("user_id"):
        raise HTTPException(status_code=400, detail="You cannot remove your own account")

    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid ID")

    # Check if this ID belongs to a pending or expired invitation
    invite = db["invitations"].find_one({
        "_id": oid,
        "organization_id": org_id,
        "status": {"$in": ["pending", "expired"]},
    })
    if invite:
        db["invitations"].delete_one({"_id": oid})
        return {"detail": "Invitation removed"}

    # Otherwise treat as a regular user
    user = db["users"].find_one({"_id": oid, "organization_id": org_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found in your organization")

    db["users"].update_one(
        {"_id": oid},
        {"$set": {"status": "inactive", "organization_id": None, "updated_at": datetime.now(timezone.utc)}},
    )
    return {"detail": "User removed from organization"}


@router.post("/invites/{invite_id}/resend")
def resend_invite(invite_id: str, current_user=_require_admin):
    """Delete the expired invite and create a fresh one with a new token and 48h TTL."""
    org_id = _scoped_org_id(current_user)
    db = get_db()

    try:
        oid = ObjectId(invite_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid invite ID")

    old_invite = db["invitations"].find_one({
        "_id": oid,
        "organization_id": org_id,
        "status": {"$in": ["pending", "expired"]},
    })
    if not old_invite:
        raise HTTPException(status_code=404, detail="Invitation not found")

    org = get_org_or_404(org_id, db)
    if org.get("status") != "active":
        raise HTTPException(status_code=403, detail="Organization is not active")

    email = old_invite["email"]
    role = old_invite.get("role", "user")

    # Remove the old invite record before creating a fresh one
    db["invitations"].delete_one({"_id": oid})

    raw_token = create_invite(db, org_id, current_user["user_id"], email, role)
    invite_link = f"{FRONTEND_BASE_URL}/accept-invite?token={raw_token}"
    send_invite_email(email, org.get("name", ""), invite_link)

    return {"detail": "Invitation resent", "email": email}


@router.patch("/users/{user_id}/force-reset")
def admin_force_reset(user_id: str, current_user=_require_admin):
    org_id = _scoped_org_id(current_user)
    db = get_db()
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    user = db["users"].find_one({"_id": oid, "organization_id": org_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found in your organization")

    db["users"].update_one(
        {"_id": oid},
        {"$set": {"force_password_reset": True, "updated_at": datetime.now(timezone.utc)}},
    )
    return {"detail": "Password reset flag set for user"}


# ── Email recipients ──────────────────────────────────────────────────────────

class RecipientCreate(BaseModel):
    email: EmailStr
    name: str
    is_active: bool = True


class RecipientUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None


def _recipient_to_dict(r: dict) -> dict:
    return {
        "id": str(r["_id"]),
        "organization_id": r.get("organization_id"),
        "email": r.get("email"),
        "name": r.get("name"),
        "is_active": r.get("is_active", True),
        "created_at": r.get("created_at").isoformat() if r.get("created_at") else None,
        "updated_at": r.get("updated_at").isoformat() if r.get("updated_at") else None,
    }


@router.get("/email-recipients")
def list_recipients(current_user=_require_admin):
    org_id = _scoped_org_id(current_user)
    db = get_db()
    recipients = db["organization_email_recipients"].find({"organization_id": org_id})
    return [_recipient_to_dict(r) for r in recipients]


@router.post("/email-recipients")
def add_recipient(body: RecipientCreate, current_user=_require_admin):
    org_id = _scoped_org_id(current_user)
    db = get_db()
    email = body.email.lower().strip()

    if db["organization_email_recipients"].find_one({"organization_id": org_id, "email": email}):
        raise HTTPException(status_code=409, detail="Recipient with this email already exists")

    now = datetime.now(timezone.utc)
    doc = {
        "organization_id": org_id,
        "email": email,
        "name": body.name,
        "is_active": body.is_active,
        "created_at": now,
        "updated_at": now,
    }
    result = db["organization_email_recipients"].insert_one(doc)
    doc["_id"] = result.inserted_id
    return _recipient_to_dict(doc)


@router.patch("/email-recipients/{recipient_id}")
def update_recipient(recipient_id: str, body: RecipientUpdate, current_user=_require_admin):
    org_id = _scoped_org_id(current_user)
    db = get_db()
    try:
        oid = ObjectId(recipient_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid recipient ID")

    recipient = db["organization_email_recipients"].find_one({"_id": oid, "organization_id": org_id})
    if not recipient:
        raise HTTPException(status_code=404, detail="Recipient not found")

    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    if body.name is not None:
        updates["name"] = body.name
    if body.is_active is not None:
        updates["is_active"] = body.is_active

    db["organization_email_recipients"].update_one({"_id": oid}, {"$set": updates})
    return _recipient_to_dict(db["organization_email_recipients"].find_one({"_id": oid}))


@router.delete("/email-recipients/{recipient_id}")
def delete_recipient(recipient_id: str, current_user=_require_admin):
    org_id = _scoped_org_id(current_user)
    db = get_db()
    try:
        oid = ObjectId(recipient_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid recipient ID")

    result = db["organization_email_recipients"].delete_one({"_id": oid, "organization_id": org_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Recipient not found")
    return {"detail": "Recipient removed"}
