# Google Chat (rooms + DMs) and Google Calendar (create events)

Two capabilities that are NOT built-in harness tools — you reach them through the
Paperclip API using the auto-injected `$PAPERCLIP_API_URL` and
`$PAPERCLIP_API_KEY`. They will NOT appear in your deferred-tools / ToolSearch
list; do not conclude "there is no endpoint" just because the tool isn't mounted.
Always add `-H "Authorization: Bearer $PAPERCLIP_API_KEY"` and, for issue-linked
work, `-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"`.

## Post to a Google Chat GROUP ROOM (空間)

Group send is a **plugin tool** (`send_chat_space_message`), contributed by the
Google Chat plugin. It is available whenever that plugin's worker is running —
independent of whether this run was triggered from a chat message or a task.

Do NOT use `send_chat_message` for a room — that one is a **direct message to a
single person** by email. The room tool is `send_chat_space_message`.

**Step 1 — find the namespaced tool name** (the plugin id prefixes it):

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/plugins/tools" | jq '.[] | select(.name | test("send_chat_space_message$")) | .name'
# → e.g. "paperclip-plugin-google-chat:send_chat_space_message"
```

If that returns nothing, the Google Chat plugin worker is not running/registered
— report that as the blocker (an operator must start/redeploy the plugin); it is
not an agent-side error.

**Step 2 — post to the room by name** (the bot must already be a member; a unique
partial name works; the message is auto-prefixed with your agent name):

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d '{
    "tool": "paperclip-plugin-google-chat:send_chat_space_message",
    "parameters": { "space": "領導團隊", "text": "本週週誌批閱已完成，摘要如下…" },
    "runContext": { "agentId": "'"$PAPERCLIP_AGENT_ID"'", "companyId": "'"$PAPERCLIP_COMPANY_ID"'", "runId": "'"$PAPERCLIP_RUN_ID"'" }
  }'
```

If the room name isn't found, the tool returns the list of rooms it can reach —
pick the right name and retry. To DM one person instead, use the same execute
call with `"tool": "…:send_chat_message"` and `parameters: { "email", "text" }`.

## Google Calendar

Reading calendar events (the dashboard) and creating them use **different** Google
auth. Creating goes through the server-side endpoints below, which use the target
user's own stored Google token (write scope) — NOT any per-user MCP connector, so
they work from autonomous/task runs. As a board user it acts on your own calendar;
as an agent it acts on your **responsible/owner user's** calendar.

### The shared calendar (where most events go)

The org's cross-campus shared calendar **跨校共用行事曆** is company-wide knowledge —
the **same id for everyone**, though each person writes with their own token (so
they need edit rights on it):

```
id:   hpuapgl9i1f3830r3bppanqsc0@group.calendar.google.com
name: 跨校共用行事曆
```

**New events default to this calendar** when you don't pass a `calendarId`. Pass a
specific id (e.g. `"primary"` for the person's personal calendar) only when the
event clearly belongs elsewhere.

### List the owner user's calendars

Different users have different 我的日曆 / 其他日曆 by role/department/campus. Fetch the
owner's list (ids + names + whether they can write) so you target the right one:

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-calendar/me/calendars"
# → { connected, defaultCalendarId, calendars: [ { id, name, primary, accessRole, canWrite, color } ] }
```

Only calendars with `canWrite: true` (accessRole owner/writer) accept new events.

### ALWAYS ask which calendar first (do NOT assume)

When a user asks you to put something on "the calendar", you MUST NOT silently
pick a calendar — not even the shared default. Ask them, with a checkbox card
listing THEIR calendars, and let them multi-select one or more targets.

1. Fetch the user's writable calendars (list endpoint above; keep `canWrite: true`,
   and always include 跨校共用行事曆 / `defaultCalendarId` as an option).
2. Create a `request_checkbox_confirmation` interaction on the issue — one option
   per calendar (`id` = the calendar id, `label` = its name), default-select the
   shared calendar. Set `continuationPolicy: "wake_assignee"`. See the
   interactions section of `api-reference.md` for the payload shape.
3. Move the issue to `in_review` and wait — the pending card is your waiting path.
4. On the wake, read the selected calendar ids and **create the event once per
   selected calendar** (the create call below, passing each `calendarId`). Report
   the resulting event links back in a comment.

Example option list built from the list endpoint:

```json
{
  "kind": "request_checkbox_confirmation",
  "title": "要建立在哪個日曆？ / Which calendar(s)?",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "選擇要建立這個活動的日曆（可複選）。",
    "options": [
      { "id": "hpuapgl9i1f3830r3bppanqsc0@group.calendar.google.com", "label": "跨校共用行事曆" },
      { "id": "primary", "label": "我的主要日曆 (personal)" }
    ],
    "defaultSelectedOptionIds": ["hpuapgl9i1f3830r3bppanqsc0@group.calendar.google.com"],
    "minSelected": 1,
    "acceptLabel": "建立活動",
    "rejectLabel": "取消"
  }
}
```

Skip the card ONLY if the user already named a specific calendar in their request
(e.g. "put it on the shared calendar" / "on my personal calendar").

### Create an event (once per selected calendar)

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-calendar/me/events" \
  -d '{
    "summary": "創辦人週誌批閱",
    "start": "2026-07-20T14:00:00+08:00",
    "end":   "2026-07-20T15:00:00+08:00",
    "timeZone": "Asia/Taipei",
    "calendarId": "hpuapgl9i1f3830r3bppanqsc0@group.calendar.google.com",
    "description": "…",
    "attendees": ["someone@seasonart.org"]
  }'
```

- Timed event: RFC3339 `start`/`end` (+08:00 for Taipei) with `timeZone`.
- All-day event: `start`/`end` as `YYYY-MM-DD` (end is exclusive; omit `end` for a
  single day).
- `end` optional — defaults to +1h (timed) or +1 day (all-day).
- Success → `201 { created: true, id, htmlLink }`.
- **`409 { error: "auth_required" }`** → the user hasn't consented to the calendar
  write scope. Ask them to sign out/in with Google SSO once (re-consent). Not
  fixable agent-side.
- **`403 { error: "forbidden", detail: "…writer access…" }`** → the token is fine
  but the user's account only has **view** access to that calendar. Ask them to
  set their access to **「變更活動 (Make changes to events)」** in that calendar's
  sharing settings, OR target a calendar they can edit (check `canWrite` from the
  list endpoint; `"primary"` is always writable). Do NOT tell them to re-authorize
  — that won't help; this is a calendar-sharing issue.

### Update an event in place (e.g. change the time)

```bash
curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-calendar/me/events" \
  -d '{
    "eventId": "<calendarId::eventId or bare id>",
    "calendarId": "<calId if eventId is bare>",
    "start": "2026-07-17T15:00:00+08:00",
    "end":   "2026-07-17T16:00:00+08:00",
    "timeZone": "Asia/Taipei"
  }'
```

Only the fields you send change (`summary`, `start`, `end`, `description`,
`location`). To reschedule, send `start`+`end`. Get the `eventId` from the read
endpoint (its `id` is the composite `"<calendarId>::<eventId>"`). Success →
`{ updated: true, id, htmlLink }`; same 403/409/404 semantics as create.

### Delete an event

```bash
curl -s -X DELETE -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-calendar/me/events?eventId=<id>&calendarId=<calId>"
```

`eventId` accepts a bare Google id (with `calendarId`) or the read endpoint's
composite `"<calendarId>::<eventId>"`. Success → `{ deleted: true }` (also treats
already-deleted as success). Same 403 forbidden / 409 auth_required semantics.

---

# Gmail (read + draft) — server-side, NOT the MCP connector

Same model as the calendar endpoints above: they act with the **responsible
user's OWN** Google token and auto-refresh it. Do **not** use the claude.ai Gmail
MCP connector — it is one shared connector identity bound to a single account, its
token expires and cannot be re-authorized from a non-interactive run, and it reads
the wrong person's mailbox. It is blocked at the tool layer for local runs.

These endpoints will NOT appear in your deferred-tools / ToolSearch list. Do not
conclude "there is no Gmail endpoint" because no tool is mounted — curl them.

If a call returns `{"connected": false, "reason": "auth_required"}`, that user has
not yet granted the Gmail scopes (they are granted at Google sign-in). Report that
as the blocker and name the user — do not fall back to MCP.

### Read recent mail

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/gmail/me?limit=10"
```

`gmail/me` and `google-gmail/me` are the same endpoint. Returns headers + snippet
only (`from`, `to`, `subject`, `date`, `snippet`, `unread`) — no message bodies.

### Search mail

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/gmail/search?q=is:unread+newer_than:2d&limit=20"
```

`q` is ordinary Gmail search syntax (`is:unread`, `from:someone@x.com`,
`has:attachment`, `newer_than:7d`). Prefer a narrow `q` over fetching everything.

### Read one message (body)

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/gmail/messages/<messageId>?format=full"
```

Default is `format=metadata` (no body). Request `format=full` only when you
actually need the body — every body read is recorded in the activity log.

### Create a DRAFT (never sends)

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/gmail/drafts" \
  -d '{
    "to": "someone@seasonart.org",
    "subject": "…",
    "bodyText": "…",
    "threadId": "<optional, to reply inside a thread>"
  }'
```

Success → `201 {"connected":true,"draft":{"draftId","messageId","threadId"}}`.
The draft lands in the user's Gmail for them to review and send. **There is no
send endpoint and there will not be one** — if a task asks you to send mail,
create the draft and tell the human it is waiting for them.

### Handling what you read

Mail and chat content belongs to the person whose mailbox it is. Summarize; do not
quote private content into issue comments, which colleagues can read. If detail is
needed, say so and let the human open it themselves.

---

# Google Chat history (read the user's own DMs + rooms)

Reads as the **user** (not the bot), so it covers DMs and rooms the responsible
user belongs to — unlike the plugin's bot identity, which only sees rooms the bot
joined. Requires the Chat read scopes, granted at Google sign-in; otherwise
`{"connected": false, "reason": "auth_required"}`.

### List the user's spaces (rooms + DMs)

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-chat/spaces"
```

### Messages in one space

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-chat/messages?space=spaces/AAA&limit=50&since=2026-07-01T00:00:00Z"
```

### Search across the user's history

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-chat/history?q=請假&since=2026-07-01T00:00:00Z"
```

Answers "look through my chat history and see if anything needs attention". The
sweep is bounded (20 spaces × 30 messages by default, tunable via `maxSpaces` /
`perSpace`), so **always pass `since` when the question has a time frame** —
otherwise you see a recent slice and may miss older matches. Every read is logged.

---

# Google Sheets (read + write) — server-side, per user

Acts with the responsible user's OWN token, like the endpoints above. Use this for
anything belonging to a person. For SHARED company spreadsheets on a service account
with an id allowlist, the separate `google-sheets-mcp-server` connection exists — the
two are different tools for different jobs.

**You cannot search Drive for a sheet.** The app holds `drive.file` only, so you need
the spreadsheet id — paste the Google Sheets URL and the endpoints extract it — or a
sheet you created yourself through the create endpoint below.

### Tabs and sizes (do this first)

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-sheets/<idOrUrl>"
```

Returns the title, URL and every tab with its row/column counts, so you can build a
correct A1 range instead of guessing one.

### Read a range

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-sheets/<idOrUrl>/values?range=工作表1!A1:F50"
```

Capped at 2000 rows. Ask for the range you need rather than the whole sheet.

### Append rows (the safe write)

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-sheets/<idOrUrl>/append" \
  -d '{"range":"工作表1!A:F","values":[["2026-07-31","王小明","報到"]]}'
```

Adds rows below the existing data. **Prefer this over overwriting.**

### Overwrite an explicit range

```bash
curl -s -X PUT -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-sheets/<idOrUrl>/values" \
  -d '{"range":"工作表1!A2:C2","values":[["updated","row","here"]]}'
```

This REPLACES those cells. It is how a routine silently destroys a colleague's
hand-edited rows, so only use it when you mean exactly those cells, and never widen
the range "to be safe". If you are refreshing a generated block, overwrite only that
block and leave human-edited columns alone.

### Create a new spreadsheet

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-sheets" \
  -d '{"title":"2026 Q3 招生統計"}'
```

Returns the new id and URL. Sheets created this way are app-created, so they stay
reachable afterwards.

`{"connected": false, "reason": "not_found"}` usually means the user cannot open that
spreadsheet, not that the id is wrong — ask them to share it with themselves' account
or send a different link.

---

# Google Slides (read + write) — server-side, per user

Acts with the responsible user's OWN token. Same `drive.file` caveat as Sheets: you
**cannot search Drive** for a deck — pass the id or the pasted Slides URL, or use a
deck you created here.

**Where created decks land.** A deck created through `POST .../google-slides` is filed
into the user's "Paperclip 產出檔案" folder automatically, and the response reports
`filedInOutputFolder`. It is no longer left loose in My Drive root.

That still is not the same as a deliverable: an artifact is tracked by Paperclip and
shows on the task with a download button, whereas a native deck is a live document.
Use these endpoints for decks people keep editing together — org charts, recurring
review decks — and upload an artifact when the task has finished output to hand over.

### Read a deck (slide ids + text)

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-slides/<idOrUrl>"
```

Returns the title, slide count, and for each slide its `objectId`, index and the text
on it — so you can see what a deck says before changing anything, and you get the
`objectId` values the text endpoint needs.

### Fill a template deck (the main write path)

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-slides/<idOrUrl>/replace-text" \
  -d '{"replacements":[
        {"find":"{{校區}}","replace":"仁美校"},
        {"find":"{{月份}}","replace":"2026 年 8 月"}
      ]}'
```

Replaces every occurrence across all slides. **Prefer this over free-form editing:** it
only touches text the template author deliberately marked, so it cannot mangle a
layout. Keep a template deck with `{{placeholders}}` and populate a copy.

### Add a slide

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-slides/<idOrUrl>/slides" \
  -d '{"insertionIndex":2,"layout":"TITLE_AND_BODY"}'
```

### Type into one shape

`objectId` must be a **SHAPE** id, not a slide id. Read the deck first and take an id
from a slide's `shapes[]` — each entry has `objectId`, its current `text`, and its
`placeholder` role (`TITLE`, `BODY`, …), so pick the shape you mean:

```bash
# 1. find the shape
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-slides/<idOrUrl>" \
  | jq '.presentation.slides[].shapes[] | {objectId, placeholder, text}'

# 2. write into it
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-slides/<idOrUrl>/text" \
  -d '{"objectId":"<a shapes[].objectId>","text":"本月招生 42 人"}'
```

Passing a slide id returns `{"connected":false,"reason":"bad_request","detail":"…"}` with
Google's explanation. **`bad_request` means the request was wrong, not that auth failed** —
read `detail` and fix the call rather than assuming a scope or token problem.

### Create a deck

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-slides" \
  -d '{"title":"2026 Q3 招生檢討"}'
```

Formatting (colours, fonts, images, tables, speaker notes) is **not** implemented — only
text and slide structure. Ask for it if a task genuinely needs it rather than trying to
fake it with text.

---

# Google Docs (read + write) — server-side, per user

Same per-user token model and the same `drive.file` caveat: **no Drive search** — pass
the document id or a pasted Docs URL, or use a doc you created here.

Documents created through `POST .../google-docs` are filed into the user's
"Paperclip 產出檔案" folder automatically, and the response reports
`filedInOutputFolder`.

### Read a document

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-docs/<idOrUrl>"
```

Returns the title and the body as text, including text inside tables (a lot of real
content here lives in tables, so skipping them would look like an empty document).
Truncated at 100k characters with `truncated: true` when it happens.

### Fill a template (preferred write)

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-docs/<idOrUrl>/replace-text" \
  -d '{"replacements":[{"find":"{{姓名}}","replace":"王小明"},{"find":"{{日期}}","replace":"2026-07-31"}]}'
```

### Append to the end

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-docs/<idOrUrl>/append" \
  -d '{"text":"\n\n## 2026-07-31 補充\n本週追蹤事項…"}'
```

### Create a document

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-docs" \
  -d '{"title":"仁美校 8 月週報"}'
```

**There is no "replace the whole document" endpoint, and that is deliberate.** Wholesale
rewriting is how an agent destroys a colleague's writing. Fill marked placeholders, or
append — never reconstruct someone's document from scratch. Formatting (headings, bold,
tables) is not implemented; text only.
