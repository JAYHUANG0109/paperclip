#!/usr/bin/env node
// Paperclip MCP server — a zero-dependency stdio Model Context Protocol server
// that lets Claude Desktop (or any MCP client) drive a Paperclip instance with a
// Paperclip API key. It authenticates every call as that key:
//   - an AGENT key (pcp_…)  → the agent's own surface: tasks, its owner's
//     memory, routines. Harness edits (skills / AGENTS.md) are refused (403).
//   - a USER/board key (pcp_board_…) → acts as the human, with everything they
//     can do in the UI, INCLUDING harness edits.
// The key decides what succeeds; this server exposes the whole surface.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
// Only JSON-RPC goes to stdout; all logging goes to stderr.
//
// Env:
//   PAPERCLIP_API_URL   e.g. https://your-host.ts.net/api   (required)
//   PAPERCLIP_API_KEY   pcp_… or pcp_board_…                (required)
//   PAPERCLIP_COMPANY_ID default company id for tools that need one (optional)
//   PAPERCLIP_RUN_ID    stamped as X-Paperclip-Run-Id on writes (optional)

const API_URL = (process.env.PAPERCLIP_API_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.PAPERCLIP_API_KEY || "";
const DEFAULT_COMPANY = process.env.PAPERCLIP_COMPANY_ID || "";
const RUN_ID = process.env.PAPERCLIP_RUN_ID || "";
const SERVER_INFO = { name: "paperclip-mcp", version: "1.0.0" };

function log(...args) { console.error("[paperclip-mcp]", ...args); }

if (!API_URL || !API_KEY) {
  log("FATAL: set PAPERCLIP_API_URL and PAPERCLIP_API_KEY in the MCP server env.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP to the Paperclip API
// ---------------------------------------------------------------------------
function company(id) {
  const c = id || DEFAULT_COMPANY;
  if (!c) throw new Error("companyId is required (pass it, or set PAPERCLIP_COMPANY_ID).");
  return c;
}

async function api(method, path, { body, query } = {}) {
  let url = `${API_URL}${path.startsWith("/") ? path : `/${path}`}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers = { Authorization: `Bearer ${API_KEY}` };
  const writing = !["GET", "HEAD"].includes(method.toUpperCase());
  if (writing) {
    headers["Content-Type"] = "application/json";
    if (RUN_ID) headers["X-Paperclip-Run-Id"] = RUN_ID;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${method} ${path}`);
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Tools — a generic escape hatch plus ergonomic named wrappers.
// ---------------------------------------------------------------------------
const S = {
  str: (description) => ({ type: "string", description }),
  strArr: (description) => ({ type: "array", items: { type: "string" }, description }),
  num: (description) => ({ type: "number", description }),
  obj: (description) => ({ type: "object", description }),
  bool: (description) => ({ type: "boolean", description }),
};

// Cache the OpenAPI spec for the session so describe_api is cheap after the first call.
let _spec = null;
async function openapiSpec() {
  if (!_spec) _spec = await api("GET", "/openapi.json");
  return _spec;
}

const tools = [
  {
    name: "paperclip_request",
    description:
      "Generic authenticated call to the Paperclip REST API — FULL access to everything the key permits. " +
      "path is relative to the API root (e.g. '/agents/me', '/issues/{id}'). Use describe_api to discover endpoints, then call any of them here.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"], description: "HTTP method" },
        path: S.str("API path relative to the API root, e.g. /companies/{companyId}/issues"),
        body: S.obj("JSON request body (for POST/PATCH/PUT)"),
        query: S.obj("Query params as an object; array values are comma-joined"),
      },
      required: ["method", "path"],
    },
    handler: (a) => api(a.method, a.path, { body: a.body, query: a.query }),
  },
  {
    name: "describe_api",
    description:
      "Discover the ENTIRE Paperclip API (the platform's OpenAPI spec — hundreds of endpoints). " +
      "Call with no args for a compact searchable index (path + methods + summary); pass `search` to filter; pass `path` to get the full detail (params, body schema, responses) for one path. " +
      "Combined with paperclip_request this gives complete access to anything the platform can do.",
    inputSchema: {
      type: "object",
      properties: {
        search: S.str("Substring to filter paths/summaries, e.g. 'memory', 'skill', 'approval'"),
        path: S.str("Exact path to get full detail for, e.g. /api/companies/{companyId}/skills"),
      },
    },
    handler: async (a) => {
      const spec = await openapiSpec();
      const paths = spec.paths || {};
      const verbs = ["get", "post", "put", "patch", "delete"];
      if (a.path) return { path: a.path, detail: paths[a.path] ?? "not found (use search to find the exact path)" };
      const q = (a.search || "").toLowerCase();
      const endpoints = [];
      for (const [p, ops] of Object.entries(paths)) {
        const methods = Object.keys(ops).filter((m) => verbs.includes(m));
        const summaries = methods.map((m) => ops[m]?.summary || ops[m]?.operationId || "").join(" ");
        if (q && !`${p} ${summaries}`.toLowerCase().includes(q)) continue;
        endpoints.push({
          path: p,
          methods: methods.map((m) => m.toUpperCase()),
          summary: methods.map((m) => ops[m]?.summary).filter(Boolean)[0] ?? null,
        });
      }
      return { total: endpoints.length, endpoints };
    },
  },
  {
    name: "whoami",
    description: "Agent identity, owner (responsibleUser), and equipped skills. Works with an AGENT key; a USER/board key is not an agent, so use list_agents instead.",
    inputSchema: { type: "object", properties: {} },
    handler: () => api("GET", "/agents/me"),
  },
  {
    name: "list_agents",
    description: "List the company's agents.",
    inputSchema: { type: "object", properties: { companyId: S.str("Company id (defaults to env)") } },
    handler: (a) => api("GET", `/companies/${company(a.companyId)}/agents`),
  },
  {
    name: "list_tasks",
    description: "List tasks (issues), optionally filtered by assignee agent and status.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: S.str("Company id (defaults to env)"),
        assigneeAgentId: S.str("Filter to this agent's assigned tasks"),
        status: S.str("Comma list: todo,in_progress,in_review,blocked,done,backlog,cancelled"),
        limit: S.num("Max results"),
      },
    },
    handler: (a) => api("GET", `/companies/${company(a.companyId)}/issues`, {
      query: { assigneeAgentId: a.assigneeAgentId, status: a.status, limit: a.limit },
    }),
  },
  {
    name: "get_task",
    description: "Get one task. Set context=true for the compact heartbeat-context view (ancestors, goal/project, comment cursor).",
    inputSchema: {
      type: "object",
      properties: { taskId: S.str("Issue id or identifier"), context: S.bool("Use heartbeat-context view") },
      required: ["taskId"],
    },
    handler: (a) => api("GET", `/issues/${a.taskId}${a.context ? "/heartbeat-context" : ""}`),
  },
  {
    name: "create_task",
    description: "Create a task (issue).",
    inputSchema: {
      type: "object",
      properties: {
        companyId: S.str("Company id (defaults to env)"),
        title: S.str("Task title"),
        description: S.str("Task description (markdown)"),
        assigneeAgentId: S.str("Assign to this agent"),
        projectId: S.str("Project id"),
        goalId: S.str("Goal id"),
        parentId: S.str("Parent issue id"),
        priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
        status: S.str("Initial status"),
        blockedByIssueIds: S.strArr("Issue ids this task is blocked by"),
      },
      required: ["title"],
    },
    handler: (a) => {
      const { companyId, ...body } = a;
      return api("POST", `/companies/${company(companyId)}/issues`, { body });
    },
  },
  {
    name: "update_task",
    description: "Update a task's fields and/or add a markdown comment (comment posts even if no field changes).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: S.str("Issue id or identifier"),
        status: S.str("backlog|todo|in_progress|in_review|done|blocked|cancelled"),
        title: S.str("New title"),
        description: S.str("New description"),
        priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
        assigneeAgentId: S.str("Reassign to this agent"),
        projectId: S.str("Move to project"),
        goalId: S.str("Attach to goal"),
        parentId: S.str("Reparent"),
        comment: S.str("Markdown comment to post with this update"),
        blockedByIssueIds: S.strArr("Replace the blocker set (send [] to clear)"),
      },
      required: ["taskId"],
    },
    handler: (a) => {
      const { taskId, ...body } = a;
      return api("PATCH", `/issues/${taskId}`, { body });
    },
  },
  {
    name: "checkout_task",
    description: "Check out (claim) a task for an agent before working it. Never retry on 409 (owned by another agent).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: S.str("Issue id"),
        agentId: S.str("Agent claiming the task"),
        expectedStatuses: S.strArr("Statuses it's valid to check out from"),
      },
      required: ["taskId", "agentId"],
    },
    handler: (a) => api("POST", `/issues/${a.taskId}/checkout`, {
      body: { agentId: a.agentId, expectedStatuses: a.expectedStatuses ?? ["todo", "backlog", "blocked", "in_review"] },
    }),
  },
  {
    name: "list_memory",
    description: "List a user's personal memory. With an AGENT key the userId must be that agent's owner. With a USER key, your own id.",
    inputSchema: {
      type: "object",
      properties: { companyId: S.str("Company id (defaults to env)"), userId: S.str("Owner user id") },
      required: ["userId"],
    },
    handler: (a) => api("GET", `/companies/${company(a.companyId)}/users/${a.userId}/memories`),
  },
  {
    name: "add_memory",
    description: "Add or update one memory entry. Refused (422) if the content looks like a secret.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: S.str("Company id (defaults to env)"),
        userId: S.str("Owner user id"),
        name: S.str("Stable slug/name for the entry (updates if it exists)"),
        content: S.str("The fact to remember"),
        description: S.str("Short label"),
        memoryType: { type: "string", enum: ["preference", "profile", "expertise", "project", "workflow", "feedback", "reference", "instruction"] },
      },
      required: ["userId", "name", "content"],
    },
    handler: (a) => api("PUT", `/companies/${company(a.companyId)}/users/${a.userId}/memories/${encodeURIComponent(a.name)}`, {
      body: { content: a.content, description: a.description ?? "", memoryType: a.memoryType },
    }),
  },
  {
    name: "delete_memory",
    description: "Soft-delete one memory entry (recoverable in the deleted view).",
    inputSchema: {
      type: "object",
      properties: { companyId: S.str("Company id (defaults to env)"), userId: S.str("Owner user id"), name: S.str("Entry name") },
      required: ["userId", "name"],
    },
    handler: (a) => api("DELETE", `/companies/${company(a.companyId)}/users/${a.userId}/memories/${encodeURIComponent(a.name)}`),
  },
  {
    name: "list_routines",
    description: "List the company's routines.",
    inputSchema: { type: "object", properties: { companyId: S.str("Company id (defaults to env)") } },
    handler: (a) => api("GET", `/companies/${company(a.companyId)}/routines`),
  },
  {
    name: "update_routine",
    description: "Update a routine (title, status, schedule fields, assignee, description).",
    inputSchema: {
      type: "object",
      properties: { routineId: S.str("Routine id"), fields: S.obj("Fields to PATCH") },
      required: ["routineId", "fields"],
    },
    handler: (a) => api("PATCH", `/routines/${a.routineId}`, { body: a.fields }),
  },
  {
    name: "get_instructions",
    description: "Read an agent's instructions file (default AGENTS.md). Works with either key.",
    inputSchema: {
      type: "object",
      properties: { agentId: S.str("Agent id"), companyId: S.str("Company id (defaults to env)"), path: S.str("File path (default AGENTS.md)") },
      required: ["agentId"],
    },
    handler: (a) => api("GET", `/agents/${a.agentId}/instructions-bundle/file`, {
      query: { path: a.path ?? "AGENTS.md", companyId: company(a.companyId) },
    }),
  },
  {
    name: "set_instructions",
    description: "Rewrite an agent's instructions file (default AGENTS.md). Requires a USER/board key (an AGENT key is refused 403).",
    inputSchema: {
      type: "object",
      properties: {
        agentId: S.str("Agent id"),
        companyId: S.str("Company id (defaults to env)"),
        content: S.str("Full new file content"),
        path: S.str("File path (default AGENTS.md)"),
      },
      required: ["agentId", "content"],
    },
    handler: (a) => api("PUT", `/agents/${a.agentId}/instructions-bundle/file`, {
      query: { companyId: company(a.companyId) },
      body: { path: a.path ?? "AGENTS.md", content: a.content },
    }),
  },
  {
    name: "list_skills",
    description: "Read an agent's equipped skills (config view). Requires a USER/board key (AGENT key 403s here; agents read their own skills via whoami).",
    inputSchema: {
      type: "object",
      properties: { agentId: S.str("Agent id"), companyId: S.str("Company id (defaults to env)") },
      required: ["agentId"],
    },
    handler: (a) => api("GET", `/agents/${a.agentId}/skills`, { query: { companyId: company(a.companyId) } }),
  },
  {
    name: "set_skills",
    description: "Set an agent's equipped skills (replaces the whole set). desiredSkills is the list of skill keys. Requires a USER/board key.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: S.str("Agent id"),
        companyId: S.str("Company id (defaults to env)"),
        desiredSkills: S.strArr("Full replacement list of skill keys"),
      },
      required: ["agentId", "desiredSkills"],
    },
    handler: (a) => api("POST", `/agents/${a.agentId}/skills/sync`, {
      query: { companyId: company(a.companyId) },
      body: { desiredSkills: a.desiredSkills },
    }),
  },
  {
    name: "list_company_skills",
    description: "List the company's skill library (definitions), with keys and names.",
    inputSchema: { type: "object", properties: { companyId: S.str("Company id (defaults to env)") } },
    handler: (a) => api("GET", `/companies/${company(a.companyId)}/skills`),
  },
  {
    name: "import_skills",
    description:
      "Create/UPDATE/UPLOAD skills into the company library by importing from a source (a git repo URL, or a workspace path). " +
      "This is how you add a new skill or push a new version of an existing one — there is no inline content-edit API; re-import to update. Requires a USER/board key (skills:create).",
    inputSchema: {
      type: "object",
      properties: {
        companyId: S.str("Company id (defaults to env)"),
        source: S.str("Import source — e.g. a git repo URL or a workspace path/locator"),
      },
      required: ["source"],
    },
    handler: (a) => api("POST", `/companies/${company(a.companyId)}/skills/import`, { body: { source: a.source } }),
  },
  {
    name: "install_catalog_skill",
    description: "Install a skill from the built-in catalog into the company library. Requires a USER/board key (skills:install).",
    inputSchema: {
      type: "object",
      properties: {
        companyId: S.str("Company id (defaults to env)"),
        catalogSkillId: S.str("Catalog skill id to install"),
        options: S.obj("Any extra install options the endpoint accepts (folder/share/etc.)"),
      },
      required: ["catalogSkillId"],
    },
    handler: (a) => api("POST", `/companies/${company(a.companyId)}/skills/install-catalog`, {
      body: { catalogSkillId: a.catalogSkillId, ...(a.options ?? {}) },
    }),
  },
  {
    name: "delete_skill",
    description: "Delete a skill from the company library by its skill id. Requires a USER/board key (skills:create).",
    inputSchema: {
      type: "object",
      properties: { companyId: S.str("Company id (defaults to env)"), skillId: S.str("Skill id to delete") },
      required: ["skillId"],
    },
    handler: (a) => api("DELETE", `/companies/${company(a.companyId)}/skills/${a.skillId}`),
  },
  {
    name: "list_audit",
    description: "Agent-action audit feed, scoped to the caller's access level. Filter by agent(s), responsible user, action prefix, date range.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: S.str("Company id (defaults to env)"),
        agentId: S.str("Single agent filter"),
        agentIds: S.strArr("Multiple agent ids (comma-joined server-side)"),
        responsibleUserId: S.str("Filter by responsible user"),
        action: S.str("Action prefix, e.g. 'issue.' or 'agent.'"),
        entityType: S.str("Exact entity type, e.g. 'issue'"),
        from: S.str("ISO start datetime"),
        to: S.str("ISO end datetime"),
        limit: S.num("Page size (max 200)"),
      },
    },
    handler: (a) => api("GET", `/companies/${company(a.companyId)}/audit/agent-actions`, {
      query: {
        agentId: a.agentId, agentIds: a.agentIds, responsibleUserId: a.responsibleUserId,
        action: a.action, entityType: a.entityType, from: a.from, to: a.to, limit: a.limit,
      },
    }),
  },
];

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 over stdio (newline-delimited)
// ---------------------------------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handleToolCall(id, params) {
  const tool = toolByName.get(params?.name);
  if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
  try {
    const result = await tool.handler(params.arguments ?? {});
    reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
  } catch (err) {
    const detail = err?.payload !== undefined
      ? `${err.message}\n${JSON.stringify(err.payload, null, 2)}`
      : String(err?.message ?? err);
    reply(id, { content: [{ type: "text", text: detail }], isError: true });
  }
}

async function dispatch(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        // Echo the client's protocol version when present for maximum compatibility.
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications carry no id and need no response
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call":
      return handleToolCall(id, params);
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

let buffer = "";
// Track in-flight requests so a stdin close doesn't kill a pending API call
// before its response is written (an MCP client keeps stdin open for the
// session, but draining makes shutdown — and piped test input — correct).
const inflight = new Set();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("skipping non-JSON line"); continue; }
    const p = Promise.resolve(dispatch(msg))
      .catch((e) => log("dispatch error:", e))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
});
process.stdin.on("end", async () => {
  await Promise.allSettled([...inflight]);
  process.exit(0);
});

log(`ready — ${tools.length} tools, API ${API_URL}${DEFAULT_COMPANY ? `, default company ${DEFAULT_COMPANY}` : ""}`);
