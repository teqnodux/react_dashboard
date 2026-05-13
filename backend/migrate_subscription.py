"""
One-time migration script — run ONCE before deploying the subscription system.

Steps performed:
  1. Add missing fields to existing user documents
  2. Create MongoDB indexes for new collections
  3. Print instructions for manually promoting the first super_admin

Usage:
    cd backend
    python migrate_subscription.py
"""

from datetime import datetime, timezone
from pymongo import ASCENDING
from db import get_db, get_users_col


def migrate():
    db = get_db()
    users = get_users_col()
    now = datetime.now(timezone.utc)

    print("── Step 1: Migrate existing users ─────────────────────────────────")

    # Existing "admin" → role="admin", is_individual=False
    r = users.update_many(
        {"role": "admin", "organization_id": {"$exists": False}},
        {"$set": {
            "role": "admin",
            "is_individual": False,
            "status": "active",
            "force_password_reset": False,
            "organization_id": None,
            "updated_at": now,
        }, "$setOnInsert": {"created_at": now}},
    )
    print(f"  admin users updated: {r.modified_count}")

    # Existing "user" / "viewer" → role="user", is_individual=True
    r = users.update_many(
        {"role": {"$in": ["user", "viewer"]}, "organization_id": {"$exists": False}},
        {"$set": {
            "role": "user",
            "is_individual": True,
            "status": "active",
            "force_password_reset": False,
            "organization_id": None,
            "updated_at": now,
        }},
    )
    print(f"  user/viewer users updated: {r.modified_count}")

    # Any user that has no role at all
    r = users.update_many(
        {"role": {"$exists": False}},
        {"$set": {
            "role": "user",
            "is_individual": True,
            "status": "active",
            "force_password_reset": False,
            "organization_id": None,
            "updated_at": now,
        }},
    )
    print(f"  role-less users updated: {r.modified_count}")

    print("\n── Step 2: Create indexes ──────────────────────────────────────────")

    # users
    users.create_index("email", unique=True)
    users.create_index("organization_id")
    print("  users: email (unique), organization_id")

    # organizations
    orgs = db["organizations"]
    orgs.create_index("status")
    orgs.create_index("end_date")
    print("  organizations: status, end_date")

    # invitations — keep expired docs for 30 days so admins can see/resend them
    invitations = db["invitations"]
    invitations.create_index("token", unique=True)
    # Drop the old zero-second TTL if it exists, then create a 30-day one
    try:
        invitations.drop_index("expires_at_1")
    except Exception:
        pass
    invitations.create_index("expires_at", expireAfterSeconds=2592000)  # 30 days after expires_at
    print("  invitations: token (unique), expires_at (TTL 30 days)")

    # password_reset_tokens — TTL index auto-deletes expired docs
    pw_tokens = db["password_reset_tokens"]
    pw_tokens.create_index("expires_at", expireAfterSeconds=0)
    print("  password_reset_tokens: expires_at (TTL)")

    # email recipients
    recipients = db["organization_email_recipients"]
    recipients.create_index([("organization_id", ASCENDING), ("email", ASCENDING)], unique=True)
    print("  organization_email_recipients: (organization_id, email) unique")

    print("\n── Step 3: Manual action required ─────────────────────────────────")
    print("  Run this in the mongo shell to promote your first super_admin:")
    print('  db.users.update_one({ "email": "YOUR_EMAIL" }, { $set: { "role": "super_admin", "is_individual": false } })')

    print("\n✓ Migration complete.")


if __name__ == "__main__":
    migrate()
