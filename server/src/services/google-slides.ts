import { and, eq } from "drizzle-orm";
import { authAccounts, type Db } from "@paperclipai/db";
import { fileIntoOutputFolder } from "./google-drive.js";

/**
 * Google Slides, read and write, acting as the USER. Same per-user token model as
 * google-calendar / drive / gmail / chat / sheets.
 *
 * ─── Slides has no "values" API ────────────────────────────────────────────
 * Unlike Sheets, every mutation goes through presentations.batchUpdate. The three
 * requests exposed here are the ones that actually serve agent work:
 *   - replaceAllText : fill a TEMPLATE deck ({{name}} → 王小明). By far the most useful.
 *   - createSlide    : add a slide.
 *   - insertText     : type into a specific shape by objectId.
 * Anything else (theming, images, tables, speaker notes) is a deliberate omission
 * rather than an oversight — add it when a real task needs it.
 *
 ─── Where created decks land ──────────────────────────────────────────────
 * A deck created here is filed into the user's "Paperclip 產出檔案" folder, not left
 * loose in My Drive root. Root placement was the original reason the agent rules said
 * never to create native Google files, so createPresentation moves the deck straight
 * after creating it (see google-drive.ts fileIntoOutputFolder).
 *
 * That does NOT replace artifact upload. An artifact is tracked by Paperclip, appears
 * on the task with a download button, and is what a reviewer looks for; a native deck
 * is a live document people keep editing. Use a deck when co-editing is the point, and
 * still upload an artifact when the task has a finished output to hand over.
 *
 * ─── Finding a presentation ────────────────────────────────────────────────
 * The app holds `drive.file` only, so it cannot browse Drive. Callers pass an id or a
 * pasted Slides URL; decks created here are app-created and stay reachable.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SLIDES_API = "https://slides.googleapis.com/v1/presentations";

/** Read + write presentations the user can already open. */
export const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";

const EXPIRY_SKEW_MS = 60_000;
/** Cap extracted text so one deck cannot flood an agent's context. */
const MAX_SLIDES = 200;

export interface SlideShape {
  /** The id insertText needs. A SLIDE id will not work — Google rejects it with a 400. */
  objectId: string;
  text: string;
  /** Placeholder role when the shape is one, e.g. TITLE / BODY / SUBTITLE. */
  placeholder: string | null;
}

export interface SlideSummary {
  /** The SLIDE's id. Useful for ordering; NOT valid for insertText. */
  objectId: string;
  index: number;
  /** Text found on the slide, joined per shape — enough to know what the slide says. */
  text: string[];
  /**
   * The text-capable shapes on this slide, each with the objectId insertText wants.
   * Without this the /text endpoint was uncallable: callers only had slide ids, which
   * Google rejects, and the failure used to surface as a misleading auth error.
   */
  shapes: SlideShape[];
}

export interface PresentationMetadata {
  presentationId: string;
  title: string | null;
  url: string | null;
  slideCount: number;
  slides: SlideSummary[];
}

export type FailureReason =
  | "auth_required"
  | "not_configured"
  | "scope_missing"
  | "not_found"
  /** Google rejected the request itself — bad range, bad objectId, malformed body. */
  | "bad_request"
  | "rate_limited";

export type SlidesResult<T> =
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
  if (!account.scope || !account.scope.includes(SLIDES_SCOPE)) return null;

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

/** Accept a bare presentation id or a pasted Google Slides URL. */
export function parsePresentationId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const fromUrl = raw.match(/\/presentation\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl?.[1]) return fromUrl[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(raw) ? raw : null;
}

async function slidesFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SLIDES_API}${path}`, {
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

type ApiTextElement = { textRun?: { content?: string } };
type ApiShape = {
  text?: { textElements?: ApiTextElement[] };
  placeholder?: { type?: string };
};
type ApiPageElement = { objectId?: string; shape?: ApiShape };
type ApiSlide = { objectId?: string; pageElements?: ApiPageElement[] };

/** Text-capable shapes on a slide, with the ids insertText requires. */
function slideShapes(slide: ApiSlide): SlideShape[] {
  const out: SlideShape[] = [];
  for (const el of slide.pageElements ?? []) {
    if (!el.shape || !el.objectId) continue;
    const text = (el.shape.text?.textElements ?? [])
      .map((t) => t.textRun?.content ?? "")
      .join("")
      .replace(/\v/g, "\n")
      .trim();
    out.push({ objectId: el.objectId, text, placeholder: el.shape.placeholder?.type ?? null });
  }
  return out;
}

/** Flatten a slide's shapes into readable strings, dropping empty runs. */
function slideText(slide: ApiSlide): string[] {
  const out: string[] = [];
  for (const el of slide.pageElements ?? []) {
    const runs = (el.shape?.text?.textElements ?? [])
      .map((t) => t.textRun?.content ?? "")
      .join("")
      .replace(//g, "\n")
      .trim();
    if (runs) out.push(runs);
  }
  return out;
}

/** Deck title, slide ids and the text on each slide. */
export async function getPresentation(
  db: Db,
  userId: string,
  presentationId: string,
): Promise<SlidesResult<PresentationMetadata>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await slidesFetch(token, `/${encodeURIComponent(presentationId)}`);
  if (!res.ok) return failure(res);
  const json = (await res.json()) as { presentationId?: string; title?: string; slides?: ApiSlide[] };
  const slides = (json.slides ?? []).slice(0, MAX_SLIDES);
  return {
    connected: true,
    data: {
      presentationId: json.presentationId ?? presentationId,
      title: json.title ?? null,
      url: `https://docs.google.com/presentation/d/${json.presentationId ?? presentationId}/edit`,
      slideCount: (json.slides ?? []).length,
      slides: slides.map((s, index) => ({ objectId: s.objectId ?? "", index, text: slideText(s), shapes: slideShapes(s) })),
    },
  };
}

/**
 * Create a deck, filed into the user's "Paperclip 產出檔案" folder.
 *
 * The Slides API creates in My Drive ROOT; we move it afterwards, since that root
 * placement is exactly what made native Google files a bad deliverable. Best-effort —
 * `filedInOutputFolder` reports what happened rather than assuming.
 */
export async function createPresentation(
  db: Db,
  userId: string,
  title: string,
): Promise<SlidesResult<PresentationMetadata & { filedInOutputFolder: boolean }>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await slidesFetch(token, "", { method: "POST", body: JSON.stringify({ title }) });
  if (!res.ok) return failure(res);
  const json = (await res.json()) as { presentationId?: string; title?: string; slides?: ApiSlide[] };
  const id = json.presentationId ?? "";
  const filed = id ? await fileIntoOutputFolder(token, id) : { moved: false };
  return {
    connected: true,
    data: {
      presentationId: id,
      title: json.title ?? title,
      url: id ? `https://docs.google.com/presentation/d/${id}/edit` : null,
      slideCount: (json.slides ?? []).length,
      filedInOutputFolder: filed.moved,
      slides: (json.slides ?? []).map((s, index) => ({ objectId: s.objectId ?? "", index, text: slideText(s), shapes: slideShapes(s) })),
    },
  };
}

async function batchUpdate(
  db: Db,
  userId: string,
  presentationId: string,
  requests: Record<string, unknown>[],
): Promise<SlidesResult<{ replies: number }>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await slidesFetch(token, `/${encodeURIComponent(presentationId)}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) return failure(res);
  const json = (await res.json()) as { replies?: unknown[] };
  return { connected: true, data: { replies: (json.replies ?? []).length } };
}

/**
 * Fill a template deck: replace every occurrence of each `find` string.
 *
 * This is the workflow that actually fits how decks get made here — keep a template
 * with {{placeholders}} and let an agent populate it — and it is far safer than
 * rewriting slides, because it only touches text the template author marked.
 */
export async function replaceText(
  db: Db,
  userId: string,
  presentationId: string,
  replacements: { find: string; replace: string; matchCase?: boolean }[],
): Promise<SlidesResult<{ replies: number }>> {
  return batchUpdate(
    db,
    userId,
    presentationId,
    replacements.map((r) => ({
      replaceAllText: {
        containsText: { text: r.find, matchCase: r.matchCase ?? false },
        replaceText: r.replace,
      },
    })),
  );
}

/** Add a slide, optionally at an index and with a predefined layout. */
export async function addSlide(
  db: Db,
  userId: string,
  presentationId: string,
  opts: { insertionIndex?: number; layout?: string } = {},
): Promise<SlidesResult<{ replies: number }>> {
  return batchUpdate(db, userId, presentationId, [
    {
      createSlide: {
        ...(typeof opts.insertionIndex === "number" ? { insertionIndex: opts.insertionIndex } : {}),
        ...(opts.layout
          ? { slideLayoutReference: { predefinedLayout: opts.layout } }
          : {}),
      },
    },
  ]);
}

/** Type text into one shape, addressed by the objectId from getPresentation. */
export async function insertText(
  db: Db,
  userId: string,
  presentationId: string,
  objectId: string,
  text: string,
): Promise<SlidesResult<{ replies: number }>> {
  return batchUpdate(db, userId, presentationId, [
    { insertText: { objectId, text, insertionIndex: 0 } },
  ]);
}

export async function slidesReadiness(
  db: Db,
  userId: string,
): Promise<{ configured: boolean; canUse: boolean }> {
  const configured = googleClientCreds() !== null;
  if (!configured) return { configured: false, canUse: false };
  const account = await getGoogleAccount(db, userId);
  return {
    configured: true,
    canUse: Boolean(account?.refreshToken) && (account?.scope ?? "").includes(SLIDES_SCOPE),
  };
}
