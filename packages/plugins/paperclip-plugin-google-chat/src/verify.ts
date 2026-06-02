import { createPublicKey, createVerify, KeyObject, X509Certificate } from "node:crypto";
import type { FetchLike } from "./google-auth.js";

/**
 * Google Chat apps built as Workspace add-ons deliver a Google-issued OIDC
 * token (in the Authorization: Bearer header) signed by Google's OAuth certs.
 * Identity is asserted by the `email` claim — the add-on service account, whose
 * name embeds the project number — not by a fixed issuer service account.
 */
export const GOOGLE_OIDC_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
/** Google's public OIDC signing certs, keyed by `kid` (x509 PEM map). */
export const GOOGLE_OIDC_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";

export class InboundVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundVerificationError";
  }
}

interface DecodedJwt {
  header: { alg?: string; kid?: string };
  payload: {
    iss?: string;
    aud?: string | string[];
    email?: string;
    email_verified?: boolean;
    exp?: number;
  };
  signingInput: string;
  signature: Buffer;
}

function fromBase64url(part: string): Buffer {
  return Buffer.from(part, "base64url");
}

/** Pull the bearer token out of the Authorization header (case-insensitive). */
export function extractBearerToken(headers: Record<string, string | string[]>): string {
  let raw: string | string[] | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      raw = value;
      break;
    }
  }
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) throw new InboundVerificationError("Missing Authorization header");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new InboundVerificationError("Authorization header is not a Bearer token");
  return match[1];
}

/** Split and base64url-decode a compact JWT. Does not verify the signature. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new InboundVerificationError("Malformed JWT");
  try {
    return {
      header: JSON.parse(fromBase64url(parts[0]).toString("utf8")),
      payload: JSON.parse(fromBase64url(parts[1]).toString("utf8")),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: fromBase64url(parts[2])
    };
  } catch {
    throw new InboundVerificationError("JWT segments are not valid base64url JSON");
  }
}

export interface VerifyOptions {
  /** The add-on service account email expected in the token's `email` claim. */
  expectedEmail: string;
  /** Optional: if set, the token `aud` must equal this (the app's HTTP URL). */
  expectedAudience?: string;
  nowMs?: number;
}

/**
 * Verify a decoded Google OIDC token against a public key and the expected
 * add-on identity. Pure (no I/O) so signature + claim logic is unit-testable.
 * Throws InboundVerificationError on any failure.
 */
export function verifyJwtWithKey(
  token: string,
  publicKey: KeyObject,
  options: VerifyOptions
): DecodedJwt["payload"] {
  const decoded = decodeJwt(token);
  if (decoded.header.alg !== "RS256") {
    throw new InboundVerificationError(`Unexpected JWT alg "${decoded.header.alg}"`);
  }
  const valid = createVerify("RSA-SHA256")
    .update(decoded.signingInput)
    .verify(publicKey, decoded.signature);
  if (!valid) throw new InboundVerificationError("JWT signature does not verify");

  if (!decoded.payload.iss || !GOOGLE_OIDC_ISSUERS.includes(decoded.payload.iss)) {
    throw new InboundVerificationError(`Unexpected issuer "${decoded.payload.iss}"`);
  }
  if (decoded.payload.email !== options.expectedEmail || decoded.payload.email_verified !== true) {
    throw new InboundVerificationError(
      `Unexpected sender email "${decoded.payload.email}", expected "${options.expectedEmail}"`
    );
  }
  if (options.expectedAudience) {
    const aud = decoded.payload.aud;
    const audMatches = Array.isArray(aud)
      ? aud.includes(options.expectedAudience)
      : aud === options.expectedAudience;
    if (!audMatches) {
      throw new InboundVerificationError(
        `JWT audience mismatch: received ${JSON.stringify(aud)}, expected "${options.expectedAudience}"`
      );
    }
  }
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (typeof decoded.payload.exp !== "number" || decoded.payload.exp < nowSec) {
    throw new InboundVerificationError("JWT is expired or missing exp");
  }
  return decoded.payload;
}

/** Convert a PEM X.509 certificate (as served by Google) to its public key. */
export function certToPublicKey(pem: string): KeyObject {
  return createPublicKey(new X509Certificate(pem).publicKey.export({ type: "spki", format: "pem" }));
}

/** In-process cert cache: certs are stable, so refresh hourly at most. */
let certCache: { fetchedAtMs: number; certs: Record<string, string> } | null = null;
const CERT_TTL_MS = 60 * 60 * 1000;

async function fetchGoogleCerts(
  fetchImpl: FetchLike,
  nowMs: number
): Promise<Record<string, string>> {
  if (certCache && nowMs - certCache.fetchedAtMs < CERT_TTL_MS) {
    return certCache.certs;
  }
  const res = await fetchImpl(GOOGLE_OIDC_CERTS_URL, { method: "GET" });
  if (!res.ok) {
    throw new InboundVerificationError(`Failed to fetch Google OIDC certs (${res.status})`);
  }
  const certs = (await res.json()) as Record<string, string>;
  certCache = { fetchedAtMs: nowMs, certs };
  return certs;
}

/**
 * Verify that an inbound request genuinely came from Google Chat: extract the
 * bearer token, fetch Google's OIDC certs, and validate signature + claims.
 * Throws InboundVerificationError on any failure (caller should respond 401).
 */
export async function verifyInboundRequest(
  headers: Record<string, string | string[]>,
  fetchImpl: FetchLike,
  options: VerifyOptions
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const token = extractBearerToken(headers);
  const { header } = decodeJwt(token);
  if (!header.kid) throw new InboundVerificationError("JWT header missing kid");

  const certs = await fetchGoogleCerts(fetchImpl, nowMs);
  const pem = certs[header.kid];
  if (!pem) throw new InboundVerificationError(`No Google cert for kid "${header.kid}"`);

  verifyJwtWithKey(token, certToPublicKey(pem), { ...options, nowMs });
}

/** Test-only: reset the module cert cache. */
export function __resetCertCache(): void {
  certCache = null;
}
