import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemberships, routines as routinesTable, routineTriggers } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { notificationService } from "../services/notifications.js";
import {
  emailForUserId,
  getAsanaDigestForUser,
  writeAsanaDigestForAgent,
  resolveOwnAgentId,
  setDigestTaskCompleted,
} from "../services/asana-digest.js";
import {
  writeFounderDigestForAgent,
  getConsolesForUser,
  setFounderItemDecision,
  setFounderItemClosed,
  appendFounderItemComment,
  getFounderItemByGid,
  CONSOLE_TITLE,
  toConsoleKey,
  asConsoleKey,
  type FounderDecision,
} from "../services/founder-digest.js";
import { randomUUID } from "node:crypto";
import { logger } from "../middleware/logger.js";
import { buildAsanaDigestBody, getAsanaTaskComments, postAsanaComment, setAsanaTaskCompleted, resolveFounderPostTargetGid, autoPostFounderAiComments, buildFounderDigestPrep } from "../services/agent-asana.js";
import { CONSOLE_ASANA_LAYOUT } from "../services/founder-digest-consoles.js";
import { storeAsanaTokenForAgent } from "../services/agent-connections.js";
import {
  getCalendarEventsForUser,
  getEffectiveAliases,
  getSavedAliases,
  setSavedAliases,
  deriveNameAliases,
  getUserName,
  eventIsMine,
} from "../services/google-calendar.js";
import { heartbeatService } from "../services/heartbeat.js";
import { routineService } from "../services/routines.js";
import { assertCompanyAccess, assertPrivilegedMemberView } from "./authz.js";

/**
 * Resolve the [timeMin, timeMax] window for a calendar fetch from query params,
 * falling back to a generous default (≈ last month → next two months) when the
 * client omits them. Invalid values fall back too, so a bad query never errors.
 */
function resolveCalendarRange(query: unknown): { timeMin: string; timeMax: string } {
  const q = (query ?? {}) as { timeMin?: unknown; timeMax?: unknown };
  const parse = (v: unknown): string | null => {
    if (typeof v !== "string" || !v.trim()) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const now = Date.now();
  const DAY = 86_400_000;
  return {
    timeMin: parse(q.timeMin) ?? new Date(now - 35 * DAY).toISOString(),
    timeMax: parse(q.timeMax) ?? new Date(now + 70 * DAY).toISOString(),
  };
}

// How long a server-built Asana digest stays fresh before the next dashboard
// load rebuilds it from Asana. 10 min keeps it current without an Asana call
// on every render.
const DIGEST_REFRESH_MS = 10 * 60 * 1000;
function digestNeedsRefresh(
  digest: { generatedAt?: string | null; daily?: { permalinkUrl?: string | null }[]; weekly?: { permalinkUrl?: string | null }[] } | null,
): boolean {
  if (!digest) return true;
  const gen = digest.generatedAt ? Date.parse(digest.generatedAt) : NaN;
  if (!Number.isFinite(gen) || Date.now() - gen > DIGEST_REFRESH_MS) return true;
  // Heal legacy digests written by the old agent path (no deep-link/notes).
  const all = [...(digest.daily ?? []), ...(digest.weekly ?? [])];
  if (all.length > 0 && all.some((t) => !t.permalinkUrl)) return true;
  return false;
}

export function dashboardRoutes(db: Db, options: { restrictVisibility?: boolean } = {}) {
  const restrictVisibility = options.restrictVisibility ?? false;
  const router = Router();
  const svc = dashboardService(db);
  const heartbeat = heartbeatService(db);
  const routineSvc = routineService(db);
  const notifications = notificationService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // The dashboard is an org-wide oversight view (all agents' activity, spend,
    // approvals). Restricted members (operator/viewer) are not allowed to see it.
    assertPrivilegedMemberView(req, companyId, restrictVisibility);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  // Per-user Asana digest. Unlike the org summary above, this is intentionally
  // available to ANY company member — it returns only the caller's OWN tasks
  // (resolved via their email → their agent → that agent's stored digest), so
  // each person sees just their own work. Empty until the scheduled agent run.
  router.get("/companies/:companyId/asana-digest/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    let digest = await getAsanaDigestForUser(db, companyId, email);
    // Self-healing server-side refresh: rebuild the digest from Asana with the
    // user's OWN token (deterministic, complete fields, zero LLM tokens) when
    // it's missing, stale (>10 min), or was written without deep-links/notes
    // (the legacy agent path dropped those fields). Falls back to the stored
    // digest if the Asana pull fails.
    if (digestNeedsRefresh(digest)) {
      const agentId = await resolveOwnAgentId(db, companyId, email);
      if (agentId) {
        try {
          const body = await buildAsanaDigestBody(db, companyId, agentId);
          if (body) digest = await writeAsanaDigestForAgent(db, companyId, agentId, body);
        } catch {
          /* keep the stored digest on any failure */
        }
      }
    }
    res.json(digest ?? { generatedAt: null, daily: [], weekly: [], empty: true });
  });

  // Google Calendar — the caller's OWN events across all calendars they can see.
  // Reuses the OAuth token better-auth stored at SSO login; per-user isolation is
  // structural (caller's userId → caller's token → only their calendars). Read-only.
  // `?mine=1` returns only events related to the caller (real owner/attendee OR a
  // name-alias match against the freeform title — the team encodes attendees as
  // title text). `timeMin`/`timeMax` are RFC3339 bounds for the visible window.
  router.get("/companies/:companyId/google-calendar/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    if (!userId) {
      res.json({ connected: false, reason: "auth_required", events: [] });
      return;
    }
    const { timeMin, timeMax } = resolveCalendarRange(req.query);
    const result = await getCalendarEventsForUser(db, userId, { timeMin, timeMax });
    if (!result.connected) {
      res.json({ connected: false, reason: result.reason, events: [] });
      return;
    }
    const onlyMine = req.query.mine === "1" || req.query.mine === "true";
    if (!onlyMine) {
      res.json({ connected: true, events: result.events });
      return;
    }
    const aliases = await getEffectiveAliases(db, userId);
    res.json({ connected: true, events: result.events.filter((e) => eventIsMine(e, aliases)) });
  });

  // Read the caller's calendar name-aliases (saved overrides + the auto-derived
  // defaults), so the settings editor can show both. Self-scoped.
  router.get("/companies/:companyId/google-calendar/aliases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    if (!userId) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    const [saved, name] = await Promise.all([getSavedAliases(db, userId), getUserName(db, userId)]);
    res.json({ aliases: saved, derived: deriveNameAliases(name), usingDefaults: saved.length === 0 });
  });

  // Update the caller's calendar name-aliases. Self-scoped: a user can only set
  // their own. An empty array reverts to the auto-derived defaults.
  router.put("/companies/:companyId/google-calendar/aliases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    if (!userId) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    const raw = (req.body as { aliases?: unknown })?.aliases;
    const aliases = Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
    const saved = await setSavedAliases(db, userId, aliases);
    const name = await getUserName(db, userId);
    res.json({ aliases: saved, derived: deriveNameAliases(name), usingDefaults: saved.length === 0 });
  });

  // The agent writes its OWN digest here, in its heartbeat, after pulling Asana
  // with its user's token. Agent-only + self-scoped: an agent can only write its
  // own metadata.asanaDigest, never another agent's.
  router.post("/companies/:companyId/asana-digest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId || req.actor.companyId !== companyId) {
      res.status(403).json({ error: "Only the owning agent may write its digest." });
      return;
    }
    const digest = await writeAsanaDigestForAgent(db, companyId, req.actor.agentId, req.body);
    // Best-effort: when a digest with tasks is (re)posted, drop a once-per-day
    // inbox notification for the agent's owner. Fully guarded — a failure here
    // must never affect the digest write itself.
    try {
      const taskCount = (digest.daily?.length ?? 0) + (digest.weekly?.length ?? 0);
      if (taskCount > 0) {
        const [m] = await db
          .select({ userId: agentMemberships.userId })
          .from(agentMemberships)
          .where(and(eq(agentMemberships.agentId, req.actor.agentId), eq(agentMemberships.state, "joined")))
          .limit(1);
        if (m?.userId) {
          const day = new Date().toISOString().slice(0, 10);
          const open = [...(digest.daily ?? []), ...(digest.weekly ?? [])].filter((tk) => !tk.completed).length;
          await notifications.create({
            companyId,
            userId: m.userId,
            kind: "asana_digest",
            title: "Asana 任務已更新 / Asana tasks updated",
            body: `今日 ${digest.daily?.length ?? 0} · 本週 ${digest.weekly?.length ?? 0}（待辦 ${open}）`,
            link: "/dashboard",
            dedupeKey: `asana-digest:${m.userId}:${day}`,
          });
        }
      }
    } catch {
      /* notifications are best-effort */
    }
    res.json(digest);
  });

  // Check off (or reopen) one of the caller's OWN Asana tasks from the dashboard.
  // The server never holds the user's Asana token, so it routes the write through
  // the user's own agent: it optimistically flips the stored digest (instant UI),
  // then wakes the agent with a directive to actually complete the task in Asana
  // with that user's token and refresh the digest. Reverse-sync reconciles.
  router.post("/companies/:companyId/asana-digest/tasks/:gid/complete", async (req, res) => {
    const companyId = req.params.companyId as string;
    const gid = req.params.gid as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    const agentId = await resolveOwnAgentId(db, companyId, email);
    if (!agentId) {
      res.status(404).json({ error: "No agent is linked to your account to act on Asana." });
      return;
    }
    const completed = req.body?.completed !== false; // default true
    // Server-direct: write to Asana synchronously with the user's OWN token so
    // the UI gets an immediate confirmed/failed result (drives the checkbox
    // state machine) — and no agent LLM wake, so it costs zero tokens.
    const ok = await setAsanaTaskCompleted(db, companyId, agentId, gid, completed);
    if (!ok) {
      res.status(502).json({ ok: false, confirmed: false, error: "Could not update the task in Asana." });
      return;
    }
    const digest = await setDigestTaskCompleted(db, agentId, gid, completed);
    res.json({ ok: true, confirmed: true, digest });
  });

  // On-demand comments for one task, fetched server-direct with the caller's OWN
  // token when they expand a row. Deliberately NOT part of the bulk digest, so
  // the digest run stays cheap; only the task the user opens is fetched.
  router.get("/companies/:companyId/asana-digest/tasks/:gid/comments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const gid = req.params.gid as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    const agentId = await resolveOwnAgentId(db, companyId, email);
    if (!agentId) {
      res.status(404).json({ error: "No agent is linked to your account to read Asana." });
      return;
    }
    const comments = await getAsanaTaskComments(db, companyId, agentId, gid);
    if (comments === null) {
      res.status(502).json({ error: "Could not load comments from Asana." });
      return;
    }
    res.json({ comments, count: comments.length });
  });

  // Manual refresh: the user presses "更新" on the Asana tasks card. Rebuilds the
  // digest server-side using the caller's OWN Asana token — no LLM, no agent
  // wakeup. Returns the fresh digest in the response so the UI can update
  // immediately (no polling needed).
  router.post("/companies/:companyId/asana-digest/refresh", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    const agentId = await resolveOwnAgentId(db, companyId, email);
    if (!agentId) {
      res.status(404).json({ error: "No agent is linked to your account to refresh from Asana." });
      return;
    }
    const body = await buildAsanaDigestBody(db, companyId, agentId);
    if (!body) {
      res.status(502).json({ error: "Could not refresh digest from Asana." });
      return;
    }
    const digest = await writeAsanaDigestForAgent(db, companyId, agentId, body);
    // Best-effort: a manual 更新 should also push the fresh digest to the user's
    // Google Chat (same forward path as the daily auto-ping — server-direct, zero
    // tokens). Throttled to at most once per Taipei-hour via the dedupeKey so
    // rapid clicking can't spam the DM; a distinct key from the daily ping so a
    // manual pull still fires even after today's scheduled nudge already went out.
    try {
      const dailyOpen = digest.daily?.length ?? 0;
      const weeklyOpen = digest.weekly?.length ?? 0;
      if (userId && dailyOpen + weeklyOpen > 0) {
        // Asia/Taipei is UTC+8 (no DST) → "2026-07-02T14" = per-hour bucket.
        const hourLabel = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 13);
        const en = (email?.trim().toLowerCase() ?? "") === "jay20020109@seasonart.org";
        const title = en ? "📋 Your Asana tasks (refreshed)" : "📋 你的 Asana 任務（已更新）";
        const text = en
          ? `${dailyOpen} due today/overdue · ${weeklyOpen} this week. See your dashboard.`
          : `今日到期／逾期 ${dailyOpen} 件、本週 ${weeklyOpen} 件。詳見儀表板。`;
        await notifications.create({
          companyId,
          userId,
          kind: "asana_digest",
          title,
          body: text,
          link: "/dashboard",
          dedupeKey: `asana-digest-manual:${userId}:${hourLabel}`,
        });
      }
    } catch {
      /* forward is best-effort — never let it affect the refresh response */
    }
    res.json({ ok: true, digest });
  });

  // ── Daily-calendar consoles (創辦人 / 園長 每日行事曆) ──────────────────────
  // Read every console the caller has on their own agent (each = 4 priority
  // categories + agent drafts). Most users have one; the preview account may
  // have both. Allowlist-gated + self-scoped inside getConsolesForUser.
  router.get("/companies/:companyId/founder-digest/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    const consoles = await getConsolesForUser(db, companyId, email);
    res.json({ consoles });
  });

  // Server-side digest prep (token-lightening #2). The agent calls this to get a
  // pre-built, deterministic payload — Asana sections fetched + categorized,
  // private-links resolved, comments/subtasks collected, idempotency checked —
  // so it no longer does any of that plumbing in its model context. It then only
  // writes summary/批閱草稿 and POSTs /founder-digest as today. Agent-only,
  // self-scoped, read-only (no writes to Asana or the digest). If the console has
  // no server-side layout yet, returns { supported: false } and the agent keeps
  // its own fetch (safe fallback).
  router.get("/companies/:companyId/founder-digest/prep", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId || req.actor.companyId !== companyId) {
      res.status(403).json({ error: "Only the owning agent may build its founder-digest prep." });
      return;
    }
    const consoleKey = asConsoleKey((req.query as { console?: unknown })?.console);
    const layout = CONSOLE_ASANA_LAYOUT[consoleKey];
    if (!layout) {
      res.json({ supported: false, console: consoleKey });
      return;
    }
    const prep = await buildFounderDigestPrep(db, companyId, req.actor.agentId, layout);
    if (!prep) {
      res.json({ supported: false, console: consoleKey, reason: "no_token" });
      return;
    }
    res.json({ supported: true, console: consoleKey, ...prep });
  });

  // The agent writes its OWN founder digest (agent-only, self-scoped).
  router.post("/companies/:companyId/founder-digest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId || req.actor.companyId !== companyId) {
      res.status(403).json({ error: "Only the owning agent may write its founder digest." });
      return;
    }
    const digest = await writeFounderDigestForAgent(db, companyId, req.actor.agentId, req.body);
    // Best-effort: notify the console owner that their 待決議／行事曆 console was
    // refreshed. Distinct KIND + title from the personal "📋 你的 Asana 任務" ping
    // so a principal who gets both can tell them apart (待決議 console vs. tasks).
    // Guarded — a failure here must never affect the digest write.
    try {
      // Match the slot the write actually used: an agent that omits `console`
      // (single-console founder like 唐姐) writes the founder slot via the same
      // default. Using toConsoleKey here (null on absent) skipped the ping.
      const consoleKey = asConsoleKey((req.body as { console?: unknown })?.console);
      const cats = digest.categories;
      const total =
        cats.urgent.length + cats.meetings.length + cats.nonUrgent.length + cats.reminders.length;
      if (total > 0) {
        const [m] = await db
          .select({ userId: agentMemberships.userId })
          .from(agentMemberships)
          .where(and(eq(agentMemberships.agentId, req.actor.agentId), eq(agentMemberships.state, "joined")))
          .limit(1);
        if (m?.userId) {
          const day = new Date().toISOString().slice(0, 10);
          await notifications.create({
            companyId,
            userId: m.userId,
            kind: "founder_digest",
            title: `🗂️ ${CONSOLE_TITLE[consoleKey]}`,
            body: `急件 ${cats.urgent.length} · 會議 ${cats.meetings.length} · 提醒 ${cats.reminders.length} · 其他 ${cats.nonUrgent.length}（詳見儀表板裁示）`,
            link: "/dashboard",
            dedupeKey: `founder-digest:${m.userId}:${consoleKey}:${day}`,
          });
        }
      }
    } catch {
      /* console notification is best-effort */
    }
    res.json(digest);
    // Auto-post the AI 摘要 + 批閱草稿 to Asana for the 創辦人 console ONLY (rolled out
    // to 唐姐 first). Runs on every digest write — i.e. the daily 12:00 routine AND
    // any manual 更新 — but is idempotent (skips tasks that already carry the AI
    // comment) so refreshes don't stack duplicates. Private-linked items post ONLY
    // to the inner private task, never the company-visible shell (fail-closed);
    // the server is the sole writer, so a leak is structurally impossible. Runs
    // AFTER the response, fully guarded — it must never affect the digest write.
    try {
      // Resolve the SAME way the write did (absent → founder); toConsoleKey
      // returned null when 唐姐's agent omitted `console`, so this gate never
      // fired and no AI comment was posted despite a finished run.
      const consoleKey = asConsoleKey((req.body as { console?: unknown })?.console);
      const agentId = req.actor.agentId;
      if (consoleKey === "founder" && agentId) {
        const items = [...digest.categories.urgent, ...digest.categories.nonUrgent];
        void autoPostFounderAiComments(db, companyId, agentId, items)
          .then((r) =>
            logger.info(
              { companyId, agentId, items: items.length, ...r },
              "founder-digest auto-post complete",
            ),
          )
          .catch((err) => logger.warn({ err }, "founder-digest auto-post failed"));
      }
    } catch {
      /* auto-post is best-effort */
    }
  });

  // Manual refresh: the 創辦人/園長 presses "更新" on their console. Wakes their OWN
  // agent to re-run the daily digest pipeline now (re-read Asana → regenerate
  // summaries + drafts → rewrite the digest), giving on-demand control alongside
  // the scheduled run (once daily at 12:00 Asia/Taipei, Mon–Fri — see the
  // routine trigger). Never posts Asana comments or decisions.
  router.post("/companies/:companyId/founder-digest/refresh", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    const agentId = await resolveOwnAgentId(db, companyId, email);
    if (!agentId) {
      res.status(404).json({ error: "No agent is linked to your account to refresh from Asana." });
      return;
    }
    // Immediately forward the CURRENT console(s) to the caller's Google Chat —
    // server-direct, zero tokens, reliable. This no longer depends on the async
    // agent re-run producing a valid write (which could land in the wrong slot or
    // be empty), and uses a per-Taipei-hour MANUAL dedupe key so it still fires
    // after the scheduled 12:00 run already sent today's (that uses a per-DAY key).
    try {
      const wanted = toConsoleKey((req.body as { console?: unknown })?.console); // null → all caller's consoles
      const consoles = await getConsolesForUser(db, companyId, email);
      const targets = wanted ? consoles.filter((c) => c.key === wanted) : consoles;
      if (userId && targets.length > 0) {
        const hourLabel = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 13);
        for (const con of targets) {
          const cats = con.digest.categories;
          const total = cats.urgent.length + cats.meetings.length + cats.nonUrgent.length + cats.reminders.length;
          if (total === 0) continue; // nothing worth pinging about
          await notifications.create({
            companyId,
            userId,
            kind: "founder_digest",
            title: `🗂️ ${CONSOLE_TITLE[con.key]}`,
            body: `急件 ${cats.urgent.length} · 會議 ${cats.meetings.length} · 提醒 ${cats.reminders.length} · 其他 ${cats.nonUrgent.length}（詳見儀表板裁示）`,
            link: "/dashboard",
            dedupeKey: `founder-digest-manual:${userId}:${con.key}:${hourLabel}`,
          });
        }
      }
    } catch {
      /* forward is best-effort — never let it affect the refresh/wake */
    }
    // Regenerate by firing the agent's OWN daily-console routine on demand —
    // exactly what the 12:00 schedule does. This creates a routine-execution task
    // in the agent's inbox, which its normal heartbeat reliably picks up and runs
    // (re-read Asana → regenerate → POST /founder-digest → mark done). A bare
    // `wakeup` did NOT work: with an empty inbox the agent just exits without
    // running the pipeline. Each console agent owns exactly one active scheduled
    // routine, so this is unambiguous. Stranded executions auto-cancel (recovery)
    // rather than escalating to the founder.
    const [consoleRoutine] = await db
      .select({ id: routinesTable.id })
      .from(routinesTable)
      .innerJoin(
        routineTriggers,
        and(
          eq(routineTriggers.routineId, routinesTable.id),
          eq(routineTriggers.kind, "schedule"),
          eq(routineTriggers.enabled, true),
        ),
      )
      .where(
        and(
          eq(routinesTable.companyId, companyId),
          eq(routinesTable.assigneeAgentId, agentId),
          eq(routinesTable.status, "active"),
        ),
      )
      .limit(1);
    if (consoleRoutine) {
      try {
        await routineSvc.runRoutine(
          consoleRoutine.id,
          { source: "manual", idempotencyKey: `founder-refresh:${consoleRoutine.id}:${Math.floor(Date.now() / 60000)}` },
          { agentId: null, userId: userId ?? null },
        );
      } catch {
        /* a duplicate/idempotent dispatch is fine — the console will still refresh */
      }
    }
    // If no console routine is assigned to this agent (e.g. a test/preview account
    // viewing copied consoles), there is nothing to regenerate — the Chat forward
    // above already ran. The response is fine either way.
    res.json({ ok: true, regenerating: Boolean(consoleRoutine) });
  });

  // Record the founder's decision on a 待批閱 item's draft 批閱 — 核准 (approved) /
  // 請求變更 (changes_requested) / 拒絕 (rejected), with an optional note (the
  // founder's comment, suggestion, or regards). Optimistically flags the stored
  // digest, then routes the real Asana sign-off through the caller's OWN agent
  // (never the server's token): the agent posts the note as an Asana comment and
  // applies the verdict. `decision: null` (or legacy `{ approved: false }`)
  // reverts the item to undecided.
  router.post("/companies/:companyId/founder-digest/items/:gid/decision", async (req, res) => {
    const companyId = req.params.companyId as string;
    const gid = req.params.gid as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    const agentId = await resolveOwnAgentId(db, companyId, email);
    if (!agentId) {
      res.status(404).json({ error: "No agent is linked to your account to act on Asana." });
      return;
    }
    const body = (req.body ?? {}) as { decision?: unknown; note?: unknown; approved?: unknown };
    const decision: FounderDecision | null =
      body.decision === "approved" || body.decision === "changes_requested" || body.decision === "rejected"
        ? body.decision
        : body.approved === true
          ? "approved" // legacy one-button approve
          : null; // explicit reset / reopen
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) || null : null;
    // HARD privacy guard: a decision on a private-linked restricted task (its note
    // AND the verdict itself) must be applied to the inner private task, never the
    // company-visible outer shell. Resolve the enforced target first; if a private
    // link exists but can't be resolved, refuse any forward action (fail closed).
    const reviewItem = await getFounderItemByGid(db, agentId, gid);
    const target = await resolveFounderPostTargetGid(db, companyId, agentId, gid, reviewItem?.commentTargetGid ?? null);
    if (target.hasPrivateLink && target.blocked && (decision !== null || note)) {
      res.status(409).json({
        error: "此任務含私人連結，暫時無法確認私人任務位置；為保護機密資訊，裁示與留言未送出。請稍後再試。",
      });
      return;
    }
    const enforcedCommentTargetGid = target.hasPrivateLink ? target.targetGid : null;
    const digest = await setFounderItemDecision(db, agentId, gid, decision, note);
    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "founder-review-item",
      payload: { directive: "founder-review-item", taskGid: gid, commentTargetGid: enforcedCommentTargetGid, decision, note },
      idempotencyKey: `founder-review:${gid}:${decision ?? "reset"}:${Math.floor(Date.now() / 60000)}`,
      requestedByActorType: "user",
      requestedByActorId: userId ?? null,
    });
    res.json({ ok: true, digest });
  });

  // Mark a meeting/reminder item 結案 (done) or reopen it. Unlike 待批閱 items
  // (which carry a 3-way verdict), meetings/reminders have no draft to approve —
  // 結案 just clears them off the founder's board. Routes the real Asana write
  // (e.g. complete-task) through the caller's own agent.
  router.post("/companies/:companyId/founder-digest/items/:gid/close", async (req, res) => {
    const companyId = req.params.companyId as string;
    const gid = req.params.gid as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    const agentId = await resolveOwnAgentId(db, companyId, email);
    if (!agentId) {
      res.status(404).json({ error: "No agent is linked to your account to act on Asana." });
      return;
    }
    const closed = (req.body as { closed?: unknown })?.closed !== false; // default true
    const digest = await setFounderItemClosed(db, agentId, gid, closed);
    // Apply to Asana immediately with the agent's own token (instant, no heartbeat
    // wait). HARD privacy guard: complete the inner private task when the item is
    // private-linked — never the public outer shell. If the private link can't be
    // resolved, don't guess: hand off to the agent instead of touching the shell.
    const item = await getFounderItemByGid(db, agentId, gid);
    const target = await resolveFounderPostTargetGid(db, companyId, agentId, gid, item?.commentTargetGid ?? null);
    const applied = target.hasPrivateLink && target.blocked
      ? false
      : await setAsanaTaskCompleted(db, companyId, agentId, target.targetGid ?? gid, closed);
    if (!applied) {
      await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "founder-close-item",
        payload: { directive: "founder-close-item", taskGid: gid, commentTargetGid: target.hasPrivateLink ? target.targetGid : null, closed },
        idempotencyKey: `founder-close:${gid}:${closed ? "1" : "0"}:${Math.floor(Date.now() / 60000)}`,
        requestedByActorType: "user",
        requestedByActorId: userId ?? null,
      });
    }
    res.json({ ok: true, digest });
  });

  // Post a free-form comment to an item's thread — decision-independent (unlike
  // the optional note on a verdict, this does NOT decide the item). Optimistically
  // appends the founder's reply (pending) to the stored digest, then routes the
  // real Asana comment through the caller's OWN agent, which posts it as a story
  // and reconciles the thread (confirmed Asana history) on its next digest write.
  router.post("/companies/:companyId/founder-digest/items/:gid/comment", async (req, res) => {
    const companyId = req.params.companyId as string;
    const gid = req.params.gid as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    const email = await emailForUserId(db, userId);
    const agentId = await resolveOwnAgentId(db, companyId, email);
    if (!agentId) {
      res.status(404).json({ error: "No agent is linked to your account to act on Asana." });
      return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 2000) : "";
    if (!text) {
      res.status(400).json({ error: "A non-empty comment is required." });
      return;
    }
    // HARD privacy guard: if this item is a private-linked restricted task, the
    // comment MUST land on the inner private task, NEVER the company-visible outer
    // shell. Fail closed — if the private link can't be resolved, refuse to post
    // rather than leak classified content.
    const commentItem = await getFounderItemByGid(db, agentId, gid);
    const target = await resolveFounderPostTargetGid(db, companyId, agentId, gid, commentItem?.commentTargetGid ?? null);
    if (target.hasPrivateLink && target.blocked) {
      res.status(409).json({
        error: "此任務含私人連結，暫時無法確認私人任務位置；為保護機密資訊，留言未張貼。請稍後再試。",
      });
      return;
    }
    const commentTargetGid = target.hasPrivateLink ? target.targetGid : null;
    const posted = await postAsanaComment(db, companyId, agentId, target.targetGid ?? gid, text);
    const id = `pending-${randomUUID()}`;
    const digest = await appendFounderItemComment(db, agentId, gid, {
      id,
      author: null, // labelled "您" in the UI; the agent fills the real name on reconcile
      authorType: "founder",
      text,
      createdAt: new Date().toISOString(),
      ...(posted ? {} : { pending: true }),
    });
    if (!posted) {
      await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "founder-comment",
        payload: { directive: "founder-comment", taskGid: gid, commentTargetGid, text, commentId: id },
        idempotencyKey: `founder-comment:${id}`,
        requestedByActorType: "user",
        requestedByActorId: userId ?? null,
      });
    }
    res.json({ ok: true, digest });
  });

  // The agent stores its OWN Asana token here, the moment a user provides it —
  // writes the canonical connection file AND wires ASANA_TOKEN_PATH atomically,
  // so onboarding can never leave a token "saved but not wired" / chat-only.
  router.post("/companies/:companyId/connections/asana", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId || req.actor.companyId !== companyId) {
      res.status(403).json({ error: "Only the owning agent may store its token." });
      return;
    }
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    try {
      await storeAsanaTokenForAgent(db, companyId, req.actor.agentId, token, {
        readOnly: req.body?.readOnly === true,
        defaultWorkspace: typeof req.body?.defaultWorkspace === "string" ? req.body.defaultWorkspace : null,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  return router;
}
