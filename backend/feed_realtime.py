"""Socket.IO broadcast driven by MongoDB change stream on the feed items collection."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime
from typing import Any

import socketio
from bson import ObjectId
from pymongo.errors import OperationFailure, PyMongoError

from config import FEED_ITEMS_COLLECTION, MONGODB_URI, SEC_FILING_SUMMARY_COLLECTION
from db import get_db, feed_item_has_deal_id
from sec_feed_enrichment import enrich_sec_summary_record

logger = logging.getLogger(__name__)


def _bootstrap_feed_logging() -> None:
    """Uvicorn leaves library loggers at default; INFO was never printed without a handler."""
    lg = logging.getLogger(__name__)
    lg.setLevel(logging.INFO)
    if not lg.handlers:
        h = logging.StreamHandler()
        h.setLevel(logging.INFO)
        h.setFormatter(
            logging.Formatter("[feed_realtime] %(levelname)s %(message)s")
        )
        lg.addHandler(h)
    lg.propagate = False


_bootstrap_feed_logging()

_WATCHER_LOCK = threading.Lock()
_WATCHER_STARTED = False
_emit_loop: asyncio.AbstractEventLoop | None = None


def set_feed_emit_event_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    global _emit_loop
    _emit_loop = loop


def _socket_io_cors_origins() -> list[str]:
    import os

    default = [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
    ]
    env_origins = [
        o.strip()
        for o in os.getenv("CORS_ORIGINS", "").split(",")
        if o.strip()
    ]
    return default + env_origins


sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=_socket_io_cors_origins(),
)


@sio.event
async def connect(sid, environ):
    logger.info("[feed_realtime] socket.io client connected sid=%s", sid)


@sio.event
async def disconnect(sid):
    logger.info("[feed_realtime] socket.io client disconnected sid=%s", sid)


def _json_safe(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def normalize_feed_document(doc: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in doc.items():
        if k == "_id":
            continue
        out[k] = _json_safe(v)
    oid = doc.get("_id")
    out["id"] = str(oid) if oid is not None else ""
    return out


_INSERT_ONLY = [{"$match": {"operationType": "insert"}}]


async def _emit_feed_created(body: dict[str, Any]) -> None:
    await sio.emit("feed_item_created", body)
    inner = body.get("data") or {}
    logger.info(
        "[feed_realtime] emitted feed_item_created id=%s title=%r",
        inner.get("id"),
        (inner.get("title") or "")[:80],
    )


def _schedule_feed_emit(body: dict[str, Any]) -> None:
    loop = _emit_loop
    if loop is None:
        logger.warning(
            "[feed_realtime] event loop unset — cannot emit feed_item_created"
        )
        return
    inner = body.get("data") or {}
    logger.info(
        "[feed_realtime] scheduling socket emit feed_item_created id=%s",
        inner.get("id"),
    )
    try:
        asyncio.run_coroutine_threadsafe(_emit_feed_created(body), loop)
    except Exception:
        logger.exception("failed to schedule feed emit")


def _watch_loop() -> None:
    if not MONGODB_URI:
        logger.warning("MONGODB_URI unset — feed change stream not started")
        return

    resume_token = None
    while True:
        try:
            coll = get_db()[FEED_ITEMS_COLLECTION]
            kwargs: dict[str, Any] = {}
            if resume_token is not None:
                kwargs["resume_after"] = resume_token

            with coll.watch(_INSERT_ONLY, **kwargs) as stream:
                logger.info(
                    "Mongo change stream ACTIVE on db=%s coll=%s (insert-only pipeline)",
                    coll.database.name,
                    FEED_ITEMS_COLLECTION,
                )
                print(
                    f"[feed_realtime] change stream READY — Deal_DB.`{FEED_ITEMS_COLLECTION}` "
                    "(insert webhook only if deal_id set)",
                    flush=True,
                )
                for change in stream:
                    resume_token = change.get("_id")
                    doc = change.get("fullDocument")
                    op = change.get("operationType")
                    if not doc:
                        logger.info(
                            "[feed_realtime] change stream op=%s (no fullDocument, skip)",
                            op,
                        )
                        continue
                    if not feed_item_has_deal_id(doc):
                        logger.info(
                            "[feed_realtime] insert skipped (missing/empty deal_id) _id=%s",
                            doc.get("_id"),
                        )
                        continue
                    payload = normalize_feed_document(doc)
                    logger.info(
                        "[feed_realtime] change stream insert _id=%s normalized_id=%s title=%r",
                        doc.get("_id"),
                        payload.get("id"),
                        (payload.get("title") or "")[:80],
                    )
                    print(
                        f"[feed_realtime] INSERT seen _id={doc.get('_id')} → emitting to Socket.IO clients",
                        flush=True,
                    )
                    _schedule_feed_emit({"message": "New feed item", "data": payload})
        except OperationFailure as e:
            logger.warning(
                "feed change stream OperationFailure (retrying in 5s): %s", e
            )
            time.sleep(5)
        except PyMongoError as e:
            logger.warning(
                "feed change stream PyMongoError (retrying in 5s): %s", e
            )
            time.sleep(5)
        except Exception:
            logger.exception("feed watcher error (retrying in 5s)")
            time.sleep(5)


def ensure_feed_watcher_started() -> None:
    global _WATCHER_STARTED
    with _WATCHER_LOCK:
        if _WATCHER_STARTED:
            return
        _WATCHER_STARTED = True
        threading.Thread(
            target=_watch_loop, name="mongodb-feed-change-stream", daemon=True
        ).start()
        logger.info(
            "Change-stream watcher thread started (collection=%s)",
            FEED_ITEMS_COLLECTION,
        )
        print(
            f"[feed_realtime] watcher started — watching `{FEED_ITEMS_COLLECTION}` "
            "(emits only when deal_id non-empty)",
            flush=True,
        )


_SEC_WATCHER_LOCK = threading.Lock()
_SEC_WATCHER_STARTED = False


async def _emit_sec_summary_created(body: dict[str, Any]) -> None:
    await sio.emit("sec_feed_item_created", body)
    inner = body.get("data") or {}
    logger.info(
        "[feed_realtime] emitted sec_feed_item_created id=%s form=%r company=%r",
        inner.get("id"),
        (inner.get("form_type") or "")[:32],
        (inner.get("company_name") or "")[:80],
    )


def _schedule_sec_summary_emit(body: dict[str, Any]) -> None:
    loop = _emit_loop
    if loop is None:
        logger.warning(
            "[feed_realtime] event loop unset — cannot emit sec_feed_item_created"
        )
        return
    inner = body.get("data") or {}
    logger.info(
        "[feed_realtime] scheduling sec_feed_item_created id=%s",
        inner.get("id"),
    )
    try:
        asyncio.run_coroutine_threadsafe(_emit_sec_summary_created(body), loop)
    except Exception:
        logger.exception("failed to schedule sec feed emit")


def _sec_summary_watch_loop() -> None:
    if not MONGODB_URI:
        logger.warning("MONGODB_URI unset — sec_filing_summary change stream not started")
        return

    resume_token = None
    while True:
        try:
            db = get_db()
            coll = db[SEC_FILING_SUMMARY_COLLECTION]
            kwargs: dict[str, Any] = {}
            if resume_token is not None:
                kwargs["resume_after"] = resume_token

            with coll.watch(_INSERT_ONLY, **kwargs) as stream:
                logger.info(
                    "Mongo change stream ACTIVE sec_filing_summary db=%s coll=%s",
                    coll.database.name,
                    SEC_FILING_SUMMARY_COLLECTION,
                )
                print(
                    f"[feed_realtime] sec_filing_summary stream READY — `{SEC_FILING_SUMMARY_COLLECTION}`",
                    flush=True,
                )
                for change in stream:
                    resume_token = change.get("_id")
                    doc = change.get("fullDocument")
                    op = change.get("operationType")
                    if not doc:
                        logger.info(
                            "[feed_realtime] sec change op=%s (no fullDocument, skip)",
                            op,
                        )
                        continue
                    payload = enrich_sec_summary_record(db, doc)
                    logger.info(
                        "[feed_realtime] sec_filing_summary insert id=%s form=%s cik=%s",
                        payload.get("id"),
                        payload.get("form_type"),
                        payload.get("cik_number"),
                    )
                    print(
                        f"[feed_realtime] SEC insert id={payload.get('id')} → Socket.IO",
                        flush=True,
                    )
                    _schedule_sec_summary_emit(
                        {"message": "New SEC filing", "data": payload}
                    )
        except OperationFailure as e:
            logger.warning(
                "sec_filing_summary change stream OperationFailure (retrying in 5s): %s",
                e,
            )
            time.sleep(5)
        except PyMongoError as e:
            logger.warning(
                "sec_filing_summary change stream PyMongoError (retrying in 5s): %s",
                e,
            )
            time.sleep(5)
        except Exception:
            logger.exception("sec_filing_summary watcher error (retrying in 5s)")
            time.sleep(5)


def ensure_sec_filing_summary_watcher_started() -> None:
    global _SEC_WATCHER_STARTED
    with _SEC_WATCHER_LOCK:
        if _SEC_WATCHER_STARTED:
            return
        _SEC_WATCHER_STARTED = True
        threading.Thread(
            target=_sec_summary_watch_loop,
            name="mongodb-sec-filing-summary-change-stream",
            daemon=True,
        ).start()
        logger.info(
            "SEC summary change-stream watcher started (collection=%s)",
            SEC_FILING_SUMMARY_COLLECTION,
        )
        print(
            f"[feed_realtime] sec watcher started — `{SEC_FILING_SUMMARY_COLLECTION}`",
            flush=True,
        )
