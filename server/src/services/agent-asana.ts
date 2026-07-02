import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Server-side Asana writes using an agent's OWN stored token. This lets
 * interactive dashboard actions (a founder comment / 結案) hit Asana
 * immediately, instead of waiting minutes for the agent's next heartbeat to
 * pick up the wake directive. Callers fall back to waking the agent when these
 * return false, so a missing token / API hiccup degrades gracefully rather than
 * dropping the write. Read-only tokens are refused (returns false).
 */
const ASANA_API = "https://app.asana.com/api/1.0";

function readToken(
  row: { adapterConfig?: unknown } | undefined,
  companyId: string,
  agentId: string,
): { token: string; readOnly: boolean; defaultWorkspace: string | null } | null {
  let path: string | null = null;
  const env = (row?.adapterConfig as { env?: Record<string, unknown> } | null)?.env;
  const ptr = env?.ASANA_TOKEN_PATH as { value?: string } | string | undefined;
  if (ptr && typeof ptr === "object" && typeof ptr.value === "string") path = ptr.value;
  else if (typeof ptr === "string") path = ptr;
  if (!path) {
    path = `${homedir()}/.paperclip/instances/default/companies/${companyId}/agents/${agentId}/asana-connection.json`;
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { token?: string; readOnly?: boolean; defaultWorkspace?: string };
    const token = (cfg.token ?? "").trim();
    if (!token) return null;
    return { token, readOnly: cfg.readOnly === true, defaultWorkspace: cfg.defaultWorkspace ?? null };
  } catch {
    return null;
  }
}

async function tokenFor(db: Db, companyId: string, agentId: string) {
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  return readToken(row, companyId, agentId);
}

async function asanaGetJson(token: string, pathAndQuery: string): Promise<{ data?: unknown } | null> {
  try {
    const res = await fetch(`${ASANA_API}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { data?: unknown };
  } catch {
    return null;
  }
}

/** Post a comment (story) to an Asana task as the agent. Returns true on success. */
export async function postAsanaComment(
  db: Db,
  companyId: string,
  agentId: string,
  taskGid: string,
  text: string,
): Promise<boolean> {
  const t = await tokenFor(db, companyId, agentId);
  if (!t || t.readOnly || !text.trim()) return false;
  try {
    const res = await fetch(`${ASANA_API}/tasks/${encodeURIComponent(taskGid)}/stories`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { text } }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface AsanaTaskComment {
  id: string;
  author: string | null;
  text: string;
  createdAt: string | null;
}

/**
 * Read a task's comments (Asana "comment" stories) using the agent's OWN token.
 * On-demand only — called when a user expands a task row — so no bulk story
 * pulls happen in the digest run (zero LLM tokens; one lightweight API call for
 * the task actually opened). Returns null on token/API failure (caller shows an
 * error state); an empty array means "no comments". Read is allowed even for a
 * read-only token.
 */
export async function getAsanaTaskComments(
  db: Db,
  companyId: string,
  agentId: string,
  taskGid: string,
): Promise<AsanaTaskComment[] | null> {
  const t = await tokenFor(db, companyId, agentId);
  if (!t) return null;
  try {
    const url =
      `${ASANA_API}/tasks/${encodeURIComponent(taskGid)}/stories` +
      `?opt_fields=type,text,created_at,created_by.name&limit=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${t.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    const rows = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    return rows
      .filter((s) => s?.type === "comment" && typeof s.text === "string" && (s.text as string).trim())
      .map((s) => ({
        id: String(s.gid ?? ""),
        author: (s.created_by as { name?: string } | null)?.name ?? null,
        text: (s.text as string).trim(),
        createdAt: typeof s.created_at === "string" ? s.created_at : null,
      }));
  } catch {
    return null;
  }
}

// Asia/Taipei is UTC+8, no DST — fixed 8h offset. Digest "today" is Taipei-local.
const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;
function taipeiToday(): string {
  return new Date(Date.now() + TPE_OFFSET_MS).toISOString().slice(0, 10); // YYYY-MM-DD
}

export interface AsanaDigestBody {
  generatedAt: string;
  daily: Record<string, unknown>[];
  weekly: Record<string, unknown>[];
}

/**
 * Build the per-user "My tasks" digest SERVER-SIDE, using the user's OWN Asana
 * token — deterministic and always complete (permalinkUrl, notes, dueOn,
 * projectName), and zero LLM tokens. Mirrors `asana_client.py my-tasks`: resolve
 * the caller's user-task-list for their default workspace, then read incomplete
 * assigned tasks. Buckets: `weekly` = all incomplete assigned tasks (dated
 * first, then undated); `daily` = those due today or overdue. Returns null on
 * missing token / workspace / API failure (caller keeps the previous digest).
 */
export async function buildAsanaDigestBody(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<AsanaDigestBody | null> {
  const t = await tokenFor(db, companyId, agentId);
  if (!t || !t.defaultWorkspace) return null;
  const utl = await asanaGetJson(t.token, `/users/me/user_task_list?workspace=${encodeURIComponent(t.defaultWorkspace)}&opt_fields=gid`);
  const listGid = (utl?.data as { gid?: string } | undefined)?.gid;
  if (!listGid) return null;
  const q = "opt_fields=name,completed,due_on,permalink_url,projects.name,notes&limit=100&completed_since=now";
  const res = await asanaGetJson(t.token, `/user_task_lists/${encodeURIComponent(listGid)}/tasks?${q}`);
  if (!res) return null;
  const rows = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];

  const tasks = rows
    .filter((r) => r && typeof r.gid === "string" && r.completed !== true)
    .map((r) => ({
      gid: String(r.gid),
      name: typeof r.name === "string" ? r.name : "",
      dueOn: typeof r.due_on === "string" ? r.due_on : null,
      permalinkUrl: typeof r.permalink_url === "string" ? r.permalink_url : null,
      projectName: Array.isArray(r.projects) && (r.projects[0] as { name?: string } | undefined)?.name
        ? String((r.projects[0] as { name?: string }).name)
        : null,
      notes: typeof r.notes === "string" ? r.notes : null,
      priority: null,
      completed: false,
    }));

  // dated ascending first, then undated (keeps undated tasks visible)
  const byDue = (a: { dueOn: string | null }, b: { dueOn: string | null }) => {
    if (a.dueOn && b.dueOn) return a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0;
    if (a.dueOn) return -1;
    if (b.dueOn) return 1;
    return 0;
  };
  const today = taipeiToday();
  const weekly = tasks.slice().sort(byDue);
  const daily = tasks.filter((t) => t.dueOn && t.dueOn <= today).sort(byDue);
  return { generatedAt: new Date().toISOString(), daily, weekly };
}

/** Complete or reopen an Asana task as the agent. Returns true on success. */
export async function setAsanaTaskCompleted(
  db: Db,
  companyId: string,
  agentId: string,
  taskGid: string,
  completed: boolean,
): Promise<boolean> {
  const t = await tokenFor(db, companyId, agentId);
  if (!t || t.readOnly) return false;
  try {
    const res = await fetch(`${ASANA_API}/tasks/${encodeURIComponent(taskGid)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { completed } }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
