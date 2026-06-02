import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  __resetCertCache,
  extractBearerToken,
  InboundVerificationError,
  verifyInboundRequest,
  verifyJwtWithKey
} from "../src/verify.js";

const SENDER_EMAIL = "service-455778754146@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
const APP_URL = "https://jays-macbook-pro.tailacdc6f.ts.net/api/plugins/paperclip-plugin-google-chat/webhooks/google-chat-events";
const NOW_MS = 1_780_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Build a compact JWT signed with `privateKeyPem` (RS256 by default). */
function makeJwt(opts: {
  privateKeyPem: string | KeyObject;
  payload: Record<string, unknown>;
  kid?: string;
  alg?: string;
}): string {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid }));
  const payload = b64url(JSON.stringify(opts.payload));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(opts.privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

const validPayload = {
  iss: "https://accounts.google.com",
  aud: APP_URL,
  email: SENDER_EMAIL,
  email_verified: true,
  exp: NOW_SEC + 300
};

describe("extractBearerToken", () => {
  it("reads the token regardless of header casing or array values", () => {
    expect(extractBearerToken({ Authorization: "Bearer abc" })).toBe("abc");
    expect(extractBearerToken({ authorization: ["Bearer xyz"] })).toBe("xyz");
  });
  it("throws when absent or malformed", () => {
    expect(() => extractBearerToken({})).toThrow(InboundVerificationError);
    expect(() => extractBearerToken({ authorization: "Basic abc" })).toThrow(/Bearer/);
  });
});

describe("verifyJwtWithKey", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("accepts a correctly signed token from the expected add-on sender", () => {
    const jwt = makeJwt({ privateKeyPem: pem, payload: validPayload });
    const payload = verifyJwtWithKey(jwt, publicKey, { expectedEmail: SENDER_EMAIL, nowMs: NOW_MS });
    expect(payload.email).toBe(SENDER_EMAIL);
  });

  it("enforces audience only when expectedAudience is provided", () => {
    const jwt = makeJwt({ privateKeyPem: pem, payload: validPayload });
    expect(() =>
      verifyJwtWithKey(jwt, publicKey, { expectedEmail: SENDER_EMAIL, expectedAudience: APP_URL, nowMs: NOW_MS })
    ).not.toThrow();
    expect(() =>
      verifyJwtWithKey(jwt, publicKey, { expectedEmail: SENDER_EMAIL, expectedAudience: "https://evil/", nowMs: NOW_MS })
    ).toThrow(/audience/);
  });

  it("rejects a token signed by a different key", () => {
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = makeJwt({ privateKeyPem: attacker.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), payload: validPayload });
    expect(() => verifyJwtWithKey(jwt, publicKey, { expectedEmail: SENDER_EMAIL, nowMs: NOW_MS })).toThrow(/signature/);
  });

  it("rejects wrong email, unverified email, issuer, expiry, and alg", () => {
    const sign = (payload: Record<string, unknown>, alg?: string) => makeJwt({ privateKeyPem: pem, payload, alg });
    const opts = { expectedEmail: SENDER_EMAIL, nowMs: NOW_MS };

    expect(() => verifyJwtWithKey(sign({ ...validPayload, email: "evil@x" }), publicKey, opts)).toThrow(/sender email/);
    expect(() => verifyJwtWithKey(sign({ ...validPayload, email_verified: false }), publicKey, opts)).toThrow(/sender email/);
    expect(() => verifyJwtWithKey(sign({ ...validPayload, iss: "https://evil" }), publicKey, opts)).toThrow(/issuer/);
    expect(() => verifyJwtWithKey(sign({ ...validPayload, exp: NOW_SEC - 10 }), publicKey, opts)).toThrow(/expired/);
    expect(() => verifyJwtWithKey(sign(validPayload, "none"), publicKey, opts)).toThrow(/alg/);
  });
});

describe("verifyInboundRequest (cert fetch path)", () => {
  // Generate a self-signed X.509 cert via openssl so the full cert→key path runs.
  let dir: string | null = null;
  let certPem = "";
  let keyPem = "";
  let openssl = true;

  beforeAll(() => {
    try {
      dir = mkdtempSync(join(tmpdir(), "gchat-verify-"));
      const keyPath = join(dir, "key.pem");
      const certPath = join(dir, "cert.pem");
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath,
        "-days", "1", "-subj", "/CN=oidc-test"
      ], { stdio: "ignore" });
      keyPem = readFileSync(keyPath, "utf8");
      certPem = readFileSync(certPath, "utf8");
    } catch {
      openssl = false; // environment without openssl — skip the cert-path test
    }
    __resetCertCache();
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("verifies a genuine signed request end-to-end", async () => {
    if (!openssl) return; // gracefully skip
    const jwt = makeJwt({ privateKeyPem: keyPem, payload: validPayload, kid: "kid-1" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ "kid-1": certPem }), { status: 200 }));
    await expect(
      verifyInboundRequest({ authorization: `Bearer ${jwt}` }, fetchMock, { expectedEmail: SENDER_EMAIL, nowMs: NOW_MS })
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects when no cert matches the kid", async () => {
    if (!openssl) return;
    __resetCertCache();
    const jwt = makeJwt({ privateKeyPem: keyPem, payload: validPayload, kid: "unknown-kid" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ "kid-1": certPem }), { status: 200 }));
    await expect(
      verifyInboundRequest({ authorization: `Bearer ${jwt}` }, fetchMock, { expectedEmail: SENDER_EMAIL, nowMs: NOW_MS })
    ).rejects.toThrow(/No Google cert/);
  });
});
