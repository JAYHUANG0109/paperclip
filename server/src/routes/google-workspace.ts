import { Router } from "express";
import type { Request, RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { markRunReadPrivateSource } from "../services/private-source-runs.js";
import { createDraft, getMail, gmailReadiness, listDrafts, searchMail } from "../services/google-gmail.js";
import {
  appendRows,
  createSpreadsheet,
  getSpreadsheet,
  parseSpreadsheetId,
  readRange,
  sheetsReadiness,
  updateRange,
} from "../services/google-sheets.js";
import {
  appendText as appendDocText,
  createDocument,
  docsReadiness,
  getDocument,
  parseDocumentId,
  replaceText as replaceDocText,
} from "../services/google-docs.js";
import {
  addSlide,
  createPresentation,
  getPresentation,
  insertText,
  parsePresentationId,
  replaceText,
  slidesReadiness,
} from "../services/google-slides.js";
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
    // Mark the run as having touched private data. Comments it writes get tagged
    // with metadata.privateSource, and its stdout excerpt is not persisted — see
    // services/private-source-runs.ts.
    markRunReadPrivateSource(req.actor.runId ?? null);
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

  /**
   * `…/gmail/me` — recent mail for the caller, mirroring the `google-calendar/me`
   * convention. This alias exists because that convention is what agents guess
   * first: an agent looking for Gmail tried `gmail/me` and `google-gmail/me`, got
   * 404 on both, and concluded "no Paperclip Gmail endpoint exists" before falling
   * back to the shared claude.ai MCP connector. Cheap alias, one less dead end.
   */
  const recentMail: RequestHandler = async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ ...notConnected("auth_required"), messages: [] });
      return;
    }
    const limit = Number(req.query.limit ?? 20);
    const result = await searchMail(db, userId, {
      query: typeof req.query.q === "string" && req.query.q.trim() ? req.query.q : "in:inbox",
      maxResults: Number.isFinite(limit) ? limit : 20,
    });
    if (!result.connected) {
      res.json({ ...notConnected(result.reason), messages: [] });
      return;
    }
    await audit(req, companyId, "gmail.search", "gmail", userId, {
      onBehalfOfUserId: userId,
      resultCount: result.data.length,
      via: "me",
    });
    res.json({ connected: true, messages: result.data });
  };
  router.get("/companies/:companyId/gmail/me", recentMail);
  router.get("/companies/:companyId/google-gmail/me", recentMail);

  // ── Google Sheets ───────────────────────────────────────────────────────
  // Per-user: an agent reads and writes exactly the spreadsheets its responsible human
  // can. For shared company sheets on a service account with an id allowlist, that is
  // packages/google-sheets-mcp-server instead — the two coexist deliberately.

  router.get("/companies/:companyId/google-sheets/readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ configured: false, canUse: false });
      return;
    }
    res.json(await sheetsReadiness(db, userId));
  });

  /**
   * Tabs + sizes for one spreadsheet. `id` accepts a bare id OR a pasted Sheets URL,
   * because the URL is what a human actually has to hand.
   */
  router.get("/companies/:companyId/google-sheets/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json(notConnected("auth_required"));
      return;
    }
    const spreadsheetId = parseSpreadsheetId(req.params.id as string);
    if (!spreadsheetId) {
      res.status(400).json({ error: "id must be a spreadsheet id or a Google Sheets URL" });
      return;
    }
    const result = await getSpreadsheet(db, userId, spreadsheetId);
    if (!result.connected) {
      res.json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "sheets.read_metadata", "google_sheets", spreadsheetId, {
      onBehalfOfUserId: userId,
      tabs: result.data.tabs.length,
    });
    res.json({ connected: true, spreadsheet: result.data });
  });

  /** Read an A1 range, e.g. ?range=工作表1!A1:F50 */
  router.get("/companies/:companyId/google-sheets/:id/values", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ ...notConnected("auth_required"), values: [] });
      return;
    }
    const spreadsheetId = parseSpreadsheetId(req.params.id as string);
    const range = typeof req.query.range === "string" ? req.query.range : "";
    if (!spreadsheetId || !range) {
      res.status(400).json({ error: "a spreadsheet id/URL and ?range= are required" });
      return;
    }
    const result = await readRange(db, userId, spreadsheetId, range);
    if (!result.connected) {
      res.json({ ...notConnected(result.reason), values: [] });
      return;
    }
    await audit(req, companyId, "sheets.read_values", "google_sheets", spreadsheetId, {
      onBehalfOfUserId: userId,
      range,
      rows: result.data.values.length,
    });
    res.json({ connected: true, ...result.data });
  });

  /** Append rows below the existing data — the safe write. */
  router.post("/companies/:companyId/google-sheets/:id/append", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const spreadsheetId = parseSpreadsheetId(req.params.id as string);
    const range = typeof req.body?.range === "string" ? req.body.range : "";
    const values = Array.isArray(req.body?.values) ? (req.body.values as string[][]) : null;
    if (!spreadsheetId || !range || !values) {
      res.status(400).json({ error: "spreadsheet id/URL, range and values[][] are required" });
      return;
    }
    const result = await appendRows(db, userId, spreadsheetId, range, values);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "sheets.append", "google_sheets", spreadsheetId, {
      onBehalfOfUserId: userId,
      range,
      rows: values.length,
    });
    res.json({ connected: true, ...result.data });
  });

  /**
   * Overwrite an explicit range. Separate from append because this is how a routine
   * silently destroys someone's hand-edited rows — the caller has to mean it.
   */
  router.put("/companies/:companyId/google-sheets/:id/values", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const spreadsheetId = parseSpreadsheetId(req.params.id as string);
    const range = typeof req.body?.range === "string" ? req.body.range : "";
    const values = Array.isArray(req.body?.values) ? (req.body.values as string[][]) : null;
    if (!spreadsheetId || !range || !values) {
      res.status(400).json({ error: "spreadsheet id/URL, range and values[][] are required" });
      return;
    }
    const result = await updateRange(db, userId, spreadsheetId, range, values);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "sheets.overwrite", "google_sheets", spreadsheetId, {
      onBehalfOfUserId: userId,
      range,
      rows: values.length,
    });
    res.json({ connected: true, ...result.data });
  });

  /** Create a new spreadsheet owned by the caller. */
  router.post("/companies/:companyId/google-sheets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const result = await createSpreadsheet(db, userId, title);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "sheets.created", "google_sheets", result.data.spreadsheetId, {
      onBehalfOfUserId: userId,
      title,
    });
    res.status(201).json({ connected: true, spreadsheet: result.data });
  });

  // ── Google Docs ─────────────────────────────────────────────────────────
  // Created docs are filed into "Paperclip 產出檔案". There is no "replace the whole
  // document" endpoint on purpose — fill a template or append; do not overwrite
  // someone's writing.

  router.get("/companies/:companyId/google-docs/readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ configured: false, canUse: false });
      return;
    }
    res.json(await docsReadiness(db, userId));
  });

  /** Title + body text. `id` accepts a pasted Google Docs URL. */
  router.get("/companies/:companyId/google-docs/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json(notConnected("auth_required"));
      return;
    }
    const documentId = parseDocumentId(req.params.id as string);
    if (!documentId) {
      res.status(400).json({ error: "id must be a document id or a Google Docs URL" });
      return;
    }
    const result = await getDocument(db, userId, documentId);
    if (!result.connected) {
      res.json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "docs.read", "google_docs", documentId, {
      onBehalfOfUserId: userId,
      chars: result.data.text.length,
      truncated: result.data.truncated,
    });
    res.json({ connected: true, document: result.data });
  });

  /** Create a document (filed into the output folder). */
  router.post("/companies/:companyId/google-docs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const result = await createDocument(db, userId, title);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "docs.created", "google_docs", result.data.documentId, {
      onBehalfOfUserId: userId,
      title,
      filedInOutputFolder: result.data.filedInOutputFolder,
    });
    res.status(201).json({ connected: true, document: result.data });
  });

  /** Fill a template — replace {{placeholders}} throughout. */
  router.post("/companies/:companyId/google-docs/:id/replace-text", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const documentId = parseDocumentId(req.params.id as string);
    const raw = Array.isArray(req.body?.replacements) ? (req.body.replacements as unknown[]) : null;
    const replacements = (raw ?? [])
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
      .filter((r): r is Record<string, unknown> => Boolean(r))
      .filter((r) => typeof r.find === "string" && (r.find as string).length > 0)
      .map((r) => ({
        find: r.find as string,
        replace: typeof r.replace === "string" ? (r.replace as string) : "",
        matchCase: r.matchCase === true,
      }));
    if (!documentId || replacements.length === 0) {
      res.status(400).json({ error: "a document id/URL and replacements[{find,replace}] are required" });
      return;
    }
    const result = await replaceDocText(db, userId, documentId, replacements);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "docs.replace_text", "google_docs", documentId, {
      onBehalfOfUserId: userId,
      replacements: replacements.length,
    });
    res.json({ connected: true, ...result.data });
  });

  /** Append at the end of the body — the safe write. */
  router.post("/companies/:companyId/google-docs/:id/append", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const documentId = parseDocumentId(req.params.id as string);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!documentId || !text) {
      res.status(400).json({ error: "a document id/URL and text are required" });
      return;
    }
    const result = await appendDocText(db, userId, documentId, text);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "docs.append", "google_docs", documentId, {
      onBehalfOfUserId: userId,
      chars: text.length,
    });
    res.json({ connected: true, ...result.data });
  });

  // ── Google Slides ───────────────────────────────────────────────────────
  // Decks created here are filed into the user's "Paperclip 產出檔案" folder rather than
  // left in My Drive root. Artifact upload is still the path for a finished deliverable
  // (tracked, shows on the task); a native deck is for documents people keep editing.

  router.get("/companies/:companyId/google-slides/readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json({ configured: false, canUse: false });
      return;
    }
    res.json(await slidesReadiness(db, userId));
  });

  /** Deck title, slide ids and the text on each slide. `id` accepts a pasted Slides URL. */
  router.get("/companies/:companyId/google-slides/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.json(notConnected("auth_required"));
      return;
    }
    const presentationId = parsePresentationId(req.params.id as string);
    if (!presentationId) {
      res.status(400).json({ error: "id must be a presentation id or a Google Slides URL" });
      return;
    }
    const result = await getPresentation(db, userId, presentationId);
    if (!result.connected) {
      res.json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "slides.read", "google_slides", presentationId, {
      onBehalfOfUserId: userId,
      slides: result.data.slideCount,
    });
    res.json({ connected: true, presentation: result.data });
  });

  /** Create a deck. See the note above about deliverables vs co-edited decks. */
  router.post("/companies/:companyId/google-slides", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const result = await createPresentation(db, userId, title);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "slides.created", "google_slides", result.data.presentationId, {
      onBehalfOfUserId: userId,
      title,
    });
    res.status(201).json({ connected: true, presentation: result.data });
  });

  /**
   * Fill a template deck — replace {{placeholders}} across every slide. This is the
   * primary write path: it only touches text the template author marked, so it cannot
   * quietly mangle a slide the way free-form editing can.
   */
  router.post("/companies/:companyId/google-slides/:id/replace-text", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const presentationId = parsePresentationId(req.params.id as string);
    const raw = Array.isArray(req.body?.replacements) ? (req.body.replacements as unknown[]) : null;
    const replacements = (raw ?? [])
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
      .filter((r): r is Record<string, unknown> => Boolean(r))
      .filter((r) => typeof r.find === "string" && (r.find as string).length > 0)
      .map((r) => ({
        find: r.find as string,
        replace: typeof r.replace === "string" ? (r.replace as string) : "",
        matchCase: r.matchCase === true,
      }));
    if (!presentationId || replacements.length === 0) {
      res.status(400).json({ error: "a presentation id/URL and replacements[{find,replace}] are required" });
      return;
    }
    const result = await replaceText(db, userId, presentationId, replacements);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "slides.replace_text", "google_slides", presentationId, {
      onBehalfOfUserId: userId,
      replacements: replacements.length,
    });
    res.json({ connected: true, ...result.data });
  });

  /** Add a slide, optionally at an index / with a predefined layout. */
  router.post("/companies/:companyId/google-slides/:id/slides", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const presentationId = parsePresentationId(req.params.id as string);
    if (!presentationId) {
      res.status(400).json({ error: "id must be a presentation id or a Google Slides URL" });
      return;
    }
    const insertionIndex = Number(req.body?.insertionIndex);
    const result = await addSlide(db, userId, presentationId, {
      ...(Number.isFinite(insertionIndex) ? { insertionIndex } : {}),
      ...(typeof req.body?.layout === "string" ? { layout: req.body.layout } : {}),
    });
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "slides.add_slide", "google_slides", presentationId, {
      onBehalfOfUserId: userId,
    });
    res.status(201).json({ connected: true, ...result.data });
  });

  /** Type text into one shape, addressed by an objectId from the GET above. */
  router.post("/companies/:companyId/google-slides/:id/text", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = effectiveUserId(req);
    if (!userId) {
      res.status(422).json(notConnected("auth_required"));
      return;
    }
    const presentationId = parsePresentationId(req.params.id as string);
    const objectId = typeof req.body?.objectId === "string" ? req.body.objectId.trim() : "";
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!presentationId || !objectId || !text) {
      res.status(400).json({ error: "presentation id/URL, objectId and text are required" });
      return;
    }
    const result = await insertText(db, userId, presentationId, objectId, text);
    if (!result.connected) {
      res.status(422).json(notConnected(result.reason));
      return;
    }
    await audit(req, companyId, "slides.insert_text", "google_slides", presentationId, {
      onBehalfOfUserId: userId,
      objectId,
    });
    res.json({ connected: true, ...result.data });
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
