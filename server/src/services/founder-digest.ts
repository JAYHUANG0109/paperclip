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
  closed: boolean; // 結案 — used by meetings/reminders (no draft to approve, just "done")
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
    closed: t.closed === true,
  };
}

function sanitizeList(v: unknown): FounderItem[] {
  return Array.isArray(v) ? v.map(sanitizeItem).filter((x): x is FounderItem => !!x) : [];
}

/** Persist a founder digest onto the agent's metadata. Agent-only writer. */
export async function writeFounderDigestForAgent(
  db: Db,
  companyId: string,
  agentId: string,
  body: unknown,
): Promise<FounderDigest> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
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
  md.founderDigest = digest;
  await db.update(agents).set({ metadata: md, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return digest;
}

/** Read the caller's founder digest (their own agent's metadata.founderDigest). */
export async function getFounderDigestForUser(db: Db, companyId: string, email: string | null): Promise<FounderDigest | null> {
  // Founder-only feature — non-allowlisted users never see the console.
  if (!isFounderEmail(email)) return null;
  const agentId = await resolveOwnAgentId(db, companyId, email);
  if (!agentId) return null;
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const md = row?.metadata as Record<string, unknown> | null;
  const digest = md && typeof md === "object" ? (md.founderDigest as FounderDigest | undefined) : undefined;
  if (digest && digest.categories) return digest;
  return null;
}

/** Optimistically patch one item (matched by gid) across all four categories. */
async function patchFounderItem(
  db: Db,
  agentId: string,
  gid: string,
  patch: Partial<FounderItem>,
): Promise<FounderDigest | null> {
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const md = row?.metadata && typeof row.metadata === "object" ? { ...(row.metadata as Record<string, unknown>) } : null;
  if (!md) return null;
  const digest = md.founderDigest as FounderDigest | undefined;
  if (!digest?.categories) return null;
  const apply = (list: FounderItem[]) => (list ?? []).map((t) => (t.gid === gid ? { ...t, ...patch } : t));
  const next: FounderDigest = {
    ...digest,
    categories: {
      urgent: apply(digest.categories.urgent),
      meetings: apply(digest.categories.meetings),
      nonUrgent: apply(digest.categories.nonUrgent),
      reminders: apply(digest.categories.reminders),
    },
  };
  md.founderDigest = next;
  await db.update(agents).set({ metadata: md, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return next;
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

export const FOUNDER_EMPTY_CATEGORIES = EMPTY;
