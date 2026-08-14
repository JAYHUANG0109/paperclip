import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveSecurityPosture, getConfiguredPosture } from "./security-posture.js";

const KEYS = [
  "PAPERCLIP_SECURITY_POSTURE",
  "PAPERCLIP_RESTRICT_AGENT_VISIBILITY",
  "PAPERCLIP_TRANSCRIPT_SECRET_REDACTION",
  "PAPERCLIP_EGRESS_ENFORCE",
];

describe("security posture resolver", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("no posture + no flags = legacy defaults (nothing on) — backward compatible", () => {
    const r = resolveSecurityPosture();
    expect(r).toEqual({
      posture: null,
      egressEnforcement: "log",
      agentVisibilityRestricted: false,
      transcriptSecretRedaction: false,
    });
  });

  it("trusted keeps everything off/log", () => {
    process.env.PAPERCLIP_SECURITY_POSTURE = "trusted";
    const r = resolveSecurityPosture();
    expect(r.agentVisibilityRestricted).toBe(false);
    expect(r.transcriptSecretRedaction).toBe(false);
    expect(r.egressEnforcement).toBe("log");
  });

  it("standard bundles visibility + redaction on, egress still log", () => {
    process.env.PAPERCLIP_SECURITY_POSTURE = "standard";
    const r = resolveSecurityPosture();
    expect(r.agentVisibilityRestricted).toBe(true);
    expect(r.transcriptSecretRedaction).toBe(true);
    expect(r.egressEnforcement).toBe("log");
  });

  it("strict adds egress enforcement on top", () => {
    process.env.PAPERCLIP_SECURITY_POSTURE = "strict";
    const r = resolveSecurityPosture();
    expect(r.agentVisibilityRestricted).toBe(true);
    expect(r.transcriptSecretRedaction).toBe(true);
    expect(r.egressEnforcement).toBe("enforce");
  });

  it("explicit per-lever env overrides the posture bundle", () => {
    process.env.PAPERCLIP_SECURITY_POSTURE = "strict";
    process.env.PAPERCLIP_TRANSCRIPT_SECRET_REDACTION = "false";
    process.env.PAPERCLIP_EGRESS_ENFORCE = "false";
    const r = resolveSecurityPosture();
    expect(r.transcriptSecretRedaction).toBe(false); // explicit off wins over strict
    expect(r.egressEnforcement).toBe("log"); // explicit off wins over strict
    expect(r.agentVisibilityRestricted).toBe(true); // still from strict bundle
  });

  it("explicit env works with no posture set", () => {
    process.env.PAPERCLIP_TRANSCRIPT_SECRET_REDACTION = "true";
    const r = resolveSecurityPosture();
    expect(r.transcriptSecretRedaction).toBe(true);
    expect(r.posture).toBeNull();
  });

  it("an unrecognised posture value is treated as unset (legacy)", () => {
    process.env.PAPERCLIP_SECURITY_POSTURE = "paranoid";
    expect(getConfiguredPosture()).toBeNull();
    expect(resolveSecurityPosture().transcriptSecretRedaction).toBe(false);
  });
});
