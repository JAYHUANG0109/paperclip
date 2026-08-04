# Paperclip MCP server

A **zero-dependency** [Model Context Protocol](https://modelcontextprotocol.io) server that lets **Claude Desktop** (or any MCP client) drive a Paperclip instance using a Paperclip **API key**. One file, no `npm install`, just Node ≥ 18.

## What it can do

It authenticates every call as the key you give it, so the key decides what succeeds:

| Key type | Token | Capabilities |
|---|---|---|
| **Agent key** | `pcp_…` | The agent's own surface: tasks, the agent owner's memory, routines. Harness edits (skills / `AGENTS.md`) are **refused (403)**. |
| **User / board key** | `pcp_board_…` | Acts as **you**, with everything you can do in the UI — **including** harness edits (rewrite `AGENTS.md`, change skills). |

The server exposes the whole surface; a call the key isn't allowed to make comes back as a normal tool error (e.g. `HTTP 403 … Missing permission`).

## Requirements

- **Node ≥ 18** (uses the built-in `fetch`).
- The machine running this must be able to reach your Paperclip host. If the host is on a **Tailscale tailnet** (`*.ts.net`), this server must run on a machine **on that tailnet** — e.g. your own Mac. A cloud/remote MCP cannot reach a tailnet-only host.

## Configure Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "paperclip": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp/paperclip-mcp/paperclip-mcp.mjs"],
      "env": {
        "PAPERCLIP_API_URL": "https://YOUR-HOST.ts.net/api",
        "PAPERCLIP_API_KEY": "pcp_board_…",
        "PAPERCLIP_COMPANY_ID": "your-company-uuid"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the **paperclip** tools appear. Use a `pcp_board_…` key for full capability, or a `pcp_…` agent key for the safer, narrower surface.

> The key is a bearer credential — **whoever holds it acts as that identity.** Keep the config private, and revoke the key in Paperclip (設定 → API 金鑰) when it's no longer needed.

## Environment variables

| Var | Required | Meaning |
|---|---|---|
| `PAPERCLIP_API_URL` | yes | API root, e.g. `https://host.ts.net/api` |
| `PAPERCLIP_API_KEY` | yes | `pcp_…` (agent) or `pcp_board_…` (user) |
| `PAPERCLIP_COMPANY_ID` | no | Default company id for tools that need one (else pass `companyId` per call) |
| `PAPERCLIP_RUN_ID` | no | Stamped as `X-Paperclip-Run-Id` on writes for audit linkage |

## Full access

Two tools together give **complete access to everything the platform can do** — nothing is out of reach for a board key:

- **`describe_api`** — discover the entire API (the OpenAPI spec, ~600 endpoints). No args → a searchable index; `search: "skill"` → filter; `path: "…"` → full detail (params + body schema) for one endpoint.
- **`paperclip_request`** — call **any** of those endpoints with any method/body.

The named tools below are just ergonomic shortcuts for the common operations.

## Tools

- **Discovery / generic** — `describe_api`, `paperclip_request`
- **Tasks** — `list_tasks`, `get_task`, `create_task`, `update_task`, `checkout_task`
- **Memory** — `list_memory`, `add_memory` (create **or** update one entry), `delete_memory`
- **Skills — library** (board key) — `import_skills` (add/update by importing a source), `install_catalog_skill`, `delete_skill`, `list_company_skills`
- **Skills — per agent** (board key) — `list_skills`, `set_skills` (equip/unequip)
- **Instructions** (board key) — `get_instructions`, `set_instructions` (rewrite AGENTS.md)
- **Routines** — `list_routines`, `update_routine`
- **Identity / audit** — `whoami`, `list_agents`, `list_audit`

> Skills have no inline content-edit API — to change a skill you **re-import** a new version with `import_skills`. Memory has no bulk file-upload over MCP (that's a UI multipart feature); use `add_memory` per entry, which both creates and updates.

## Run it directly (debug)

```bash
PAPERCLIP_API_URL="https://host.ts.net/api" \
PAPERCLIP_API_KEY="pcp_board_…" \
PAPERCLIP_COMPANY_ID="…" \
node paperclip-mcp.mjs
```

It reads newline-delimited JSON-RPC on stdin and writes responses to stdout (logs go to stderr).
