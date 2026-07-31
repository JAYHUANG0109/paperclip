import { and, eq } from "drizzle-orm";
import { authAccounts, type Db } from "@paperclipai/db";
import { fileIntoOutputFolder } from "./google-drive.js";

/**
 * Google Sheets, read and write, acting as the USER.
 *
 * Same model as google-calendar.ts / google-drive.ts / google-gmail.ts: reuse the
 * OAuth token better-auth stores at SSO login and act with each caller's OWN token,
 * refreshing it automatically.
 *
 * ─── How this differs from packages/google-sheets-mcp-server ───────────────
 * That server exists and stays: it authenticates with a SERVICE ACCOUNT against an
 * explicit allowlist of spreadsheet ids, which suits shared company sheets the SA has
 * been granted on. It deliberately does not support OAuth, so it cannot answer "read
 * MY sheet" — every caller is the same identity. This service is the per-user half:
 * an agent reads and writes exactly the spreadsheets its responsible human can, and
 * nothing else. Use the MCP server for shared allowlisted sheets; use this for
 * anything belonging to a person.
 *
 * ─── Where created sheets land ─────────────────────────────────────────────
 * A spreadsheet created here is filed into the user's "Paperclip 產出檔案" folder
 * rather than left in My Drive root — see createSpreadsheet. It still does not replace
 * artifact upload: an artifact is tracked and shows on the task, a native sheet is a
 * live document for ongoing edits.
 *
 * ─── Finding a spreadsheet ─────────────────────────────────────────────────
 * The app holds `drive.file` (per-file) rather than a broad Drive scope, so it CANNOT
 * browse or search the user's Drive. Callers must supply a spreadsheet id — normally
 * pasted as a URL, which `parseSpreadsheetId` accepts directly. Sheets created through
 * `createSpreadsheet` below are app-created and therefore always reachable.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Read + write on spreadsheets the user can already open. */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const EXPIRY_SKEW_MS = 60_000;
/** Cap a single read so one agent call cannot pull an enormous sheet into context. */
const MAX_ROWS = 2_000;

export interface SheetTab {
  sheetId: number | null;
  title: string;
  rowCount: number | null;
  columnCount: number | null;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string | null;
  url: string | null;
  tabs: SheetTab[];
}

export interface SheetRange {
  range: string;
  /** Row-major cell values; short rows are not padded, matching the API. */
  values: string[][];
}

export type SheetsResult<T> =
  | { connected: true; data: T }
  | { connected: false; reason: "auth_required" | "not_configured" | "scope_missing" | "not_found" };

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
  if (!account.scope || !account.scope.includes(SHEETS_SCOPE)) return null;

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

/**
 * Accept either a bare spreadsheet id or a full Google Sheets URL, because what a
 * human actually has to hand is the URL from their address bar.
 */
export function parseSpreadsheetId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const fromUrl = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl?.[1]) return fromUrl[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(raw) ? raw : null;
}

async function sheetsFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SHEETS_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function failureReason(status: number): "scope_missing" | "not_found" | "auth_required" {
  if (status === 403) return "scope_missing";
  if (status === 404) return "not_found";
  return "auth_required";
}

/** Tab names and sizes — the first call an agent needs before reading a range. */
export async function getSpreadsheet(
  db: Db,
  userId: string,
  spreadsheetId: string,
): Promise<SheetsResult<SpreadsheetMetadata>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await sheetsFetch(
    token,
    `/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`,
  );
  if (!res.ok) return { connected: false, reason: failureReason(res.status) };
  const json = (await res.json()) as {
    spreadsheetId?: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
    sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
  };
  return {
    connected: true,
    data: {
      spreadsheetId: json.spreadsheetId ?? spreadsheetId,
      title: json.properties?.title ?? null,
      url: json.spreadsheetUrl ?? null,
      tabs: (json.sheets ?? []).map((s) => ({
        sheetId: s.properties?.sheetId ?? null,
        title: s.properties?.title ?? "",
        rowCount: s.properties?.gridProperties?.rowCount ?? null,
        columnCount: s.properties?.gridProperties?.columnCount ?? null,
      })),
    },
  };
}

/** Read an A1 range, e.g. "工作表1!A1:F50". Truncated at MAX_ROWS. */
export async function readRange(
  db: Db,
  userId: string,
  spreadsheetId: string,
  range: string,
): Promise<SheetsResult<SheetRange>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await sheetsFetch(
    token,
    `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  );
  if (!res.ok) return { connected: false, reason: failureReason(res.status) };
  const json = (await res.json()) as { range?: string; values?: unknown[][] };
  const values = (json.values ?? []).slice(0, MAX_ROWS).map((row) => row.map((cell) => String(cell ?? "")));
  return { connected: true, data: { range: json.range ?? range, values } };
}

/** Append rows after the last populated row of the range's table. */
export async function appendRows(
  db: Db,
  userId: string,
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<SheetsResult<{ updatedRange: string | null; updatedRows: number }>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await sheetsFetch(
    token,
    `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`
      + "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
    { method: "POST", body: JSON.stringify({ values }) },
  );
  if (!res.ok) return { connected: false, reason: failureReason(res.status) };
  const json = (await res.json()) as { updates?: { updatedRange?: string; updatedRows?: number } };
  return {
    connected: true,
    data: { updatedRange: json.updates?.updatedRange ?? null, updatedRows: json.updates?.updatedRows ?? 0 },
  };
}

/**
 * Overwrite an explicit range. Distinct from append on purpose: overwriting is how a
 * routine silently destroys someone's hand-edited rows, so a caller has to say plainly
 * that it means to replace those cells.
 */
export async function updateRange(
  db: Db,
  userId: string,
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<SheetsResult<{ updatedRange: string | null; updatedCells: number }>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await sheetsFetch(
    token,
    `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: "PUT", body: JSON.stringify({ range, values }) },
  );
  if (!res.ok) return { connected: false, reason: failureReason(res.status) };
  const json = (await res.json()) as { updatedRange?: string; updatedCells?: number };
  return {
    connected: true,
    data: { updatedRange: json.updatedRange ?? null, updatedCells: json.updatedCells ?? 0 },
  };
}

/**
 * Create a new spreadsheet owned by the caller, filed into the user's
 * "Paperclip 產出檔案" folder.
 *
 * The Sheets API always creates in My Drive ROOT, so we move it afterwards — that root
 * placement was the whole reason agents were told not to create native Google files.
 * The move is best-effort: if it fails the sheet still exists and is still usable, and
 * `filedInOutputFolder` reports what actually happened rather than assuming success.
 */
export async function createSpreadsheet(
  db: Db,
  userId: string,
  title: string,
): Promise<SheetsResult<SpreadsheetMetadata & { filedInOutputFolder: boolean }>> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const res = await sheetsFetch(token, "", {
    method: "POST",
    body: JSON.stringify({ properties: { title } }),
  });
  if (!res.ok) return { connected: false, reason: failureReason(res.status) };
  const json = (await res.json()) as {
    spreadsheetId?: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  const spreadsheetId = json.spreadsheetId ?? "";
  const filed = spreadsheetId ? await fileIntoOutputFolder(token, spreadsheetId) : { moved: false };
  return {
    connected: true,
    data: {
      spreadsheetId,
      title: json.properties?.title ?? title,
      url: json.spreadsheetUrl ?? null,
      filedInOutputFolder: filed.moved,
      tabs: (json.sheets ?? []).map((s) => ({
        sheetId: s.properties?.sheetId ?? null,
        title: s.properties?.title ?? "",
        rowCount: null,
        columnCount: null,
      })),
    },
  };
}

/** Whether this user can use Sheets features right now. */
export async function sheetsReadiness(
  db: Db,
  userId: string,
): Promise<{ configured: boolean; canUse: boolean }> {
  const configured = googleClientCreds() !== null;
  if (!configured) return { configured: false, canUse: false };
  const account = await getGoogleAccount(db, userId);
  return {
    configured: true,
    canUse: Boolean(account?.refreshToken) && (account?.scope ?? "").includes(SHEETS_SCOPE),
  };
}
