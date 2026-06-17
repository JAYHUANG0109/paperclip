/**
 * Helpers for mirroring Paperclip issue comments to Google Chat: decide which
 * comments are worth forwarding, and build a signature for de-duplicating an
 * agent that posts the same answer twice.
 *
 * What we forward: any non-empty comment that is NOT a system notice and does
 * NOT look like an agent's internal ops/heartbeat note. We forward BOTH 繁體中文
 * and English answers — some staff use English only, so language is not a filter.
 *
 * Why not `authorType`: it's unreliable — when an agent posts its answer through
 * the REST API the comment gets mis-attributed to "local-board"/"user" rather
 * than "agent", while internal heartbeat notes (written inside a proper agent
 * run) keep authorType "agent". So filtering on authorType dropped real answers
 * and kept noise. Instead we filter on content: drop system notices and the
 * agent's English self-talk ("Exiting heartbeat", "no action needed", "stays
 * blocked on …") via `looksLikeInternalNote`. (An earlier version also required
 * CJK presence; that was relaxed so English answers reach English-only users.)
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
 * Internal ops/heartbeat notes the agent writes to itself (English self-talk).
 * This is now the PRIMARY filter (we no longer require CJK), so it must catch
 * the common status-chatter phrasings. Kept conservative to avoid swallowing a
 * real answer that merely mentions one of these words in passing.
 */
export function looksLikeInternalNote(body: string): boolean {
  return /heartbeat|no action needed|no new human input|wake (was triggered|comment|received)|duplicate wake|marked \w+ again|(stays|remains|still) blocked|blocked posture|re-?comment needed|dedup rule|re-?closed|re-?opened|no (new |further )?(reply|response|action) (needed|required|is needed)|nothing to (do|report)/i.test(
    body
  );
}

/**
 * A comment is forwarded to Chat if it's a user-facing answer: non-empty, not a
 * system notice, and not an internal ops/heartbeat note. Language-agnostic —
 * both 繁體中文 and English answers are forwarded.
 */
export function isForwardableComment(c: ForwardableComment): boolean {
  const body = typeof c.body === "string" ? c.body : "";
  if (body.trim().length === 0) return false;
  if (c.presentation?.kind === "system_notice") return false;
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
