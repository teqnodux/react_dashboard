import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useToast } from "../components/ToastNotification";
import { connectFeedRealtime } from "../services/feedRealtime";
import { formatFeedPublishedLabel } from "../utils/feedFormatting";
import { hasNonEmptyDealId } from "../utils/dealId";
import { usePermissions } from "../hooks/usePermissions";

/** Dispatched whenever the backend emits `feed_item_created` while logged in */
export const DASHBOARD_NEWS_FEED_ITEM = "dashboard:news-feed-item";

/** Dispatched whenever the backend emits `sec_feed_item_created` while logged in */
export const DASHBOARD_SEC_FEED_ITEM = "dashboard:sec-feed-item";

/** Dispatched whenever the backend emits `foreign_feed_item_created` while logged in */
export const DASHBOARD_FOREIGN_FEED_ITEM = "dashboard:foreign-feed-item";

export type NewsFeedItemDetail = Record<string, unknown> & { id?: string };

const FeedConnectedCtx = createContext(false);

/** Single Socket.IO connection: news + SEC + foreign filing toasts and window events */
export function FeedLiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const { showToast } = useToast();
  const { allowedDealIds, isSuperAdmin } = usePermissions();
  const allowedIdsRef = useRef<string[] | "all">(allowedDealIds ?? "all");

  useEffect(() => {
    allowedIdsRef.current = isSuperAdmin ? "all" : (allowedDealIds ?? "all");
  }, [allowedDealIds, isSuperAdmin]);

  const isDealAllowed = (dealId: unknown): boolean => {
    const ids = allowedIdsRef.current;
    if (ids === "all") return true;
    return typeof dealId === "string" && dealId.length > 0 && ids.includes(dealId);
  };

  useEffect(() => {
    const disconnect = connectFeedRealtime(
      (row) => {
        const item = row as NewsFeedItemDetail;
        const id =
          typeof item.id === "string" && item.id ? item.id : String(item["_id"] ?? "");
        if (!id) return;
        if (!hasNonEmptyDealId(item)) return;
        if (!isDealAllowed(item.deal_id)) return;

        window.dispatchEvent(
          new CustomEvent<NewsFeedItemDetail>(DASHBOARD_NEWS_FEED_ITEM, {
            detail: { ...item, id }
          })
        );

        const subtitleRaw =
          (typeof item.date_published === "string" ? item.date_published : undefined) ??
          (typeof item.created_at === "string" ? item.created_at : undefined) ??
          (typeof item.published_at === "string" ? item.published_at : undefined);
        const subtitle = subtitleRaw ? formatFeedPublishedLabel(subtitleRaw) : "";

        showToast(
          typeof item.title === "string" && item.title.trim()
            ? item.title.trim()
            : "Untitled article",
          "success",
          {
            heading: "News Feed",
            subtitle: subtitle || undefined
          }
        );
      },
      setConnected,
      (secRow) => {
        const item = secRow as Record<string, unknown>;
        const id =
          typeof item.id === "string" && item.id
            ? item.id
            : String(item["_id"] ?? "");
        if (!id) return;
        if (!isDealAllowed(item.deal_id)) return;

        window.dispatchEvent(
          new CustomEvent<Record<string, unknown>>(DASHBOARD_SEC_FEED_ITEM, {
            detail: { ...item, id }
          })
        );

        const company =
          typeof item.company_name === "string" && item.company_name.trim()
            ? item.company_name.trim()
            : "SEC filing";
        const form = typeof item.form_type === "string" ? item.form_type : "—";
        const cik =
          typeof item.cik_number === "string" && item.cik_number
            ? item.cik_number
            : "—";
        const filingRaw =
          typeof item.filing_date === "string" ? item.filing_date : undefined;
        const when = filingRaw ? formatFeedPublishedLabel(filingRaw) : "—";
        const subtitle = `${form} · CIK ${cik} · ${when}`;

        showToast(company, "success", {
          heading: "SEC Feed",
          subtitle
        });
      },
      (foreignRow) => {
        const item = foreignRow as Record<string, unknown>;
        const id =
          typeof item.id === "string" && item.id
            ? item.id
            : String(item["_id"] ?? "");
        if (!id) return;
        if (!hasNonEmptyDealId(item)) return;
        if (!isDealAllowed(item.deal_id)) return;

        window.dispatchEvent(
          new CustomEvent<Record<string, unknown>>(DASHBOARD_FOREIGN_FEED_ITEM, {
            detail: { ...item, id }
          })
        );

        const label =
          typeof item.source_label === "string" && item.source_label.trim()
            ? item.source_label.trim()
            : "Foreign filing";
        const country =
          typeof item.country === "string" && item.country.trim()
            ? item.country.trim()
            : "";
        const titleGuess =
          (typeof item.title === "string" && item.title.trim()
            ? item.title.trim()
            : undefined) ??
          (typeof item.case_title === "string" && item.case_title.trim()
            ? item.case_title.trim()
            : undefined) ??
          (typeof item.parties === "string" && item.parties.trim()
            ? item.parties.trim()
            : undefined) ??
          label;
        const updatedRaw =
          (typeof item.updated_at === "string" ? item.updated_at : undefined) ??
          (typeof item.processed_at === "string" ? item.processed_at : undefined);
        const when = updatedRaw ? formatFeedPublishedLabel(updatedRaw) : "";

        showToast(titleGuess, "success", {
          heading: "Foreign Filing",
          subtitle: [label, country, when].filter(Boolean).join(" · ") || undefined
        });
      }
    );

    return disconnect;
  }, [showToast]);

  return (
    <FeedConnectedCtx.Provider value={connected}>{children}</FeedConnectedCtx.Provider>
  );
}

export function useFeedSocketConnected() {
  return useContext(FeedConnectedCtx);
}
