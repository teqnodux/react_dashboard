"""
Organization business logic:
  - Status checks
  - User cap enforcement
  - Org expiry background job
"""

from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException


def get_org_or_404(org_id: str, db) -> dict:
    try:
        oid = ObjectId(org_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid organization ID")
    org = db["organizations"].find_one({"_id": oid})
    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")
    return org


def assert_org_active(org: dict):
    """Raise 403 if the org is not in active status."""
    if org.get("status") != "active":
        raise HTTPException(
            status_code=403,
            detail=f"Organization subscription is '{org['status']}' — access denied",
        )


def check_user_cap(org_id: str, db):
    """Raise 403 if the org has reached its user cap."""
    org = get_org_or_404(org_id, db)
    current_count = db["users"].count_documents({
        "organization_id": org_id,
        "status": {"$in": ["active", "invited"]},
    })
    cap = org.get("user_cap", 0)
    if current_count >= cap:
        raise HTTPException(
            status_code=403,
            detail=f"User cap of {cap} reached for this organization",
        )


def expire_organizations(db):
    """
    Mark organizations as 'expired' when their end_date has passed.
    Called by the APScheduler hourly job.
    """
    now = datetime.now(timezone.utc)
    result = db["organizations"].update_many(
        {"end_date": {"$lt": now}, "status": "active"},
        {"$set": {"status": "expired", "updated_at": now}},
    )
    if result.modified_count:
        import logging
        logging.getLogger(__name__).info(
            "Expired %d organization(s)", result.modified_count
        )


def org_to_dict(org: dict) -> dict:
    """Serialize a MongoDB org document for API responses."""
    return {
        "id": str(org["_id"]),
        "name": org.get("name"),
        "status": org.get("status"),
        "plan_name": org.get("plan_name"),
        "user_cap": org.get("user_cap"),
        "start_date": org.get("start_date").isoformat() if org.get("start_date") else None,
        "end_date": org.get("end_date").isoformat() if org.get("end_date") else None,
        "created_by_super_admin_id": str(org["created_by_super_admin_id"])
            if org.get("created_by_super_admin_id") else None,
        "created_at": org.get("created_at").isoformat() if org.get("created_at") else None,
        "updated_at": org.get("updated_at").isoformat() if org.get("updated_at") else None,
    }
