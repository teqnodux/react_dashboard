import { useState, useEffect, useRef, useCallback } from "react";
import DashboardNav from "../components/DashboardNav";
import { useToast } from "../components/ToastNotification";
import { socketService } from "../services/socketService";
import api from "../services/api";
import "../styles/Feed.css";

interface NewsItem {
  id: string;
  title?: string;
  description_text?: string;
  url?: string;
  thumbnail?: string;
  source?: string;
  authors?: { name: string }[];
  date_published?: string;
  [key: string]: unknown;
}

export default function NewsFeed() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  const fetchPage = useCallback(async (p: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const { data } = await api.get(`/api/news-feed?page=${p}&page_size=20`);
      const newItems: NewsItem[] = data.items;
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
      setError("Failed to load news feed");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchPage(1, false);
  }, [fetchPage]);

  // Infinite scroll
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

  // Socket subscription
  useEffect(() => {
    const handleConnection = (data: unknown) => {
      const d = data as { connected: boolean };
      setConnected(d.connected);
    };

    const handleRssUpdate = (data: unknown) => {
      const d = data as { type?: string; items?: NewsItem[]; message?: string };
      if (d.type === "new_feed_items" || d.type === "feed_update") {
        if (d.items?.length) {
          setItems((prev) => [...d.items!, ...prev]);
          showToast(
            `📰 ${d.items!.length} new article${d.items!.length > 1 ? "s" : ""} received`,
            "success"
          );
        }
      } else if (d.type === "error") {
        showToast(`RSS Error: ${d.message}`, "error");
      }
    };

    socketService.on("connection_status", handleConnection);
    socketService.on("rss_update", handleRssUpdate);
    setConnected(socketService.getConnectionStatus());

    return () => {
      socketService.off("connection_status", handleConnection);
      socketService.off("rss_update", handleRssUpdate);
    };
  }, [showToast]);

  const formatDate = (d?: string) => {
    if (!d) return "";
    return new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  const getAuthors = (authors?: { name: string }[]) =>
    authors?.map((a) => a.name).join(", ") ?? "";

  if (loading) {
    return (
      <div className="dashboard">
        <DashboardNav />
        <div className="feed-page">
          <div className="feed-header">
            <h2 className="feed-title">Latest News</h2>
          </div>
          <div className="feed-list">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="feed-card feed-card-skeleton">
                <div className="skeleton-line skeleton-title" />
                <div className="skeleton-line skeleton-body" />
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
          <h2 className="feed-title">Latest News</h2>
          <div className="feed-header-right">
            <span className={`feed-dot ${connected ? "connected" : ""}`} />
            <span className="feed-count">{items.length} articles</span>
          </div>
        </div>

        <div className="feed-list" ref={scrollRef}>
          {items.length === 0 ? (
            <div className="feed-empty">
              No news items yet. Check back later.
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="feed-card"
                onClick={() => item.url && window.open(item.url, "_blank")}
              >
                {item.thumbnail ? (
                  <div className="feed-card-row">
                    <div className="feed-card-thumb">
                      <img
                        src={item.thumbnail}
                        alt=""
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                      {item.source && (
                        <div className="feed-card-source">{item.source}</div>
                      )}
                    </div>
                    <div className="feed-card-body">
                      <div className="feed-card-title">{item.title}</div>
                      <div className="feed-card-desc">
                        {item.description_text?.split(" -- ")[1] ??
                          item.description_text}
                      </div>
                      <div className="feed-card-meta">
                        <span>{getAuthors(item.authors)}</span>
                        <span>{formatDate(item.date_published)}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="feed-card-body">
                    <div className="feed-card-title">{item.title}</div>
                    <div className="feed-card-desc">
                      {item.description_text?.split(" -- ")[1] ??
                        item.description_text}
                    </div>
                    <div className="feed-card-meta">
                      <span>{getAuthors(item.authors)}</span>
                      <span>{formatDate(item.date_published)}</span>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
          {loadingMore && (
            <div className="feed-loading-more">
              <div className="feed-spinner" />
              Loading more…
            </div>
          )}
          {!hasNext && items.length > 0 && (
            <div className="feed-end">No more articles</div>
          )}
        </div>
      </div>
    </div>
  );
}
