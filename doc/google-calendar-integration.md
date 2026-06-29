# Google Calendar Integration + Personal "My Schedule" — Implementation Plan

Status: **planned (not yet built)** · Audience: Season Arts (四季藝術) Paperclip deployment

## Goal

1. Each user logs in with **their own Google account** via the existing Google SSO/OAuth
   (seasonart.org domain lock) and Paperclip can read **all the Google Calendar events
   they can already see** (own + shared + team/department calendars).
2. The main **Calendar page stays a full view** — identical philosophy to Google Calendar
   today; nothing hidden.
3. A new **dashboard widget ("我的行程 / My Schedule")** shows only the events **related to the
   logged-in user**. Asana tasks (already integrated) and issue due dates continue to appear
   on the calendar as today.

### The Season Arts constraint (drives the design)

Meetings are NOT created with real calendar attendees. Organizers just **type attendee names
into the event title** (e.g. `週會 睦傑 思瑜 惠君`). So there is no structured "this event is
for Jay" signal — the only signal is **the user's name appearing in the title**. The personal
view therefore matches on **title text**, layered with real ownership/attendee data when present.

## Locked decisions

- **Token model:** server-side reuse of the SSO-stored Google token (simplest; matches "log in with Google").
- **Calendar scope per user:** **all accessible calendars** (primary + shared + team/department).
- **Name aliases:** **auto-derived from SSO name + user-editable** per person.
- **Main calendar:** add a **title search/filter box** (keeps the manual "find my name" people do today).
- **v1 is read-only** (no event creation/editing from Paperclip).

## What already exists (foundation)

| Piece | Status | Reference |
|---|---|---|
| Asana → calendar overlay | ✅ done | `ui/src/pages/MyCalendar.tsx:247-289` |
| Google SSO + `hd: seasonart.org` lock | ✅ live | `server/src/auth/better-auth.ts:269-278` |
| Per-user OAuth tokens (access/refresh/scope) | ✅ stored | `packages/db/src/schema/auth.ts:24-38` (`authAccounts`) |
| Calendar aggregates issues + projects + Asana | ✅ done | `ui/src/pages/MyCalendar.tsx:225-334` |
| Per-user prefs table pattern | ✅ exists | `packages/db/src/schema/user_sidebar_preferences.ts` |
| Asana-digest endpoint pattern (per-user, self-scoped) | ✅ exists | `server/src/routes/dashboard.ts:44-51` |

## Phases

### Phase 0 — Google Cloud (IT, no code)
In the existing **"Paperclip Seasonarts"** GCP project:
1. Enable **Google Calendar API**.
2. Add scope `https://www.googleapis.com/auth/calendar.readonly` to the OAuth consent screen.
3. If the consent screen is **Internal** (Workspace-only — implied by `hd: seasonart.org`), the
   calendar scope needs **no Google verification/review**.

### Phase 1 — Auth: request the calendar scope
File: `server/src/auth/better-auth.ts:269-278`
```ts
google: {
  clientId, clientSecret, hd: googleHostedDomain,
  scope: ["https://www.googleapis.com/auth/calendar.readonly"],
  accessType: "offline",  // return a refresh_token
  prompt: "consent",      // existing users re-consent once to grant the new scope
}
```
- One-time re-consent for existing users; new users get it automatically.
- No migration — `authAccounts` already stores the tokens.

### Phase 2 — Server: Google Calendar service
New file: `server/src/services/google-calendar.ts`
- `getCalendarEventsForUser(db, auth, userId, { timeMin, timeMax })`:
  1. Fresh access token via better-auth `auth.api.getAccessToken({ body: { providerId: "google", userId }})`
     (auto-refresh; manual Google token-endpoint refresh as fallback).
  2. No google account / missing scope / refresh fail → `{ connected: false, reason: "auth_required" }`.
  3. **All calendars:** `GET calendarList` → per calendar `GET events?timeMin&timeMax&singleEvents=true&orderBy=startTime`; merge.
  4. Normalize → `{ id, calendarId, title, start, end, allDay, htmlLink, calendarColor }`.
     Convert RFC3339 → local `YYYY-MM-DD` date key honoring timezone (main correctness gotcha).
- **Caching:** fetch only the visible window; short TTL (~60s, like the Asana digest) for rate limits.

### Phase 3 — Server: endpoints (mirror Asana-digest pattern, `server/src/routes/dashboard.ts`)
```
GET /companies/:companyId/google-calendar/me?timeMin=&timeMax=
    → { connected, events[] }   (full accessible set, for the Calendar page)
GET /companies/:companyId/google-calendar/mine?timeMin=&timeMax=
    → { connected, events[] }   (personal subset, for the dashboard widget)
```
- `assertCompanyAccess(req, companyId)`; `userId = req.actor.userId` (board actor only).
- **Isolation is structural:** caller's own userId → own token → only their calendars.

### Phase 4 — Personal matching (title-based + ownership/attendee)
New table (migration `9014_user_calendar_preferences.sql`), modeled on `user_sidebar_preferences`:
```
user_calendar_preferences(
  id uuid pk, user_id text unique,
  name_aliases jsonb string[] default [],   -- editable; defaults auto-derived from SSO name
  created_at, updated_at
)
```
- **Alias derivation helper:** from the SSO display name produce defaults — full name (`黃睦傑`),
  given name (`睦傑`, full minus surname), English/preferred name (`Jay`). User can edit in settings.
- **An event is "mine" if:** user is creator/owner **OR** a real attendee **OR** the **title contains
  any alias** (case-insensitive; word-ish boundary for Latin names to limit false hits).
- Surface the widget results as **"可能相關 / likely related"** — title-matching is a heuristic
  (common names / mentioned-but-not-attending can over/under-match).
- Endpoints to read/update aliases:
  `GET/PUT /companies/:companyId/google-calendar/aliases` (self-scoped).

### Phase 5 — UI
- New `ui/src/api/googleCalendar.ts` (me / mine / aliases).
- `ui/src/pages/MyCalendar.tsx`: add Google events as a 4th source (distinct dot color, e.g. green
  vs Asana sky-blue); plumb through `IssueCalendar` (month), `WeekView`, `AgendaList` like `asanaEvents`.
  Add a **title search/filter box**. Show **"Connect Google Calendar"** banner on `auth_required`.
- New **dashboard "我的行程 / My Schedule" card** next to the Asana digest, fed by `/mine`.
- Small **alias editor** in user settings ("行事曆名稱比對 / Calendar name matching").
- **i18n:** add all new strings to **all 40 locale files** (zh-TW proper, English fallback) or
  `locale-validation.test.ts` fails.

### Phase 6 — Verify
- `npx tsc -b` from repo root (true full typecheck), `locale-validation` test, then manual:
  log in → re-consent → confirm full calendar shows all accessible events + Asana + due dates,
  and the dashboard widget shows only title/owner/attendee matches for you.

## Risks / notes

| Risk | Handling |
|---|---|
| Existing users lack scope | One-time re-consent (`prompt:"consent"`); "Connect" banner until then |
| Missing/expired refresh token | `accessType:"offline"`; failure → `auth_required`, never a hard error |
| Title matching is heuristic | Editable aliases + label as "likely related"; layer with owner/attendee data |
| Google API rate limits | Visible-window fetch + short TTL cache |
| Timezone / all-day events | Normalize RFC3339 → local date key server-side |
| "All calendars" noise | Per user's choice; optional per-calendar toggle later |
| Server now uses the token | Accepted; read-only; better-auth stores it for this purpose |

## Effort
~1–2 focused sessions. One small migration (`9014`). Purely additive — issues, projects, and
Asana already work on the calendar.
