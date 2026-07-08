import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { secretService } from "./secrets.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { resolveAgentResponsibleUserId, ASANA_USER_SECRET_KEY } from "./agent-asana.js";
import { logger } from "../middleware/logger.js";

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

/**
 * Mirror the token into the responsible user's per-user secret ("My secrets",
 * key ASANA_TOKEN) so it shows in the Secrets UI and is the single source the
 * run-env injection reads. Idempotent upsert; best-effort — the file write is
 * the source of truth for back-compat, so a mirror failure never fails token
 * storage. Creates the ASANA_TOKEN definition on first use.
 */
async function mirrorAsanaTokenToUserSecret(
  db: Db,
  companyId: string,
  agentId: string,
  token: string,
): Promise<void> {
  try {
    const userId = await resolveAgentResponsibleUserId(db, companyId, agentId);
    if (!userId) return;
    const svc = secretService(db);
    const defs = await svc.listUserSecretDefinitions(companyId);
    if (!defs.some((d: { key: string }) => d.key === ASANA_USER_SECRET_KEY)) {
      await svc.createUserSecretDefinition(
        companyId,
        {
          key: ASANA_USER_SECRET_KEY,
          name: "Asana token",
          description:
            "Your personal Asana personal access token. Every agent you are responsible for uses it to read/post on Asana. Never shown back to anyone, including admins.",
          provider: getConfiguredSecretProvider(),
          usageGuidance: "Create a Personal Access Token at https://app.asana.com/0/my-apps and paste it here.",
        },
        { userId: null, agentId: null },
      );
    }
    const entries = await svc.listCurrentUserSecretValues(companyId, userId);
    const entry = entries.find(
      (e: { definition: { key: string }; secret: { id: string } | null }) =>
        e.definition.key === ASANA_USER_SECRET_KEY && e.secret,
    );
    if (entry?.secret) {
      await svc.updateCurrentUserSecretValue(companyId, userId, entry.secret.id, { value: token }, { userId, agentId: null });
    } else {
      await svc.createCurrentUserSecretValue(companyId, userId, { definitionKey: ASANA_USER_SECRET_KEY, value: token }, { userId, agentId: null });
    }
  } catch (err) {
    logger.warn({ err, companyId, agentId }, "asana token: per-user secret mirror failed (file write still succeeded)");
  }
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
  // Mirror into the user's per-user secret so it's UI-managed + the single
  // source the run-env injection reads (see heartbeat run-config assembly).
  await mirrorAsanaTokenToUserSecret(db, companyId, agentId, trimmed);
  return { ok: true, path: tokenPath };
}
