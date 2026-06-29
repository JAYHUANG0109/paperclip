import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemberships } from "@paperclipai/db";
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
  type FounderDecision,
} from "../services/founder-digest.js";
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

export function dashboardRoutes(db: Db, options: { restrictVisibility?: boolean } = {}) {
  const restrictVisibility = options.restrictVisibility ?? false;
  const router = Router();
  const svc = dashboardService(db);
  const heartbeat = heartbeatService(db);
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
    const digest = await getAsanaDigestForUser(db, companyId, email);
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
    const digest = await setDigestTaskCompleted(db, agentId, gid, completed);
    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: completed ? "complete-asana-task" : "reopen-asana-task",
      payload: { directive: completed ? "complete-asana-task" : "reopen-asana-task", taskGid: gid },
      idempotencyKey: `asana-task-complete:${gid}:${completed ? "1" : "0"}:${Math.floor(Date.now() / 60000)}`,
      requestedByActorType: "user",
      requestedByActorId: userId ?? null,
    });
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

  // The agent writes its OWN founder digest (agent-only, self-scoped).
  router.post("/companies/:companyId/founder-digest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId || req.actor.companyId !== companyId) {
      res.status(403).json({ error: "Only the owning agent may write its founder digest." });
      return;
    }
    const digest = await writeFounderDigestForAgent(db, companyId, req.actor.agentId, req.body);
    res.json(digest);
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
    const digest = await setFounderItemDecision(db, agentId, gid, decision, note);
    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "founder-review-item",
      payload: { directive: "founder-review-item", taskGid: gid, decision, note },
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
    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "founder-close-item",
      payload: { directive: "founder-close-item", taskGid: gid, closed },
      idempotencyKey: `founder-close:${gid}:${closed ? "1" : "0"}:${Math.floor(Date.now() / 60000)}`,
      requestedByActorType: "user",
      requestedByActorId: userId ?? null,
    });
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
