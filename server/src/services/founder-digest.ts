import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { resolveOwnAgentId } from "./asana-digest.js";

/**
 * Founder daily-calendar digest. PRODUCED by the founder's own agent (their
 * Asana token) from the "創辦人每日行事曆" project, which organizes work into
 * four sections. For 待批閱 items the agent drafts a summary + 批閱 (it never
 * submits); for meetings it drafts a prep brief. STORED on the agent as
 * metadata.founderDigest. The dashboard READS it (no token use at read time).
 */
/**
 * The founder's verdict on a draft 批閱:
 *   approved         核准      — accept the draft as-is (green)
 *   changes_requested 請求變更 — send back with the founder's note (amber)
 *   rejected         拒絕      — decline (red)
 * `null` = not yet decided (or the founder reset their decision).
 */
export type FounderDecision = "approved" | "changes_requested" | "rejected";

/**
 * One comment in an item's thread. The agent seeds the history from the task's
 * Asana stories (authorType "agent"/"asana"); the founder's own replies are
 * appended optimistically by the server (authorType "founder", pending: true)
 * and reconciled into confirmed Asana stories on the next digest write.
 */
export interface FounderComment {
  id: string; // Asana story gid, or a client/server-generated id for a pending reply
  author: string | null; // display name (null = unknown / "您")
  authorType: "founder" | "agent" | "asana";
  text: string;
  createdAt: string; // ISO
  pending?: boolean; // optimistic reply not yet confirmed posted to Asana
}

export interface FounderItem {
  gid: string;
  name: string;
  notes: string | null; // short description preview
  permalinkUrl: string | null;
  summary: string | null; // agent's proof-read summary (待批閱)
  review: string | null; // agent's DRAFT 批閱 — never auto-submitted
  prep: string | null; // agent's meeting prep brief (會議)
  triage: "now" | "evening" | null; // 15:30+ runs tag: 現在可先處理 / 留待晚上
  decision: FounderDecision | null; // founder's verdict on the draft 批閱 (review items)
  decisionNote: string | null; // founder's comment / suggestion / regards (optional)
  comments: FounderComment[]; // discussion thread (Asana stories + founder replies)
  closed: boolean; // 結案 — used by meetings/reminders (no draft to approve, just "done")
  /**
   * When the outer public task links to a restricted private task (a "Private link"
   * in Asana), the agent sets this to the inner task's GID. All comment writes
   * (AI drafts, founder replies) are routed here instead of `gid`. If null/absent,
   * comments go to the outer task (existing behaviour).
   */
  commentTargetGid?: string | null;
}

export interface FounderDigest {
  generatedAt: string;
  lastRunLabel: string | null; // e.g. "11:30", "15:30" — which scheduled run produced this
  categories: {
    urgent: FounderItem[]; // 🔴 待批閱・急件
    meetings: FounderItem[]; // 📅 今日會議與行程
    nonUrgent: FounderItem[]; // 🟡 待批閱・非急件
    reminders: FounderItem[]; // 🔔 提醒事項
  };
  sample?: boolean;
}

const EMPTY: FounderDigest["categories"] = { urgent: [], meetings: [], nonUrgent: [], reminders: [] };

/**
 * A user can host more than one daily console on their own agent — e.g. Jay (the
 * preview/test account) carries both the 創辦人 and the 園長 console so he can
 * verify each. Each console is its own slot on `agent.metadata`; the same 4-block
 * UI renders one group per console that exists.
 */
// One console per campus/role. A user sees a console only if their OWN agent
// carries that slot, so visibility is naturally scoped: 創辦人 sees only
// `founder`; each 園長 sees only their campus's principal slot; Jay (preview)
// carries all of them. Render order follows CONSOLE_KEYS.
//   • principal           — 仁美 (吳家秀 reneew / 王姿雅 ziya)
//   • principalZhengXitun — 市政 + 西屯, aggregated (哈哈 Tracy tracyha)
export type ConsoleKey = "founder" | "principal" | "principalZhengXitun";
export const CONSOLE_KEYS: ConsoleKey[] = ["founder", "principal", "principalZhengXitun"];
/** Which `agent.metadata` field stores each console's digest. */
const CONSOLE_META_KEY: Record<ConsoleKey, string> = {
  founder: "founderDigest", // unchanged — back-compat with existing data
  principal: "principalDigest",
  principalZhengXitun: "principalDigestZhengXitun",
};
/** Heading shown above each console's blocks on the dashboard. */
const CONSOLE_TITLE: Record<ConsoleKey, string> = {
  founder: "創辦人每日行事曆",
  principal: "仁美園長待決議與提醒",
  principalZhengXitun: "市政・西屯園長待決議與提醒",
};

export interface DailyConsole {
  key: ConsoleKey;
  title: string;
  digest: FounderDigest;
}

function asConsoleKey(v: unknown): ConsoleKey {
  if (v === "principal") return "principal";
  if (v === "principalZhengXitun") return "principalZhengXitun";
  return "founder";
}

// The daily-calendar console is a bespoke customization for a small set of
// leaders, NOT the whole org. Every other user keeps the normal dashboard
// (daily/weekly Asana tasks + summaries). This allowlist gates the READ so even
// if some other agent ever produced a founderDigest, it would never surface for
// a non-allowlisted user. The exact same 4-block UI serves two variants — the
// difference is only which Asana project each user's OWN agent reads from (see
// the agent AGENTS.md "daily pipeline"):
//   • 創辦人 唐富美 — 創辦人每日行事曆 project
//   • 仁美校園長 吳家秀 (Renee) + 王姿雅 (雅雅) — 仁美｜園長待決議與提醒 project
//   • Jay — test/preview account
// Overridable via PAPERCLIP_FOUNDER_EMAILS (comma-separated) for the rollout.
const DEFAULT_FOUNDER_EMAILS = [
  "tang@seasonart.org",
  "jay20020109@seasonart.org",
  "reneew@seasonart.org", // 仁美校園長 吳家秀 Renee
  "ziya@seasonart.org", // 仁美校園長 王姿雅 雅雅
  "tracyha@seasonart.org", // 跨校總園長 哈哈 Tracy — 市政 + 西屯 console
];

function founderEmails(): Set<string> {
  const raw = process.env.PAPERCLIP_FOUNDER_EMAILS?.trim();
  const list = raw ? raw.split(",").map((e) => e.trim()).filter(Boolean) : DEFAULT_FOUNDER_EMAILS;
  return new Set(list.map((e) => e.toLowerCase()));
}

export function isFounderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return founderEmails().has(email.toLowerCase());
}

function sanitizeItem(raw: unknown): FounderItem | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.gid !== "string" || typeof t.name !== "string") return null;
  const str = (v: unknown, max = 2000): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  // Decision: prefer the explicit field; fall back to the legacy boolean
  // `approved` so digests produced by an older agent build still render.
  const decision: FounderDecision | null =
    t.decision === "approved" || t.decision === "changes_requested" || t.decision === "rejected"
      ? t.decision
      : t.approved === true
        ? "approved"
        : null;
  const commentTargetGid =
    typeof t.commentTargetGid === "string" && /^\d+$/.test(t.commentTargetGid.trim())
      ? t.commentTargetGid.trim()
      : null;
  return {
    gid: t.gid,
    name: t.name,
    notes: str(t.notes, 400),
    permalinkUrl: str(t.permalinkUrl),
    summary: str(t.summary),
    review: str(t.review),
    prep: str(t.prep),
    triage: t.triage === "now" || t.triage === "evening" ? t.triage : null,
    decision,
    decisionNote: str(t.decisionNote),
    comments: sanitizeComments(t.comments),
    closed: t.closed === true,
    ...(commentTargetGid ? { commentTargetGid } : {}),
  };
}

/** Parse a thread of comments off agent output. Drops malformed entries; caps
 * the list so a runaway story history can't bloat the stored digest. */
function sanitizeComments(v: unknown): FounderComment[] {
  if (!Array.isArray(v)) return [];
  const out: FounderComment[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const text = typeof c.text === "string" ? c.text.trim().slice(0, 2000) : "";
    if (!text) continue;
    const authorType: FounderComment["authorType"] =
      c.authorType === "founder" || c.authorType === "agent" ? c.authorType : "asana";
    out.push({
      id: typeof c.id === "string" && c.id.trim() ? c.id.trim().slice(0, 200) : `c-${out.length}`,
      author: typeof c.author === "string" && c.author.trim() ? c.author.trim().slice(0, 120) : null,
      authorType,
      text,
      createdAt: typeof c.createdAt === "string" && c.createdAt ? c.createdAt : new Date().toISOString(),
      ...(c.pending === true ? { pending: true } : {}),
    });
  }
  return out.slice(-50);
}

function sanitizeList(v: unknown): FounderItem[] {
  return Array.isArray(v) ? v.map(sanitizeItem).filter((x): x is FounderItem => !!x) : [];
}

/** Persist a digest onto the agent's metadata, under the given console slot
 * (default "founder"; the slot is taken from `body.console` by the route). */
export async function writeFounderDigestForAgent(
  db: Db,
  companyId: string,
  agentId: string,
  body: unknown,
): Promise<FounderDigest> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const consoleKey = asConsoleKey(b.console);
  const cats = (b.categories && typeof b.categories === "object" ? b.categories : {}) as Record<string, unknown>;
  const digest: FounderDigest = {
    generatedAt: typeof b.generatedAt === "string" ? b.generatedAt : new Date().toISOString(),
    lastRunLabel: typeof b.lastRunLabel === "string" ? b.lastRunLabel : null,
    categories: {
      urgent: sanitizeList(cats.urgent),
      meetings: sanitizeList(cats.meetings),
      nonUrgent: sanitizeList(cats.nonUrgent),
      reminders: sanitizeList(cats.reminders),
    },
    ...(b.sample === true ? { sample: true } : {}),
  };
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const md = row?.metadata && typeof row.metadata === "object" ? { ...(row.metadata as Record<string, unknown>) } : {};
  md[CONSOLE_META_KEY[consoleKey]] = digest;
  await db.update(agents).set({ metadata: md, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return digest;
}

/** Read the caller's primary (founder) digest — kept for back-compat. */
export async function getFounderDigestForUser(db: Db, companyId: string, email: string | null): Promise<FounderDigest | null> {
  const consoles = await getConsolesForUser(db, companyId, email);
  return consoles.find((c) => c.key === "founder")?.digest ?? null;
}

/**
 * Read every daily console the caller has on their OWN agent. Allowlist-gated,
 * self-scoped (caller's email → caller's agent → that agent's metadata). Most
 * users have one (創辦人 OR 園長); the preview account may have both.
 */
export async function getConsolesForUser(db: Db, companyId: string, email: string | null): Promise<DailyConsole[]> {
  if (!isFounderEmail(email)) return []; // not an allowlisted console user
  const agentId = await resolveOwnAgentId(db, companyId, email);
  if (!agentId) return [];
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const md = row?.metadata as Record<string, unknown> | null;
  if (!md || typeof md !== "object") return [];
  const out: DailyConsole[] = [];
  for (const key of CONSOLE_KEYS) {
    const digest = md[CONSOLE_META_KEY[key]] as FounderDigest | undefined;
    if (digest && digest.categories) out.push({ key, title: CONSOLE_TITLE[key], digest });
  }
  return out;
}

/**
 * Optimistically patch one item (matched by gid) across all four categories of
 * whichever console slot contains it. Item gids are unique across consoles, so
 * we patch the slot that holds the gid and return that console's updated digest.
 */
async function mutateFounderItem(
  db: Db,
  agentId: string,
  gid: string,
  update: (item: FounderItem) => FounderItem,
): Promise<FounderDigest | null> {
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const md = row?.metadata && typeof row.metadata === "object" ? { ...(row.metadata as Record<string, unknown>) } : null;
  if (!md) return null;
  const apply = (list: FounderItem[]) => (list ?? []).map((t) => (t.gid === gid ? update(t) : t));
  let patched: FounderDigest | null = null;
  for (const key of CONSOLE_KEYS) {
    const slot = CONSOLE_META_KEY[key];
    const digest = md[slot] as FounderDigest | undefined;
    if (!digest?.categories) continue;
    const hit = [digest.categories.urgent, digest.categories.meetings, digest.categories.nonUrgent, digest.categories.reminders]
      .some((l) => (l ?? []).some((t) => t.gid === gid));
    if (!hit) continue;
    const next: FounderDigest = {
      ...digest,
      categories: {
        urgent: apply(digest.categories.urgent),
        meetings: apply(digest.categories.meetings),
        nonUrgent: apply(digest.categories.nonUrgent),
        reminders: apply(digest.categories.reminders),
      },
    };
    md[slot] = next;
    patched = next;
  }
  if (!patched) return null;
  await db.update(agents).set({ metadata: md, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return patched;
}

/** Merge a partial patch onto the item matched by gid (used by decision/close). */
function patchFounderItem(
  db: Db,
  agentId: string,
  gid: string,
  patch: Partial<FounderItem>,
): Promise<FounderDigest | null> {
  return mutateFounderItem(db, agentId, gid, (t) => ({ ...t, ...patch }));
}

/**
 * Optimistically record the founder's decision (+ optional note) on a 待批閱
 * item in the stored digest. `decision: null` reverts it to undecided. The real
 * Asana write is routed through the agent (see the dashboard route).
 */
export function setFounderItemDecision(
  db: Db,
  agentId: string,
  gid: string,
  decision: FounderDecision | null,
  note: string | null,
): Promise<FounderDigest | null> {
  return patchFounderItem(db, agentId, gid, { decision, decisionNote: note });
}

/**
 * Optimistically mark a meeting/reminder item 結案 (or reopen). The real Asana
 * write (e.g. complete-task) is routed through the agent.
 */
export function setFounderItemClosed(
  db: Db,
  agentId: string,
  gid: string,
  closed: boolean,
): Promise<FounderDigest | null> {
  return patchFounderItem(db, agentId, gid, { closed });
}

/**
 * Optimistically append the founder's reply to an item's thread (capped, like
 * the agent-seeded history). The comment is marked `pending` until the agent
 * posts it to Asana and reconciles it on the next digest write. The real Asana
 * comment is routed through the agent (see the dashboard route).
 */
export function appendFounderItemComment(
  db: Db,
  agentId: string,
  gid: string,
  comment: FounderComment,
): Promise<FounderDigest | null> {
  return mutateFounderItem(db, agentId, gid, (t) => ({
    ...t,
    comments: [...(t.comments ?? []), comment].slice(-50),
  }));
}

/**
 * Look up a single item by gid across all console slots on the agent's metadata.
 * Used by the comment endpoint to resolve commentTargetGid before writing to Asana.
 */
export async function getFounderItemByGid(db: Db, agentId: string, gid: string): Promise<FounderItem | null> {
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const md = row?.metadata as Record<string, unknown> | null;
  if (!md || typeof md !== "object") return null;
  for (const key of CONSOLE_KEYS) {
    const digest = md[CONSOLE_META_KEY[key]] as FounderDigest | undefined;
    if (!digest?.categories) continue;
    const all = [
      ...(digest.categories.urgent ?? []),
      ...(digest.categories.meetings ?? []),
      ...(digest.categories.nonUrgent ?? []),
      ...(digest.categories.reminders ?? []),
    ];
    const hit = all.find((t) => t.gid === gid);
    if (hit) return hit;
  }
  return null;
}

export const FOUNDER_EMPTY_CATEGORIES = EMPTY;
