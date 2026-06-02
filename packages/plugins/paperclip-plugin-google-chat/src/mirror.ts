/**
 * Helpers for mirroring Paperclip issue comments to Google Chat: decide which
 * comments are worth forwarding, and build a signature for de-duplicating an
 * agent that posts the same answer twice.
 *
 * Why we key on CJK, not authorType: in this deployment the human writes in
 * Chinese and the agent answers in Chinese, while the agent's internal
 * ops/heartbeat notes are English self-talk ("Exiting heartbeat", "no action
 * needed", "stays blocked on …"). Crucially, `authorType` is unreliable — when
 * an agent posts its answer through the REST API the comment gets mis-attributed
 * to "local-board"/"user" rather than "agent", while the internal heartbeat
 * notes (written inside a proper agent run) keep authorType "agent". Filtering
 * on authorType therefore dropped the real answers and kept the noise. CJK
 * presence is the signal that actually tracks "user-facing answer" here.
 */

/** Minimal shape we read off an issue comment (see shared IssueComment). */
export interface ForwardableComment {
  id?: string;
  authorType?: string;
  body?: string;
  createdAt?: string | Date;
  presentation?: { kind?: string } | null;
}

/** True if the string contains any CJK (Chinese/Japanese/Korean) character. */
export function containsCjk(s: string): boolean {
  return /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/.test(s);
}

/**
 * Internal ops/heartbeat notes the agent writes to itself (always English here).
 * Secondary guard — CJK-absence already filters these — but cheap insurance for
 * a note that happens to mix in some Chinese.
 */
export function looksLikeInternalNote(body: string): boolean {
  return /heartbeat|no action needed|no new human input|wake (was triggered|comment)|stays blocked|re-?comment needed|blocked posture|dedup rule|re-closed/i.test(
    body
  );
}

/**
 * A comment is forwarded to Chat only if it's a user-facing answer: non-empty,
 * not a system notice, contains CJK (the deployment's answer language), and
 * isn't an internal ops note.
 */
export function isForwardableComment(c: ForwardableComment): boolean {
  const body = typeof c.body === "string" ? c.body : "";
  if (body.trim().length === 0) return false;
  if (c.presentation?.kind === "system_notice") return false;
  if (!containsCjk(body)) return false;
  if (looksLikeInternalNote(body)) return false;
  return true;
}

/** Stable signature for exact-repost de-dup (whitespace-insensitive). */
export function commentSignature(body: string): string {
  const norm = body.replace(/\s+/g, " ").trim();
  return norm.length <= 400 ? norm : norm.slice(0, 200) + "…" + norm.slice(-200);
}

function toMs(v: string | Date | undefined): number {
  if (!v) return 0;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/** Forwardable comments, oldest first. */
export function orderedForwardable<T extends ForwardableComment>(comments: T[]): T[] {
  return comments
    .filter(isForwardableComment)
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
}
