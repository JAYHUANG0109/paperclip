import { and, eq } from "drizzle-orm";
import { authAccounts, type Db } from "@paperclipai/db";

/**
 * Gmail integration (read + draft). Same model as google-calendar.ts and
 * google-drive.ts: reuse the OAuth token better-auth stores at SSO login
 * (`account` table, provider "google") and act with each caller's OWN token, so
 * per-user isolation is structural — there is no code path that reads another
 * user's mailbox.
 *
 * ─── Deliberately NO send ──────────────────────────────────────────────────
 * There is no `sendMessage` here, and that is the point. Google has no
 * "draft but never send" scope: `gmail.compose` grants drafting AND sending, so
 * the guarantee that agents cannot send mail on a human's behalf cannot come from
 * the scope — it has to come from this file not implementing it. Agents draft;
 * a human presses send in Gmail. If sending is ever wanted, it should arrive as
 * an explicit, separately-reviewed change that routes through the approval-card
 * flow, not as a quiet helper added next to the draft path.
 *
 * ─── Least exposure by default ─────────────────────────────────────────────
 * Triage rarely needs message bodies, so reads default to Gmail's `metadata`
 * format (headers + snippet only). Full bodies require an explicit
 * `format: "full"` at the call site, which keeps the sensitive path visible in
 * code review rather than incidental.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Read scope — list/search/read the caller's own mail. */
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/**
 * Draft scope. NOTE: this scope can also send; see the header comment. We request
 * it for drafting only and never implement a send call.
 */
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
/**
 * Not requested yet. `gmail.modify` is what labels/archive/mark-read would need.
 * Left out until that workflow is actually built, to keep the consent screen (and
 * the blast radius) as small as the current features justify.
 */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** Refresh a little before actual expiry to avoid mid-request 401s. */
const EXPIRY_SKEW_MS = 60_000;
/** Hard cap so an agent cannot accidentally pull a whole mailbox in one call. */
const MAX_RESULTS_CAP = 50;

export interface GmailHeaderSummary {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  /** RFC2822 Date header, as returned by Gmail. */
  date: string | null;
  /** Gmail's own short preview — no body fetch required. */
  snippet: string | null;
  labelIds: string[];
  unread: boolean;
}

export interface GmailMessageBody extends GmailHeaderSummary {
  /** Plain-text body when one could be extracted, else null. */
  bodyText: string | null;
}

export interface GmailDraftRef {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
}

export type GmailResult<T> =
  | { connected: true; data: T }
  | { connected: false; reason: "auth_required" | "not_configured" | "scope_missing" };

function googleClientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** The Google `account` row for a user, if they signed in with Google. */
async function getGoogleAccount(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "google")))
    .limit(1);
  return row ?? null;
}

/**
 * Return a valid Google access token carrying `requiredScope` for the user,
 * refreshing via the stored refresh_token when needed. Returns null when the user
 * has no Google account, hasn't consented to the scope, or has no usable refresh
 * path — callers surface that as `auth_required` so the UI can prompt a re-consent.
 */
async function getAccessTokenForUser(
  db: Db,
  userId: string,
  requiredScope: string,
): Promise<string | null> {
  const creds = googleClientCreds();
  if (!creds) return null;
  const account = await getGoogleAccount(db, userId);
  if (!account) return null;

  // The token must actually carry the scope — tokens issued before the scope was
  // added (or for users who declined it) cannot be used for this operation.
  if (!account.scope || !account.scope.includes(requiredScope)) return null;

  const now = Date.now();
  const notExpired =
    account.accessToken &&
    account.accessTokenExpiresAt &&
    account.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > now;
  if (notExpired && account.accessToken) return account.accessToken;

  if (!account.refreshToken) return null;
  try {
    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string };
    if (!json.access_token) return null;
    const expiresAt = json.expires_in ? new Date(now + json.expires_in * 1000) : null;
    await db
      .update(authAccounts)
      .set({
        accessToken: json.access_token,
        accessTokenExpiresAt: expiresAt,
        ...(json.scope ? { scope: json.scope } : {}),
        updatedAt: new Date(),
      })
      .where(eq(authAccounts.id, account.id));
    return json.access_token;
  } catch {
    return null;
  }
}

type GmailApiHeader = { name?: string; value?: string };
type GmailApiPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailApiPart[];
};
type GmailApiMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailApiPart & { headers?: GmailApiHeader[] };
};

function header(headers: GmailApiHeader[] | undefined, name: string): string | null {
  const hit = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return hit?.value ?? null;
}

function summarize(msg: GmailApiMessage): GmailHeaderSummary {
  const headers = msg.payload?.headers;
  const labelIds = msg.labelIds ?? [];
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    from: header(headers, "From"),
    to: header(headers, "To"),
    subject: header(headers, "Subject"),
    date: header(headers, "Date"),
    snippet: msg.snippet ?? null,
    labelIds,
    unread: labelIds.includes("UNREAD"),
  };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Depth-first search for the first text/plain part; falls back to a bare body. */
function extractPlainText(part: GmailApiPart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const found = extractPlainText(child);
    if (found) return found;
  }
  if (!part.mimeType?.startsWith("multipart/") && part.body?.data) return decodeBase64Url(part.body.data);
  return null;
}

async function gmailFetch(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Search the caller's mail. `query` is Gmail search syntax, so the callers that
 * matter are expressible without new API surface: `is:unread`,
 * `newer_than:2d`, `from:parent@example.com`, `has:attachment`, etc.
 *
 * Returns header summaries only — no bodies are fetched here.
 */
export async function searchMail(
  db: Db,
  userId: string,
  input: { query?: string; maxResults?: number } = {},
): Promise<GmailResult<GmailHeaderSummary[]>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId, GMAIL_READ_SCOPE);
  if (!token) return { connected: false, reason: "auth_required" };

  const max = Math.min(Math.max(1, input.maxResults ?? 20), MAX_RESULTS_CAP);
  const params = new URLSearchParams({ maxResults: String(max) });
  if (input.query?.trim()) params.set("q", input.query.trim());

  const listRes = await gmailFetch(token, `/messages?${params.toString()}`);
  if (!listRes.ok) return { connected: false, reason: listRes.status === 403 ? "scope_missing" : "auth_required" };
  const list = (await listRes.json()) as { messages?: { id: string }[] };
  const ids = (list.messages ?? []).map((m) => m.id).filter(Boolean);

  // Metadata format: headers + snippet, no body. Sequential-with-cap rather than a
  // full fan-out so one agent call cannot burst dozens of Gmail requests at once.
  const out: GmailHeaderSummary[] = [];
  for (const id of ids) {
    const res = await gmailFetch(
      token,
      `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
    );
    if (!res.ok) continue;
    out.push(summarize((await res.json()) as GmailApiMessage));
  }
  return { connected: true, data: out };
}

/**
 * Read one message. Defaults to metadata; pass `format: "full"` to pull the body,
 * which is the sensitive path and should be requested explicitly.
 */
export async function getMail(
  db: Db,
  userId: string,
  messageId: string,
  opts: { format?: "metadata" | "full" } = {},
): Promise<GmailResult<GmailMessageBody>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId, GMAIL_READ_SCOPE);
  if (!token) return { connected: false, reason: "auth_required" };

  const format = opts.format ?? "metadata";
  const res = await gmailFetch(token, `/messages/${encodeURIComponent(messageId)}?format=${format}`);
  if (!res.ok) return { connected: false, reason: res.status === 403 ? "scope_missing" : "auth_required" };
  const msg = (await res.json()) as GmailApiMessage;
  return {
    connected: true,
    data: { ...summarize(msg), bodyText: format === "full" ? extractPlainText(msg.payload) : null },
  };
}

/** RFC2822 message, base64url encoded, as Gmail's drafts API expects. */
function buildRawMessage(input: {
  to: string;
  cc?: string;
  subject: string;
  bodyText: string;
  inReplyTo?: string;
}): string {
  const lines = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${input.subject}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    input.bodyText,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Create a DRAFT in the caller's mailbox. Nothing is sent — the draft lands in
 * Gmail for the human to review, edit and send themselves. Pass `threadId` to
 * attach the draft as a reply within an existing thread.
 */
export async function createDraft(
  db: Db,
  userId: string,
  input: { to: string; cc?: string; subject: string; bodyText: string; threadId?: string; inReplyTo?: string },
): Promise<GmailResult<GmailDraftRef>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId, GMAIL_COMPOSE_SCOPE);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await gmailFetch(token, "/drafts", {
    method: "POST",
    body: JSON.stringify({
      message: {
        raw: buildRawMessage(input),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    }),
  });
  if (!res.ok) return { connected: false, reason: res.status === 403 ? "scope_missing" : "auth_required" };
  const json = (await res.json()) as { id?: string; message?: { id?: string; threadId?: string } };
  return {
    connected: true,
    data: {
      draftId: json.id ?? "",
      messageId: json.message?.id ?? null,
      threadId: json.message?.threadId ?? null,
    },
  };
}

/** List the caller's existing drafts (ids + thread refs only). */
export async function listDrafts(
  db: Db,
  userId: string,
  input: { maxResults?: number } = {},
): Promise<GmailResult<GmailDraftRef[]>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId, GMAIL_COMPOSE_SCOPE);
  if (!token) return { connected: false, reason: "auth_required" };

  const max = Math.min(Math.max(1, input.maxResults ?? 20), MAX_RESULTS_CAP);
  const res = await gmailFetch(token, `/drafts?maxResults=${max}`);
  if (!res.ok) return { connected: false, reason: res.status === 403 ? "scope_missing" : "auth_required" };
  const json = (await res.json()) as { drafts?: { id?: string; message?: { id?: string; threadId?: string } }[] };
  return {
    connected: true,
    data: (json.drafts ?? []).map((d) => ({
      draftId: d.id ?? "",
      messageId: d.message?.id ?? null,
      threadId: d.message?.threadId ?? null,
    })),
  };
}

/**
 * Whether this user could use Gmail features right now — used by the UI to show
 * "connect Gmail" instead of failing a call. Mirrors the calendar/drive helpers.
 */
export async function gmailReadiness(
  db: Db,
  userId: string,
): Promise<{ configured: boolean; canRead: boolean; canDraft: boolean }> {
  const configured = googleClientCreds() !== null;
  if (!configured) return { configured: false, canRead: false, canDraft: false };
  const account = await getGoogleAccount(db, userId);
  const scope = account?.scope ?? "";
  const refreshable = Boolean(account?.refreshToken);
  return {
    configured: true,
    canRead: refreshable && scope.includes(GMAIL_READ_SCOPE),
    canDraft: refreshable && scope.includes(GMAIL_COMPOSE_SCOPE),
  };
}
