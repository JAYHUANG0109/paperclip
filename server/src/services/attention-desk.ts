/**
 * Pure desk-ranking predicates for 待決議.
 *
 * Split out of `attention.ts` so the ROUTE can recompute the desk badge over the
 * items it actually returns. The route filters the service's feed down to what
 * is relevant to the caller; if it imported these from `attention.ts` every test
 * that mocks that module would have to re-declare them, and the badge would be
 * one forgotten mock away from silently reverting to a company-wide count.
 *
 * Keep in lockstep with `ui/src/lib/attention.ts` (same UTC day boundaries).
 */
import type { AttentionItem } from "@paperclipai/shared";

export function attentionTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function startOfUtcDay(now: number) {
  const value = new Date(now);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

export function endOfUtcDay(now: number) {
  return startOfUtcDay(now) + 24 * 60 * 60 * 1_000 - 1;
}

export function endOfUtcWeek(now: number) {
  const start = startOfUtcDay(now);
  const weekday = new Date(start).getUTCDay();
  // Use an ISO-style Monday-Sunday week. Sunday (0) is already the last
  // day of the current week; every other day advances only to that Sunday.
  const daysUntilSunday = weekday === 0 ? 0 : 7 - weekday;
  return start + (daysUntilSunday + 1) * 24 * 60 * 60 * 1_000 - 1;
}

export function decideOrder(item: AttentionItem, now: number): [number, number] {
  if (item.decideBy === "today") return [0, endOfUtcDay(now)];
  if (item.decideBy === "this_week") return [0, endOfUtcWeek(now)];
  if (item.decideBy && /^\d{4}-\d{2}-\d{2}$/.test(item.decideBy)) {
    const deadline = Date.parse(`${item.decideBy}T23:59:59.999Z`);
    if (Number.isFinite(deadline)) return [0, deadline];
  }
  if (item.decideBy === "whenever") return [1, Number.MAX_SAFE_INTEGER];
  return [2, Number.MAX_SAFE_INTEGER];
}

export function isDecideNow(item: AttentionItem, now: number) {
  const [bucket, deadline] = decideOrder(item, now);
  return bucket === 0 && deadline <= endOfUtcDay(now);
}

/** Surfaced today (arrival). Mirrors `attentionIsNewToday` in `ui/src/lib/attention.ts`. */
export function isNewToday(item: AttentionItem, now: number) {
  const ts = attentionTimestamp(item.createdAt);
  return ts > 0 && ts >= startOfUtcDay(now);
}

/** Desk badge: items that surfaced today OR are due today/past. */
export function deskBadgeCountFor(items: readonly AttentionItem[], now: number) {
  return items.filter((item) => isNewToday(item, now) || isDecideNow(item, now)).length;
}
