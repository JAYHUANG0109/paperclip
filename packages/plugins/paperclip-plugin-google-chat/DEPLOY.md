# Live wiring — Google Chat ↔ Paperclip (echo bring-up)

Goal: a message you DM the SeasonartsAI bot in Google Chat comes back as
`echo: <your text>`. Once that works, the transport is proven and we swap the
echo for real agent routing.

## How it flows

```
You (Google Chat)
   │  POST (with a Google-signed Bearer JWT)
   ▼
Tailscale Funnel  https://<mac>.ts.net   ──►  Paperclip :3100
   │
   ▼
/api/plugins/paperclip-plugin-google-chat/webhooks/google-chat-events
   │  verify JWT → mint SA token → reply
   ▼
chat.googleapis.com/v1/{space}/messages   ──►  back to you in Chat
```

The reply is **asynchronous** (a second API call), not the HTTP response — the
plugin SDK's webhook handler can't return a message body.

---

## Who does what

| Step | Who | Surface |
|------|-----|---------|
| 1. Install + enable the plugin | Claude (CLI) | `paperclipai plugin ...` |
| 2. Store the SA key as a secret | **You** | Web UI (no CLI for secrets) |
| 3. Install Tailscale + enable Funnel | **You** | terminal + tailnet admin console |
| 4. Point the Chat app at the Funnel URL | **You** | Google Cloud Console |
| 5. Live echo test | both | Google Chat |

---

## Step 1 — Install & enable the plugin  *(Claude can run these)*

Keep a watch-build running so rebuilt `dist/` reloads into Paperclip:

```bash
cd ~/dev/paperclip-plugins/paperclip-plugin-google-chat
pnpm dev        # leave running in its own terminal
```

Install from the local path, then enable:

```bash
paperclipai plugin install ~/dev/paperclip-plugins/paperclip-plugin-google-chat
paperclipai plugin enable paperclip-plugin-google-chat
paperclipai plugin list          # confirm status: ready / enabled
```

---

## Step 2 — Store the service-account key as a secret  *(you, in the Web UI)*

The plugin reads its SA key through `ctx.secrets.resolve("google-chat-service-account")`.

1. Open Paperclip → **Company Settings → Secrets** (`/company/settings/secrets`).
2. Click **+ New Secret** (managed / `local_encrypted` is the default — fine).
3. **Name:** `google-chat-service-account`
   (if there's a separate **Key** field, set it to the same string).
4. **Value:** paste the **entire contents** of the SA JSON file — the whole
   `{ ... }`, not a path. Get it with:
   ```bash
   cat ~/.config/paperclip/google-chat/sa.json
   ```
5. Save.

> The plugin parses this JSON and signs a short-lived token from it — so it must
> be the full key file, including `client_email` and `private_key`.

If you name it something else, set the plugin's `serviceAccountSecretRef` config
field to match (Plugins → Google Chat → Configuration).

---

## Step 3 — Tailscale Funnel: a public HTTPS URL for your Mac  *(you, hands-on)*

Tailscale is **not installed yet**. Funnel gives Google a stable public HTTPS URL
that tunnels to your local `:3100` — no router/port-forwarding.

1. **Install Tailscale** (easiest is the app, which bundles the daemon):
   ```bash
   brew install --cask tailscale
   ```
   Open the Tailscale app, sign in with the seasonart.org Google account, and
   leave it connected.

2. **Enable HTTPS + Funnel for the tailnet** (one-time, admin console):
   - Go to https://login.tailscale.com/admin/dns → enable **MagicDNS** and
     **HTTPS Certificates**.
   - Go to https://login.tailscale.com/admin/settings/features (or edit the ACL)
     and make sure **Funnel** is allowed for this machine. Tailscale will tell
     you the exact `nodeAttr`/`funnel` ACL line if it's not on.

3. **Start the Funnel** pointing at Paperclip:
   ```bash
   tailscale funnel --bg 3100
   tailscale funnel status      # prints your public https://<mac>.<tailnet>.ts.net URL
   ```
   Copy that `https://<mac>.<tailnet>.ts.net` URL.

   > The Mac must stay awake/connected for the bot to respond (System Settings →
   > Battery/Energy → prevent sleep, or run on a dedicated always-on Mac later).

Your **webhook URL** is that host + the plugin path:

```
https://<mac>.<tailnet>.ts.net/api/plugins/paperclip-plugin-google-chat/webhooks/google-chat-events
```

Quick sanity check (should reach Paperclip, not time out):
```bash
curl -i https://<mac>.<tailnet>.ts.net/api/plugins/paperclip-plugin-google-chat/health
```

---

## Step 4 — Point the Chat app at the Funnel URL  *(you, Google Cloud Console)*

Project: **vital-defender-490707-b6** ("Paperclip Seasonarts"), project number
**455778754146**.

1. Console → **APIs & Services → Google Chat API → Configuration**
   (or search "Chat API" → Manage → Configuration).
2. **Connection settings / App URL:** select **HTTP endpoint URL** and paste the
   webhook URL from Step 3.
3. **Authentication Audience:** select **Project Number**.
   ⚠️ This must be **Project Number**, not "App URL" — the plugin verifies the
   JWT audience equals `455778754146`. (That value is the `audience` default in
   the plugin config; if you ever change the project, update both.)
4. Make sure the app is **Live/運作中** and the allowlist still includes
   `jay20020109@seasonart.org` and `claude_bot_08@seasonart.org`.
5. Save. Changes take effect within a minute or so.

---

## Step 5 — Live echo test

1. In Google Chat, open a DM with **SeasonartsAI** (or @mention it in a space
   it's in).
2. Send `hello`.
3. Expect `echo: hello` back within a couple of seconds.

If it doesn't reply, check, in order:

```bash
paperclipai plugin inspect paperclip-plugin-google-chat   # status / lastError
paperclipai plugin logs paperclip-plugin-google-chat      # per-request logs
```

Common causes:
- **401 / "Authorization header" / "audience" in logs** → Step 4 audience isn't
  set to Project Number, or the URL points somewhere else.
- **"Service account JSON missing…" / token errors** → the secret value isn't the
  full sa.json, or the name doesn't match `serviceAccountSecretRef`.
- **No request reaches the logs at all** → Funnel down (`tailscale funnel status`)
  or the Chat app URL is wrong / not saved.
- **Mac asleep** → bot silent; wake it.

---

## Toggles (Plugins → Google Chat → Configuration)

| Field | Default | Notes |
|-------|---------|-------|
| `serviceAccountSecretRef` | `google-chat-service-account` | must match the secret name/key |
| `echoMode` | `true` | bring-up echo; turn off when real routing lands |
| `routingEnabled` | `false` | relay messages to agents instead of echoing |
| `gateUnassigned` | `false` | when on, only assigned users get a reply (manage on the settings page) |
| `unassignedMessage` | 請聯絡資訊部… | reply sent to unassigned senders |
| `verifyInbound` | `true` | verify Google's signed JWT; keep on |
| `audience` | `455778754146` | GCP project number for JWT audience |

## Proactively messaging someone by email (agent tool)

The plugin exposes an agent tool, **`send_chat_message`** (params: `email`,
`text`), so a Paperclip agent (e.g. the CEO agent) can DM a person on Google
Chat by email — "tell sinney@… her report is ready."

How it reaches people, and the hard limits:

- A Chat app authenticated as a **service account (`chat.bot`) cannot open a
  brand-new DM** — `spaces.setup` requires *user* auth. So the bot can only
  message people it already shares a DM space with.
- To make that practical, the plugin **learns an `email → DM space` mapping from
  every inbound DM**. Once someone has messaged SeasonartsAI even once, the agent
  can DM them by email indefinitely. Unknown emails return a clear error
  ("they need to message SeasonartsAI at least once first").
- The recipient must also be on the Chat app's **allowlist** (Step 4) — that's
  what lets them find/add the bot in the first place.

**Cold outreach to someone who has never messaged the bot** needs two extra
things, not built here: (1) resolve email → numeric user id via the Admin SDK
Directory API (service-account **domain-wide delegation** + an admin grant for
`admin.directory.user.readonly`), then `spaces.findDirectMessage(users/{id})`;
and (2) the person must still have **added the app** (an app can't create the DM).
`findDirectMessageSpace()` in `chat.ts` is the building block for (1).

## How replies reach Chat (mirroring + formatting)

The bot **mirrors the agent conversation**: every new agent message on a
Chat-originated issue is forwarded to the originating space as it's posted
(triggered by `issue.comment.created`), so Chat reads like the Paperclip thread
— not just one message at the end.

- Forwarded: agent comments only. **Filtered out:** the user's own echo, system
  notices (`presentation.kind === "system_notice"`), the bot's "⏳" ack, and the
  agent's internal heartbeat/ops notes ("Heartbeat done", "no action needed", …).
- De-duped per issue by comment id + a body signature, so an agent reposting the
  same answer doesn't double-send.
- **Formatting for Chat** ([format.ts](./src/format.ts)): markdown is converted to
  Chat's dialect — `**bold**`→`*bold*`, `#` headers→bold lines, `[t](u)`→`<u|t>`,
  bullets→`•`. **Markdown tables become fixed-width monospace code blocks**
  (CJK-aware padding so Chinese columns align). Long replies are split into
  multiple messages under Chat's 4096-char limit, without breaking a code block.

> Earlier bug (fixed): delivery fired once on the first `done` and forgot the
> issue, so when a CEO dispatched to a sub-issue and the parent churned through
> `done`, Chat got the interim plan and never the real answer.

## Who gets a response (access control)

When the bot is visible org-wide, **only people with an assignment get a real
reply.** This is enforced inside the plugin, independent of Google's allowlist:

- Manage assignments at **Paperclip → Company Settings → Google Chat**
  (`/<company>/company/settings/google-chat`): an email → agent table with a
  dropdown to add, and Remove buttons.
- An **assigned** sender is routed to *their* agent (per-person, not a single
  default).
- An **unassigned** sender gets the `unassignedMessage` ("請聯絡資訊部…") and **no
  agent run is created**.
- Controlled by config `gateUnassigned` (default **off** — a fresh install keeps
  answering everyone via `defaultAgentUrlKey`). **Turn it on once you've added
  assignments**, and definitely before making the bot org-wide visible.

Making the bot org-wide visible needs a Workspace admin — see
[VISIBILITY-IT-HANDOFF.md](./VISIBILITY-IT-HANDOFF.md).

## Known gaps still open

- **Webhook failure status** — the SDK webhook contract returns void, so a failed
  verification surfaces as a 5xx (not the 401 Google's docs prefer). Forged
  requests fail signature checks regardless; genuine-but-late requests get
  retried by Google. Acceptable for bring-up.
- **Cold DM by email** — see above; needs Admin SDK delegation and the recipient
  having added the app.
