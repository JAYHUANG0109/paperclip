import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  agentMemberships,
  agents,
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  companyMemberships,
  instanceUserRoles,
  pluginState,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";

/**
 * Auto-provision a newly signed-in user from any agents pre-tagged with their
 * email (adapterConfig.assignedUserEmail). This makes onboarding self-service:
 * an admin sets up an agent + tags the person's email; when that person logs in
 * with their @domain Google account, they automatically get operator access to
 * exactly their assigned agent — no manual grant per login. Users with no
 * pre-assigned agent are left ungated-out (they see "No company access").
 */
async function autoProvisionAssignedAgents(
  db: Db,
  user: { id?: string; email?: string | null },
  hostedDomain: string,
): Promise<void> {
  const userId = user.id;
  if (!userId) return;
  // Email may be absent (session hook only has the id) — look it up.
  let email = user.email?.trim().toLowerCase();
  if (!email) {
    const row = (await db.select().from(authUsers).where(eq(authUsers.id, userId)))[0];
    email = row?.email?.trim().toLowerCase();
  }
  if (!email) return;
  if (hostedDomain && !email.endsWith(`@${hostedDomain.toLowerCase()}`)) return;

  const all = await db.select().from(agents);
  const wantedAgentIds = new Set<string>();
  // Source 1: the Google Chat "Assignments" page (email → agent), which is the
  // single UI control surface — stored in plugin_state under "agent-assignments".
  try {
    const rows = await db
      .select()
      .from(pluginState)
      .where(eq(pluginState.stateKey, "agent-assignments"));
    for (const row of rows) {
      const map = (row.valueJson as Record<string, { agentId?: string }>) ?? {};
      const entry = map[email];
      if (entry?.agentId) wantedAgentIds.add(entry.agentId);
    }
  } catch {
    /* assignments are optional */
  }
  // Source 2: an agent tagged directly with this email (prep-agent.ts).
  for (const a of all) {
    const cfg = a.adapterConfig as { assignedUserEmail?: string } | null;
    if (cfg?.assignedUserEmail?.trim().toLowerCase() === email) wantedAgentIds.add(a.id);
  }
  const mine = all.filter((a) => wantedAgentIds.has(a.id) && a.status !== "terminated");
  const VALID_ROLES = new Set(["owner", "admin", "operator", "viewer"]);
  for (const agent of mine) {
    const cfg = agent.adapterConfig as { assignedUserRole?: string } | null;
    // Default to operator; an agent may specify a higher role (e.g. 創辦人_agent
    // → owner so the founder lands with full visibility automatically).
    const requested = cfg?.assignedUserRole?.trim().toLowerCase();
    const role = requested && VALID_ROLES.has(requested) ? requested : "operator";
    // operator/viewer company membership
    const existingMem = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, agent.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      );
    if (existingMem.length === 0) {
      await db.insert(companyMemberships).values({
        id: randomUUID(),
        companyId: agent.companyId,
        principalType: "user",
        principalId: userId,
        membershipRole: role,
        status: "active",
      });
    } else if (existingMem[0].membershipRole !== role && role === "owner") {
      await db.update(companyMemberships).set({ membershipRole: role, updatedAt: new Date() }).where(eq(companyMemberships.id, existingMem[0].id));
    }
    // If the agent requested owner-level access, also grant instance_admin so the
    // user can access instance settings (same as Jay/創辦人).
    if (role === "owner") {
      const existingAdmin = await db.select().from(instanceUserRoles).where(
        and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")),
      );
      if (existingAdmin.length === 0) {
        await db.insert(instanceUserRoles).values({ id: randomUUID(), userId, role: "instance_admin" });
      }
    }
    // agent_membership(joined) → they see only this agent (with restriction on)
    const existingJoin = await db
      .select()
      .from(agentMemberships)
      .where(
        and(
          eq(agentMemberships.companyId, agent.companyId),
          eq(agentMemberships.userId, userId),
          eq(agentMemberships.agentId, agent.id),
        ),
      );
    if (existingJoin.length === 0) {
      await db.insert(agentMemberships).values({
        id: randomUUID(),
        companyId: agent.companyId,
        userId,
        agentId: agent.id,
        state: "joined",
      });
    }
  }
}

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthInstance = ReturnType<typeof betterAuth>;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  authBaseUrlMode: Config["authBaseUrlMode"];
  authPublicBaseUrl: string | undefined;
  publicUrl?: string | undefined;
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  // Optional Google SSO. Activated only when both client credentials are set,
  // so the default (email/password) is unchanged until configured. `hd` limits
  // the Google account chooser to the org's Workspace domain (defaults to
  // seasonart.org); combined with an "Internal" OAuth consent screen and
  // Paperclip's invite-only membership, sign-in is restricted to that domain.
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const googleHostedDomain =
    process.env.GOOGLE_WORKSPACE_DOMAIN?.trim() || "seasonart.org";
  const socialProviders =
    googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            hd: googleHostedDomain,
          },
        }
      : undefined;

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    ...(socialProviders ? { socialProviders } : {}),
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser: { id?: string; email?: string | null }) => {
            try {
              await autoProvisionAssignedAgents(db, createdUser, googleHostedDomain);
            } catch {
              /* auto-provisioning is best-effort; never block sign-in */
            }
          },
        },
      },
      // Also run on every sign-in so someone assigned AFTER their first login
      // still gets provisioned next time they sign in (idempotent).
      session: {
        create: {
          after: async (session: { userId?: string }) => {
            try {
              if (session.userId) {
                await autoProvisionAssignedAgents(db, { id: session.userId }, googleHostedDomain);
              }
            } catch {
              /* best-effort */
            }
          },
        },
      },
    },
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthInstance): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = (auth as unknown as { api?: { getSession?: (input: unknown) => Promise<unknown> } }).api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthInstance,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
