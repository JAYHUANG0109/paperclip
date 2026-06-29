import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { notifications } from "@paperclipai/db";

export function notificationService(db: Db) {
  // Idempotent on (companyId, dedupeKey): the same dedupeKey won't create a 2nd row.
  async function create(input: {
    companyId: string;
    userId: string;
    kind: string;
    title: string;
    body?: string | null;
    link?: string | null;
    dedupeKey: string;
  }) {
    const [row] = await db
      .insert(notifications)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        dedupeKey: input.dedupeKey,
      })
      .onConflictDoNothing({ target: [notifications.companyId, notifications.dedupeKey] })
      .returning({ id: notifications.id });
    return row ?? null;
  }

  async function listForUser(companyId: string, userId: string, limit = 50) {
    return db
      .select()
      .from(notifications)
      .where(and(eq(notifications.companyId, companyId), eq(notifications.userId, userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async function unreadCount(companyId: string, userId: string): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.companyId, companyId), eq(notifications.userId, userId), isNull(notifications.readAt)));
    return r?.n ?? 0;
  }

  async function markRead(companyId: string, userId: string, id: string) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.companyId, companyId), eq(notifications.userId, userId)));
  }

  async function markAllRead(companyId: string, userId: string) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.companyId, companyId), eq(notifications.userId, userId), isNull(notifications.readAt)));
  }

  // Retention: drop notifications older than N days so daily/weekly summaries
  // don't accumulate unbounded. Returns how many rows were pruned.
  async function pruneOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const res = await db.delete(notifications).where(lt(notifications.createdAt, cutoff)).returning({ id: notifications.id });
    return res.length;
  }

  return { create, listForUser, unreadCount, markRead, markAllRead, pruneOlderThan };
}
