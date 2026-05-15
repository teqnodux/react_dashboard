import { useState, useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import DashboardNav from "../components/DashboardNav";
import {
  DASHBOARD_NEWS_FEED_ITEM,
  DASHBOARD_SEC_FEED_ITEM,
  useFeedSocketConnected,
  type NewsFeedItemDetail
} from "../context/FeedLiveContext";
import { formatFeedPublishedLabel } from "../utils/feedFormatting";
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
  "United Kingdom": "🇬🇧"
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function Feed() {
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  // ── Filter state ───────────────────────────────────────────────────────────
  const [dateRange, setDateRange] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const connected = useFeedSocketConnected();

  // Debounce search input — wait 400 ms after user stops typing
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  // Build query string for API
  const buildQuery = useCallback(
    (tab: TabKey, p: number, s: string, dr: string) => {
      const params = new URLSearchParams({
        tab,
        page: String(p),
        page_size: "20"
      });
      if (s.trim()) params.set("search", s.trim());
      if (dr !== "all") params.set("days", dr);
      return `/api/feed?${params.toString()}`;
    },
    []
  );

  const fetchPage = useCallback(
    async (p: number, append: boolean, tab: TabKey, s: string, dr: string) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const { data } = await api.get(buildQuery(tab, p, s, dr));
        const newItems: FeedItem[] = data.items;
        if (append) {
          setItems((prev) => {
            const existingIds = new Set(prev.map((i) => i.id));
            return [...prev, ...newItems.filter((i) => !existingIds.has(i.id))];
          });
        } else {
          setItems(newItems);
        }
        setHasNext(data.has_next);
        setPage(p);
      } catch {
        setError("Failed to load feed");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [buildQuery]
  );

  // Reset + refetch when tab changes
  useEffect(() => {
    setItems([]);
    setPage(1);
    setHasNext(false);
    setError("");
    setDateRange("all");
    setSearch("");
    setDebouncedSearch("");
    fetchPage(1, false, activeTab, "", "all");
  }, [activeTab, fetchPage]);

  // Refetch from page 1 when debounced search or date range changes
  useEffect(() => {
    setItems([]);
    setPage(1);
    setHasNext(false);
    setError("");
    fetchPage(1, false, activeTab, debouncedSearch, dateRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, dateRange]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || !hasNext) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      fetchPage(page + 1, true, activeTab, debouncedSearch, dateRange);
    }
  }, [
    fetchPage,
    loadingMore,
    hasNext,
    page,
    activeTab,
    debouncedSearch,
    dateRange
  ]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Live updates: press releases
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
      const item = {
        ...detail,
        id,
        feed_type: "press_release" as const
      } as FeedItem;
      flushSync(() => {
        setItems((prev) => {
          if (prev.some((p) => p.id === id)) return prev;
          return [item, ...prev];
        });
      });
    };
    window.addEventListener(DASHBOARD_NEWS_FEED_ITEM, onItem);
    return () => window.removeEventListener(DASHBOARD_NEWS_FEED_ITEM, onItem);
  }, [activeTab]);

  // Live updates: SEC filings
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
      flushSync(() => {
        setItems((prev) => {
          if (prev.some((x) => x.id === id)) return prev;
          return [row, ...prev];
        });
      });
    };
    window.addEventListener(DASHBOARD_SEC_FEED_ITEM, onItem);
    return () => window.removeEventListener(DASHBOARD_SEC_FEED_ITEM, onItem);
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
          {item.date_published && (
            <span> · {formatFeedPublishedLabel(item.date_published)}</span>
          )}
        </span>
      </div>
      <div className="feed-item-date">{formatDate(item.date_published)}</div>
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
          {item.filing_date && (
            <span> · {formatFeedPublishedLabel(item.filing_date)}</span>
          )}
          {item.accession_number && <span> · {item.accession_number}</span>}
        </span>
      </div>
      <div className="feed-item-date">{formatDate(item.filing_date)}</div>
    </div>
  );

  const renderForeignRow = (item: FeedItem) => {
    const src = (item.source as string) ?? "";
    const title = getRecordTitle(src, item);
    const url = getRecordUrl(src, item);
    const status = getRecordStatus(src, item);
    const flag = FLAG[item.country ?? ""] ?? "🌐";

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
            {item.updated_at && (
              <span> · {formatFeedPublishedLabel(item.updated_at)}</span>
            )}
          </span>
        </div>
        <div className="feed-item-date">{formatDate(item.updated_at)}</div>
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
        {/* Header */}
        <div className="feed-header">
          <h2 className="feed-title">Feed</h2>
          <div className="feed-header-right">
            <span className={`feed-dot ${connected ? "connected" : ""}`} />
            <span className="feed-count">{items.length} items</span>
          </div>
        </div>

        {/* Tabs — DealDetail style */}
        <div className="tabs-nav">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab-btn tab-ready ${activeTab === t.key ? "active" : ""}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Filter bar — date range + search */}
        <div className="feed-filters">
          <div className="feed-right-filters">
            <select
              className="feed-date-select"
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value)}
            >
              <option value="7">Last 7d</option>
              <option value="30">Last 30d</option>
              <option value="90">Last 90d</option>
              <option value="365">Last year</option>
              <option value="all">All time</option>
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
                {debouncedSearch || dateRange !== "all"
                  ? "No items match your filters."
                  : "No items yet. Check back later."}
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
