import { and, eq } from "drizzle-orm";
import { authAccounts, type Db } from "@paperclipai/db";

/**
 * Google Drive delivery. Same model as google-calendar.ts: reuse the OAuth token
 * better-auth stores at SSO login (`account` table, provider "google") and act
 * with each user's OWN token, so per-user isolation is structural — a file only
 * ever lands in the token-owner's Drive.
 *
 * Purpose: when an agent produces an output file for an issue, we push a copy to
 * the RESPONSIBLE USER's own Drive (the human driving the agent), into a folder
 * named "Paperclip 產出檔案". If that user runs Google Drive for Desktop, the file
 * then syncs to their real machine — which is what agents-on-a-shared-runner
 * otherwise can't do (they run on the runner, not the user's computer).
 *
 * Scope: `drive.file` (per-file) — the app can only see/modify files IT created,
 * never the rest of the user's Drive. The output folder is app-created, so the
 * find-or-create query below only ever matches our own folder.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
/** Per-file Drive scope — least privilege: only files this app creates. */
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Refresh a little before actual expiry to avoid mid-request 401s. */
const EXPIRY_SKEW_MS = 60_000;

/** The per-user output folder name (overridable per deployment). */
export function outputFolderName(): string {
  return process.env.PAPERCLIP_DRIVE_OUTPUT_FOLDER?.trim() || "Paperclip 產出檔案";
}

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
 * Return a valid Google access token carrying the Drive scope for the user,
 * refreshing via the stored refresh_token when needed. Returns null when the
 * user has no Google account, hasn't consented to the Drive scope, or has no
 * usable refresh path — callers treat that as "not connected" and skip delivery.
 */
async function getAccessTokenForUser(db: Db, userId: string): Promise<string | null> {
  const creds = googleClientCreds();
  if (!creds) return null;
  const account = await getGoogleAccount(db, userId);
  if (!account) return null;

  // The token must actually carry the Drive scope — tokens issued before the
  // scope was added (or for users who declined) can't be used.
  if (!account.scope || !account.scope.includes(DRIVE_FILE_SCOPE)) return null;

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
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      scope?: string;
    };
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

/**
 * Find (or create) the user's "Paperclip 產出檔案" folder in their My Drive root.
 * With `drive.file` scope the search only sees files this app created, so it
 * matches our own folder on subsequent runs and creates it the first time.
 */
async function findOrCreateOutputFolder(token: string): Promise<string | null> {
  const name = outputFolderName();
  // Escape single quotes for the Drive query string.
  const safeName = name.replace(/'/g, "\\'");
  const q = `mimeType = '${FOLDER_MIME}' and name = '${safeName}' and trashed = false and 'root' in parents`;
  try {
    const listRes = await fetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name)")}&spaces=drive`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (listRes.ok) {
      const data = (await listRes.json()) as { files?: Array<{ id?: string }> };
      const existing = data.files?.find((f) => f.id)?.id;
      if (existing) return existing;
    }
    // Create it (defaults to My Drive root when no parents given).
    const createRes = await fetch(`${DRIVE_API}/files?fields=id`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    if (!createRes.ok) return null;
    const created = (await createRes.json()) as { id?: string };
    return created.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Move an app-created file into the user's "Paperclip 產出檔案" folder.
 *
 * Why this exists: a spreadsheet or deck created through the Sheets/Slides API lands in
 * My Drive ROOT, which is the reason the agent rules told agents not to create native
 * Google files. Filing them here removes that objection — a created sheet/deck now
 * appears in the same folder as every other Paperclip output instead of loose at the
 * top of someone's Drive.
 *
 * `drive.file` is sufficient because we only ever touch files this app created.
 * Best-effort by design: if the move fails the file still exists and is still usable,
 * so callers should not fail their operation over it.
 */
export async function fileIntoOutputFolder(
  token: string,
  fileId: string,
): Promise<{ moved: boolean; folderId: string | null; webViewLink: string | null }> {
  const folderId = await findOrCreateOutputFolder(token);
  if (!folderId) return { moved: false, folderId: null, webViewLink: null };
  try {
    const res = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}`
        + `?addParents=${encodeURIComponent(folderId)}&removeParents=root`
        + `&fields=${encodeURIComponent("id,webViewLink")}`,
      { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" },
    );
    if (!res.ok) return { moved: false, folderId, webViewLink: null };
    const json = (await res.json()) as { webViewLink?: string };
    return { moved: true, folderId, webViewLink: json.webViewLink ?? null };
  } catch {
    return { moved: false, folderId, webViewLink: null };
  }
}

export type DriveDeliveryResult =
  | { delivered: true; fileId: string; webViewLink: string | null }
  | {
      delivered: false;
      reason: "not_configured" | "auth_required" | "google_error";
      detail?: string;
    };

/**
 * Upload one output file to the user's own Drive output folder. Best-effort:
 * callers should not fail their own operation when this returns `delivered:false`
 * — the file is already stored in Paperclip regardless.
 */
export async function deliverOutputToUserDrive(
  db: Db,
  userId: string,
  file: { filename: string; contentType: string; bytes: Buffer },
): Promise<DriveDeliveryResult> {
  if (!googleClientCreds()) return { delivered: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { delivered: false, reason: "auth_required" };

  const folderId = await findOrCreateOutputFolder(token);
  if (!folderId) return { delivered: false, reason: "google_error", detail: "could not resolve output folder" };

  const filename = file.filename?.trim() || "output";
  const contentType = file.contentType?.trim() || "application/octet-stream";

  // multipart/related upload: JSON metadata part + binary media part.
  const boundary = `paperclip-${Math.abs(hashString(`${filename}:${file.bytes.length}:${folderId}`)).toString(36)}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      "utf8",
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);

  try {
    const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=${encodeURIComponent("id,webViewLink")}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) return { delivered: false, reason: "auth_required", detail: text };
      return { delivered: false, reason: "google_error", detail: `${res.status}: ${text || res.statusText}` };
    }
    const data = (await res.json()) as { id?: string; webViewLink?: string };
    if (!data.id) return { delivered: false, reason: "google_error", detail: "no file id returned" };
    return { delivered: true, fileId: data.id, webViewLink: data.webViewLink ?? null };
  } catch (err) {
    return { delivered: false, reason: "google_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Small, stable string hash for a deterministic multipart boundary. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
