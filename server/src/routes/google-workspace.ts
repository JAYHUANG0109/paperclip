import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { createDraft, getMail, gmailReadiness, listDrafts, searchMail } from "../services/google-gmail.js";
import {
  chatUserReadiness,
  listSpaceMessages,
  listUserSpaces,
  searchUserChatHistory,
  type ChatReadAudit,
} from "../services/google-chat-user.js";

/**
 * Agent- and board-facing routes for Gmail and Google Chat history.
 *
 * These are the surface agents actually use: a local agent calls the Paperclip REST
 * API with its agent token, exactly as it already does for the calendar routes in
 * dashboard.ts. That is deliberate — the shared claude.ai Google MCP connectors are
 * blocked at the adapter layer for being flaky, so Google access goes through this
 * server-side path with per-user tokens and automatic refresh.
 *
 * ─── Whose mailbox / chats? ────────────────────────────────────────────────
 * Same resolution as the calendar routes: a board user acts as themselves, and an
 * agent acts as the user it is paired with (`onBehalfOfUserId`). There is no
 * parameter for "read someone else's mail" — the effective user comes from the
 * authenticated actor, so one agent cannot reach another user's data even if it
 * asks. Anything beyond that would need a deliberate impersonation design.
 *
 * ─── Sensitivity ──────────────────────────────────────────────────────────
 * Mail and chat reads are logged to activity_log (who read what, and how much),
 * because "an agent read my DMs" needs to be answerable after the fact. Bodies are
 * never returned unless explicitly requested.
 */

/** Board user → themselves; agent → the user it works for. Null when neither. */
function effectiveUserId(req: Request): string | null {
  if (req.actor.type === "board") return req.actor.userId ?? null;
  if (req.actor.type === "agent") return req.actor.onBehalfOfUserId ?? null;
  return null;
}

/** activity_log wants a narrower actorType than req.actor.type carries. */
function actorFor(req: Request): { actorType: "agent" | "user" | "system"; actorId: string } {
  if (req.actor.type === "agent") return { actorType: "agent", actorId: req.actor.agentId ?? "unknown-agent" };
  if (req.actor.type === "board") return { actorType: "user", actorId: req.actor.userId ?? "unknown-user" };
  return { actorType: "system", actorId: "system" };
}

function notConnected(reason: string) {
  return { connected: false as const, reason };
}

export function googleWorkspaceRoutes(db: Db) {
  const router = Router();

  /**
   * Record that a read happened — actor, target and count only, never the message
   * or mail contents. Auditing must never fail the read itself: the read is already
   * scoped to the caller, so a logging outage is not a security boundary.
   */
  async function audit(
    req: Request,
    companyId: string,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const { actorType, actorId } = actorFor(req);
    try {
      await logActivity(db, { companyId, actorType, actorId, action, entityType, entityId, details });
    } catch {
      /* ignore */
    }
  }

  /** Audit sink handed to the chat service. */
  function chatAudit(req: Request, companyId: string): ChatReadAudit {
    return (event) =>
      audit(req, companyId, event.action, "google_chat", event.spaceName ?? event.userId, {
        onBehalfOfUserId: event.userId,
        spaceName: event.spaceName ?? null,
        resultCount: event.resultCount,
      });
  }

  // ── Gmail ───────────────────────────────────────────────────────────────

  /** Can this caller use Gmail features yet (scope granted + refreshable)? */
  router.get("/companies/:companyId/gmail/readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ configured: false, canRead: false, canDraft: false });
      return;
    }
    res.json(await gmailReadiness(db, userId));
  });

  /**
   * Search the caller's own mail. `q` is Gmail search syntax, so triage questions
   * are expressible without extra endpoints: `is:unread`, `newer_than:2d`,
   * `from:someone@example.com`. Returns headers + snippet only.
   */
  router.get("/companies/:companyId/gmail/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ ...notConnected("auth_required"), messages: [] });
      return;
    }
    const limit = Number(req.query.limit ?? 20);
    const result = await searchMail(db, userId, {
      query: typeof req.query.q === "string" ? req.query.q : undefined,
      maxResults: Number.isFinite(limit) ? limit : 20,
    });
    if (!result.connected) {
      res.json({ ...notConnected(result.reason), messages: [] });
      return;
    }
    await audit(req, companyId, "gmail.search", "gmail", userId, {
      onBehalfOfUserId: userId,
      resultCount: result.data.length,
    });
    res.json({ connected: true, messages: result.data });
  });

  /**
   * Read one message. Defaults to metadata (headers + snippet); `?format=full`
   * pulls the body, which is the sensitive path and is logged as such.
   */
  router.get("/companies/:companyId/gmail/messages/:messageId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json(notConnected("auth_required"));
      return;
    }
    const format = req.query.format === "full" ? "full" : "metadata";
    const result = await getMail(db, userId, req.params.messageId as string, { format });
    if (!result.connected) {
      res.json(notConnected(result.reason));
      return;
    }
    await audit(
      req,
      companyId,
      format === "full" ? "gmail.read_body" : "gmail.read_metadata",
      "gmail",
      req.params.messageId as string,
      { onBehalfOfUserId: userId, format },
    );
    res.json({ connected: true, message: result.data });
  });

  /** List the caller's drafts (ids/thread refs only). */
  router.get("/companies/:companyId/gmail/drafts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ ...notConnected("auth_required"), drafts: [] });
      return;
    }
    const result = await listDrafts(db, userId, {});
    if (!result.connected) {
      res.json({ ...notConnected(result.reason), drafts: [] });
      return;
    }
    res.json({ connected: true, drafts: result.data });
  });

  /**
   * Create a DRAFT. Nothing is sent: the draft lands in the user's Gmail for them
   * to review and send. There is intentionally no send endpoint here — see
   * services/google-gmail.ts for why that guarantee lives in code.
   */
  router.post("/companies/:companyId/gmail/drafts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject : "";
    const bodyText = typeof body.bodyText === "string" ? body.bodyText : "";
    if (!to || !subject || !bodyText) {
      res.status(400).json({ error: "to, subject and bodyText are required" });
      return;
    }
    const result = await createDraft(db, userId, {
      to,
      subject,
      bodyText,
      cc: typeof body.cc === "string" ? body.cc : undefined,
      threadId: typeof body.threadId === "string" ? body.threadId : undefined,
      inReplyTo: typeof body.inReplyTo === "string" ? body.inReplyTo : undefined,
    });
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "gmail.draft_created", "gmail", result.data.draftId, {
      onBehalfOfUserId: userId,
      draftId: result.data.draftId,
      to,
    });
    res.status(201).json({ connected: true, draft: result.data });
  });

  // ── Google Chat history ─────────────────────────────────────────────────

  router.get("/companies/:companyId/google-chat/readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ configured: false, canListSpaces: false, canReadMessages: false });
      return;
    }
    res.json(await chatUserReadiness(db, userId));
  });

  /** The spaces/DMs the caller belongs to. */
  router.get("/companies/:companyId/google-chat/spaces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ ...notConnected("auth_required"), spaces: [] });
      return;
    }
    const result = await listUserSpaces(db, userId, { audit: chatAudit(req, companyId) });
    if (!result.connected) {
      res.json({ ...notConnected(result.reason), spaces: [] });
      return;
    }
    res.json({ connected: true, spaces: result.data });
  });

  /**
   * Messages in one space. `spaceName` is Google's resource name ("spaces/AAA");
   * membership is enforced by Google because the call uses the caller's own token.
   */
  router.get("/companies/:companyId/google-chat/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ ...notConnected("auth_required"), messages: [] });
      return;
    }
    const spaceName = typeof req.query.space === "string" ? req.query.space : "";
    if (!spaceName.startsWith("spaces/")) {
      res.status(400).json({ error: "space must be a Google Chat resource name, e.g. spaces/AAA" });
      return;
    }
    const size = Number(req.query.limit ?? 50);
    const result = await listSpaceMessages(db, userId, spaceName, {
      pageSize: Number.isFinite(size) ? size : 50,
      filter: typeof req.query.since === "string" ? `createTime > "${req.query.since}"` : undefined,
      audit: chatAudit(req, companyId),
    });
    if (!result.connected) {
      res.json({ ...notConnected(result.reason), messages: [] });
      return;
    }
    res.json({ connected: true, messages: result.data });
  });

  /**
   * "Look through my chat history" — bounded sweep across the caller's spaces.
   * `q` matches message text case-insensitively; `since` (RFC3339) narrows the
   * window and should be used whenever the question allows it.
   */
  router.get("/companies/:companyId/google-chat/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ ...notConnected("auth_required"), results: [] });
      return;
    }
    const maxSpaces = Number(req.query.maxSpaces ?? 20);
    const perSpace = Number(req.query.perSpace ?? 30);
    const result = await searchUserChatHistory(db, userId, {
      query: typeof req.query.q === "string" ? req.query.q : undefined,
      sinceIso: typeof req.query.since === "string" ? req.query.since : undefined,
      maxSpaces: Number.isFinite(maxSpaces) ? maxSpaces : 20,
      perSpace: Number.isFinite(perSpace) ? perSpace : 30,
      audit: chatAudit(req, companyId),
    });
    if (!result.connected) {
      res.json({ ...notConnected(result.reason), results: [] });
      return;
    }
    res.json({ connected: true, results: result.data });
  });

  return router;
}
