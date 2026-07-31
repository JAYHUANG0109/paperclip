import { and, eq } from "drizzle-orm";
import { authAccounts, type Db } from "@paperclipai/db";
import { fileIntoOutputFolder } from "./google-drive.js";

/**
 * Google Docs, read and write, acting as the USER. Seventh service on the per-user
 * token model (calendar, drive, gmail, chat, sheets, slides, docs).
 *
 * ─── Writing ───────────────────────────────────────────────────────────────
 * Like Slides, every mutation goes through documents.batchUpdate. Two write paths are
 * exposed, and the split is deliberate:
 *   - replaceAllText : fill a TEMPLATE ({{name}} → 王小明). Only touches text the
 *                      template author marked, so it cannot mangle a document.
 *   - appendText     : add at the END of the body, via endOfSegmentLocation so we never
 *                      do index arithmetic against a document someone else is editing.
 * There is deliberately NO "replace the whole document" call: that is how an agent
 * silently destroys a colleague's edits, the same failure the founder hit with the
 * calendar cards. Rewrite a marked block or append; don't overwrite a person's work.
 *
 * ─── Where created docs land ───────────────────────────────────────────────
 * The Docs API creates in My Drive ROOT, so createDocument files it into the user's
 * "Paperclip 產出檔案" folder immediately afterwards and reports what happened via
 * `filedInOutputFolder`. Still not a substitute for artifact upload: an artifact is
 * tracked and shows on the task; a doc is a live document for ongoing edits.
 *
 * ─── Finding a document ────────────────────────────────────────────────────
 * `drive.file` only, so no Drive browsing. Callers pass an id or a pasted Docs URL;
 * documents created here stay reachable.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DOCS_API = "https://docs.googleapis.com/v1/documents";

/** Read + write documents the user can already open. */
export const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";

const EXPIRY_SKEW_MS = 60_000;
/** Cap extracted text so one long document cannot flood an agent's context. */
const MAX_TEXT_CHARS = 100_000;

export interface DocumentContent {
  documentId: string;
  title: string | null;
  url: string | null;
  /** Body text, paragraphs separated by newlines. Truncated at MAX_TEXT_CHARS. */
  text: string;
  truncated: boolean;
}

export type FailureReason =
  | "auth_required"
  | "not_configured"
  | "scope_missing"
  | "not_found"
  /** Google rejected the request itself — bad range, bad objectId, malformed body. */
  | "bad_request"
  | "rate_limited";

export type DocsResult<T> =
  | { connected: true; data: T }
  /** `detail` carries Google's own error message when it sent one. */
  | { connected: false; reason: FailureReason; detail?: string };

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

async function getAccessTokenForUser(db: Db, userId: string): Promise<string | null> {
  const creds = googleClientCreds();
  if (!creds) return null;
  const account = await getGoogleAccount(db, userId);
  if (!account) return null;
  if (!account.scope || !account.scope.includes(DOCS_SCOPE)) return null;

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

/** Accept a bare document id or a pasted Google Docs URL. */
export function parseDocumentId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const fromUrl = raw.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl?.[1]) return fromUrl[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(raw) ? raw : null;
}

async function docsFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${DOCS_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Turn a Google error response into a typed failure, keeping Google's own message.
 *
 * The previous version mapped every non-403/404 to `auth_required`, which made a plain
 * 400 ("invalid objectId") look like an expired token — an agent hit exactly that and
 * spent its run diagnosing a scope problem that did not exist. Anything the caller can
 * fix must say so, and Google's message is far more useful than our guess.
 */
async function failure(res: Response): Promise<{ connected: false; reason: FailureReason; detail?: string }> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? text.slice(0, 300);
    } catch {
      detail = text.slice(0, 300);
    }
  } catch {
    /* body already consumed or unreadable */
  }
  const reason: FailureReason =
    res.status === 403 ? "scope_missing"
      : res.status === 404 ? "not_found"
        : res.status === 400 ? "bad_request"
          : res.status === 429 ? "rate_limited"
            : "auth_required";
  return { connected: false, reason, ...(detail ? { detail } : {}) };
}

type ApiParagraphElement = { textRun?: { content?: string } };
type ApiStructuralElement = {
  paragraph?: { elements?: ApiParagraphElement[] };
  table?: { tableRows?: { tableCells?: { content?: ApiStructuralElement[] }[] }[] };
};

/**
 * Flatten the document body to text. Recurses into tables, because in this org a lot of
 * real content (rosters, checklists) lives in them and skipping tables would silently
 * return a near-empty document.
 */
function extractText(content: ApiStructuralElement[] | undefined): string {
  const parts: string[] = [];
  for (const el of content ?? []) {
    if (el.paragraph) {
      const line = (el.paragraph.elements ?? [])
        .map((e) => e.textRun?.content ?? "")
        .join("")
        .replace(/\v/g, "\n");
      if (line.trim()) parts.push(line.replace(/\n+$/, ""));
    }
    for (const row of el.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        const inner = extractText(cell.content);
        if (inner.trim()) parts.push(inner);
      }
    }
  }
  return parts.join("\n");
}

/** Title and body text. The first call an agent makes before changing anything. */
export async function getDocument(
  db: Db,
  userId: string,
  documentId: string,
): Promise<DocsResult<DocumentContent>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await docsFetch(token, `/${encodeURIComponent(documentId)}`);
  if (!res.ok) return failure(res);
  const json = (await res.json()) as {
    documentId?: string;
    title?: string;
    body?: { content?: ApiStructuralElement[] };
  };
  const full = extractText(json.body?.content);
  const id = json.documentId ?? documentId;
  return {
    connected: true,
    data: {
      documentId: id,
      title: json.title ?? null,
      url: `https://docs.google.com/document/d/${id}/edit`,
      text: full.slice(0, MAX_TEXT_CHARS),
      truncated: full.length > MAX_TEXT_CHARS,
    },
  };
}

/** Create a document, filed into the user's "Paperclip 產出檔案" folder. */
export async function createDocument(
  db: Db,
  userId: string,
  title: string,
): Promise<DocsResult<DocumentContent & { filedInOutputFolder: boolean }>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await docsFetch(token, "", { method: "POST", body: JSON.stringify({ title }) });
  if (!res.ok) return failure(res);
  const json = (await res.json()) as { documentId?: string; title?: string };
  const id = json.documentId ?? "";
  const filed = id ? await fileIntoOutputFolder(token, id) : { moved: false };
  return {
    connected: true,
    data: {
      documentId: id,
      title: json.title ?? title,
      url: id ? `https://docs.google.com/document/d/${id}/edit` : null,
      text: "",
      truncated: false,
      filedInOutputFolder: filed.moved,
    },
  };
}

async function batchUpdate(
  db: Db,
  userId: string,
  documentId: string,
  requests: Record<string, unknown>[],
): Promise<DocsResult<{ replies: number }>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await docsFetch(token, `/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) return failure(res);
  const json = (await res.json()) as { replies?: unknown[] };
  return { connected: true, data: { replies: (json.replies ?? []).length } };
}

/** Fill a template: replace every occurrence of each `find` string. */
export async function replaceText(
  db: Db,
  userId: string,
  documentId: string,
  replacements: { find: string; replace: string; matchCase?: boolean }[],
): Promise<DocsResult<{ replies: number }>> {
  return batchUpdate(
    db,
    userId,
    documentId,
    replacements.map((r) => ({
      replaceAllText: {
        containsText: { text: r.find, matchCase: r.matchCase ?? false },
        replaceText: r.replace,
      },
    })),
  );
}

/**
 * Append text at the end of the body.
 *
 * Uses `endOfSegmentLocation` rather than a computed index: the document may be open in
 * someone's browser while this runs, and index arithmetic against a moving target is
 * how you end up inserting into the middle of a sentence.
 */
export async function appendText(
  db: Db,
  userId: string,
  documentId: string,
  text: string,
): Promise<DocsResult<{ replies: number }>> {
  return batchUpdate(db, userId, documentId, [
    { insertText: { text, endOfSegmentLocation: { segmentId: "" } } },
  ]);
}

export async function docsReadiness(
  db: Db,
  userId: string,
): Promise<{ configured: boolean; canUse: boolean }> {
  const configured = googleClientCreds() !== null;
  if (!configured) return { configured: false, canUse: false };
  const account = await getGoogleAccount(db, userId);
  return {
    configured: true,
    canUse: Boolean(account?.refreshToken) && (account?.scope ?? "").includes(DOCS_SCOPE),
  };
}
