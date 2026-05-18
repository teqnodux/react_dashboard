import { useState, useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import DashboardNav from "../components/DashboardNav";
import {
  DASHBOARD_FOREIGN_FEED_ITEM,
  DASHBOARD_NEWS_FEED_ITEM,
  DASHBOARD_SEC_FEED_ITEM,
  useFeedSocketConnected,
  type NewsFeedItemDetail
} from "../context/FeedLiveContext";
import { formatFeedPublishedLabel } from "../utils/feedFormatting";
import { hasNonEmptyDealId } from "../utils/dealId";
import api from "../services/api";
import "../styles/Feed.css";
import "../styles/ForeignFilingsTab.css";

// ─── Types ────────────────────────────────────────────────────────────────────

type TabKey = "all" | "sec" | "press" | "foreign";
// foreign filing source:
// accc_cases, brazil_cases, canada_cases, ec_cases, fs_cases, german_cases, nz_cases, samr_cases, samr_conditional, samr_unconditional, uk_cma_cases

interface FeedItem {
  id: string;
  feed_type: "sec_filing" | "press_release" | "foreign_filing";
  // press release fields
  title?: string;
  description_text?: string;
  url?: string;
  thumbnail?: string;
  source?: string;
  authors?: { name: string }[];
  date_published?: string;
  // SEC filing fields
  company_name?: string;
  cik_number?: string;
  form_type?: string;
  filing_date?: string;
  accession_number?: string;
  link?: string;
  // foreign filing fields
  source_label?: string;
  country?: string;
  updated_at?: string;
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "sec", label: "SEC Filing" },
  { key: "press", label: "Press Release" },
  { key: "foreign", label: "Foreign Filing" }
];

const FORM_TYPE_COLORS: Record<string, string> = {
  "8-K": "badge-blue",
  "8-K/": "badge-blue",
  "10-K": "badge-green",
  "10-K/": "badge-green",
  "10-Q": "badge-yellow",
  "PRE 14A": "badge-purple",
  "DEF 14A": "badge-indigo"
};

const FLAG: Record<string, string> = {
  Australia: "🇦🇺",
  Brazil: "🇧🇷",
  Canada: "🇨🇦",
  EU: "🇪🇺",
  Germany: "🇩🇪",
  "New Zealand": "🇳🇿",
  China: "🇨🇳",
  "United Kingdom": "🇬🇧",
  "United States": "🇺🇸"
};

// ─── Type colors / icons (MongoFeedTab style) ─────────────────────────────────

const TYPE_ICON: Record<string, string> = {
  sec_filing: "■",
  press_release: "●",
  foreign_filing: "◆"
};

const TYPE_COLOR: Record<string, string> = {
  sec_filing: "var(--accent-blue)",
  press_release: "var(--accent-yellow)",
  foreign_filing: "var(--accent-green)"
};

const TYPE_LABEL: Record<string, string> = {
  sec_filing: "SEC Filing",
  press_release: "Press Release",
  foreign_filing: "Foreign Filing"
};

/** SAMR rows sort/filter on `processed_at` in unified_feed — mirror for live events */
const SAMR_SOURCES = new Set([
  "samr_cases",
  "samr_conditional",
  "samr_unconditional"
]);

// ─── Foreign filing helpers ───────────────────────────────────────────────────

function getRecordTitle(source: string, r: FeedItem): string {
  switch (source) {
    case "accc_cases":
      return (r.title as string) || "";
    case "brazil_cases":
      return (r.interessados_en as string) || (r.interessados as string) || "";
    case "canada_cases":
      return (r.parties as string) || "";
    case "ec_cases":
    case "fs_cases":
      return (r.case_title as string) || "";
    case "ftc_cases":
      return (r.title as string) || (r.case_title as string) || "";
    case "german_cases":
      return (r.pursue_en as string) || (r.pursue as string) || "";
    case "nz_cases":
      return (r.title as string) || "";
    case "samr_cases":
    case "samr_conditional":
    case "samr_unconditional":
      return (r.title_en as string) || (r.title_cn as string) || "";
    case "uk_cma_cases":
      return (r.title as string) || "";
    default:
      return "";
  }
}

function getRecordUrl(source: string, r: FeedItem): string | null {
  switch (source) {
    case "accc_cases":
    case "samr_cases":
    case "samr_conditional":
    case "samr_unconditional":
      return (r.url as string) || null;
    case "brazil_cases":
      return (r.detail_url as string) || null;
    case "ec_cases":
    case "fs_cases":
      return (r.case_url as string) || null;
    case "ftc_cases":
      return (r.url as string) || (r.detail_url as string) || null;
    case "nz_cases":
    case "uk_cma_cases":
      return (r.detail_url as string) || null;
    default:
      return null;
  }
}

function getRecordStatus(
  source: string,
  r: FeedItem
): { text: string; open: boolean } | null {
  switch (source) {
    case "accc_cases": {
      const status = r.status as Record<string, unknown> | undefined;
      const text =
        (status?.accc_determination as string) ||
        (r.acquisition_status as string) ||
        "";
      return text ? { text, open: (r.is_open as boolean) ?? true } : null;
    }
    case "brazil_cases":
      return r.type_en
        ? {
            text: r.type_en as string,
            open: r.is_open === "True" || r.is_open === true
          }
        : null;
    case "canada_cases":
      return r.outcome
        ? { text: r.outcome as string, open: r.is_open === true }
        : null;
    case "ec_cases":
    case "fs_cases":
      return r.status
        ? { text: r.status as string, open: r.is_open !== false }
        : null;
    case "german_cases":
      return r.diploma_en
        ? { text: r.diploma_en as string, open: r.is_open === true }
        : null;
    case "nz_cases":
      return r.status
        ? { text: r.status as string, open: r.is_open !== false }
        : null;
    case "samr_cases":
      return { text: r.is_open ? "Open" : "Closed", open: r.is_open === true };
    case "uk_cma_cases": {
      const text = r.case_state
        ? r.outcome
          ? `${r.case_state} — ${r.outcome}`
          : (r.case_state as string)
        : "";
      return text ? { text, open: r.case_state === "Open" } : null;
    }
    default:
      return null;
  }
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

const badgeClass = (formType?: string) =>
  FORM_TYPE_COLORS[formType ?? ""] ?? "badge-default";

const formatDate = (d?: string | null) => {
  if (!d) return "N/A";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
};

function parseTimeMs(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const t = new Date(String(raw)).getTime();
  return Number.isNaN(t) ? null : t;
}

function withinDaysWindow(updatedAtRaw: unknown, daysStr: string): boolean {
  const days = parseInt(daysStr, 10);
  if (!days || days < 1) return true;
  const t = parseTimeMs(updatedAtRaw);
  if (t === null) return false;
  const cutoff = Date.now() - days * 86400000;
  return t >= cutoff;
}

function matchesSearchHaystack(item: FeedItem, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const parts = [
    item.title,
    item.company_name,
    item.description_text,
    item.source,
    item.source_label,
    item.country,
    item.form_type,
    item.accession_number
  ].filter(Boolean) as string[];
  if (item.feed_type === "foreign_filing" && typeof item.source === "string") {
    const ft = getRecordTitle(item.source, item);
    if (ft) parts.push(ft);
  }
  const hay = parts.join(" ").toLowerCase();
  return hay.includes(needle);
}

function livePressMatchesFilters(item: FeedItem, daysStr: string, q: string): boolean {
  return (
    withinDaysWindow(item.updated_at, daysStr) && matchesSearchHaystack(item, q)
  );
}

function liveSecMatchesFilters(item: FeedItem, daysStr: string, q: string): boolean {
  return (
    withinDaysWindow(item.updated_at, daysStr) && matchesSearchHaystack(item, q)
  );
}

function foreignLiveSortTimestamp(item: FeedItem): unknown {
  const src = typeof item.source === "string" ? item.source : "";
  if (SAMR_SOURCES.has(src)) {
    return item.processed_at ?? item.updated_at;
  }
  return item.updated_at ?? item.processed_at;
}

function liveForeignMatchesFilters(item: FeedItem, daysStr: string, q: string): boolean {
  return (
    withinDaysWindow(foreignLiveSortTimestamp(item), daysStr) &&
    matchesSearchHaystack(item, q)
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Feed() {
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [hasNext, setHasNext] = useState(false);
  const [dateRange, setDateRange] = useState<string>("1");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextCursorRef = useRef<string | null>(null);
  const dateRangeRef = useRef<string>("1");
  const debouncedSearchRef = useRef<string>("");
  const connected = useFeedSocketConnected();

  useEffect(() => {
    dateRangeRef.current = dateRange;
  }, [dateRange]);
  useEffect(() => {
    debouncedSearchRef.current = debouncedSearch;
  }, [debouncedSearch]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const fetchFeed = useCallback(
    async (opts: { append: boolean; tab: TabKey; days: string; q: string }) => {
      const { append, tab, days, q } = opts;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        nextCursorRef.current = null;
      }
      try {
        const params = new URLSearchParams({
          tab,
          page_size: "20",
          days
        });
        if (q.trim()) params.set("search", q.trim());
        if (append && nextCursorRef.current) {
          params.set("cursor", nextCursorRef.current);
        }
        const { data } = await api.get(`/api/feed?${params.toString()}`);
        const newItems: FeedItem[] = data.items ?? [];
        nextCursorRef.current =
          typeof data.next_cursor === "string" ? data.next_cursor : null;
        if (append) {
          setItems((prev) => {
            const existingIds = new Set(prev.map((i) => i.id));
            return [...prev, ...newItems.filter((i) => !existingIds.has(i.id))];
          });
        } else {
          setItems(newItems);
        }
        setHasNext(Boolean(data.has_next));
        setError("");
      } catch {
        setError("Failed to load feed");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchFeed({
      append: false,
      tab: activeTab,
      days: dateRange,
      q: debouncedSearch
    });
  }, [activeTab, dateRange, debouncedSearch, fetchFeed]);

  const selectTab = (key: TabKey) => {
    setActiveTab(key);
    setDateRange("1");
    setSearch("");
    setDebouncedSearch("");
  };

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || !hasNext || !nextCursorRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      fetchFeed({
        append: true,
        tab: activeTab,
        days: dateRange,
        q: debouncedSearch
      });
    }
  }, [fetchFeed, loadingMore, hasNext, activeTab, dateRange, debouncedSearch]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const onItem = (ev: Event) => {
      if (activeTab !== "all" && activeTab !== "press") return;
      const e = ev as CustomEvent<NewsFeedItemDetail>;
      const detail = e.detail;
      const id =
        typeof detail?.id === "string" && detail.id
          ? detail.id
          : String(detail["_id"] ?? "");
      if (!id) return;
      if (!hasNonEmptyDealId(detail as Record<string, unknown>)) return;
      const item = {
        ...detail,
        id,
        feed_type: "press_release" as const
      } as FeedItem;
      if (!livePressMatchesFilters(item, dateRangeRef.current, debouncedSearchRef.current))
        return;
      flushSync(() => {
        setItems((prev) => {
          const rest = prev.filter((p) => p.id !== id);
          return [item, ...rest];
        });
      });
    };
    window.addEventListener(DASHBOARD_NEWS_FEED_ITEM, onItem);
    return () => window.removeEventListener(DASHBOARD_NEWS_FEED_ITEM, onItem);
  }, [activeTab]);

  useEffect(() => {
    const onItem = (ev: Event) => {
      if (activeTab !== "all" && activeTab !== "sec") return;
      const e = ev as CustomEvent<Record<string, unknown>>;
      const detail = e.detail;
      const id =
        typeof detail?.id === "string" && detail.id
          ? detail.id
          : String(detail["_id"] ?? "");
      if (!id) return;
      const row = {
        ...detail,
        id,
        feed_type: "sec_filing" as const
      } as FeedItem;
      if (!liveSecMatchesFilters(row, dateRangeRef.current, debouncedSearchRef.current))
        return;
      flushSync(() => {
        setItems((prev) => {
          const rest = prev.filter((x) => x.id !== id);
          return [row, ...rest];
        });
      });
    };
    window.addEventListener(DASHBOARD_SEC_FEED_ITEM, onItem);
    return () => window.removeEventListener(DASHBOARD_SEC_FEED_ITEM, onItem);
  }, [activeTab]);

  useEffect(() => {
    const onItem = (ev: Event) => {
      if (activeTab !== "all" && activeTab !== "foreign") return;
      const e = ev as CustomEvent<Record<string, unknown>>;
      const detail = e.detail;
      const id =
        typeof detail?.id === "string" && detail.id
          ? detail.id
          : String(detail["_id"] ?? "");
      if (!id) return;
      if (!hasNonEmptyDealId(detail as Record<string, unknown>)) return;
      const row = {
        ...detail,
        id,
        feed_type: "foreign_filing" as const
      } as FeedItem;
      if (
        !liveForeignMatchesFilters(row, dateRangeRef.current, debouncedSearchRef.current)
      )
        return;
      flushSync(() => {
        setItems((prev) => {
          const rest = prev.filter((x) => x.id !== id);
          return [row, ...rest];
        });
      });
    };
    window.addEventListener(DASHBOARD_FOREIGN_FEED_ITEM, onItem);
    return () => window.removeEventListener(DASHBOARD_FOREIGN_FEED_ITEM, onItem);
  }, [activeTab]);

  // ─── Row renderers (MongoFeedTab style) ───────────────────────────────────

  const renderPressRow = (item: FeedItem) => (
    <div
      key={item.id}
      className="feed-item"
      onClick={() => item.url && window.open(item.url, "_blank")}
    >
      <span
        className="feed-item-icon"
        style={{ color: TYPE_COLOR.press_release }}
      >
        {TYPE_ICON.press_release}
      </span>
      <div className="feed-item-content">
        <div className="feed-item-header">
          <span className="feed-item-title">
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {item.title || "Untitled"}
              </a>
            ) : (
              item.title || "Untitled"
            )}
          </span>
          <span
            className="feed-type-badge"
            style={{ color: TYPE_COLOR.press_release }}
          >
            {TYPE_LABEL.press_release}
          </span>
        </div>
        {item.description_text && (
          <div className="feed-item-headline">
            {item.description_text.split(" -- ")[1] ?? item.description_text}
          </div>
        )}
        <span className="feed-item-source">
          {item.source}
          {item.updated_at && (
            <span> · Updated {formatFeedPublishedLabel(item.updated_at)}</span>
          )}
          {item.date_published && !item.updated_at && (
            <span> · {formatFeedPublishedLabel(item.date_published)}</span>
          )}
        </span>
      </div>
      <div className="feed-item-date">
        {formatDate((item.updated_at as string) || item.date_published)}
      </div>
    </div>
  );

  const renderSecRow = (item: FeedItem) => (
    <div
      key={item.id}
      className="feed-item"
      onClick={() => item.link && window.open(item.link, "_blank")}
    >
      <span className="feed-item-icon" style={{ color: TYPE_COLOR.sec_filing }}>
        {TYPE_ICON.sec_filing}
      </span>
      <div className="feed-item-content">
        <div className="feed-item-header">
          <span className="feed-item-title">
            {item.link ? (
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {item.company_name ?? "Unknown"}
              </a>
            ) : (
              (item.company_name ?? "Unknown")
            )}
          </span>
          <span className={`form-badge ${badgeClass(item.form_type)}`}>
            {item.form_type ?? "—"}
          </span>
        </div>
        <span className="feed-item-source">
          CIK: {item.cik_number ?? "—"}
          {item.updated_at && (
            <span> · Updated {formatFeedPublishedLabel(item.updated_at)}</span>
          )}
          {item.filing_date && (
            <span> · Filed {formatFeedPublishedLabel(item.filing_date)}</span>
          )}
          {item.accession_number && <span> · {item.accession_number}</span>}
        </span>
      </div>
      <div className="feed-item-date">
        {formatDate((item.updated_at as string) || item.filing_date)}
      </div>
    </div>
  );

  const renderForeignRow = (item: FeedItem) => {
    const src = (item.source as string) ?? "";
    const title = getRecordTitle(src, item);
    const url = getRecordUrl(src, item);
    const status = getRecordStatus(src, item);
    const flag = FLAG[item.country ?? ""] ?? "🌐";
    const isSamr =
      src === "samr_cases" ||
      src === "samr_conditional" ||
      src === "samr_unconditional";
    const sortTs = (isSamr ? item.processed_at : item.updated_at) as
      | string
      | undefined;

    return (
      <div
        key={item.id}
        className="feed-item"
        onClick={() => url && window.open(url, "_blank")}
      >
        <span className="feed-item-icon">{flag}</span>
        <div className="feed-item-content">
          <div className="feed-item-header">
            <span className="feed-item-title">
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {title || "Untitled"}
                </a>
              ) : (
                title || "Untitled"
              )}
            </span>
            {item.source_label && (
              <span
                className="feed-type-badge"
                style={{ color: TYPE_COLOR.foreign_filing }}
              >
                {item.source_label}
              </span>
            )}
            {status && (
              <span
                className={`ff-status-badge ${status.open ? "open" : "closed"}`}
              >
                {status.text}
              </span>
            )}
          </div>
          <span className="feed-item-source">
            {item.country}
            {sortTs && (
              <span>
                {" "}
                · {isSamr ? "Processed " : "Updated "}
                {formatFeedPublishedLabel(sortTs)}
              </span>
            )}
          </span>
        </div>
        <div className="feed-item-date">{formatDate(sortTs)}</div>
      </div>
    );
  };

  const renderItem = (item: FeedItem) => {
    switch (item.feed_type) {
      case "press_release":
        return renderPressRow(item);
      case "sec_filing":
        return renderSecRow(item);
      case "foreign_filing":
        return renderForeignRow(item);
      default:
        return null;
    }
  };

  // ─── Skeleton ────────────────────────────────────────────────────────────────

  const renderSkeleton = () => (
    <div className="feed-list">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="feed-item feed-item-skeleton">
          <span className="feed-item-icon skeleton-icon" />
          <div className="feed-item-content">
            <div className="skeleton-line skeleton-title" />
            <div
              className="skeleton-line skeleton-body"
              style={{ marginTop: 6 }}
            />
            <div
              className="skeleton-line skeleton-meta"
              style={{ marginTop: 6 }}
            />
          </div>
          <div
            className="skeleton-line"
            style={{ width: 55, height: 10, marginTop: 4 }}
          />
        </div>
      ))}
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="dashboard">
      <DashboardNav />
      <div className="feed-page">
        {/* Tabs — DealDetail style */}
        <div className="tabs-nav">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab-btn tab-ready ${activeTab === t.key ? "active" : ""}`}
              onClick={() => selectTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Filter bar — date range + search */}
        <div className="feed-filters">
          <div className="feed-right-filters">
            <div className="feed-live-indicator">
              <span className={`feed-dot ${connected ? "connected" : ""}`} />
              <span className="feed-count">{items.length} loaded</span>
            </div>
            <select
              className="feed-date-select"
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value)}
            >
              <option value="1">Last 1 day</option>
              <option value="3">Last 3 days</option>
              <option value="7">Last 7 days</option>
            </select>
            <input
              className="feed-search"
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Error */}
        {error && <div className="feed-error">{error}</div>}

        {/* Feed rows */}
        {loading ? (
          renderSkeleton()
        ) : (
          <div className="feed-list" ref={scrollRef}>
            {items.length === 0 ? (
              <div className="feed-empty">
                {debouncedSearch.trim()
                  ? "No items match your filters."
                  : "No items in this time window."}
              </div>
            ) : (
              items.map((item) => renderItem(item))
            )}
            {loadingMore && (
              <div className="feed-loading-more">
                <div className="feed-spinner" />
                Loading more…
              </div>
            )}
            {!hasNext && items.length > 0 && (
              <div className="feed-end">No more items</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
