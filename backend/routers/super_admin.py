"""
Super-admin routes — full system access.
All routes require role = super_admin.
"""

import os
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr

from auth import require_roles, hash_password
from config import EMAIL_REPORT_TYPES
from db import get_db
from services.email_service import send_invite_email
from services.invite_service import create_invite
from services.org_service import get_org_or_404, org_to_dict, check_user_cap

FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")

router = APIRouter(prefix="/api/super-admin", tags=["super-admin"])

_require_super = Depends(require_roles("super_admin"))


def _user_to_dict(u: dict) -> dict:
    return {
        "id": str(u["_id"]),
        "email": u.get("email"),
        "role": u.get("role"),
        "status": u.get("status"),
        "is_individual": u.get("is_individual", False),
        "organization_id": u.get("organization_id"),
        "force_password_reset": u.get("force_password_reset", False),
        "created_at": u.get("created_at").isoformat() if u.get("created_at") else None,
        "updated_at": u.get("updated_at").isoformat() if u.get("updated_at") else None,
    }


# ── Organization CRUD ─────────────────────────────────────────────────────────

class CreateOrgRequest(BaseModel):
    name: str
    plan_name: str = "basic"          # basic | pro | enterprise
    user_cap: int = 5
    start_date: str                    # ISO date string
    end_date: str
    status: str = "active"


class UpdateOrgRequest(BaseModel):
    name: Optional[str] = None
    plan_name: Optional[str] = None
    user_cap: Optional[int] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: Optional[str] = None


@router.post("/orgs")
def create_org(body: CreateOrgRequest, current_user=_require_super):
    db = get_db()
    now = datetime.now(timezone.utc)
    doc = {
        "name": body.name,
        "status": body.status,
        "plan_name": body.plan_name,
        "user_cap": body.user_cap,
        "start_date": datetime.fromisoformat(body.start_date),
        "end_date": datetime.fromisoformat(body.end_date),
        "created_by_super_admin_id": current_user["user_id"],
        "created_at": now,
        "updated_at": now,
    }
    result = db["organizations"].insert_one(doc)
    doc["_id"] = result.inserted_id
    return org_to_dict(doc)


@router.get("/orgs")
def list_orgs(status: Optional[str] = None, current_user=_require_super):
    db = get_db()
    query = {}
    if status:
        query["status"] = status
    orgs = db["organizations"].find(query).sort("created_at", -1)
    return [org_to_dict(o) for o in orgs]


@router.get("/orgs/{org_id}")
def get_org(org_id: str, current_user=_require_super):
    db = get_db()
    return org_to_dict(get_org_or_404(org_id, db))


@router.patch("/orgs/{org_id}")
def update_org(org_id: str, body: UpdateOrgRequest, current_user=_require_super):
    db = get_db()
    get_org_or_404(org_id, db)   # ensure exists

    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    if body.name is not None:
        updates["name"] = body.name
    if body.plan_name is not None:
        updates["plan_name"] = body.plan_name
    if body.user_cap is not None:
        updates["user_cap"] = body.user_cap
    if body.status is not None:
        updates["status"] = body.status
    if body.start_date is not None:
        updates["start_date"] = datetime.fromisoformat(body.start_date)
    if body.end_date is not None:
        updates["end_date"] = datetime.fromisoformat(body.end_date)

    db["organizations"].update_one({"_id": ObjectId(org_id)}, {"$set": updates})
    return org_to_dict(get_org_or_404(org_id, db))


@router.delete("/orgs/{org_id}")
def delete_org(org_id: str, current_user=_require_super):
    """Soft-delete: sets status=inactive."""
    db = get_db()
    get_org_or_404(org_id, db)
    db["organizations"].update_one(
        {"_id": ObjectId(org_id)},
        {"$set": {"status": "inactive", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"detail": "Organization deactivated"}


# ── Report types master list ──────────────────────────────────────────────────

@router.get("/report-types")
def get_report_types(current_user=_require_super):
    """Return the master list of all available email report types."""
    return EMAIL_REPORT_TYPES


# ── Org notification settings ─────────────────────────────────────────────────

class NotificationSettingsRequest(BaseModel):
    enabled_report_types: list[str]


def _notif_settings_to_dict(doc: dict | None) -> dict:
    if not doc:
        return {"enabled_report_types": []}
    return {
        "enabled_report_types": doc.get("enabled_report_types", []),
        "created_at": doc["created_at"].isoformat() if doc.get("created_at") else None,
        "updated_at": doc["updated_at"].isoformat() if doc.get("updated_at") else None,
    }


@router.get("/orgs/{org_id}/notification-settings")
def get_org_notification_settings(org_id: str, current_user=_require_super):
    db = get_db()
    get_org_or_404(org_id, db)
    doc = db["organization_notification_settings"].find_one({"organization_id": org_id})
    return _notif_settings_to_dict(doc)


@router.put("/orgs/{org_id}/notification-settings")
def update_org_notification_settings(
    org_id: str,
    body: NotificationSettingsRequest,
    current_user=_require_super,
):
    db = get_db()
    get_org_or_404(org_id, db)

    invalid = [t for t in body.enabled_report_types if t not in EMAIL_REPORT_TYPES]
    if invalid:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown report type(s): {', '.join(invalid)}",
        )

    now = datetime.now(timezone.utc)
    db["organization_notification_settings"].update_one(
        {"organization_id": org_id},
        {"$set": {
            "organization_id": org_id,
            "enabled_report_types": body.enabled_report_types,
            "updated_at": now,
        }, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )
    doc = db["organization_notification_settings"].find_one({"organization_id": org_id})
    return _notif_settings_to_dict(doc)


def _org_member_to_dict(u: dict) -> dict:
    """Org-scoped user row (no organization_id — implied by path)."""
    return {
        "id": str(u["_id"]),
        "email": u.get("email"),
        "role": u.get("role"),
        "status": u.get("status"),
        "is_individual": u.get("is_individual", False),
        "force_password_reset": u.get("force_password_reset", False),
        "created_at": u.get("created_at").isoformat() if u.get("created_at") else None,
    }


def _recipient_to_dict(r: dict) -> dict:
    return {
        "id": str(r["_id"]),
        "organization_id": r.get("organization_id"),
        "email": r.get("email"),
        "name": r.get("name"),
        "is_active": r.get("is_active", True),
        "report_types": r.get("report_types", []),
        "created_at": r.get("created_at").isoformat() if r.get("created_at") else None,
        "updated_at": r.get("updated_at").isoformat() if r.get("updated_at") else None,
    }


@router.get("/orgs/{org_id}/users")
def list_org_users(org_id: str, current_user=_require_super):
    """Users + pending/expired invitations for one organization."""
    db = get_db()
    get_org_or_404(org_id, db)

    users = [_org_member_to_dict(u) for u in db["users"].find({"organization_id": org_id})]

    invites = db["invitations"].find({
        "organization_id": org_id,
        "status": {"$in": ["pending", "expired"]},
    })
    for inv in invites:
        inv_status = inv.get("status")
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


class OrgInviteRequest(BaseModel):
    email: EmailStr
    role: str = "user"


@router.post("/orgs/{org_id}/invite")
def invite_org_user(org_id: str, body: OrgInviteRequest, current_user=_require_super):
    db = get_db()
    org = get_org_or_404(org_id, db)
    if org.get("status") != "active":
        raise HTTPException(status_code=403, detail="Organization is not active")

    check_user_cap(org_id, db)

    email = body.email.lower().strip()
    if db["users"].find_one({"email": email}):
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    if db["invitations"].find_one({
        "email": email,
        "organization_id": org_id,
        "status": "pending",
    }):
        raise HTTPException(
            status_code=409,
            detail="An active invitation already exists for this email",
        )

    raw_token = create_invite(db, org_id, current_user["user_id"], email, body.role)
    invite_link = f"{FRONTEND_BASE_URL}/accept-invite?token={raw_token}"
    send_invite_email(email, org.get("name", ""), invite_link)

    return {"detail": "Invitation sent", "email": email}


@router.patch("/orgs/{org_id}/users/{user_id}/suspend")
def suspend_org_user(org_id: str, user_id: str, current_user=_require_super):
    db = get_db()
    get_org_or_404(org_id, db)
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    user = db["users"].find_one({"_id": oid, "organization_id": org_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found in this organization")

    db["users"].update_one(
        {"_id": oid},
        {"$set": {"status": "suspended", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"detail": "User suspended"}


@router.patch("/orgs/{org_id}/users/{user_id}/reactivate")
def reactivate_org_user(org_id: str, user_id: str, current_user=_require_super):
    db = get_db()
    get_org_or_404(org_id, db)
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    user = db["users"].find_one({"_id": oid, "organization_id": org_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found in this organization")

    if user.get("status") == "active":
        raise HTTPException(status_code=400, detail="User is already active")

    db["users"].update_one(
        {"_id": oid},
        {"$set": {"status": "active", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"detail": "User reactivated"}


@router.delete("/orgs/{org_id}/users/{user_id}")
def remove_org_user(org_id: str, user_id: str, current_user=_require_super):
    """Remove a user or cancel a pending/expired invitation."""
    db = get_db()
    get_org_or_404(org_id, db)
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid ID")

    invite = db["invitations"].find_one({
        "_id": oid,
        "organization_id": org_id,
        "status": {"$in": ["pending", "expired"]},
    })
    if invite:
        db["invitations"].delete_one({"_id": oid})
        return {"detail": "Invitation removed"}

    user = db["users"].find_one({"_id": oid, "organization_id": org_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found in this organization")

    db["users"].update_one(
        {"_id": oid},
        {"$set": {
            "status": "inactive",
            "organization_id": None,
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    return {"detail": "User removed from organization"}


@router.post("/orgs/{org_id}/invites/{invite_id}/resend")
def resend_org_invite(org_id: str, invite_id: str, current_user=_require_super):
    db = get_db()
    org = get_org_or_404(org_id, db)
    if org.get("status") != "active":
        raise HTTPException(status_code=403, detail="Organization is not active")

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

    email = old_invite["email"]
    role = old_invite.get("role", "user")

    db["invitations"].delete_one({"_id": oid})

    raw_token = create_invite(db, org_id, current_user["user_id"], email, role)
    invite_link = f"{FRONTEND_BASE_URL}/accept-invite?token={raw_token}"
    send_invite_email(email, org.get("name", ""), invite_link)

    return {"detail": "Invitation resent", "email": email}


@router.patch("/orgs/{org_id}/users/{user_id}/force-reset")
def force_reset_org_user(org_id: str, user_id: str, current_user=_require_super):
    db = get_db()
    get_org_or_404(org_id, db)
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    user = db["users"].find_one({"_id": oid, "organization_id": org_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found in this organization")

    db["users"].update_one(
        {"_id": oid},
        {"$set": {"force_password_reset": True, "updated_at": datetime.now(timezone.utc)}},
    )
    return {"detail": "Password reset flag set for user"}


# ── Org email recipients ──────────────────────────────────────────────────────

def _validate_recipient_report_types(org_id: str, report_types: list[str], db) -> None:
    """Ensure recipient's report_types are all within the org's enabled list."""
    if not report_types:
        return
    settings = db["organization_notification_settings"].find_one({"organization_id": org_id})
    enabled = settings.get("enabled_report_types", []) if settings else []
    invalid = [t for t in report_types if t not in enabled]
    if invalid:
        raise HTTPException(
            status_code=422,
            detail=f"Report type(s) not enabled for this org: {', '.join(invalid)}",
        )


class RecipientCreate(BaseModel):
    email: EmailStr
    name: str
    is_active: bool = True
    report_types: list[str] = []


class RecipientUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None
    report_types: Optional[list[str]] = None


@router.get("/orgs/{org_id}/email-recipients")
def list_org_email_recipients(org_id: str, current_user=_require_super):
    db = get_db()
    get_org_or_404(org_id, db)
    recipients = db["organization_email_recipients"].find({"organization_id": org_id})
    return [_recipient_to_dict(r) for r in recipients]


@router.post("/orgs/{org_id}/email-recipients")
def add_org_email_recipient(
    org_id: str, body: RecipientCreate, current_user=_require_super
):
    db = get_db()
    get_org_or_404(org_id, db)
    email = body.email.lower().strip()

    if db["organization_email_recipients"].find_one({
        "organization_id": org_id,
        "email": email,
    }):
        raise HTTPException(status_code=409, detail="Recipient with this email already exists")

    _validate_recipient_report_types(org_id, body.report_types, db)

    now = datetime.now(timezone.utc)
    doc = {
        "organization_id": org_id,
        "email": email,
        "name": body.name,
        "is_active": body.is_active,
        "report_types": body.report_types,
        "created_at": now,
        "updated_at": now,
    }
    result = db["organization_email_recipients"].insert_one(doc)
    doc["_id"] = result.inserted_id
    return _recipient_to_dict(doc)


@router.patch("/orgs/{org_id}/email-recipients/{recipient_id}")
def update_org_email_recipient(
    org_id: str,
    recipient_id: str,
    body: RecipientUpdate,
    current_user=_require_super,
):
    db = get_db()
    get_org_or_404(org_id, db)
    try:
        oid = ObjectId(recipient_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid recipient ID")

    recipient = db["organization_email_recipients"].find_one({
        "_id": oid,
        "organization_id": org_id,
    })
    if not recipient:
        raise HTTPException(status_code=404, detail="Recipient not found")

    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    if body.name is not None:
        updates["name"] = body.name
    if body.is_active is not None:
        updates["is_active"] = body.is_active
    if body.report_types is not None:
        _validate_recipient_report_types(org_id, body.report_types, db)
        updates["report_types"] = body.report_types

    db["organization_email_recipients"].update_one({"_id": oid}, {"$set": updates})
    return _recipient_to_dict(
        db["organization_email_recipients"].find_one({"_id": oid})
    )


@router.delete("/orgs/{org_id}/email-recipients/{recipient_id}")
def delete_org_email_recipient(
    org_id: str, recipient_id: str, current_user=_require_super
):
    db = get_db()
    get_org_or_404(org_id, db)
    try:
        oid = ObjectId(recipient_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid recipient ID")

    result = db["organization_email_recipients"].delete_one({
        "_id": oid,
        "organization_id": org_id,
    })
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Recipient not found")
    return {"detail": "Recipient removed"}


# ── Global user management ────────────────────────────────────────────────────

class CreateUserRequest(BaseModel):
    email: EmailStr
    password: str
    role: str = "user"                 # super_admin | admin | user
    organization_id: Optional[str] = None
    is_individual: bool = False
    status: str = "active"


class UpdateUserRequest(BaseModel):
    role: Optional[str] = None
    status: Optional[str] = None
    organization_id: Optional[str] = None
    is_individual: Optional[bool] = None


@router.post("/users")
def create_user(body: CreateUserRequest, current_user=_require_super):
    db = get_db()

    if db["users"].find_one({"email": body.email.lower()}):
        raise HTTPException(status_code=409, detail="Email already in use")

    if body.organization_id:
        check_user_cap(body.organization_id, db)

    now = datetime.now(timezone.utc)
    doc = {
        "email": body.email.lower(),
        "password": hash_password(body.password),
        "role": body.role,
        "status": body.status,
        "organization_id": body.organization_id,
        "is_individual": body.is_individual,
        "force_password_reset": False,
        "invited_by": None,
        "created_at": now,
        "updated_at": now,
    }
    result = db["users"].insert_one(doc)
    doc["_id"] = result.inserted_id
    return _user_to_dict(doc)


@router.get("/users")
def list_all_users(current_user=_require_super):
    db = get_db()
    return [_user_to_dict(u) for u in db["users"].find()]


@router.patch("/users/{user_id}")
def update_user(user_id: str, body: UpdateUserRequest, current_user=_require_super):
    db = get_db()
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    user = db["users"].find_one({"_id": oid})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    if body.role is not None:
        updates["role"] = body.role
    if body.status is not None:
        updates["status"] = body.status
    if body.organization_id is not None:
        updates["organization_id"] = body.organization_id
    if body.is_individual is not None:
        updates["is_individual"] = body.is_individual

    db["users"].update_one({"_id": oid}, {"$set": updates})
    return _user_to_dict(db["users"].find_one({"_id": oid}))


@router.patch("/users/{user_id}/force-reset")
def force_password_reset(user_id: str, current_user=_require_super):
    db = get_db()
    try:
        oid = ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")

    result = db["users"].update_one(
        {"_id": oid},
        {"$set": {"force_password_reset": True, "updated_at": datetime.now(timezone.utc)}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"detail": "Password reset flag set"}


# ── Analytics / Overview ───────────────────────────────────────────────────────

@router.get("/stats")
def get_stats(current_user=_require_super):
    """
    Aggregated analytics for the Overview tab.
    All values are computed fresh on each request.
    """
    db = get_db()
    now = datetime.now(timezone.utc)
    in_30_days = now.replace(tzinfo=None) if False else (now.replace(hour=23, minute=59, second=59) if False else now)

    from datetime import timedelta
    in_30_days = now + timedelta(days=30)

    # ── Organizations ──
    total_orgs   = db["organizations"].count_documents({})
    active_orgs  = db["organizations"].count_documents({"status": "active"})
    expired_orgs = db["organizations"].count_documents({"status": "expired"})

    # Orgs expiring within the next 30 days (still active)
    expiring_soon = db["organizations"].count_documents({
        "status": "active",
        "end_date": {"$gte": now, "$lte": in_30_days},
    })

    # Orgs using ≥ 80% of their user cap
    near_cap_count = 0
    for org in db["organizations"].find({"status": "active"}, {"_id": 1, "user_cap": 1}):
        cap = org.get("user_cap", 0)
        if cap <= 0:
            continue
        used = db["users"].count_documents({
            "organization_id": str(org["_id"]),
            "status": {"$in": ["active", "suspended"]},
        })
        if used >= cap * 0.8:
            near_cap_count += 1

    # ── Users ──
    total_users        = db["users"].count_documents({})
    active_users       = db["users"].count_documents({"status": "active"})
    force_reset_pending = db["users"].count_documents({"force_password_reset": True})

    # ── Invitations ──
    pending_invites = db["invitations"].count_documents({"status": "pending"})

    return {
        # Organizations
        "total_orgs":    total_orgs,
        "active_orgs":   active_orgs,
        "expired_orgs":  expired_orgs,
        "expiring_soon": expiring_soon,
        "near_cap":      near_cap_count,
        # Users
        "total_users":         total_users,
        "active_users":        active_users,
        "force_reset_pending": force_reset_pending,
        # Invitations
        "pending_invites": pending_invites,
    }
