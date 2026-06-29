import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Store a per-agent Asana token in the ONE canonical place and wire it in a
 * single atomic step, so a token a user provides during onboarding is
 * immediately usable — never "saved in chat" or "saved but not wired" (the bug
 * that made agents say "I can't find your token" after a user already gave it).
 *
 * Writes `…/agents/{agentId}/asana-connection.json` AND sets
 * `adapterConfig.env.ASANA_TOKEN_PATH` to point at it. Called by the agent itself
 * (agent-actor) the moment a user hands over their token.
 */
const ASANA_PAT = /^2\/\d{8,}\/\d{8,}:[0-9a-f]{16,}$/;
const SEASON_ARTS_WS = "1200850800726786";

export function isValidAsanaPat(token: string): boolean {
  return ASANA_PAT.test(token.trim());
}

export async function storeAsanaTokenForAgent(
  db: Db,
  companyId: string,
  agentId: string,
  token: string,
  opts: { readOnly?: boolean; defaultWorkspace?: string | null } = {},
): Promise<{ ok: true; path: string }> {
  const trimmed = token.trim();
  if (!isValidAsanaPat(trimmed)) {
    throw new Error("Not a valid Asana Personal Access Token (expected 2/<gid>/<gid>:<hex>).");
  }
  const agentDir = `${homedir()}/.paperclip/instances/default/companies/${companyId}/agents/${agentId}`;
  mkdirSync(agentDir, { recursive: true });
  const tokenPath = `${agentDir}/asana-connection.json`;
  writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        token: trimmed,
        readOnly: opts.readOnly ?? false,
        defaultWorkspace: opts.defaultWorkspace ?? SEASON_ARTS_WS,
        note: "User's OWN Asana Personal Access Token. Never share or reuse for another agent.",
      },
      null,
      2,
    ),
  );
  // Wire the pointer the runtime injects so the agent process can read it.
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const ac: Record<string, unknown> = row?.adapterConfig && typeof row.adapterConfig === "object"
    ? { ...(row.adapterConfig as Record<string, unknown>) }
    : {};
  const env: Record<string, unknown> = ac.env && typeof ac.env === "object" ? { ...(ac.env as Record<string, unknown>) } : {};
  env.ASANA_TOKEN_PATH = { type: "plain", value: tokenPath };
  ac.env = env;
  await db.update(agents).set({ adapterConfig: ac, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return { ok: true, path: tokenPath };
}
