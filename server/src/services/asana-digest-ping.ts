import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemberships, authUsers } from "@paperclipai/db";
import { notificationService } from "./notifications.js";
import { buildAsanaDigestBody } from "./agent-asana.js";
import { writeAsanaDigestForAgent, resolveOwnAgentId } from "./asana-digest.js";

/**
 * Server-side daily "you have N Asana tasks" reminder. Replaces the old per-user
 * agent digest routine: builds each person's digest from THEIR own Asana token
 * (no LLM run, zero tokens), refreshes the stored digest so their dashboard is
 * pre-warmed, and drops a short inbox notification with the counts. The Google
 * Chat plugin forwards that notification to their DM (for allowlisted users who
 * have messaged the bot) — so the "digest updated" Chat ping survives, cheaply.
 */

// Asia/Taipei is UTC+8, no DST.
const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;
function taipeiDateLabel(d: Date): string {
  return new Date(d.getTime() + TPE_OFFSET_MS).toISOString().slice(0, 10);
}

// Mirror ui/src/i18n/resolveLocale + summaries.ts: English for a small allowlist.
const ENGLISH_EMAILS = new Set<string>(["jay20020109@seasonart.org"]);
function isEnglish(email: string | null | undefined): boolean {
  const e = email?.trim().toLowerCase();
  return !!e && ENGLISH_EMAILS.has(e);
}

export function asanaDigestPingService(db: Db) {
  const notifications = notificationService(db);

  /**
   * For every user in a company: rebuild their digest server-side and, if they
   * have any open tasks, create a once-per-day reminder notification. Idempotent
   * via a per-(user, date) dedupeKey. Returns how many notifications were made.
   */
  async function generate(companyId: string, now: Date): Promise<number> {
    const label = taipeiDateLabel(now);

    const members = await db
      .select({ userId: agentMemberships.userId })
      .from(agentMemberships)
      .where(and(eq(agentMemberships.companyId, companyId), eq(agentMemberships.state, "joined")));
    const userIds = [...new Set(members.map((m) => m.userId).filter((u): u is string => !!u))];
    if (userIds.length === 0) return 0;

    const emailRows = await db
      .select({ id: authUsers.id, email: authUsers.email })
      .from(authUsers)
      .where(inArray(authUsers.id, userIds));
    const emailByUser = new Map(emailRows.map((r) => [r.id, r.email]));

    let created = 0;
    for (const userId of userIds) {
      const email = emailByUser.get(userId) ?? null;
      const agentId = await resolveOwnAgentId(db, companyId, email);
      if (!agentId) continue;

      const body = await buildAsanaDigestBody(db, companyId, agentId);
      if (!body) continue; // no Asana token / API failure — skip quietly

      // Pre-warm the stored digest (so the dashboard/calendar are current even
      // before the user opens them).
      try {
        await writeAsanaDigestForAgent(db, companyId, agentId, body);
      } catch {
        /* non-fatal — the reminder is still worth sending */
      }

      const dailyOpen = body.daily.length;
      const weeklyOpen = body.weekly.length;
      if (dailyOpen === 0 && weeklyOpen === 0) continue; // nothing to nudge about

      const en = isEnglish(email);
      const title = en ? "📋 Your Asana tasks" : "📋 你的 Asana 任務";
      const text = en
        ? `${dailyOpen} due today/overdue · ${weeklyOpen} this week. See your dashboard.`
        : `今日到期／逾期 ${dailyOpen} 件、本週 ${weeklyOpen} 件。詳見儀表板。`;

      const row = await notifications.create({
        companyId,
        userId,
        kind: "asana_digest",
        title,
        body: text,
        link: "/dashboard",
        dedupeKey: `asana-digest-ping:${userId}:${label}`,
      });
      if (row) created += 1;
    }
    return created;
  }

  return { generate };
}
