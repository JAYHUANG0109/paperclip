import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { SEND_SPACE_TOOL } from "../src/manifest.js";
import plugin from "../src/worker.js";

/**
 * All 46 agents share one bot identity, so the tool gateway granting an agent
 * `send_chat_space_message` is not by itself enough: without a membership check any agent
 * could post into any room the bot belongs to, including rooms its own person is not in.
 * An agent speaks for exactly one person and may only post where that person already is.
 *
 * Google will not tell an app the emails of a space's members — app auth returns opaque
 * `users/{numeric id}` values — so the check compares against the id the plugin learned
 * for that person from their own inbound messages. When that id is unknown, or the roster
 * cannot be read, the send must fail closed.
 */

function makeServiceAccountJson(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    type: "service_account",
    client_email: "bot@test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const AGENT = "agent-1";
const COMPANY = "co1";
const OWNER = "owner@example.org";
const OWNER_ID = "users/111111111111111111111";
const SPACE = "spaces/ROOM";

/**
 * Seed the state the check depends on: which person this agent speaks for, that person's
 * learned Chat id, and a space index containing the target room.
 */
async function seed(harness: Awaited<ReturnType<typeof createTestHarness>>, opts: { withOwnerId: boolean }) {
  await harness.ctx.state.set(
    { scopeKind: "instance", stateKey: "agent-assignments" },
    { [OWNER]: { email: OWNER, agentId: AGENT, agentName: "Owner's Agent" } },
  );
  if (opts.withOwnerId) {
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: `dm-space:${OWNER}` },
      { userName: OWNER_ID, spaceName: "spaces/DM" },
    );
  }
  await harness.ctx.state.set(
    { scopeKind: "instance", stateKey: "chat-spaces" },
    [{ spaceName: SPACE, displayName: "領導團隊", lastSeenAt: "2026-08-01T00:00:00.000Z" }],
  );
}

function harnessWith(members: { id: string; type?: string }[] | null) {
  const harness = createTestHarness({
    manifest,
    config: { serviceAccountSecretRef: "sa-ref", echoMode: false, verifyInbound: false },
  });
  harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());
  const sends: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("oauth2.googleapis.com")) return jsonResponse({ access_token: "ya29.test", expires_in: 3600 });
    if (url.includes("/members")) {
      if (members === null) return jsonResponse({ error: "nope" }, 403);
      return jsonResponse({
        memberships: members.map((m) => ({ member: { name: m.id, type: m.type ?? "HUMAN" } })),
      });
    }
    if (url.includes("/messages")) {
      sends.push(url);
      return jsonResponse({ name: `${SPACE}/messages/x` });
    }
    return jsonResponse({});
  });
  harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;
  return { harness, sends };
}

describe("send_chat_space_message — owner must be in the space", () => {
  it("posts when the agent's person is a member of the room", async () => {
    const { harness, sends } = harnessWith([{ id: OWNER_ID }, { id: "users/999" }]);
    await seed(harness, { withOwnerId: true });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool(SEND_SPACE_TOOL, { space: "領導團隊", text: "hello" }, {
      agentId: AGENT,
      companyId: COMPANY,
    });

    expect(result.error).toBeUndefined();
    expect(sends.length).toBe(1);
  });

  it("refuses when the agent's person is NOT a member — the whole point", async () => {
    const { harness, sends } = harnessWith([{ id: "users/999" }, { id: "users/888" }]);
    await seed(harness, { withOwnerId: true });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool(SEND_SPACE_TOOL, { space: "領導團隊", text: "hello" }, {
      agentId: AGENT,
      companyId: COMPANY,
    });

    expect(result.error).toContain(OWNER);
    expect(sends.length).toBe(0);
  });

  it("fails closed when the person's Chat id was never learned", async () => {
    // Google does not expose member emails, so with no learned id membership is unprovable.
    const { harness, sends } = harnessWith([{ id: OWNER_ID }]);
    await seed(harness, { withOwnerId: false });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool(SEND_SPACE_TOOL, { space: "領導團隊", text: "hello" }, {
      agentId: AGENT,
      companyId: COMPANY,
    });

    expect(result.error).toBeTruthy();
    expect(sends.length).toBe(0);
  });

  it("fails closed when the roster cannot be read", async () => {
    const { harness, sends } = harnessWith(null);
    await seed(harness, { withOwnerId: true });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool(SEND_SPACE_TOOL, { space: "領導團隊", text: "hello" }, {
      agentId: AGENT,
      companyId: COMPANY,
    });

    expect(result.error).toBeTruthy();
    expect(sends.length).toBe(0);
  });

  it("ignores non-HUMAN members when matching, so a bot id cannot stand in for a person", async () => {
    const { harness, sends } = harnessWith([{ id: OWNER_ID, type: "BOT" }]);
    await seed(harness, { withOwnerId: true });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool(SEND_SPACE_TOOL, { space: "領導團隊", text: "hello" }, {
      agentId: AGENT,
      companyId: COMPANY,
    });

    expect(result.error).toBeTruthy();
    expect(sends.length).toBe(0);
  });
});
