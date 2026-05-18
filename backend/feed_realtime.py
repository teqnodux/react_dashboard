"""Socket.IO broadcast driven by MongoDB change streams (insert/update/replace)."""

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
from foreign_collections import FOREIGN_COLLECTIONS
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


def normalize_foreign_feed_document(
    doc: dict, coll_name: str, label: str, country: str
) -> dict[str, Any]:
    """Same shape as `unified_feed._fetch_foreign_collection_batch` rows (JSON-safe)."""
    out = normalize_feed_document(doc)
    out["feed_type"] = "foreign_filing"
    out["source"] = coll_name
    out["source_label"] = label
    out["country"] = country
    return out


_FOREIGN_COLL_NAMES = [c for c, _, _ in FOREIGN_COLLECTIONS]
_FOREIGN_META = {c: (lbl, ct) for c, lbl, ct in FOREIGN_COLLECTIONS}


_CHANGE_STREAM_OPS = [
    {"$match": {"operationType": {"$in": ["insert", "update", "replace"]}}}
]

_WATCH_KWARGS: dict[str, Any] = {"full_document": "updateLookup"}


def _foreign_db_watch_pipeline(db_name: str) -> list[dict[str, Any]]:
    return [
        {
            "$match": {
                "operationType": {"$in": ["insert", "update", "replace"]},
                "ns.db": db_name,
                "ns.coll": {"$in": _FOREIGN_COLL_NAMES},
            }
        }
    ]


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
            kwargs: dict[str, Any] = dict(_WATCH_KWARGS)
            if resume_token is not None:
                kwargs["resume_after"] = resume_token

            with coll.watch(_CHANGE_STREAM_OPS, **kwargs) as stream:
                logger.info(
                    "Mongo change stream ACTIVE on db=%s coll=%s "
                    "(insert/update/replace, fullDocument=updateLookup)",
                    coll.database.name,
                    FEED_ITEMS_COLLECTION,
                )
                print(
                    f"[feed_realtime] change stream READY — Deal_DB.`{FEED_ITEMS_COLLECTION}` "
                    "(emit when deal_id non-empty)",
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
                            "[feed_realtime] change skipped (missing/empty deal_id) op=%s _id=%s",
                            op,
                            doc.get("_id"),
                        )
                        continue
                    payload = normalize_feed_document(doc)
                    logger.info(
                        "[feed_realtime] change stream op=%s _id=%s normalized_id=%s title=%r",
                        op,
                        doc.get("_id"),
                        payload.get("id"),
                        (payload.get("title") or "")[:80],
                    )
                    print(
                        f"[feed_realtime] {str(op or '').upper()} seen _id={doc.get('_id')} → emitting to Socket.IO clients",
                        flush=True,
                    )
                    _schedule_feed_emit(
                        {"message": "New feed item", "data": payload})
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
        logger.warning(
            "MONGODB_URI unset — sec_filing_summary change stream not started")
        return

    resume_token = None
    while True:
        try:
            db = get_db()
            coll = db[SEC_FILING_SUMMARY_COLLECTION]
            kwargs: dict[str, Any] = dict(_WATCH_KWARGS)
            if resume_token is not None:
                kwargs["resume_after"] = resume_token

            with coll.watch(_CHANGE_STREAM_OPS, **kwargs) as stream:
                logger.info(
                    "Mongo change stream ACTIVE sec_filing_summary db=%s coll=%s "
                    "(insert/update/replace, fullDocument=updateLookup)",
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
                        "[feed_realtime] sec_filing_summary op=%s id=%s form=%s cik=%s",
                        op,
                        payload.get("id"),
                        payload.get("form_type"),
                        payload.get("cik_number"),
                    )
                    print(
                        f"[feed_realtime] SEC {op} id={payload.get('id')} → Socket.IO",
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
            logger.exception(
                "sec_filing_summary watcher error (retrying in 5s)")
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


_FOREIGN_WATCHER_LOCK = threading.Lock()
_FOREIGN_WATCHER_STARTED = False


async def _emit_foreign_feed_created(body: dict[str, Any]) -> None:
    await sio.emit("foreign_feed_item_created", body)
    inner = body.get("data") or {}
    logger.info(
        "[feed_realtime] emitted foreign_feed_item_created id=%s source=%r label=%r",
        inner.get("id"),
        inner.get("source"),
        inner.get("source_label"),
    )


def _schedule_foreign_feed_emit(body: dict[str, Any]) -> None:
    loop = _emit_loop
    if loop is None:
        logger.warning(
            "[feed_realtime] event loop unset — cannot emit foreign_feed_item_created"
        )
        return
    inner = body.get("data") or {}
    logger.info(
        "[feed_realtime] scheduling foreign_feed_item_created id=%s",
        inner.get("id"),
    )
    try:
        asyncio.run_coroutine_threadsafe(_emit_foreign_feed_created(body), loop)
    except Exception:
        logger.exception("failed to schedule foreign feed emit")


def _foreign_feed_watch_loop() -> None:
    if not MONGODB_URI:
        logger.warning(
            "MONGODB_URI unset — foreign filing change stream not started"
        )
        return

    resume_token = None
    while True:
        try:
            db = get_db()
            pipeline = _foreign_db_watch_pipeline(db.name)
            kwargs: dict[str, Any] = dict(_WATCH_KWARGS)
            if resume_token is not None:
                kwargs["resume_after"] = resume_token

            with db.watch(pipeline, **kwargs) as stream:
                logger.info(
                    "Mongo change stream ACTIVE foreign filings db=%s "
                    "(collections=%s, insert/update/replace, fullDocument=updateLookup)",
                    db.name,
                    len(_FOREIGN_COLL_NAMES),
                )
                print(
                    "[feed_realtime] foreign DB-level stream READY — "
                    f"{len(_FOREIGN_COLL_NAMES)} regulatory collections",
                    flush=True,
                )
                for change in stream:
                    resume_token = change.get("_id")
                    doc = change.get("fullDocument")
                    op = change.get("operationType")
                    ns = change.get("ns") or {}
                    coll_name = ns.get("coll")
                    if not coll_name or coll_name not in _FOREIGN_META:
                        continue
                    label, country = _FOREIGN_META[coll_name]
                    if not doc:
                        logger.info(
                            "[feed_realtime] foreign change op=%s coll=%s (no fullDocument, skip)",
                            op,
                            coll_name,
                        )
                        continue
                    if not feed_item_has_deal_id(doc):
                        logger.info(
                            "[feed_realtime] foreign change skipped (missing/empty deal_id) "
                            "op=%s coll=%s _id=%s",
                            op,
                            coll_name,
                            doc.get("_id"),
                        )
                        continue
                    payload = normalize_foreign_feed_document(
                        doc, coll_name, label, country
                    )
                    logger.info(
                        "[feed_realtime] foreign op=%s coll=%s id=%s label=%s",
                        op,
                        coll_name,
                        payload.get("id"),
                        label,
                    )
                    print(
                        f"[feed_realtime] FOREIGN {op} {coll_name} id={payload.get('id')} → Socket.IO",
                        flush=True,
                    )
                    _schedule_foreign_feed_emit(
                        {"message": "Foreign filing update", "data": payload}
                    )
        except OperationFailure as e:
            logger.warning(
                "foreign feed change stream OperationFailure (retrying in 5s): %s",
                e,
            )
            time.sleep(5)
        except PyMongoError as e:
            logger.warning(
                "foreign feed change stream PyMongoError (retrying in 5s): %s",
                e,
            )
            time.sleep(5)
        except Exception:
            logger.exception("foreign feed watcher error (retrying in 5s)")
            time.sleep(5)


def ensure_foreign_feed_watcher_started() -> None:
    global _FOREIGN_WATCHER_STARTED
    with _FOREIGN_WATCHER_LOCK:
        if _FOREIGN_WATCHER_STARTED:
            return
        _FOREIGN_WATCHER_STARTED = True
        threading.Thread(
            target=_foreign_feed_watch_loop,
            name="mongodb-foreign-feed-change-stream",
            daemon=True,
        ).start()
        logger.info(
            "Foreign filing DB change-stream watcher started (%s collections)",
            len(_FOREIGN_COLL_NAMES),
        )
        print(
            "[feed_realtime] foreign watcher started — DB-level stream "
            f"({len(_FOREIGN_COLL_NAMES)} collections, deal_id required)",
            flush=True,
        )
