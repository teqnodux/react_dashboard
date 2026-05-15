# Feed Page — Real-Time Phasing Plan

## Overview

The unified `/feed` page merges three data sources into four tabs:

| Tab | Collection(s) | Live Update |
|---|---|---|
| All | `feed_items` + `sec_filing_summary` + 11 foreign collections | Phase 1 (press + SEC only) |
| Press Release | `feed_items` | Phase 1 ✅ |
| SEC Filing | `sec_filing_summary` | Phase 1 ✅ |
| Foreign Filing | 11 foreign collections (read below) | Phase 2 🔜 |

---

## Phase 1 — Scope (feed_items + sec_filing_summary only)

### What changes

#### Backend (`backend/feed_realtime.py`)

- **Change stream watcher for `feed_items`** (press releases)
  - Filters inserts where `deal_id` is non-empty
  - Emits Socket.IO event: `feed_item_created` with normalized document payload
  - Restarts automatically on `OperationFailure` / `PyMongoError`

- **Change stream watcher for `sec_filing_summary`**
  - Watches all inserts (no `deal_id` filter needed)
  - Enriches the document with company name via `enrich_sec_summary_record`
  - Emits Socket.IO event: `sec_feed_item_created` with enriched payload
  - Restarts automatically on errors

Both watchers are started at FastAPI startup from `main.py` via:
```python
ensure_feed_watcher_started()
ensure_sec_filing_summary_watcher_started()
```

#### Backend (`backend/unified_feed.py`)

- REST endpoint `/api/feed` supports query params: `tab`, `page`, `page_size`
- `tab=press` → paginated from `feed_items`, sorted by `date_published`
- `tab=sec` → paginated from `sec_filing_summary`, sorted by `filing_date`
- `tab=foreign` → fetches all 11 foreign collections, merges and sorts in Python, then slices (no live updates, just REST)
- `tab=all` → merges all three sources in memory, sorted by timestamp

#### Frontend (`frontend/src/services/feedRealtime.ts`)

- Single Socket.IO connection to backend
- Listens for `feed_item_created` → calls `onFeedItem` callback
- Listens for `sec_feed_item_created` → calls `onSecFeedItem` callback

#### Frontend (`frontend/src/context/FeedLiveContext.tsx`)

- `FeedLiveProvider` wraps the app with a single shared socket connection
- On `feed_item_created`: dispatches `dashboard:news-feed-item` window event + shows toast ("News Feed")
- On `sec_feed_item_created`: dispatches `dashboard:sec-feed-item` window event + shows toast ("SEC Feed")

#### Frontend (`frontend/src/pages/Feed.tsx`)

- Listens to `dashboard:news-feed-item` window event
  - Prepends new press release card to the list if `activeTab` is `all` or `press`
- Listens to `dashboard:sec-feed-item` window event
  - Prepends new SEC filing card to the list if `activeTab` is `all` or `sec`
- Scroll pagination works for all four tabs
- Connection indicator dot shown in the header (green = connected)

### What is NOT in Phase 1

- No change stream for any of the 11 foreign filing collections
- No Socket.IO event for foreign filings
- Foreign Filing tab data is static until user scrolls (REST + pagination only)

---

## Phase 2 — Foreign Filing Live Updates (deferred)

> To be designed and implemented separately after Phase 1 is confirmed stable.

### Anticipated scope

- Add a change stream watcher for each (or a representative set) of the 11 foreign collections:
  ```
  accc_cases, brazil_cases, canada_cases, ec_cases, fs_cases,
  german_cases, nz_cases, samr_cases, samr_conditional, samr_unconditional, uk_cma_cases
  ```
- Emit a new Socket.IO event: `foreign_filing_created` (or per-collection event)
- `FeedLiveContext` handles the new event → dispatches `dashboard:foreign-filing-item` window event + shows toast ("Foreign Filing")
- `Feed.tsx` listens and prepends the new card to the list when `activeTab` is `all` or `foreign`

### Key considerations for Phase 2

1. **11 collections = 11 change streams** — may need a combined watcher loop or a single oplog-level watch to reduce connection overhead
2. **No `deal_id` filter needed** — foreign filing collections don't use `deal_id`
3. **Toast design** — use `flag + source_label + title` for the toast heading
4. **Deduplication** — same logic as press/SEC: skip if `id` already in the list

---

## Foreign Filing Collections Reference

| Collection | Label | Country |
|---|---|---|
| `accc_cases` | ACCC | Australia |
| `brazil_cases` | CADE | Brazil |
| `canada_cases` | Competition Bureau | Canada |
| `ec_cases` | European Commission | EU |
| `fs_cases` | Foreign Subsidies | EU |
| `german_cases` | Bundeskartellamt | Germany |
| `nz_cases` | NZCC | New Zealand |
| `samr_cases` | SAMR | China |
| `samr_conditional` | SAMR Conditional | China |
| `samr_unconditional` | SAMR Unconditional | China |
| `uk_cma_cases` | CMA | United Kingdom |

All 11 collections are fetched via REST in `unified_feed.py` and shown in the Foreign Filing tab. Phase 1 does not add change streams for any of these.

---

## Summary: Files Affected in Phase 1

| File | Change |
|---|---|
| `backend/feed_realtime.py` | Add `sec_filing_summary` watcher + `ensure_sec_filing_summary_watcher_started()` |
| `backend/unified_feed.py` | New file — REST handler for `/api/feed` |
| `backend/foreign_collections.py` | New file — shared list of 11 foreign collection names/labels/countries |
| `backend/main.py` | Wire up both watchers at startup; add `/api/feed` route |
| `frontend/src/services/feedRealtime.ts` | Update — listen to both `feed_item_created` and `sec_feed_item_created` |
| `frontend/src/context/FeedLiveContext.tsx` | Update — handle SEC event, dispatch window event + toast |
| `frontend/src/pages/Feed.tsx` | New file — unified 4-tab feed page with live prepend for press + SEC |
| `frontend/src/App.tsx` | Add `/feed` route |
| `frontend/src/config/roleConfig.ts` | Add Feed nav item to role config |
