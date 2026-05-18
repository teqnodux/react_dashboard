import { useState, useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import DashboardNav from "../components/DashboardNav";
import {
  DASHBOARD_SEC_FEED_ITEM,
  useFeedSocketConnected,
} from "../context/FeedLiveContext";
import api from "../services/api";
import "../styles/Feed.css";

interface SecFiling {
  id: string;
  company_name?: string;
  cik_number?: string;
  form_type?: string;
  filing_date?: string;
  accession_number?: string;
  link?: string;
  document_kind?: string;
  xbrl_files?: { type: string; url: string }[];
  [key: string]: unknown;
}

const FORM_TYPE_COLORS: Record<string, string> = {
  "8-K": "badge-blue",
  "8-K/": "badge-blue",
  "10-K": "badge-green",
  "10-K/": "badge-green",
  "10-Q": "badge-yellow",
  "PRE 14A": "badge-purple",
  "DEF 14A": "badge-indigo"
};

export default function SecFeed() {
  const [items, setItems] = useState<SecFiling[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const connected = useFeedSocketConnected();

  const fetchPage = useCallback(async (p: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const { data } = await api.get(`/api/sec-feed?page=${p}&page_size=20`);
      const newItems: SecFiling[] = data.items;
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
      setError("Failed to load SEC filings");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchPage(1, false);
  }, [fetchPage]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || !hasNext) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      fetchPage(page + 1, true);
    }
  }, [fetchPage, loadingMore, hasNext, page]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const onItem = (ev: Event) => {
      const e = ev as CustomEvent<Record<string, unknown>>;
      const detail = e.detail;
      const id =
        typeof detail?.id === "string" && detail.id
          ? detail.id
          : String(detail["_id"] ?? "");
      if (!id) return;

      const row = { ...detail, id } as SecFiling;

      flushSync(() => {
        setItems((prev) => {
          const rest = prev.filter((x) => x.id !== id);
          return [row, ...rest];
        });
      });
    };

    window.addEventListener(DASHBOARD_SEC_FEED_ITEM, onItem);
    return () => window.removeEventListener(DASHBOARD_SEC_FEED_ITEM, onItem);
  }, []);

  const formatDate = (d?: string | null) => {
    if (!d) return "N/A";
    return new Date(d).toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric"
    });
  };

  const badgeClass = (formType?: string) =>
    FORM_TYPE_COLORS[formType ?? ""] ?? "badge-default";

  if (loading) {
    return (
      <div className="dashboard">
        <DashboardNav />
        <div className="feed-page">
          <div className="feed-header">
            <h2 className="feed-title">SEC Filings</h2>
          </div>
          <div className="feed-list">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="feed-card feed-card-skeleton">
                <div className="skeleton-line skeleton-title" />
                <div className="skeleton-line skeleton-meta" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard">
        <DashboardNav />
        <div className="feed-page">
          <div className="feed-error">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <DashboardNav />
      <div className="feed-page">
        <div className="feed-header">
          <h2 className="feed-title">SEC Filings</h2>
          <div className="feed-header-right">
            <span className={`feed-dot ${connected ? "connected" : ""}`} />
            <span className="feed-count">{items.length} filings</span>
          </div>
        </div>

        <div className="feed-list" ref={scrollRef}>
          {items.length === 0 ? (
            <div className="feed-empty">No SEC filings yet. Check back later.</div>
          ) : (
            items.map((f) => (
              <div
                key={f.id}
                className="feed-card"
                onClick={() => f.link && window.open(f.link, "_blank")}
              >
                <div className="feed-card-row sec-card-row">
                  <div className="feed-card-body">
                    <div className="feed-card-title">{f.company_name ?? "Unknown"}</div>
                    <div className="feed-card-meta">
                      <span>CIK: {f.cik_number ?? "—"}</span>
                      <span>{formatDate(f.filing_date)}</span>
                    </div>
                    {f.accession_number && (
                      <div className="feed-card-sub">{f.accession_number}</div>
                    )}
                  </div>
                  <div className="sec-card-badge-col">
                    <span className={`form-badge ${badgeClass(f.form_type)}`}>
                      {f.form_type ?? "—"}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
          {loadingMore && (
            <div className="feed-loading-more">
              <div className="feed-spinner" />
              Loading more filings…
            </div>
          )}
          {!hasNext && items.length > 0 && (
            <div className="feed-end">No more filings</div>
          )}
        </div>
      </div>
    </div>
  );
}
