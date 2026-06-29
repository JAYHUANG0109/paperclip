import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemberships, authUsers, issues } from "@paperclipai/db";
import { notificationService } from "./notifications.js";

export type SummaryKind = "daily" | "weekly";

// Mirror of the UI's resolveLocale rule (ui/src/i18n/resolveLocale.ts): English
// for a small allowlist, Traditional Chinese for everyone else. Keep IN SYNC.
const ENGLISH_EMAILS = new Set<string>(["jay20020109@seasonart.org"]);
function localeForEmail(email: string | null | undefined): "en" | "zh-TW" {
  const e = email?.trim().toLowerCase();
  return e && ENGLISH_EMAILS.has(e) ? "en" : "zh-TW";
}

// Asia/Taipei is UTC+8 with no DST — safe to offset by a fixed 8h.
const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;
function taipeiDateLabel(d: Date): string {
  const tp = new Date(d.getTime() + TPE_OFFSET_MS);
  return tp.toISOString().slice(0, 10); // YYYY-MM-DD in Taipei
}
function taipeiDayStartUtc(d: Date): Date {
  const tp = new Date(d.getTime() + TPE_OFFSET_MS);
  const startTpMs = Date.UTC(tp.getUTCFullYear(), tp.getUTCMonth(), tp.getUTCDate(), 0, 0, 0, 0);
  return new Date(startTpMs - TPE_OFFSET_MS);
}
// The Taipei date of the current week's Friday — used as the weekly label +
// dedupe key so a Fri/Sat/Sun catch-up run all resolve to the same week.
function taipeiFridayLabel(d: Date): string {
  const tp = new Date(d.getTime() + TPE_OFFSET_MS);
  const daysSinceFriday = (tp.getUTCDay() - 5 + 7) % 7; // Fri=0, Sat=1, Sun=2, Mon=3...
  const fri = new Date(Date.UTC(tp.getUTCFullYear(), tp.getUTCMonth(), tp.getUTCDate() - daysSinceFriday));
  return fri.toISOString().slice(0, 10);
}

function renderSummary(
  kind: SummaryKind,
  locale: "en" | "zh-TW",
  count: number,
  titles: string[],
  label: string,
): { title: string; body: string } {
  const list = titles.map((tk) => `• ${tk}`).join("\n");
  if (locale === "en") {
    const title = kind === "daily" ? `Daily summary · ${label}` : `Weekly summary · week of ${label}`;
    const head = kind === "daily" ? `Completed ${count} task(s) today.` : `Completed ${count} task(s) this week.`;
    return { title, body: list ? `${head}\n${list}` : head };
  }
  const title = kind === "daily" ? `每日摘要 · ${label}` : `每週摘要 · ${label} 當週`;
  const head = kind === "daily" ? `今日完成 ${count} 件任務。` : `本週完成 ${count} 件任務。`;
  return { title, body: list ? `${head}\n${list}` : head };
}

export function summaryService(db: Db) {
  const notifications = notificationService(db);

  /**
   * Generate per-user "tasks done" summaries for a company and drop them into
   * each user's inbox (as notifications, kind daily_summary/weekly_summary).
   * Idempotent: the notification dedupeKey is per (user, period), so calling
   * this repeatedly in a window creates each summary at most once. Only users
   * who actually completed something get a summary (no empty spam).
   */
  async function generate(companyId: string, kind: SummaryKind, now: Date): Promise<number> {
    const end = now;
    const start = kind === "daily" ? taipeiDayStartUtc(now) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const label = kind === "daily" ? taipeiDateLabel(now) : taipeiFridayLabel(now);

    // user -> their agent ids
    const memberships = await db
      .select({ agentId: agentMemberships.agentId, userId: agentMemberships.userId })
      .from(agentMemberships)
      .where(and(eq(agentMemberships.companyId, companyId), eq(agentMemberships.state, "joined")));
    if (memberships.length === 0) return 0;
    const userByAgent = new Map<string, string>();
    const agentIds: string[] = [];
    for (const m of memberships) {
      if (!m.agentId || !m.userId) continue;
      userByAgent.set(m.agentId, m.userId);
      agentIds.push(m.agentId);
    }
    if (agentIds.length === 0) return 0;

    // completed issues in range, by those agents
    const done = await db
      .select({ title: issues.title, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.status, "done"),
          inArray(issues.assigneeAgentId, agentIds),
          gte(issues.completedAt, start),
          lt(issues.completedAt, end),
        ),
      );
    if (done.length === 0) return 0;

    // group titles by user
    const titlesByUser = new Map<string, string[]>();
    for (const row of done) {
      const uid = row.assigneeAgentId ? userByAgent.get(row.assigneeAgentId) : null;
      if (!uid) continue;
      const list = titlesByUser.get(uid) ?? [];
      list.push(row.title);
      titlesByUser.set(uid, list);
    }
    if (titlesByUser.size === 0) return 0;

    // resolve emails for locale
    const userIds = [...titlesByUser.keys()];
    const emails = new Map<string, string | null>();
    const rows = await db.select({ id: authUsers.id, email: authUsers.email }).from(authUsers).where(inArray(authUsers.id, userIds));
    for (const r of rows) emails.set(r.id, r.email);

    let created = 0;
    for (const [userId, titles] of titlesByUser) {
      const locale = localeForEmail(emails.get(userId));
      const { title, body } = renderSummary(kind, locale, titles.length, titles.slice(0, 8), label);
      const row = await notifications.create({
        companyId,
        userId,
        kind: kind === "daily" ? "daily_summary" : "weekly_summary",
        title,
        body,
        link: "/dashboard",
        dedupeKey: `${kind}-summary:${userId}:${label}`,
      });
      if (row) created += 1;
    }
    return created;
  }

  return { generate };
}
