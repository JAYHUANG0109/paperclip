import { describe, expect, it, vi } from "vitest";
import {
  ODOO_FALLBACK_URL,
  ODOO_OFFICIAL_URL,
  buildAuthenticateCall,
  buildOdooConnectionFile,
  isValidOdooApiKey,
  isValidOdooLogin,
  maskOdooKey,
  parseAuthenticateResponse,
  probeOdoo,
  resolveOdooTarget,
} from "./agent-odoo.js";

const uidXml = (uid: number) =>
  `<?xml version='1.0'?><methodResponse><params><param><value><int>${uid}</int></value></param></params></methodResponse>`;
const denied =
  "<?xml version='1.0'?><methodResponse><params><param><value><boolean>0</boolean></value></param></params></methodResponse>";
const faultXml = (msg: string) =>
  `<?xml version='1.0'?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>1</int></value></member><member><name>faultString</name><value><string>${msg}</string></value></member></struct></value></fault></methodResponse>`;

const ok = (body: string) => ({ ok: true, status: 200, text: async () => body }) as unknown as Response;

describe("odoo credential validation", () => {
  it("accepts a work-email login and rejects blanks/spaces", () => {
    expect(isValidOdooLogin("betty@seasonart.org")).toBe(true);
    expect(isValidOdooLogin("  betty@seasonart.org ")).toBe(true);
    expect(isValidOdooLogin("betty")).toBe(false);
    expect(isValidOdooLogin("")).toBe(false);
    expect(isValidOdooLogin("bet ty@seasonart.org")).toBe(false);
  });

  it("rejects keys too short to be an Odoo API key", () => {
    expect(isValidOdooApiKey("0123456789abcdef")).toBe(true);
    expect(isValidOdooApiKey("short")).toBe(false);
    expect(isValidOdooApiKey("0123456789 abcdef")).toBe(false);
  });

  it("never exposes more than the last 4 of a key", () => {
    expect(maskOdooKey("abcdefghijklmnop")).toBe("abc…mnop");
    expect(maskOdooKey("abc")).toBe("…");
    expect(maskOdooKey("")).toBe("…");
  });
});

describe("XML-RPC authenticate", () => {
  it("escapes the login and key into the request body", () => {
    const xml = buildAuthenticateCall("eip", "a&b@x.org", "k<ey>");
    expect(xml).toContain("<string>a&amp;b@x.org</string>");
    expect(xml).toContain("<string>k&lt;ey&gt;</string>");
    expect(xml).toContain("<methodName>authenticate</methodName>");
  });

  it("reads a uid, treats boolean-0 as denied, and throws on a fault", () => {
    expect(parseAuthenticateResponse(uidXml(744))).toBe(744);
    expect(parseAuthenticateResponse(denied)).toBeNull();
    expect(() => parseAuthenticateResponse(faultXml("database \"eip\" does not exist"))).toThrow(/does not exist/);
  });

  it("turns a non-2xx and a network error into a recorded error, not a throw", async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "" } as unknown as Response);
    await expect(probeOdoo(ODOO_OFFICIAL_URL, "eip", "b@x.org", "k".repeat(20), bad)).resolves.toMatchObject({
      uid: null,
      error: "HTTP 502",
    });
    const boom = vi.fn().mockRejectedValue(new Error("timed out"));
    await expect(probeOdoo(ODOO_OFFICIAL_URL, "eip", "b@x.org", "k".repeat(20), boom)).resolves.toMatchObject({
      uid: null,
      error: "timed out",
    });
  });
});

describe("resolveOdooTarget", () => {
  it("picks test-eip when the key authenticates there, not the first db tried", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      return ok(body.includes("<string>test-eip</string>") ? uidXml(96) : denied);
    }) as unknown as typeof fetch;
    const { target, attempts } = await resolveOdooTarget("frank@seasonart.org", "k".repeat(20), { fetchImpl });
    expect(target).toMatchObject({ url: ODOO_OFFICIAL_URL, db: "test-eip", uid: 96 });
    // eip was tried first and rejected — the probe is what distinguishes them.
    expect(attempts[0]).toMatchObject({ db: "eip", uid: null });
  });

  it("stops at the first success without probing the 備援", async () => {
    const fetchImpl = vi.fn(async () => ok(uidXml(7))) as unknown as typeof fetch;
    const { target, attempts } = await resolveOdooTarget("betty@seasonart.org", "k".repeat(20), { fetchImpl });
    expect(target).toMatchObject({ url: ODOO_OFFICIAL_URL, db: "eip", uid: 7 });
    expect(attempts).toHaveLength(1);
  });

  it("falls through to the 備援 host when the official one is down", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith(ODOO_FALLBACK_URL) ? ok(uidXml(12)) : ok(denied),
    ) as unknown as typeof fetch;
    const { target } = await resolveOdooTarget("carter@seasonart.org", "k".repeat(20), { fetchImpl });
    expect(target).toMatchObject({ url: ODOO_FALLBACK_URL, uid: 12 });
  });

  it("returns no target for a dead key, with every attempt recorded", async () => {
    const fetchImpl = vi.fn(async () => ok(denied)) as unknown as typeof fetch;
    const { target, attempts } = await resolveOdooTarget("a0000807@seasonart.org", "k".repeat(20), { fetchImpl });
    expect(target).toBeNull();
    expect(attempts).toHaveLength(4); // 2 hosts × 2 databases
  });
});

describe("buildOdooConnectionFile", () => {
  it("writes the probed target first and the other host as fallback on the same db", () => {
    const cfg = buildOdooConnectionFile({
      login: "frank@seasonart.org",
      apiKey: "k".repeat(20),
      url: ODOO_OFFICIAL_URL,
      db: "test-eip",
      readOnly: true,
    }) as { login: string; readOnly: boolean; connections: Array<{ name: string; url: string; db: string; apiKey: string }> };
    expect(cfg.login).toBe("frank@seasonart.org");
    expect(cfg.readOnly).toBe(true);
    expect(cfg.connections.map((c) => [c.url, c.db])).toEqual([
      [ODOO_OFFICIAL_URL, "test-eip"],
      [ODOO_FALLBACK_URL, "test-eip"],
    ]);
    expect(cfg.connections.every((c) => c.apiKey === "k".repeat(20))).toBe(true);
  });
});
