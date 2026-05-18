"""
One-time update: set created_at and updated_at on SAMR collections.

Copies `processed_at` into both fields as-is (same type and value — no parsing,
no use of `date`).

Only updates documents where `processed_at` exists and is not null or empty string.

Usage:
    cd backend
    python add_samr_created_updated_at.py

Requires MONGODB_URI (and optional .env next to config.py).
"""

from db import get_db

COLLECTIONS = ("samr_cases", "samr_conditional", "samr_unconditional")

_PIPELINE = [
    {
        "$set": {
            "created_at": "$processed_at",
            "updated_at": "$processed_at",
        }
    },
]


def migrate_collection(coll) -> tuple[int, int]:
    """Returns (matched_count, modified_count)."""
    result = coll.update_many(
        {"processed_at": {"$exists": True, "$nin": [None, ""]}},
        _PIPELINE,
    )
    return result.matched_count, result.modified_count


def main():
    db = get_db()
    total_matched = total_modified = 0
    for name in COLLECTIONS:
        matched, modified = migrate_collection(db[name])
        total_matched += matched
        total_modified += modified
        print(f"{name}: matched={matched}, modified={modified}")
    print(f"Done. Total matched={total_matched}, modified={total_modified}")


if __name__ == "__main__":
    main()
