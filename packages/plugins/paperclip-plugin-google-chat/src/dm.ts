import type { PluginContext } from "@paperclipai/plugin-sdk";
import { findDirectMessageSpace } from "./chat.js";
import type { FetchLike } from "./google-auth.js";

/**
 * What we remember about a person so an agent can DM them later by email.
 * Learned from inbound DMs (the only path that works with app/`chat.bot` auth —
 * an app can't create a DM, only reply in one it already shares).
 */
export interface DmTarget {
  /** DM space resource name, e.g. "spaces/AAAA". */
  spaceName: string;
  /** User resource name "users/{id}" — lets us re-find the space if it changes. */
  userName?: string;
}

function dmKey(email: string) {
  return { scopeKind: "instance" as const, stateKey: `dm-space:${email.trim().toLowerCase()}` };
}

/**
 * Record the DM space for an email, learned from an inbound direct message.
 * Only call this for genuine DMs — never for room/space messages, or we'd
 * "remember" a shared room as someone's personal channel.
 */
export async function rememberDmTarget(
  ctx: PluginContext,
  email: string,
  target: DmTarget
): Promise<void> {
  if (!email) return;
  await ctx.state.set(dmKey(email), target);
}

export async function getDmTarget(
  ctx: PluginContext,
  email: string
): Promise<DmTarget | null> {
  if (!email) return null;
  return (await ctx.state.get(dmKey(email))) as DmTarget | null;
}

/**
 * Resolve which DM space to post into for a given email:
 *  1. The learned space (set when the person last DM'd the bot).
 *  2. Failing that, if we remembered their user resource name, re-discover the
 *     space via spaces.findDirectMessage (handles a space that was recreated).
 * Returns null when we have no way to reach them yet — the caller surfaces a
 * clear "they must message the bot first" error.
 */
export async function resolveDmSpace(
  ctx: PluginContext,
  fetchImpl: FetchLike,
  accessToken: string,
  email: string
): Promise<string | null> {
  const known = await getDmTarget(ctx, email);
  if (known?.spaceName) return known.spaceName;
  if (known?.userName) {
    const rediscovered = await findDirectMessageSpace(fetchImpl, accessToken, known.userName);
    if (rediscovered) {
      await rememberDmTarget(ctx, email, { spaceName: rediscovered, userName: known.userName });
      return rediscovered;
    }
  }
  return null;
}
