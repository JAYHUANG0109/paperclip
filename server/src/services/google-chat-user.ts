import { and, eq } from "drizzle-orm";
import { authAccounts, type Db } from "@paperclipai/db";

/**
 * Google Chat, read as the USER (not as the bot).
 *
 * The existing google-chat plugin authenticates as the Chat *app* (`chat.bot`),
 * which can only see spaces the bot was added to — so it cannot answer questions
 * like "look through my chat history and tell me what needs attention". This
 * service reads with each caller's OWN OAuth token instead, exactly like
 * google-calendar.ts / google-drive.ts / google-gmail.ts.
 *
 * ─── Why per-user tokens rather than domain-wide delegation ────────────────
 * The alternative is DWD on the Chat service account: impersonate any user with no
 * consent. That is operationally easier (no re-consent for staff, works for people
 * who never sign in) but it turns one JSON key into "read every employee's chats",
 * with no per-user revocation. Here the reachable set is defined by whose token is
 * presented, so agent A cannot reach user B's DMs even with a coding mistake —
 * isolation is structural, not a check we have to remember to write.
 *
 * If DWD is later chosen, only `getAccessTokenForUser` changes; every function
 * below keeps working unmodified.
 *
 * ─── Scope of what is readable ─────────────────────────────────────────────
 * `spaces.list` with user auth returns the spaces THIS user belongs to — DMs and
 * group conversations included — and `spaces.messages.list` reads within one of
 * those. Verify against the live API before enabling for staff: Chat's read scopes
 * are Workspace-only and typically require admin allowlisting, and we have not yet
 * confirmed the exact behaviour for human-to-human DMs on this domain.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_API = "https://chat.googleapis.com/v1";

/** List the spaces/DMs the user belongs to. */
export const CHAT_SPACES_READ_SCOPE = "https://www.googleapis.com/auth/chat.spaces.readonly";
/** Read messages within those spaces. */
export const CHAT_MESSAGES_READ_SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly";

const EXPIRY_SKEW_MS = 60_000;
/** Caps so one agent request cannot sweep an entire chat corpus. */
const MAX_SPACES = 50;
const MAX_MESSAGES_PER_SPACE = 100;

export interface ChatSpaceRef {
  /** Resource name, e.g. "spaces/AAAA". */
  name: string;
  /** DIRECT_MESSAGE | SPACE | GROUP_CHAT, as reported by Google. */
  spaceType: string | null;
  displayName: string | null;
  singleUserBotDm: boolean;
}

export interface ChatMessageRef {
  name: string;
  spaceName: string;
  senderName: string | null;
  senderDisplayName: string | null;
  text: string | null;
  createTime: string | null;
  threadName: string | null;
}

export type ChatUserResult<T> =
  | { connected: true; data: T }
  | { connected: false; reason: "auth_required" | "not_configured" | "scope_missing" };

/**
 * Optional audit sink. Reading someone's chat history is high-sensitivity, so the
 * caller is expected to record it (activity_log). Passed in rather than imported so
 * this service stays free of route/service cycles.
 */
export type ChatReadAudit = (event: {
  userId: string;
  action: "chat.spaces.list" | "chat.messages.list" | "chat.history.search";
  spaceName?: string;
  resultCount: number;
}) => void | Promise<void>;

function googleClientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function getGoogleAccount(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "google")))
    .limit(1);
  return row ?? null;
}

async function getAccessTokenForUser(
  db: Db,
  userId: string,
  requiredScope: string,
): Promise<string | null> {
  const creds = googleClientCreds();
  if (!creds) return null;
  const account = await getGoogleAccount(db, userId);
  if (!account) return null;
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

async function chatFetch(token: string, path: string): Promise<Response> {
  return fetch(`${CHAT_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

type ApiSpace = {
  name?: string;
  spaceType?: string;
  displayName?: string;
  singleUserBotDm?: boolean;
};
type ApiMessage = {
  name?: string;
  sender?: { name?: string; displayName?: string };
  text?: string;
  createTime?: string;
  thread?: { name?: string };
};

/** The spaces (including DMs and group chats) this user is a member of. */
export async function listUserSpaces(
  db: Db,
  userId: string,
  opts: { audit?: ChatReadAudit } = {},
): Promise<ChatUserResult<ChatSpaceRef[]>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId, CHAT_SPACES_READ_SCOPE);
  if (!token) return { connected: false, reason: "auth_required" };

  const spaces: ChatSpaceRef[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await chatFetch(token, `/spaces?${params.toString()}`);
    if (!res.ok) return { connected: false, reason: res.status === 403 ? "scope_missing" : "auth_required" };
    const json = (await res.json()) as { spaces?: ApiSpace[]; nextPageToken?: string };
    for (const s of json.spaces ?? []) {
      if (!s.name) continue;
      spaces.push({
        name: s.name,
        spaceType: s.spaceType ?? null,
        displayName: s.displayName ?? null,
        singleUserBotDm: s.singleUserBotDm === true,
      });
      if (spaces.length >= MAX_SPACES) break;
    }
    pageToken = json.nextPageToken;
  } while (pageToken && spaces.length < MAX_SPACES);

  await opts.audit?.({ userId, action: "chat.spaces.list", resultCount: spaces.length });
  return { connected: true, data: spaces };
}

/**
 * Messages within ONE space. `spaceName` must be a space this user belongs to —
 * enforced by Google, since the call is made with the user's own token.
 */
export async function listSpaceMessages(
  db: Db,
  userId: string,
  spaceName: string,
  opts: { pageSize?: number; filter?: string; audit?: ChatReadAudit } = {},
): Promise<ChatUserResult<ChatMessageRef[]>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId, CHAT_MESSAGES_READ_SCOPE);
  if (!token) return { connected: false, reason: "auth_required" };

  const size = Math.min(Math.max(1, opts.pageSize ?? 50), MAX_MESSAGES_PER_SPACE);
  const params = new URLSearchParams({ pageSize: String(size) });
  // Chat supports createTime filtering, which is how "since yesterday" stays cheap.
  if (opts.filter?.trim()) params.set("filter", opts.filter.trim());

  const res = await chatFetch(token, `/${encodeURI(spaceName)}/messages?${params.toString()}`);
  if (!res.ok) return { connected: false, reason: res.status === 403 ? "scope_missing" : "auth_required" };
  const json = (await res.json()) as { messages?: ApiMessage[] };
  const messages: ChatMessageRef[] = (json.messages ?? []).map((m) => ({
    name: m.name ?? "",
    spaceName,
    senderName: m.sender?.name ?? null,
    senderDisplayName: m.sender?.displayName ?? null,
    text: m.text ?? null,
    createTime: m.createTime ?? null,
    threadName: m.thread?.name ?? null,
  }));

  await opts.audit?.({ userId, action: "chat.messages.list", spaceName, resultCount: messages.length });
  return { connected: true, data: messages };
}

/**
 * "Look through my chat history" — sweep the user's spaces and return matching
 * messages, newest space first.
 *
 * Chat has no cross-space full-text search for user auth, so matching happens here
 * over a bounded window: at most `maxSpaces` spaces × `perSpace` messages. That
 * bound is deliberate — it keeps a vague agent request from turning into hundreds
 * of API calls, and it means an agent sees a recent slice rather than a mailbox-wide
 * dragnet. Narrow with `sinceIso` (maps to Chat's createTime filter) when possible.
 */
export async function searchUserChatHistory(
  db: Db,
  userId: string,
  input: {
    /** Case-insensitive substring; omit to return the recent window unfiltered. */
    query?: string;
    sinceIso?: string;
    maxSpaces?: number;
    perSpace?: number;
    audit?: ChatReadAudit;
  } = {},
): Promise<ChatUserResult<{ space: ChatSpaceRef; messages: ChatMessageRef[] }[]>> {
  const spacesResult = await listUserSpaces(db, userId, { audit: input.audit });
  if (!spacesResult.connected) return spacesResult;

  const maxSpaces = Math.min(Math.max(1, input.maxSpaces ?? 20), MAX_SPACES);
  const perSpace = Math.min(Math.max(1, input.perSpace ?? 30), MAX_MESSAGES_PER_SPACE);
  const needle = input.query?.trim().toLowerCase() ?? null;
  const filter = input.sinceIso ? `createTime > "${input.sinceIso}"` : undefined;

  const out: { space: ChatSpaceRef; messages: ChatMessageRef[] }[] = [];
  let scanned = 0;
  for (const space of spacesResult.data.slice(0, maxSpaces)) {
    const msgs = await listSpaceMessages(db, userId, space.name, { pageSize: perSpace, filter });
    if (!msgs.connected) continue; // one unreadable space shouldn't fail the sweep
    scanned += msgs.data.length;
    const matched = needle
      ? msgs.data.filter((m) => (m.text ?? "").toLowerCase().includes(needle))
      : msgs.data;
    if (matched.length > 0) out.push({ space, messages: matched });
  }

  await input.audit?.({ userId, action: "chat.history.search", resultCount: scanned });
  return { connected: true, data: out };
}

/** Whether this user can use Chat-history features right now. */
export async function chatUserReadiness(
  db: Db,
  userId: string,
): Promise<{ configured: boolean; canListSpaces: boolean; canReadMessages: boolean }> {
  const configured = googleClientCreds() !== null;
  if (!configured) return { configured: false, canListSpaces: false, canReadMessages: false };
  const account = await getGoogleAccount(db, userId);
  const scope = account?.scope ?? "";
  const refreshable = Boolean(account?.refreshToken);
  return {
    configured: true,
    canListSpaces: refreshable && scope.includes(CHAT_SPACES_READ_SCOPE),
    canReadMessages: refreshable && scope.includes(CHAT_MESSAGES_READ_SCOPE),
  };
}
