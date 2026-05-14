/** Formats Mongo / API timestamps for News Feed UI and toasts */
export function formatFeedPublishedLabel(d?: string): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
