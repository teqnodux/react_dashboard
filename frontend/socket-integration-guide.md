## Real-time dashboards (news + SEC)

**News:** backend watches **`feed_items`** (`FEED_ITEMS_COLLECTION` in `backend/config.py`; inserts emit only when `deal_id` is set — see `backend/db.py`). Socket.IO **`feed_item_created`**; REST **`/api/news-feed`** uses the same Mongo filter.

**SEC:** **`sec_filing_summary`** (`SEC_FILING_SUMMARY_COLLECTION`). REST **`/api/sec-feed`** adds **`company_name`** by **`deals` + deal_id**, matching filing **`cik_number`** to **`cik`** vs **`acquirer_cik`** (`backend/sec_feed_enrichment.py`). Inserts broadcast **`sec_feed_item_created`** (no extra webhook filter).

**Frontend:** **`FeedLiveProvider`** (under **`ProtectedRoute`**) shares one Socket.IO client (`feedRealtime.ts`). Global toasts; **`dashboard:news-feed-item`** / **`dashboard:sec-feed-item`** drive **`NewsFeed.tsx`** / **`SecFeed.tsx`** prepends.
