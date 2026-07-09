import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { notifications, authUsers, companies } from "@paperclipai/db";
import { publishPluginDomainEvent } from "./activity-log.js";
import { loadConfig } from "../config.js";

/**
 * The app's public origin (e.g. https://host.ts.net), read once from config.
 * Used to turn app-relative notification links ("/dashboard") into absolute,
 * clickable URLs for EXTERNAL forwards (Google Chat). The in-app inbox keeps
 * the relative link for client-side routing; only the emitted event payload is
 * made absolute. Best-effort: if config/parsing fails, we fall back to null and
 * the link stays relative (a harmless hint) rather than breaking the notify.
 */
let publicBaseOrigin: string | null | undefined;
function resolvePublicBaseOrigin(): string | null {
  if (publicBaseOrigin !== undefined) return publicBaseOrigin;
  try {
    const raw = loadConfig().authPublicBaseUrl?.trim();
    publicBaseOrigin = raw ? new URL(raw).origin : null;
  } catch {
    publicBaseOrigin = null;
  }
  return publicBaseOrigin;
}
/**
 * Board routes are company-scoped in the UI: "/dashboard" actually lives at
 * "/{ISSUE_PREFIX}/dashboard" (the first path segment is the company code, e.g.
 * SEAAA). App-relative notification links omit that segment because the client
 * injects the active company — but an external Chat link has no company context,
 * so we splice the prefix in here. Skips if the link already carries it.
 */
function withCompanyPrefix(link: string, issuePrefix: string | null | undefined): string {
  const prefix = issuePrefix?.trim().toUpperCase();
  if (!prefix || !link.startsWith("/")) return link;
  const firstSeg = link.split("/").filter(Boolean)[0]?.toUpperCase();
  if (firstSeg === prefix) return link; // already prefixed
  return `/${prefix}${link}`;
}
export function toAbsoluteLink(link: string | null | undefined, issuePrefix?: string | null): string | null {
  const l = link?.trim();
  if (!l) return null;
  if (/^https?:\/\//i.test(l)) return l; // already absolute
  const base = resolvePublicBaseOrigin();
  if (!base) return l; // no known origin — leave relative
  const scoped = withCompanyPrefix(l, issuePrefix);
  return `${base}${scoped.startsWith("/") ? "" : "/"}${scoped}`;
}

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
    // Emit a plugin event only for a genuinely NEW notification (a deduped
    // insert returns no row). Connectors like Google Chat subscribe to this to
    // forward the item to the user's own channel. The recipient's email is
    // resolved here (plugins have no users API) so the handler can map it to a
    // chat DM. Fully guarded — forwarding must never break the notification.
    if (row) {
      try {
        const u = (await db.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, input.userId)))[0];
        // Company code (issue prefix) that scopes board URLs like /dashboard.
        const c = (await db.select({ p: companies.issuePrefix }).from(companies).where(eq(companies.id, input.companyId)))[0];
        publishPluginDomainEvent({
          eventId: randomUUID(),
          eventType: "notification.created",
          occurredAt: new Date().toISOString(),
          actorType: "system",
          entityId: row.id,
          entityType: "notification",
          companyId: input.companyId,
          payload: {
            notificationId: row.id,
            userId: input.userId,
            email: u?.email?.trim().toLowerCase() ?? null,
            kind: input.kind,
            title: input.title,
            body: input.body ?? null,
            link: toAbsoluteLink(input.link, c?.p),
          },
        });
      } catch {
        /* best-effort: never let event fan-out affect the write */
      }
    }
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
