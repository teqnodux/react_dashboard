"""
When a new deal is inserted with deal_status Open or Unknown, add its id to
allowed_deal_ids on all active email recipients in active organizations.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from pymongo.errors import OperationFailure, PyMongoError

from config import MONGODB_URI
from db import get_db

logger = logging.getLogger(__name__)

_WATCHER_LOCK = threading.Lock()
_WATCHER_STARTED = False

_INSERT_ONLY_PIPELINE = [{"$match": {"operationType": "insert"}}]


def _is_open_or_unknown_deal_status(deal_status: Any) -> bool:
    """Match load_deals_summary_for_admin: Open + Unknown only (not Closed)."""
    if deal_status is None:
        return True
    s = str(deal_status).strip()
    if not s:
        return True
    lower = s.lower()
    return lower in ("open", "unknown")


def propagate_new_deal_to_recipients(deal_id: str, db=None) -> int:
    """
    Add deal_id to allowed_deal_ids for every active recipient in an active org.
    Returns the number of recipient documents modified.
    """
    if db is None:
        db = get_db()

    active_org_ids = [
        str(org["_id"])
        for org in db["organizations"].find({"status": "active"}, {"_id": 1})
    ]
    if not active_org_ids:
        return 0

    result = db["organization_email_recipients"].update_many(
        {
            "is_active": True,
            "organization_id": {"$in": active_org_ids},
        },
        {"$addToSet": {"allowed_deal_ids": deal_id}},
    )
    return result.modified_count


def _handle_new_deal(doc: dict) -> None:
    if not _is_open_or_unknown_deal_status(doc.get("deal_status")):
        logger.info(
            "[deal_access] skip deal _id=%s deal_status=%r (not Open/Unknown)",
            doc.get("_id"),
            doc.get("deal_status"),
        )
        return

    deal_id = str(doc["_id"])
    try:
        modified = propagate_new_deal_to_recipients(deal_id)
        logger.info(
            "[deal_access] propagated deal_id=%s to %d recipient(s)",
            deal_id,
            modified,
        )
        print(
            f"[deal_access] new deal {deal_id} → added to {modified} active recipient(s)",
            flush=True,
        )
    except Exception:
        logger.exception(
            "[deal_access] failed to propagate deal_id=%s to recipients", deal_id
        )


def _watch_loop() -> None:
    if not MONGODB_URI:
        logger.warning("MONGODB_URI unset — deal access change stream not started")
        return

    resume_token = None
    while True:
        try:
            coll = get_db()["deals"]
            kwargs: dict[str, Any] = {}
            if resume_token is not None:
                kwargs["resume_after"] = resume_token

            with coll.watch(_INSERT_ONLY_PIPELINE, **kwargs) as stream:
                logger.info(
                    "Mongo change stream ACTIVE on db=%s coll=deals (insert only)",
                    coll.database.name,
                )
                print(
                    "[deal_access] change stream READY — watching `deals` inserts "
                    "(Open/Unknown → all active recipients)",
                    flush=True,
                )
                for change in stream:
                    resume_token = change.get("_id")
                    doc = change.get("fullDocument")
                    if not doc:
                        logger.info(
                            "[deal_access] insert change with no fullDocument, skip"
                        )
                        continue
                    _handle_new_deal(doc)
        except OperationFailure as e:
            logger.warning(
                "deal access change stream OperationFailure (retrying in 5s): %s", e
            )
            time.sleep(5)
        except PyMongoError as e:
            logger.warning(
                "deal access change stream PyMongoError (retrying in 5s): %s", e
            )
            time.sleep(5)
        except Exception:
            logger.exception("deal access watcher error (retrying in 5s)")
            time.sleep(5)


def ensure_deal_access_watcher_started() -> None:
    global _WATCHER_STARTED
    with _WATCHER_LOCK:
        if _WATCHER_STARTED:
            return
        _WATCHER_STARTED = True
        threading.Thread(
            target=_watch_loop,
            name="mongodb-deal-access-change-stream",
            daemon=True,
        ).start()
        logger.info("Deal access change-stream watcher thread started (collection=deals)")
        print(
            "[deal_access] watcher started — insert-only on `deals` "
            "(Open/Unknown → active recipients)",
            flush=True,
        )
