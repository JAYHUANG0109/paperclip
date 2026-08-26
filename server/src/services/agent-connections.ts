import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { secretService } from "./secrets.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { resolveAgentResponsibleUserId, ASANA_USER_SECRET_KEY } from "./agent-asana.js";
import {
  ODOO_USER_SECRET_KEY,
  buildOdooConnectionFile,
  isValidOdooApiKey,
  isValidOdooLogin,
  maskOdooKey,
  resolveOdooTarget,
  type ProbeResult,
} from "./agent-odoo.js";
import { syncAgentAdapterEnvBindings } from "./agent-secret-bindings.js";
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
async function mirrorToUserSecret(
  db: Db,
  companyId: string,
  agentId: string,
  def: { key: string; name: string; description: string; usageGuidance: string },
  value: string,
): Promise<void> {
  try {
    const userId = await resolveAgentResponsibleUserId(db, companyId, agentId);
    if (!userId) return;
    const svc = secretService(db);
    const defs = await svc.listUserSecretDefinitions(companyId);
    if (!defs.some((d: { key: string }) => d.key === def.key)) {
      await svc.createUserSecretDefinition(
        companyId,
        { ...def, provider: getConfiguredSecretProvider() },
        { userId: null, agentId: null },
      );
    }
    const entries = await svc.listCurrentUserSecretValues(companyId, userId);
    const entry = entries.find(
      (e: { definition: { key: string }; secret: { id: string } | null }) =>
        e.definition.key === def.key && e.secret,
    );
    if (entry?.secret) {
      await svc.updateCurrentUserSecretValue(companyId, userId, entry.secret.id, { value }, { userId, agentId: null });
    } else {
      await svc.createCurrentUserSecretValue(companyId, userId, { definitionKey: def.key, value }, { userId, agentId: null });
    }
  } catch (err) {
    logger.warn({ err, companyId, agentId, key: def.key }, "connection: per-user secret mirror failed (file write still succeeded)");
  }
}

const ASANA_SECRET_DEF = {
  key: ASANA_USER_SECRET_KEY,
  name: "Asana token",
  description:
    "Your personal Asana personal access token. Every agent you are responsible for uses it to read/post on Asana. Never shown back to anyone, including admins.",
  usageGuidance: "Create a Personal Access Token at https://app.asana.com/0/my-apps and paste it here.",
};

const ODOO_SECRET_DEF = {
  key: ODOO_USER_SECRET_KEY,
  name: "Odoo API key",
  description:
    "Your personal Odoo API key. Every agent you are responsible for uses it to read Odoo AS YOU, so Odoo enforces your own permissions. Never shown back to anyone, including admins.",
  usageGuidance: "In Odoo: 設定 → 我的個人資料 → 帳戶安全 → 我的API金鑰 (Settings → My Profile → Account Security → API Keys). Create a read-only key and paste it here.",
};

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
  // Wire the secret as well as the file, so the agent can read BOTH. The file
  // is a snapshot frozen at the moment it was written; this binding resolves the
  // responsible user's ASANA_TOKEN at run time, so a token rotated in 我的密鑰
  // reaches the agent on its next run instead of silently going nowhere. Not
  // required: an agent whose owner has no token yet must still run.
  env.ASANA_TOKEN = {
    type: "user_secret_ref",
    key: ASANA_USER_SECRET_KEY,
    version: "latest",
    required: false,
    allowMissingOverride: true,
  };
  ac.env = env;
  await db.update(agents).set({ adapterConfig: ac, updatedAt: new Date() }).where(eq(agents.id, agentId));
  // The raw update above bypasses the agent-PATCH path, so declare the binding
  // explicitly — without a user_secret_declarations row the runtime has nothing
  // to resolve and the env var never appears.
  await syncAgentAdapterEnvBindings({
    secretsSvc: secretService(db),
    companyId,
    agentId,
    adapterConfig: ac,
  });
  // Mirror into the user's per-user secret so it's UI-managed and the binding
  // above has something to resolve.
  await mirrorToUserSecret(db, companyId, agentId, ASANA_SECRET_DEF, trimmed);
  return { ok: true, path: tokenPath };
}

/**
 * Store a per-agent Odoo credential the same atomic way Asana works, so an Odoo
 * key a user hands over during onboarding is immediately usable and every agent
 * created later gets Odoo access without hand-placed files.
 *
 * Writes `…/agents/{agentId}/odoo-connection.json` (the shape
 * `.claude/odoo_client.py` reads), wires `adapterConfig.env.ODOO_CONNECTION_PATH`,
 * and mirrors the key into the responsible user's ODOO_API_KEY secret so it is
 * rotatable from the Secrets UI.
 *
 * The database is resolved by a LIVE auth probe (eip vs test-eip vs 備援) rather
 * than assumed — one host serves both databases and each key belongs to exactly
 * one. A key that authenticates nowhere is rejected here, so a dead key fails at
 * the moment the user pastes it instead of silently at the agent's next run.
 */
export async function storeOdooCredentialsForAgent(
  db: Db,
  companyId: string,
  agentId: string,
  input: { login: string; apiKey: string; readOnly?: boolean; url?: string | null; db?: string | null },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true; path: string; url: string; db: string; uid: number | null; attempts: ProbeResult[] }> {
  const login = (input.login ?? "").trim();
  const apiKey = (input.apiKey ?? "").trim();
  if (!isValidOdooLogin(login)) {
    throw new Error("Not a valid Odoo login (expected the user's work email).");
  }
  if (!isValidOdooApiKey(apiKey)) {
    throw new Error("Not a valid Odoo API key (expected an opaque token of at least 16 characters).");
  }

  // An explicit (url, db) is still probed — but only that one pair, so an
  // operator can pin a target without us silently accepting a dead key.
  const { target, attempts } = await resolveOdooTarget(login, apiKey, {
    urls: input.url ? [input.url] : undefined,
    databases: input.db ? [input.db] : undefined,
    fetchImpl: opts.fetchImpl,
  });
  if (!target) {
    const tried = attempts.map((a) => `${a.url} db=${a.db}: ${a.error ?? "auth failed"}`).join("; ");
    throw new Error(
      `This Odoo key (${maskOdooKey(apiKey)}) authenticates on no database as ${login}. ` +
        `Generate a fresh read-only key in Odoo (設定 → 我的API金鑰) and try again. Tried: ${tried}`,
    );
  }

  const readOnly = input.readOnly ?? true; // Odoo keys are read-only by default
  const agentDir = `${homedir()}/.paperclip/instances/default/companies/${companyId}/agents/${agentId}`;
  mkdirSync(agentDir, { recursive: true });
  const connectionPath = `${agentDir}/odoo-connection.json`;
  writeFileSync(
    connectionPath,
    JSON.stringify(buildOdooConnectionFile({ login, apiKey, url: target.url, db: target.db, readOnly }), null, 2),
  );

  // Wire the pointer the runtime injects. odoo_client.py can also find this file
  // from PAPERCLIP_COMPANY_ID/PAPERCLIP_AGENT_ID, but the explicit pointer keeps
  // it working for any cwd and mirrors ASANA_TOKEN_PATH.
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const ac: Record<string, unknown> = row?.adapterConfig && typeof row.adapterConfig === "object"
    ? { ...(row.adapterConfig as Record<string, unknown>) }
    : {};
  const env: Record<string, unknown> = ac.env && typeof ac.env === "object" ? { ...(ac.env as Record<string, unknown>) } : {};
  env.ODOO_CONNECTION_PATH = { type: "plain", value: connectionPath };
  env.ODOO_LOGIN = { type: "plain", value: login };
  env.ODOO_URL = { type: "plain", value: target.url };
  env.ODOO_DB = { type: "plain", value: target.db };
  ac.env = env;
  await db.update(agents).set({ adapterConfig: ac, updatedAt: new Date() }).where(eq(agents.id, agentId));

  await mirrorToUserSecret(db, companyId, agentId, ODOO_SECRET_DEF, apiKey);
  logger.info(
    { companyId, agentId, login, url: target.url, db: target.db, uid: target.uid, key: maskOdooKey(apiKey) },
    "odoo: stored per-agent credentials (db resolved by live probe)",
  );
  return { ok: true, path: connectionPath, url: target.url, db: target.db, uid: target.uid, attempts };
}
