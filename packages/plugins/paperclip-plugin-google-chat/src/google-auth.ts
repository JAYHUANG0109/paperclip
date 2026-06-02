import { createSign } from "node:crypto";

/** Minimal shape of a Google service-account JSON key. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** A resolved access token plus the epoch-ms at which it expires. */
export interface AccessToken {
  token: string;
  expiresAtMs: number;
}

/** Fetch signature compatible with both global fetch and ctx.http.fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Sufficient to send messages as the Chat app. */
export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Parse a service-account key from its raw JSON string, validating the
 *  fields we depend on. Throws with a clear message on malformed input. */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Service account secret is not valid JSON");
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (!key || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error("Service account JSON missing client_email or private_key");
  }
  return { client_email: key.client_email, private_key: key.private_key, token_uri: key.token_uri };
}

/** Build and RS256-sign a JWT assertion for the OAuth2 token exchange. */
function signAssertion(key: ServiceAccountKey, scope: string, nowSec: number): string {
  const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Mint a Google OAuth2 access token from a service-account key via the
 * JWT-bearer grant. `fetchImpl` is injected so callers can route through
 * ctx.http.fetch (for host tracing) and tests can stub the network.
 */
export async function mintAccessToken(
  key: ServiceAccountKey,
  fetchImpl: FetchLike,
  options: { scope?: string; nowMs?: number } = {}
): Promise<AccessToken> {
  const scope = options.scope ?? CHAT_BOT_SCOPE;
  const nowMs = options.nowMs ?? Date.now();
  const assertion = signAssertion(key, scope, Math.floor(nowMs / 1000));
  const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;

  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString()
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  let body: { access_token?: string; expires_in?: number };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Token endpoint returned non-JSON response");
  }
  if (!body.access_token) {
    throw new Error("Token endpoint response missing access_token");
  }
  const ttlSec = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return { token: body.access_token, expiresAtMs: nowMs + ttlSec * 1000 };
}
