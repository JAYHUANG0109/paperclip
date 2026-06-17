import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Per-person conversation index that backs the manager-facing "Chat Logs" page.
 *
 * The reply-mirror only stores `issueId → ChatTarget` (routing.ts), which answers
 * "where do I deliver this reply?" but not "show me everything <person> has said".
 * This module adds the reverse view:
 *   - `sender-issues:<email>` → the person's conversation turns (issueId + the
 *     message text + when), most-recent last, bounded.
 *   - `chat-senders` → a roster of everyone who has ever messaged the bot, so the
 *     page can list people (even those without an assignment) with a last-seen
 *     time, like a messaging-app inbox.
 *
 * Reads are assembled into a transcript by the worker's `chat-logs` data handler.
 */

export interface ConversationEntry {
  /** The Paperclip issue created for this message (one issue per inbound turn). */
  issueId: string;
  /** The person's message text (the user side of the transcript). */
  text: string;
  /** ISO timestamp of when the message was received. */
  at: string;
}

export interface SenderProfile {
  /** Original-case email, for display. */
  email: string;
  /** Chat display name, if Google gave us one. */
  displayName?: string;
  /** ISO timestamp of this person's most recent message. */
  lastAt: string;
}

/** Keep at most this many recent turns per person (bounds state growth). */
const INDEX_CAP = 200;

const ROSTER_KEY = { scopeKind: "instance" as const, stateKey: "chat-senders" };

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function indexKey(email: string) {
  return { scopeKind: "instance" as const, stateKey: `sender-issues:${normalize(email)}` };
}

/**
 * Record one inbound turn: append it to the sender's conversation index and
 * refresh their entry in the roster. Called when a Chat message is dispatched
 * to an agent. Idempotent on issueId so a retry won't double-list a turn.
 */
export async function recordConversation(
  ctx: PluginContext,
  params: { email: string; displayName?: string; issueId: string; text: string; at: string }
): Promise<void> {
  const email = normalize(params.email);
  if (!email) return;

  const list =
    ((await ctx.state.get(indexKey(email))) as ConversationEntry[] | null) ?? [];
  if (!list.some((e) => e.issueId === params.issueId)) {
    list.push({ issueId: params.issueId, text: params.text, at: params.at });
  }
  await ctx.state.set(indexKey(email), list.slice(-INDEX_CAP));

  const roster =
    ((await ctx.state.get(ROSTER_KEY)) as Record<string, SenderProfile> | null) ?? {};
  roster[email] = {
    email: params.email,
    displayName: params.displayName ?? roster[email]?.displayName,
    lastAt: params.at
  };
  await ctx.state.set(ROSTER_KEY, roster);
}

/** Everyone who has ever messaged the bot (most recent first). */
export async function listSenders(ctx: PluginContext): Promise<SenderProfile[]> {
  const roster =
    ((await ctx.state.get(ROSTER_KEY)) as Record<string, SenderProfile> | null) ?? {};
  return Object.values(roster).sort(
    (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()
  );
}

/** A person's recorded conversation turns, oldest first. */
export async function listConversationEntries(
  ctx: PluginContext,
  email: string
): Promise<ConversationEntry[]> {
  if (!email) return [];
  return ((await ctx.state.get(indexKey(email))) as ConversationEntry[] | null) ?? [];
}
