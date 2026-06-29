import { and, eq } from "drizzle-orm";
import { authAccounts, authUsers, userCalendarPreferences, type Db } from "@paperclipai/db";

/**
 * Google Calendar integration (read-only). Unlike the Asana digest — which is
 * pulled by each user's own agent so the server never touches a token — Google
 * Calendar reuses the OAuth token better-auth already stores at SSO login
 * (`account` table, provider "google"). The server reads each caller's OWN token
 * to fetch ONLY that caller's calendars, so per-user isolation is structural:
 * there is no code path that reads another user's calendar.
 *
 * The user's team encodes meeting attendees as plain text in the event TITLE
 * (no real attendee emails), so the personal "My Schedule" view matches on the
 * title (plus genuine owner/attendee signals when present). See
 * doc/google-calendar-integration.md.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
/** Refresh a little before actual expiry to avoid mid-request 401s. */
const EXPIRY_SKEW_MS = 60_000;

export interface GoogleCalendarEvent {
  id: string;
  calendarId: string;
  calendarName: string | null;
  calendarColor: string | null;
  title: string;
  /** RFC3339 datetime, or YYYY-MM-DD for all-day events. */
  start: string;
  end: string | null;
  /** Local date key (YYYY-MM-DD) the calendar grid buckets by. */
  dateKey: string;
  allDay: boolean;
  htmlLink: string | null;
  /**
   * True only when the caller is a genuine *invited attendee* of the event.
   * We deliberately do NOT count creator/organizer here: the team keeps one
   * shared calendar that the user's account owns, so Google reports
   * `organizer.self`/`creator.self` = true for EVERY event on it — a useless
   * signal that would make every event look like "mine". Real per-person
   * relevance comes from the title-name match instead (see `eventIsMine`).
   */
  isInvitedAttendee: boolean;
}

export type GoogleCalendarResult =
  | { connected: true; events: GoogleCalendarEvent[] }
  | { connected: false; reason: "auth_required" | "not_configured" };

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
 * Return a valid Google access token for the user, refreshing via the stored
 * refresh_token when the current one is missing/expired. Returns null when the
 * user has no Google account, no calendar scope, or no usable refresh path —
 * callers surface that as `auth_required` so the UI can prompt a re-consent.
 */
async function getAccessTokenForUser(db: Db, userId: string): Promise<string | null> {
  const creds = googleClientCreds();
  if (!creds) return null;
  const account = await getGoogleAccount(db, userId);
  if (!account) return null;

  // The token must actually carry the calendar scope — tokens issued before the
  // scope was added (or for users who declined consent) cannot read calendars.
  if (!account.scope || !account.scope.includes(CALENDAR_SCOPE)) return null;

  const now = Date.now();
  const notExpired =
    account.accessToken &&
    account.accessTokenExpiresAt &&
    account.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > now;
  if (notExpired && account.accessToken) return account.accessToken;

  // Refresh.
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
    // Persist so we don't refresh on every request.
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

async function googleGet<T>(token: string, url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface RawCalendarListEntry {
  id: string;
  summary?: string;
  backgroundColor?: string;
  primary?: boolean;
  deleted?: boolean;
  selected?: boolean;
}
interface RawEvent {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  creator?: { self?: boolean };
  organizer?: { self?: boolean };
  attendees?: Array<{ self?: boolean }>;
}

/** Convert a Google start (date or dateTime) to a local YYYY-MM-DD bucket key. */
function toDateKey(start: { date?: string; dateTime?: string } | undefined): string | null {
  if (!start) return null;
  if (start.date) return start.date; // all-day: already YYYY-MM-DD
  if (start.dateTime) {
    const d = new Date(start.dateTime);
    if (Number.isNaN(d.getTime())) return null;
    // Local date components (server TZ); good enough for day bucketing.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return null;
}

/** A single calendar can hold far more than one page of events in a window
 * (the team's shared calendar has dozens of events per day). Page through
 * `nextPageToken` up to this many pages so we don't silently drop everything
 * past the first 250 events — while still bounding worst-case payload/latency. */
const MAX_PAGES_PER_CALENDAR = 12; // 12 × 250 = up to 3000 events/calendar.

/**
 * Fetch every event for one calendar within [timeMin, timeMax], following
 * `nextPageToken` until the calendar is exhausted or the page cap is hit.
 * Returns whatever it gathered (per-calendar failures degrade to fewer pages,
 * never throw — the caller skips empty calendars).
 */
async function fetchCalendarEvents(
  token: string,
  calId: string,
  range: { timeMin: string; timeMax: string },
): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_CALENDAR; page++) {
    const qs = new URLSearchParams({
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await googleGet<{ items?: RawEvent[]; nextPageToken?: string }>(
      token,
      `${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events?${qs.toString()}`,
    );
    if (!data) break;
    if (data.items?.length) out.push(...data.items);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

/**
 * Fetch the user's events across ALL accessible calendars within [timeMin,
 * timeMax]. Per-calendar failures are skipped rather than failing the whole
 * request. Each calendar is paged to completion (see MAX_PAGES_PER_CALENDAR).
 */
export async function getCalendarEventsForUser(
  db: Db,
  userId: string,
  range: { timeMin: string; timeMax: string },
): Promise<GoogleCalendarResult> {
  if (!googleClientCreds()) return { connected: false, reason: "not_configured" };
  const token = await getAccessTokenForUser(db, userId);
  if (!token) return { connected: false, reason: "auth_required" };

  const list = await googleGet<{ items?: RawCalendarListEntry[] }>(
    token,
    `${CALENDAR_API}/users/me/calendarList`,
  );
  if (!list) return { connected: false, reason: "auth_required" };
  const calendars = (list.items ?? []).filter((c) => c.id && !c.deleted);

  const perCalendar = await Promise.all(
    calendars.map(async (cal) => {
      const items = await fetchCalendarEvents(token, cal.id, range);
      return items
        .filter((ev) => ev.id && ev.status !== "cancelled")
        .map((ev): GoogleCalendarEvent | null => {
          const dateKey = toDateKey(ev.start);
          if (!dateKey) return null;
          const start = ev.start?.dateTime ?? ev.start?.date ?? dateKey;
          const end = ev.end?.dateTime ?? ev.end?.date ?? null;
          return {
            id: `${cal.id}::${ev.id}`,
            calendarId: cal.id,
            calendarName: cal.summary ?? null,
            calendarColor: cal.backgroundColor ?? null,
            title: ev.summary?.trim() || "(no title)",
            start,
            end,
            dateKey,
            allDay: Boolean(ev.start?.date),
            htmlLink: ev.htmlLink ?? null,
            // Only a real invite counts — NOT organizer/creator (see field doc).
            isInvitedAttendee: Boolean(ev.attendees?.some((a) => a.self)),
          };
        })
        .filter((e): e is GoogleCalendarEvent => e !== null);
    }),
  );

  const events = perCalendar.flat().sort((a, b) => a.start.localeCompare(b.start));
  return { connected: true, events };
}

/**
 * Auto-derive default name aliases from a user's display name for title matching.
 *
 * The team formats display names as `部門_姓名 暱稱` — e.g.
 * "數位資訊部_陳偉誠 Frank", "仁美校園長_王姿雅 雅雅". Event titles, however, use
 * only the bare given name / nickname ("…偉誠、睦傑、雅雅"). So we:
 *   1. drop the `部門_` prefix (keep the segment after the last underscore),
 *   2. pull out each CJK run and each Latin run separately (handles a mixed
 *      "陳偉誠 Frank"), and
 *   3. for each CJK run, also add the given name (drop a 1- or 2-char surname).
 * Callers merge these with the user's saved overrides, and the per-user editor
 * still covers cases the title uses a nickname we can't infer (e.g. 唐姐).
 */
export function deriveNameAliases(name: string | null | undefined): string[] {
  const out = new Set<string>();
  const full = (name ?? "").trim();
  if (!full) return [];

  // Strip a leading "部門_" style prefix: keep the segment after the last "_".
  const segment = full.includes("_") ? full.slice(full.lastIndexOf("_") + 1).trim() : full;

  // Candidate runs: the whole segment, each whitespace token, and each maximal
  // CJK / Latin run (so "陳偉誠 Frank" and even "陳偉誠Frank" both split cleanly).
  const candidates = [segment, ...segment.split(/\s+/)];
  for (const m of segment.matchAll(/[一-鿿]+/g)) candidates.push(m[0]);
  for (const m of segment.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) candidates.push(m[0]);

  for (const cand of candidates) {
    const c = cand.trim();
    if (!c) continue;
    out.add(c);
    // Pure-CJK run → also add the given name: drop a 1-char surname, or a
    // 2-char compound surname when the name is long enough.
    if (/^[一-鿿]+$/.test(c)) {
      if (c.length >= 2) out.add(c.slice(1));
      if (c.length >= 4) out.add(c.slice(2));
    }
  }
  // Keep aliases ≥ 2 chars — a single CJK character matches far too much.
  return [...out].filter((a) => a.length >= 2);
}

/**
 * Whether an event is "mine": the caller is a genuine invited attendee, OR the
 * event title contains one of the caller's name-aliases. The team encodes
 * attendees as plain text in the title (one shared calendar, no real invitees),
 * so the title match is the primary signal — see `isInvitedAttendee`'s doc for
 * why owner/organizer is intentionally ignored.
 */
export function eventIsMine(
  event: GoogleCalendarEvent,
  aliases: string[],
): boolean {
  if (event.isInvitedAttendee) return true;
  const title = event.title.toLowerCase();
  return aliases.some((alias) => {
    const a = alias.trim().toLowerCase();
    if (a.length < 2) return false;
    // CJK aliases: plain substring (no word boundaries in CJK).
    if (/[一-鿿]/.test(a)) return title.includes(a);
    // Latin aliases: require a word-ish boundary to limit false positives.
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(a)}([^a-z0-9]|$)`, "i").test(event.title);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve a user's display name (for alias derivation). */
export async function getUserName(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  return row?.name ?? null;
}

/** The user's explicitly-saved aliases (empty array when they've never saved). */
export async function getSavedAliases(db: Db, userId: string): Promise<string[]> {
  const [row] = await db
    .select({ aliases: userCalendarPreferences.nameAliases })
    .from(userCalendarPreferences)
    .where(eq(userCalendarPreferences.userId, userId))
    .limit(1);
  return Array.isArray(row?.aliases) ? row.aliases : [];
}

/** Persist a user's alias overrides (self-scoped; trimmed + de-duplicated). */
export async function setSavedAliases(db: Db, userId: string, aliases: string[]): Promise<string[]> {
  const cleaned = [...new Set(aliases.map((a) => a.trim()).filter((a) => a.length >= 1))].slice(0, 25);
  const now = new Date();
  await db
    .insert(userCalendarPreferences)
    .values({ userId, nameAliases: cleaned, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: userCalendarPreferences.userId,
      set: { nameAliases: cleaned, updatedAt: now },
    });
  return cleaned;
}

/**
 * Effective aliases used for title matching: the user's saved overrides if they
 * have any, otherwise the auto-derived defaults from their SSO display name.
 */
export async function getEffectiveAliases(db: Db, userId: string): Promise<string[]> {
  const saved = await getSavedAliases(db, userId);
  if (saved.length > 0) return saved;
  return deriveNameAliases(await getUserName(db, userId));
}
