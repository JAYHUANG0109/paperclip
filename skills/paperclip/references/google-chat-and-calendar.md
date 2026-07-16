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

## Create a Google Calendar event

Reading calendar events (the dashboard) and creating them use **different**
Google auth. Creating goes through this server-side endpoint, which uses the
target user's own stored Google token (write scope) — it does NOT depend on any
per-user MCP connector, so it works from autonomous/task runs.

- As a **board user**, it creates on your own calendar.
- As an **agent**, it creates on your **responsible/owner user's** calendar.

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "content-type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/google-calendar/me/events" \
  -d '{
    "summary": "創辦人週誌批閱",
    "start": "2026-07-20T14:00:00+08:00",
    "end":   "2026-07-20T15:00:00+08:00",
    "timeZone": "Asia/Taipei",
    "description": "…",
    "attendees": ["someone@seasonart.org"]
  }'
```

- Timed event: RFC3339 `start`/`end` (+08:00 for Taipei) with `timeZone`.
- All-day event: `start`/`end` as `YYYY-MM-DD` (end is exclusive; omit `end` for a
  single day).
- `end` optional — defaults to +1h (timed) or +1 day (all-day).
- Success → `201 { created: true, id, htmlLink }`.
- **`409 { error: "auth_required" }`** → the user has not consented to the
  calendar write scope. Ask them to sign out and back in with Google SSO once
  (re-consent) to grant it; then retry. This is not fixable agent-side.
