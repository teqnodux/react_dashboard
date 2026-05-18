import { io, Socket } from "socket.io-client";

const baseUrl = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8000"
).replace(/\/$/, "");

export type FeedItemCreatedPayload = {
  message?: string;
  data?: Record<string, unknown>;
};

export type SecFeedItemCreatedPayload = {
  message?: string;
  data?: Record<string, unknown>;
};

export type ForeignFeedItemCreatedPayload = {
  message?: string;
  data?: Record<string, unknown>;
};

/** Subscribes to feed / SEC / foreign Socket.IO events on one connection. */
export function connectFeedRealtime(
  onFeedItem: (item: Record<string, unknown>) => void,
  onConnectionChange: (connected: boolean) => void,
  onSecFeedItem?: (item: Record<string, unknown>) => void,
  onForeignFeedItem?: (item: Record<string, unknown>) => void
): () => void {
  const socket: Socket = io(baseUrl, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    reconnectionAttempts: 5,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 15000,
    timeout: 20000
  });

  socket.on("connect", () => {
    // Default DevTools hides "Verbose" (= console.info); use log for debugging.
    console.log("[feedRealtime] socket connected", baseUrl, socket.id);
    onConnectionChange(true);
  });
  socket.on("disconnect", (reason) => {
    console.log("[feedRealtime] socket disconnected", reason);
    onConnectionChange(false);
  });
  socket.on("connect_error", (err) => {
    console.warn("[feedRealtime] connect_error", err?.message ?? err);
    onConnectionChange(false);
  });
  socket.io.on("reconnect_failed", () => {
    console.warn("[feedRealtime] reconnect_failed (max attempts)");
    onConnectionChange(false);
  });

  socket.on("feed_item_created", (payload: FeedItemCreatedPayload) => {
    console.log("[feedRealtime] feed_item_created", payload);
    const row = payload?.data;
    if (!row || typeof row !== "object") {
      console.warn("[feedRealtime] feed_item_created missing data", payload);
      return;
    }
    onFeedItem(row);
  });

  socket.on("sec_feed_item_created", (payload: SecFeedItemCreatedPayload) => {
    console.log("[feedRealtime] sec_feed_item_created", payload);
    if (!onSecFeedItem) return;
    const row = payload?.data;
    if (!row || typeof row !== "object") {
      console.warn("[feedRealtime] sec_feed_item_created missing data", payload);
      return;
    }
    onSecFeedItem(row);
  });

  socket.on(
    "foreign_feed_item_created",
    (payload: ForeignFeedItemCreatedPayload) => {
      console.log("[feedRealtime] foreign_feed_item_created", payload);
      if (!onForeignFeedItem) return;
      const row = payload?.data;
      if (!row || typeof row !== "object") {
        console.warn(
          "[feedRealtime] foreign_feed_item_created missing data",
          payload
        );
        return;
      }
      onForeignFeedItem(row);
    }
  );

  return () => {
    socket.disconnect();
  };
}
