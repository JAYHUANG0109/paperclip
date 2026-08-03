/**
 * Per-user Odoo credentials, the Asana-shaped way.
 *
 * Odoo auth is per human: the user generates a read-only API key in Odoo
 * (設定 → 我的API金鑰) and it acts AS that user, so Odoo enforces their real
 * permissions. This module holds the parts that have nothing to do with storage:
 * validation, the live auth probe, and the connection-file shape that
 * `.claude/odoo_client.py` reads. `storeOdooCredentialsForAgent` in
 * agent-connections.ts does the writing/wiring/mirroring.
 *
 * The database is PROBED, never assumed. One host (eip.seasonarts.ltd) serves
 * both `eip` (production) and `test-eip` (staging), and a given user's key
 * authenticates on exactly one of them — hardcoding `eip` for everyone silently
 * breaks the staging users, which is how the 3 agents broke the first time.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { logger } from "../middleware/logger.js";

/**
 * The per-user secret key each user stores their personal Odoo API key under.
 * One key per human; every agent that user is responsible for reuses it, so keys
 * are managed/rotated from the "My secrets" UI instead of loose files.
 * Mirrors ASANA_USER_SECRET_KEY in agent-asana.ts.
 */
export const ODOO_USER_SECRET_KEY = "ODOO_API_KEY";

/** 主站 first, 備援 second — `connect()` tries them in order. */
export const ODOO_OFFICIAL_URL = "https://eip.seasonarts.ltd";
export const ODOO_FALLBACK_URL = "https://seasonart-test.aiuptop.com";

/** The two databases the official host serves. Probed in this order. */
export const ODOO_DATABASES = ["eip", "test-eip"] as const;
export type OdooDatabase = (typeof ODOO_DATABASES)[number] | string;

const PROBE_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_SECONDS = 6;

export function isValidOdooLogin(login: string): boolean {
  const t = login.trim();
  // Odoo logins here are work emails; keep it deliberately loose but non-empty.
  return t.length > 2 && t.includes("@") && !/\s/.test(t);
}

export function isValidOdooApiKey(key: string): boolean {
  const t = key.trim();
  // Odoo API keys are opaque tokens; reject only what cannot possibly be one.
  return t.length >= 16 && !/\s/.test(t);
}

/** Mask a key down to its last 4 — never log or echo a whole key. */
export function maskOdooKey(key: string): string {
  const s = key ?? "";
  return s.length >= 8 ? `${s.slice(0, 3)}…${s.slice(-4)}` : "…";
}

/**
 * Read-only connection status for the Connections UI — mirrors agent-asana's
 * readToken, but NEVER returns the key (only whether one is present, plus the
 * login/url/db so the card can show "connected as …"). Resolves the file from
 * the agent's ODOO_CONNECTION_PATH env pointer, else the per-agent default path.
 */
export function readOdooConnectionStatus(
  row: { adapterConfig?: unknown } | undefined,
  companyId: string,
  agentId: string,
): { connected: boolean; login: string | null; url: string | null; db: string | null } {
  const notConnected = { connected: false, login: null, url: null, db: null };
  let path: string | null = null;
  const env = (row?.adapterConfig as { env?: Record<string, unknown> } | null)?.env;
  const ptr = env?.ODOO_CONNECTION_PATH as { value?: string } | string | undefined;
  if (ptr && typeof ptr === "object" && typeof ptr.value === "string") path = ptr.value;
  else if (typeof ptr === "string") path = ptr;
  if (!path) {
    path = `${homedir()}/.paperclip/instances/default/companies/${companyId}/agents/${agentId}/odoo-connection.json`;
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      login?: string;
      connections?: Array<{ url?: string; db?: string; apiKey?: string }>;
    };
    const conns = cfg.connections ?? [];
    const hasKey = conns.some((c) => (c.apiKey ?? "").trim().length > 0);
    if (!hasKey) return notConnected;
    const first = conns.find((c) => (c.apiKey ?? "").trim()) ?? conns[0];
    return { connected: true, login: (cfg.login ?? "").trim() || null, url: first?.url ?? null, db: first?.db ?? null };
  } catch {
    return notConnected;
  }
}

// ---------------------------------------------------------------------------
// XML-RPC (stdlib-only, same wire protocol odoo_client.py speaks)
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildAuthenticateCall(db: string, login: string, apiKey: string): string {
  const str = (v: string) => `<param><value><string>${xmlEscape(v)}</string></value></param>`;
  return (
    '<?xml version="1.0"?>' +
    "<methodCall><methodName>authenticate</methodName><params>" +
    str(db) +
    str(login) +
    str(apiKey) +
    "<param><value><struct/></value></param>" +
    "</params></methodCall>"
  );
}

/**
 * Parse an XML-RPC `authenticate` response into the uid.
 *   - `<int>7</int>`          → 7            (authenticated)
 *   - `<boolean>0</boolean>`  → null         (wrong key for this db)
 *   - `<fault>…</fault>`      → throws       (e.g. db does not exist)
 */
export function parseAuthenticateResponse(xml: string): number | null {
  const fault = /<fault>([\s\S]*?)<\/fault>/.exec(xml);
  if (fault) {
    const msg = /<name>faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/.exec(fault[1]);
    const detail = (msg?.[1] ?? fault[1]).trim().split("\n").pop() ?? "unknown fault";
    throw new Error(detail.slice(0, 200));
  }
  const int = /<(?:int|i4)>\s*(-?\d+)\s*<\/(?:int|i4)>/.exec(xml);
  if (int) {
    const uid = Number(int[1]);
    return uid > 0 ? uid : null;
  }
  return null; // <boolean>0</boolean> and anything else non-numeric
}

export type ProbeResult = { url: string; db: string; uid: number | null; error: string | null };

/** One live `authenticate` against one (url, db). Never throws. */
export async function probeOdoo(
  url: string,
  db: string,
  login: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/xmlrpc/2/common`, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: buildAuthenticateCall(db, login, apiKey),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { url, db, uid: null, error: `HTTP ${res.status}` };
    return { url, db, uid: parseAuthenticateResponse(await res.text()), error: null };
  } catch (e) {
    return { url, db, uid: null, error: (e as Error).message.slice(0, 200) };
  }
}

export type ResolvedOdooTarget = { url: string; db: string; uid: number; attempts: ProbeResult[] };

/**
 * Find where this key actually authenticates: official host × both databases
 * first, then the 備援. Returns null when nothing accepts it (a dead key), with
 * the attempts so the caller can tell the user what was tried.
 */
export async function resolveOdooTarget(
  login: string,
  apiKey: string,
  opts: { urls?: string[]; databases?: string[]; fetchImpl?: typeof fetch } = {},
): Promise<{ target: ResolvedOdooTarget | null; attempts: ProbeResult[] }> {
  const urls = opts.urls ?? [ODOO_OFFICIAL_URL, ODOO_FALLBACK_URL];
  const databases = opts.databases ?? [...ODOO_DATABASES];
  const attempts: ProbeResult[] = [];
  for (const url of urls) {
    for (const db of databases) {
      const r = await probeOdoo(url, db, login, apiKey, opts.fetchImpl ?? fetch);
      attempts.push(r);
      if (r.uid) return { target: { url, db, uid: r.uid, attempts }, attempts };
    }
  }
  logger.info(
    { login, key: maskOdooKey(apiKey), attempts: attempts.map((a) => `${a.url} db=${a.db}: ${a.error ?? "auth failed"}`) },
    "odoo: key authenticated on no database",
  );
  return { target: null, attempts };
}

/**
 * The exact shape `.claude/odoo_client.py` reads: `login`, `readOnly`, and
 * `connections` tried in order (the probed target first, then the 備援 on the
 * same db, so a 主站 outage still connects).
 */
export function buildOdooConnectionFile(args: {
  login: string;
  apiKey: string;
  url: string;
  db: string;
  readOnly: boolean;
}): Record<string, unknown> {
  const others = [ODOO_OFFICIAL_URL, ODOO_FALLBACK_URL].filter((u) => u !== args.url);
  return {
    login: args.login,
    readOnly: args.readOnly,
    connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
    connections: [
      { name: "primary", url: args.url, db: args.db, apiKey: args.apiKey, note: "User's OWN Odoo API key. Never share or reuse for another agent." },
      ...others.map((u) => ({ name: "fallback", url: u, db: args.db, apiKey: args.apiKey })),
    ],
  };
}
