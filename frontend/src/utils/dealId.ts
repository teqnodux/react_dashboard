/**
 * Mirrors backend `feed_item_has_deal_id` (`backend/db.py`): non-null deal_id
 * with non-whitespace string form.
 */
export function hasNonEmptyDealId(
  record: Record<string, unknown> | null | undefined
): boolean {
  if (!record) return false;
  const raw = record.deal_id;
  if (raw == null) return false;
  return String(raw).trim().length > 0;
}
