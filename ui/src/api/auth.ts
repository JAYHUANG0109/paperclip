import { getViewAs, getViewAsUserId } from "@/lib/view-as";
import {
  authSessionSchema,
  currentUserProfileSchema,
  type AuthSession,
  type CurrentUserProfile,
  type UpdateCurrentUserProfile,
} from "@paperclipai/shared";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";

type AuthErrorBody =
  | {
    code?: string;
    message?: string;
    error?: string | { code?: string; message?: string };
  }
  | null;

export class AuthApiError extends Error {
  status: number;
  code: string | null;
  body: unknown;

  constructor(message: string, status: number, body: unknown, code: string | null = null) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function toSession(value: unknown): AuthSession | null {
  const direct = authSessionSchema.safeParse(value);
  if (direct.success) return direct.data;

  if (!value || typeof value !== "object") return null;
  const nested = authSessionSchema.safeParse((value as Record<string, unknown>).data);
  return nested.success ? nested.data : null;
}

function extractAuthError(payload: AuthErrorBody, status: number) {
  const nested =
    payload?.error && typeof payload.error === "object"
      ? payload.error
      : null;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof payload?.code === "string"
        ? payload.code
        : null;
  const message =
    typeof nested?.message === "string" && nested.message.trim().length > 0
      ? nested.message
      : typeof payload?.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : typeof payload?.error === "string" && payload.error.trim().length > 0
          ? payload.error
          : `Request failed: ${status}`;

  return new AuthApiError(message, status, payload, code);
}

// Rich diagnostics for auth requests. Network-layer failures (Safari
// "Load failed" / Chrome "Failed to fetch") throw a TypeError *before* any
// HTTP response, so they are indistinguishable from a bad password in the UI
// unless we log the resolved request URL + origin here. See PAP-13466.
function resolveAuthUrl(path: string) {
  const relative = `/api/auth${path}`;
  try {
    return new URL(relative, window.location.origin).href;
  } catch {
    return relative;
  }
}

function logAuthNetworkFailure(method: string, path: string, error: unknown) {
  // eslint-disable-next-line no-console
  console.error("[auth] request failed at the network layer (no HTTP response)", {
    method,
    requestUrl: resolveAuthUrl(path),
    pageOrigin: typeof window !== "undefined" ? window.location.origin : "(no window)",
    pageHref: typeof window !== "undefined" ? redactUrlSecrets(window.location.href) : "(no window)",
    credentials: "include",
    online: typeof navigator !== "undefined" ? navigator.onLine : "(no navigator)",
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    error,
    hint:
      "This means the browser never got a response from the server. Common causes: " +
      "the page origin differs from the API host (mixed http/https, wrong hostname/port, " +
      "or a proxy/tunnel that only forwards the page but not /api), an SSL error, or the " +
      "connection was reset. A wrong password would instead return HTTP 401, not this.",
  });
}

function logAuthHttpError(method: string, path: string, status: number, statusText: string, body: unknown) {
  // eslint-disable-next-line no-console
  console.error("[auth] request returned an error status", {
    method,
    requestUrl: resolveAuthUrl(path),
    status,
    statusText,
    body,
  });
}

async function authPost(path: string, body: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`/api/auth${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    logAuthNetworkFailure("POST", path, networkError);
    throw networkError;
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    logAuthHttpError("POST", path, res.status, res.statusText, payload);
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return payload;
}

async function authPatch<T>(path: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return parse(payload);
}

/**
 * Re-point a session at the user being viewed.
 *
 * `/api/auth/get-session` is better-auth's own route: it reads the session
 * cookie and answers with the REAL account, and it never sees Paperclip's
 * view-as header. Components derive `currentUserId` from this session to decide
 * what counts as "mine", so without this override "view as" would scope the
 * server's data to the target while the client still highlighted the viewer's
 * own rows — a view that is neither person's, which is worse than either.
 *
 * The real identity is not hidden: the amber banner names it for as long as
 * view-as is on, and the server independently enforces read-only.
 */
function applyViewAsToSession(session: AuthSession | null): AuthSession | null {
  const viewAsUserId = getViewAsUserId();
  if (!session || !viewAsUserId) return session;
  const viewing = getViewAs();
  return {
    ...session,
    user: session.user
      ? {
          ...session.user,
          id: viewAsUserId,
          name: viewing?.label ?? session.user.name,
          email: viewing?.label ?? session.user.email,
        }
      : session.user,
    session: session.session ? { ...session.session, userId: viewAsUserId } : session.session,
  };
}

export const authApi = {
  getSession: async (): Promise<AuthSession | null> => {
    const res = await fetch("/api/auth/get-session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return null;
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Failed to load session (${res.status})`);
    }
    const direct = toSession(payload);
    if (direct) return applyViewAsToSession(direct);
    const nested = payload && typeof payload === "object" ? toSession((payload as Record<string, unknown>).data) : null;
    return applyViewAsToSession(nested);
  },

  signInEmail: async (input: { email: string; password: string }) => {
    await authPost("/sign-in/email", input);
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  /** Begin a social (e.g. Google) sign-in. Returns the provider URL to redirect
   *  the browser to; better-auth completes the flow at /api/auth/callback/<provider>. */
  signInSocial: async (input: { provider: string; callbackURL?: string }): Promise<{ url: string }> => {
    const payload = await authPost("/sign-in/social", {
      provider: input.provider,
      callbackURL: input.callbackURL ?? "/",
    });
    const url = (payload as { url?: string } | null)?.url;
    if (!url || typeof url !== "string") {
      throw new AuthApiError("Social sign-in did not return a redirect URL", 500, payload);
    }
    return { url };
  },

  getProfile: async (): Promise<CurrentUserProfile> => {
    const res = await fetch("/api/auth/profile", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((payload as { error?: string } | null)?.error ?? `Failed to load profile (${res.status})`);
    }
    return currentUserProfileSchema.parse(payload);
  },

  updateProfile: async (input: UpdateCurrentUserProfile): Promise<CurrentUserProfile> =>
    authPatch("/profile", input, (payload) => currentUserProfileSchema.parse(payload)),

  signOut: async () => {
    await authPost("/sign-out", {});
  },
};
