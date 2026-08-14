/**
 * Agent egress audit — STEP 1: LOG-ONLY.
 *
 * Records outbound requests the server makes on an agent's behalf (Odoo, Asana,
 * …) so we can review a week of real traffic before turning enforcement on. It
 * computes what an allowlist WOULD decide ("allow" vs "would_deny") but NEVER
 * blocks and NEVER throws — logging must not affect the request it observes.
 *
 * When we flip to enforcement (Step 2), the allowlist here becomes authoritative
 * and callers switch from `recordEgress(...)` to a guard that rejects
 * "would_deny". Until then this file changes nothing about behaviour.
 *
 * NOTE (mini): on macOS/trusted-local there is no sandbox/network confinement, so
 * this app-level record is the only egress visibility available for the paths
 * that route through the Node server. The agent's own Odoo queries go through
 * `.claude/odoo_client.py`, which logs its own audit line separately.
 */
import { logger } from "../middleware/logger.js";

/**
 * Known-good outbound destinations for this deployment. Step 1 only *labels*
 * against this list; it does not enforce it.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "eip.seasonarts.ltd",
  "seasonart-test.aiuptop.com",
  "app.asana.com",
  "api.anthropic.com",
]);

export type EgressSource = "odoo" | "asana" | "plugin_fetch";
export type EgressDecision = "allow" | "would_deny";

export interface EgressContext {
  source: EgressSource;
  method?: string;
  companyId?: string | null;
  agentId?: string | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unparseable";
  }
}

/**
 * Record one outbound request. LOG-ONLY: returns the decision it *would* make so
 * a future enforcement step can act on it, but this function itself never blocks
 * and never throws.
 */
export function recordEgress(url: string, ctx: EgressContext): EgressDecision {
  const host = hostOf(url);
  const decision: EgressDecision = ALLOWED_HOSTS.has(host) ? "allow" : "would_deny";
  try {
    logger.info(
      {
        evt: "agent_egress",
        source: ctx.source,
        method: ctx.method ?? "GET",
        host,
        decision,
        companyId: ctx.companyId ?? null,
        agentId: ctx.agentId ?? null,
      },
      `egress ${decision}: ${ctx.source} -> ${host}`,
    );
  } catch {
    /* logging must never affect the observed request */
  }
  return decision;
}
