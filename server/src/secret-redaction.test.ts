import { describe, it, expect } from "vitest";
import { redactSecretsText, redactSecretsValue } from "./secret-redaction.js";

describe("redactSecretsText", () => {
  it("redacts vendor token shapes", () => {
    const cases: Array<[string, string]> = [
      ["key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA done", "anthropic-key"],
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"],
      ["AIzaSyA1234567890abcdefghijklmnopqrstuvw", "google-api-key"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
      ["xoxb-1234567890-abcdefghijkl", "slack-token"],
      ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV", "jwt"],
      ["Authorization: Bearer abcdef0123456789ABCDEF", "bearer"],
    ];
    for (const [input, kind] of cases) {
      const out = redactSecretsText(input);
      expect(out, input).toContain(`[REDACTED:${kind}]`);
    }
  });

  it("redacts secret-named assignments (the realistic Odoo/Asana key case)", () => {
    const odoo = '{"apiKey":"5856a2b0362688e855c9bc3576359984b7553fe1"}';
    const out = redactSecretsText(odoo);
    expect(out).toContain("[REDACTED:secret]");
    expect(out).not.toContain("5856a2b0362688e855c9bc3576359984b7553fe1");

    expect(redactSecretsText("password: hunter2hunter2")).toContain("[REDACTED:secret]");
    expect(redactSecretsText("access_token=ya29.aVeryLongOAuthTokenValue123")).toContain("[REDACTED:secret]");
    // The label is preserved, only the value is scrubbed.
    expect(redactSecretsText("api_key: SUPERSECRETVALUE12345")).toMatch(/api_key:\s*\[REDACTED:secret\]/i);
  });

  it("does NOT over-redact bare git SHAs / hashes / UUIDs (precision guard)", () => {
    const sha = "0236d40d0abcdef0123456789abcdef012345678"; // 40-hex, no secret context
    expect(redactSecretsText(`deploying ${sha} now`)).toBe(`deploying ${sha} now`);
    const uuid = "0980d089-ebdf-4f54-9576-1a9150c5d6f9";
    expect(redactSecretsText(`company ${uuid}`)).toBe(`company ${uuid}`);
    expect(redactSecretsText("plain log line, nothing secret")).toBe("plain log line, nothing secret");
  });
});

describe("redactSecretsValue", () => {
  it("recurses over objects and arrays, preserving shape", () => {
    const input = {
      content: "used Bearer abcdef0123456789ABCDEF to call",
      nested: { list: ['{"apiKey":"5856a2b0362688e855c9bc3576359984b7553fe1"}', "safe"] },
      count: 3,
      flag: true,
    };
    const out = redactSecretsValue(input);
    expect(out.content).toContain("[REDACTED:bearer]");
    expect(out.nested.list[0]).toContain("[REDACTED:secret]");
    expect(out.nested.list[1]).toBe("safe");
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
  });

  it("passes through untouched when disabled", () => {
    const input = { content: "Bearer abcdef0123456789ABCDEF" };
    expect(redactSecretsValue(input, { enabled: false })).toBe(input);
  });
});
