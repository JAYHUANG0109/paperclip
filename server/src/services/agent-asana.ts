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

/**
 * Extract the GID of a "Private link" task referenced inside a task's notes —
 * i.e. a DIFFERENT Asana task URL than the task itself. The 創辦人/園長 行事曆 is
 * company-visible, so restricted items live as a public outer shell whose notes
 * link to a private inner task only the assigner/assignee/創辦人 can see. Matches
 * the same URL shapes the agent scans for: `…/0/<project>/<taskGid>` and the
 * newer `…/task/<taskGid>` form. Returns the first linked GID that isn't the
 * outer task, or null when there is no private link.
 */
export function extractPrivateLinkGid(notes: string | null | undefined, outerGid: string): string | null {
  if (!notes) return null;
  const found = new Set<string>();
  for (const m of notes.matchAll(/app\.asana\.com\/0\/\d+\/(\d+)/g)) found.add(m[1]!);
  for (const m of notes.matchAll(/app\.asana\.com\/[^\s)]*?\/task\/(\d+)/g)) found.add(m[1]!);
  for (const gid of found) {
    if (gid && gid !== outerGid) return gid;
  }
  return null;
}

/**
 * HARD privacy guard for the 創辦人/園長 console. Resolves WHERE a founder's
 * comment / 批閱草稿 / decision note must be posted, and guarantees it never lands
 * on the public outer shell when the item is a private-linked restricted task:
 *
 *  - No private link              → post on the task itself (`outerGid`).
 *  - Private link, inner resolved → post on the inner private task.
 *  - Private link, NOT resolvable → BLOCKED (targetGid=null): the caller MUST NOT
 *    post anywhere. Failing closed is the whole point — leaking classified content
 *    to the company-visible shell is worse than not posting.
 *
 * `knownInnerGid` (the item's agent-resolved `commentTargetGid`) is trusted as a
 * fast path; otherwise we re-read the outer task's full notes from Asana with the
 * founder's own token (the digest preview is truncated and unreliable) and verify
 * the inner task is actually reachable before allowing a post.
 */
export async function resolveFounderPostTargetGid(
  db: Db,
  companyId: string,
  agentId: string,
  outerGid: string,
  knownInnerGid?: string | null,
): Promise<{ targetGid: string | null; hasPrivateLink: boolean; blocked: boolean }> {
  if (knownInnerGid && knownInnerGid !== outerGid) {
    return { targetGid: knownInnerGid, hasPrivateLink: true, blocked: false };
  }
  const t = await tokenFor(db, companyId, agentId);
  if (!t) return { targetGid: null, hasPrivateLink: false, blocked: true }; // no token → never guess
  const res = await asanaGetJson(t.token, `/tasks/${encodeURIComponent(outerGid)}?opt_fields=notes`);
  const notes = res && typeof (res.data as { notes?: unknown } | undefined)?.notes === "string"
    ? String((res.data as { notes?: string }).notes)
    : null;
  const innerGid = extractPrivateLinkGid(notes, outerGid);
  if (!innerGid) return { targetGid: outerGid, hasPrivateLink: false, blocked: false };
  // Private link present — confirm the inner task is reachable with this token
  // before allowing any write. If not, fail closed.
  const inner = await asanaGetJson(t.token, `/tasks/${encodeURIComponent(innerGid)}?opt_fields=gid`);
  const reachable = Boolean(inner && (inner.data as { gid?: unknown } | undefined)?.gid);
  return reachable
    ? { targetGid: innerGid, hasPrivateLink: true, blocked: false }
    : { targetGid: null, hasPrivateLink: true, blocked: true };
}

/** Stable marker so we post the AI 每日彙整 comment at most ONCE per task —
 *  repeated 12:00 runs / manual refreshes detect it and skip (no duplicates). */
export const AI_DIGEST_COMMENT_MARKER = "【🤖 AI 每日彙整】";

/**
 * Auto-post the agent's AI 摘要 + 批閱草稿 as an Asana comment for each 待批閱 item,
 * with the SAME hard privacy guarantee as the manual paths and built-in idempotency:
 *
 *  - Private-linked item → comment goes on the inner private task, NEVER the public
 *    shell. If the inner task can't be resolved, the item is SKIPPED (fail closed) —
 *    there is no code path that posts to the shell when a private link exists.
 *  - Public item (no private link) → comment goes on the task itself.
 *  - Idempotent: the check for an existing AI comment runs on the SAME task we would
 *    post to (inner when private, public otherwise), so we never duplicate and never
 *    peek at / write to the wrong task.
 *
 * Server-side by design: the agent writes only to the Paperclip digest; the server
 * is the sole writer of these Asana comments, so leaking to a public shell is
 * structurally impossible. Best-effort per item — one failure never blocks others.
 */
export async function autoPostFounderAiComments(
  db: Db,
  companyId: string,
  agentId: string,
  items: Array<{ gid: string; summary?: string | null; review?: string | null; commentTargetGid?: string | null }>,
): Promise<{ posted: number; skipped: number; blocked: number }> {
  let posted = 0, skipped = 0, blocked = 0;
  for (const item of items) {
    const summary = item.summary?.trim();
    const review = item.review?.trim();
    if (!summary && !review) { skipped += 1; continue; } // nothing to post
    try {
      const target = await resolveFounderPostTargetGid(db, companyId, agentId, item.gid, item.commentTargetGid ?? null);
      // HARD stop: a private link that can't be resolved → never touch the shell.
      if ((target.hasPrivateLink && target.blocked) || !target.targetGid) { blocked += 1; continue; }
      const targetGid = target.targetGid;
      // Idempotency check on the SAME task we'll post to (inner when private).
      const existing = await getAsanaTaskComments(db, companyId, agentId, targetGid);
      if (existing && existing.some((c) => c.text.includes(AI_DIGEST_COMMENT_MARKER))) { skipped += 1; continue; }
      const text =
        `${AI_DIGEST_COMMENT_MARKER}\n【摘要】${summary ?? "（無）"}` +
        (review ? `\n\n【批閱草稿・僅供參考，未經核准；核准／要求變更／拒絕仍需在儀表板手動裁示】\n${review}` : "");
      const ok = await postAsanaComment(db, companyId, agentId, targetGid, text);
      if (ok) posted += 1; else blocked += 1; // failure → not posted anywhere (no fallback)
    } catch {
      blocked += 1; // never let one item's error post elsewhere or break the loop
    }
  }
  return { posted, skipped, blocked };
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

/**
 * SERVER-SIDE founder-digest prep (token-lightening #2). Does the deterministic
 * plumbing the digest agent currently does inside its model context: fetch each
 * section's incomplete tasks, categorize by section, resolve the private-link
 * inner task, merge+dedupe comments (outer+inner), collect subtasks, and check
 * the AI-comment idempotency marker. The agent then only needs to write the
 * summary/批閱草稿 for each item — no Asana fetching in-prompt.
 *
 * Uses the agent's OWN Asana token (same as the agent). Returns null on missing
 * token. Best-effort per task: one task's fetch failure never aborts the run.
 * Includes `modifiedAt` per item so the caller can skip re-summarizing unchanged
 * items (#3). NOT wired into the live path yet — built for parity verification.
 */
export interface FounderPrepItem {
  gid: string;
  name: string;
  permalinkUrl: string | null;
  notes: string | null;
  modifiedAt: string | null;
  commentTargetGid: string | null;
  hasExistingAiComment: boolean;
  comments: AsanaTaskComment[];
  subtasks: { name: string; completed: boolean }[];
}
export interface FounderDigestPrep {
  generatedAt: string;
  categories: {
    urgent: FounderPrepItem[];
    meetings: FounderPrepItem[];
    nonUrgent: FounderPrepItem[];
    reminders: FounderPrepItem[];
  };
}

async function fetchSectionIncompleteTasks(token: string, sectionGid: string): Promise<Record<string, unknown>[]> {
  const body = await asanaGetJson(
    token,
    `/tasks?section=${encodeURIComponent(sectionGid)}&completed_since=now` +
      `&opt_fields=name,notes,permalink_url,modified_at,completed&limit=100`,
  );
  return Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]) : [];
}

async function fetchSubtasks(token: string, taskGid: string): Promise<{ name: string; completed: boolean }[]> {
  const body = await asanaGetJson(
    token,
    `/tasks/${encodeURIComponent(taskGid)}/subtasks?opt_fields=name,completed&limit=20`,
  );
  const rows = Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]) : [];
  return rows
    .map((s) => ({ name: String(s.name ?? "").trim(), completed: s.completed === true }))
    .filter((s) => s.name);
}

export async function buildFounderDigestPrep(
  db: Db,
  companyId: string,
  agentId: string,
  layout: { sections: { category: "urgent" | "meetings" | "nonUrgent" | "reminders"; sectionGid: string }[] },
): Promise<FounderDigestPrep | null> {
  const t = await tokenFor(db, companyId, agentId);
  if (!t) return null;
  const categories: FounderDigestPrep["categories"] = { urgent: [], meetings: [], nonUrgent: [], reminders: [] };

  for (const ref of layout.sections) {
    let tasks: Record<string, unknown>[];
    try {
      tasks = await fetchSectionIncompleteTasks(t.token, ref.sectionGid);
    } catch {
      continue; // section fetch failed — skip; caller keeps prior digest
    }
    for (const task of tasks) {
      if (task.completed === true) continue;
      const gid = String(task.gid ?? "");
      if (!gid) continue;
      const notes = typeof task.notes === "string" ? task.notes : null;
      const item: FounderPrepItem = {
        gid,
        name: String(task.name ?? ""),
        permalinkUrl: typeof task.permalink_url === "string" ? task.permalink_url : null,
        notes,
        modifiedAt: typeof task.modified_at === "string" ? task.modified_at : null,
        commentTargetGid: null,
        hasExistingAiComment: false,
        comments: [],
        subtasks: [],
      };
      // Decision items get the full deterministic prep. Meetings/reminders keep
      // only the light fields (name/notes/link) the agent needs for prep text.
      if (ref.category === "urgent" || ref.category === "nonUrgent") {
        try {
          const target = await resolveFounderPostTargetGid(db, companyId, agentId, gid, null);
          if (target.hasPrivateLink && target.targetGid && target.targetGid !== gid) {
            item.commentTargetGid = target.targetGid;
          }
          const outer = (await getAsanaTaskComments(db, companyId, agentId, gid)) ?? [];
          let merged = outer;
          if (item.commentTargetGid) {
            const inner = (await getAsanaTaskComments(db, companyId, agentId, item.commentTargetGid)) ?? [];
            const byId = new Map<string, AsanaTaskComment>();
            for (const c of [...outer, ...inner]) if (c.id) byId.set(c.id, c);
            merged = [...byId.values()].sort((a, b) =>
              String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
            );
          }
          item.comments = merged.slice(-50);
          item.hasExistingAiComment = merged.some((c) => c.text.includes(AI_DIGEST_COMMENT_MARKER));
          item.subtasks = await fetchSubtasks(t.token, gid);
        } catch {
          /* leave the item with its light fields; the agent can still summarize */
        }
      }
      categories[ref.category].push(item);
    }
  }
  return { generatedAt: new Date().toISOString(), categories };
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
      commentCount: 0,
    }));

  // Comment counts for the collapsed task rows: token-free (direct REST, no LLM)
  // and cheap — one minimal `stories?opt_fields=type` call per task (payload is
  // just the story types), capped at 8 concurrent. This runs only during the
  // ~10-min digest rebuild; dashboard loads read the cached digest, so the
  // per-load cost is zero. Best-effort: a failed/empty count stays 0.
  for (let i = 0; i < tasks.length; i += 8) {
    await Promise.all(
      tasks.slice(i, i + 8).map(async (task) => {
        const sres = await asanaGetJson(
          t.token,
          `/tasks/${encodeURIComponent(task.gid)}/stories?opt_fields=type&limit=100`,
        );
        const srows = sres && Array.isArray(sres.data) ? (sres.data as Record<string, unknown>[]) : [];
        task.commentCount = srows.filter((s) => s?.type === "comment").length;
      }),
    );
  }

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
