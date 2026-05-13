"""
Super-admin routes — full system access.
All routes require role = super_admin.
"""

from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr

from auth import get_current_user, require_roles, hash_password, build_token_payload
from db import get_db
from services.org_service import get_org_or_404, org_to_dict, check_user_cap

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


@router.get("/orgs/{org_id}/users")
def list_org_users(org_id: str, current_user=_require_super):
    db = get_db()
    get_org_or_404(org_id, db)
    users = db["users"].find({"organization_id": org_id})
    return [_user_to_dict(u) for u in users]


# ── User management ───────────────────────────────────────────────────────────

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
