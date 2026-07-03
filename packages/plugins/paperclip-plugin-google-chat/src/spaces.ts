import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getSpace } from "./chat.js";
import type { FetchLike } from "./google-auth.js";

/**
 * A group space (ROOM) the bot is a member of, learned from inbound room
 * activity. Unlike DMs (keyed per-email — a personal 1:1 channel), a room is
 * shared, so we index rooms by their human display name so an agent can target
 * one by the name people see in Google Chat (e.g. "領導團隊").
 */
export interface KnownSpace {
  /** Space resource name, e.g. "spaces/AAAA". */
  spaceName: string;
  /** Human-visible room name from Google Chat (may be empty for unnamed rooms). */
  displayName?: string;
  /** ISO timestamp of the last time we saw activity in / (re)learned this room. */
  lastSeenAt: string;
}

const INDEX_KEY = { scopeKind: "instance" as const, stateKey: "chat-spaces" } as const;

/** Normalize a room name for tolerant matching: trim + collapse whitespace +
 *  casefold. Chinese names pass through unchanged apart from surrounding space. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

async function readIndex(ctx: PluginContext): Promise<KnownSpace[]> {
  const rec = (await ctx.state.get(INDEX_KEY)) as KnownSpace[] | null;
  return Array.isArray(rec) ? rec : [];
}

/**
 * Record (or refresh) a room the bot belongs to. Keyed by the immutable
 * `spaceName`, so a rename just updates the stored `displayName`. Best-effort:
 * callers wrap in try/catch — learning a room must never break message handling.
 */
export async function rememberSpace(
  ctx: PluginContext,
  space: { spaceName: string; displayName?: string }
): Promise<void> {
  if (!space.spaceName) return;
  const index = await readIndex(ctx);
  const at = new Date().toISOString();
  const existing = index.find((s) => s.spaceName === space.spaceName);
  if (existing) {
    if (space.displayName) existing.displayName = space.displayName;
    existing.lastSeenAt = at;
  } else {
    index.push({ spaceName: space.spaceName, displayName: space.displayName, lastSeenAt: at });
  }
  await ctx.state.set(INDEX_KEY, index);
}

/** All rooms the bot currently knows it can post to, newest-seen first. */
export async function listKnownSpaces(ctx: PluginContext): Promise<KnownSpace[]> {
  const index = await readIndex(ctx);
  return index
    .slice()
    .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
}

/**
 * Resolve an agent-supplied space identifier to a room resource name:
 *  1. A raw resource name ("spaces/…") the bot knows → used directly.
 *  2. Exact display-name match (normalized).
 *  3. Unique substring match (so "領導" finds "領導團隊") — only when it's
 *     unambiguous; multiple hits return null so the agent must be specific.
 * Returns null when unmatched/ambiguous; the caller lists the known names.
 */
export async function resolveSpaceName(
  ctx: PluginContext,
  query: string
): Promise<string | null> {
  const q = norm(query);
  if (!q) return null;
  const index = await readIndex(ctx);
  if (index.length === 0) return null;

  // Raw resource name the bot already knows.
  if (query.trim().startsWith("spaces/")) {
    const hit = index.find((s) => s.spaceName === query.trim());
    return hit ? hit.spaceName : null;
  }
  // Exact display-name match.
  const exact = index.filter((s) => s.displayName && norm(s.displayName) === q);
  if (exact.length === 1) return exact[0].spaceName;
  if (exact.length > 1) return null; // ambiguous — two rooms share a name
  // Unique substring match.
  const partial = index.filter((s) => s.displayName && norm(s.displayName).includes(q));
  return partial.length === 1 ? partial[0].spaceName : null;
}

/**
 * Learn a room's display name via the Chat API when the inbound event didn't
 * carry it. Best-effort — a failed lookup just stores the room without a name
 * (still targetable by resource name, and re-learned on the next message).
 */
export async function learnSpaceFromApi(
  ctx: PluginContext,
  fetchImpl: FetchLike,
  accessToken: string,
  spaceName: string
): Promise<void> {
  try {
    const info = await getSpace(fetchImpl, accessToken, spaceName);
    await rememberSpace(ctx, { spaceName, displayName: info?.displayName });
  } catch {
    await rememberSpace(ctx, { spaceName });
  }
}
