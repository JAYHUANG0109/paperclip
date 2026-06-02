import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { WEBHOOK_KEY } from "../src/manifest.js";
import plugin from "../src/worker.js";
import { extractInboundMessage, findDirectMessageSpace } from "../src/chat.js";
import { latestAgentReply } from "../src/routing.js";
import { SEND_DM_TOOL } from "../src/manifest.js";
import { mintAccessToken, parseServiceAccountKey } from "../src/google-auth.js";

/** A throwaway RSA service-account key so the real RS256 signing path runs. */
function makeServiceAccountJson(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    type: "service_account",
    client_email: "bot@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: "https://oauth2.googleapis.com/token"
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/** Workspace add-on MESSAGE event shape, mirroring a real Google delivery. */
const ADDON_MESSAGE_EVENT = {
  commonEventObject: { hostApp: "CHAT" },
  chat: {
    user: { displayName: "Jay", email: "jay@example.org" },
    messagePayload: {
      space: { name: "spaces/AAAA", type: "DM" },
      message: {
        name: "spaces/AAAA/messages/123",
        text: "hello there",
        thread: { name: "spaces/AAAA/threads/T1" },
        sender: { displayName: "Jay", email: "jay@example.org" }
      }
    }
  }
};

describe("manifest", () => {
  it("declares the inbound webhook and required capabilities", () => {
    expect(manifest.webhooks?.[0]?.endpointKey).toBe(WEBHOOK_KEY);
    for (const cap of ["webhooks.receive", "http.outbound", "secrets.read-ref"]) {
      expect(manifest.capabilities).toContain(cap);
    }
  });
});

describe("chat event parsing", () => {
  it("extracts the reply target from a Workspace add-on MESSAGE event", () => {
    const inbound = extractInboundMessage(ADDON_MESSAGE_EVENT)!;
    expect(inbound.spaceName).toBe("spaces/AAAA");
    expect(inbound.threadName).toBe("spaces/AAAA/threads/T1");
    expect(inbound.text).toBe("hello there");
    expect(inbound.senderDisplayName).toBe("Jay");
  });

  it("also parses the classic Chat MESSAGE format", () => {
    const inbound = extractInboundMessage({
      type: "MESSAGE",
      space: { name: "spaces/BBBB" },
      message: { text: "hi", thread: { name: "spaces/BBBB/threads/T2" } }
    })!;
    expect(inbound.spaceName).toBe("spaces/BBBB");
    expect(inbound.text).toBe("hi");
  });

  it("ignores non-message events", () => {
    expect(extractInboundMessage({ chat: { addedToSpacePayload: {} } })).toBeNull();
    expect(extractInboundMessage({ type: "ADDED_TO_SPACE" })).toBeNull();
    expect(extractInboundMessage({ noType: true })).toBeNull();
  });
});

describe("latestAgentReply", () => {
  it("prefers the most recent agent comment", () => {
    const reply = latestAgentReply([
      { authorType: "user", body: "q", createdAt: "2026-06-01T00:00:00Z" },
      { authorType: "agent", body: "first", createdAt: "2026-06-01T00:00:01Z" },
      { authorType: "agent", body: "final", createdAt: "2026-06-01T00:00:09Z" }
    ]);
    expect(reply).toBe("final");
  });
  it("returns null when there are no usable comments", () => {
    expect(latestAgentReply([])).toBeNull();
  });
});

describe("google-auth", () => {
  it("signs a JWT and exchanges it for an access token", async () => {
    const key = parseServiceAccountKey(makeServiceAccountJson());
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ access_token: "ya29.test", expires_in: 3600 })
    );
    const token = await mintAccessToken(key, fetchMock, { nowMs: 1_000_000 });

    expect(token.token).toBe("ya29.test");
    expect(token.expiresAtMs).toBe(1_000_000 + 3600 * 1000);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(String(init?.body)).toContain("grant_type=urn");
    expect(String(init?.body)).toContain("assertion=");
  });

  it("throws on a failed token exchange", async () => {
    const key = parseServiceAccountKey(makeServiceAccountJson());
    const fetchMock = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400));
    await expect(mintAccessToken(key, fetchMock)).rejects.toThrow(/Token exchange failed/);
  });
});

describe("worker echo flow", () => {
  it("mints a token and posts an echo reply to the message's space", async () => {
    const harness = createTestHarness({
      manifest,
      config: { serviceAccountSecretRef: "sa-ref", echoMode: true, verifyInbound: false }
    });

    harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return jsonResponse({ access_token: "ya29.test", expires_in: 3600 });
      }
      return jsonResponse({ name: "spaces/AAAA/messages/456" });
    });
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;

    await plugin.definition.setup(harness.ctx);
    await plugin.definition.onWebhook!({
      endpointKey: WEBHOOK_KEY,
      headers: { "content-type": "application/json" },
      rawBody: JSON.stringify(ADDON_MESSAGE_EVENT),
      parsedBody: ADDON_MESSAGE_EVENT,
      requestId: "req-1"
    });

    const sendCall = fetchMock.mock.calls.find(([u]) => u.includes("chat.googleapis.com"));
    expect(sendCall).toBeDefined();
    const [sendUrl, sendInit] = sendCall!;
    expect(sendUrl).toBe("https://chat.googleapis.com/v1/spaces/AAAA/messages");
    expect((sendInit?.headers as Record<string, string>).Authorization).toBe("Bearer ya29.test");
    const sentBody = JSON.parse(String(sendInit?.body));
    expect(sentBody.text).toBe("echo: hello there");
    expect(sentBody.thread.name).toBe("spaces/AAAA/threads/T1");
  });

  it("routes to an agent as an issue, acks, then delivers the agent comment on done", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        serviceAccountSecretRef: "sa-ref",
        verifyInbound: false,
        echoMode: false,
        routingEnabled: true,
        gateUnassigned: false,
        companyId: "co1",
        defaultAgentUrlKey: "finance"
      }
    });

    harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());
    const chatPosts: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return jsonResponse({ access_token: "ya29.test", expires_in: 3600 });
      }
      chatPosts.push(JSON.parse(String(init?.body)).text);
      return jsonResponse({ name: "spaces/AAAA/messages/r1" });
    });
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;

    harness.ctx.agents.list = vi.fn(async () => [
      { id: "ag1", urlKey: "finance", name: "Finance" }
    ]) as unknown as typeof harness.ctx.agents.list;

    const issues = {
      create: vi.fn(async () => ({ id: "iss1" })),
      update: vi.fn(async () => ({})),
      requestWakeup: vi.fn(async () => ({})),
      listComments: vi.fn(async () => [
        { authorType: "user", body: "hello there", createdAt: "2026-06-01T00:00:00Z" },
        { authorType: "agent", body: "您好，我是您的財務 agent。", createdAt: "2026-06-01T00:00:05Z" }
      ])
    };
    harness.ctx.issues = { ...harness.ctx.issues, ...issues } as unknown as typeof harness.ctx.issues;

    await plugin.definition.setup(harness.ctx);
    await plugin.definition.onWebhook!({
      endpointKey: WEBHOOK_KEY,
      headers: {},
      rawBody: JSON.stringify(ADDON_MESSAGE_EVENT),
      parsedBody: ADDON_MESSAGE_EVENT,
      requestId: "req-route"
    });

    // Dispatched as an issue assigned to the resolved agent, with an ack posted.
    expect(issues.create).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "co1", assigneeAgentId: "ag1" })
    );
    expect(chatPosts).toContain("⏳ Working on it…");

    // Agent posts a comment → it's mirrored to Chat (the English line is not).
    await harness.emit("issue.comment.created", {}, { entityId: "iss1" });
    expect(chatPosts).toContain("您好，我是您的財務 agent。");
    expect(chatPosts).not.toContain("hello there");
  });

  it("ignores a duplicate delivery of the same message id", async () => {
    const harness = createTestHarness({
      manifest,
      config: { serviceAccountSecretRef: "sa-ref", verifyInbound: false, echoMode: true }
    });
    harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("oauth2") ? jsonResponse({ access_token: "t", expires_in: 3600 }) : jsonResponse({})
    );
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;

    await plugin.definition.setup(harness.ctx);
    const delivery = {
      endpointKey: WEBHOOK_KEY,
      headers: {},
      rawBody: JSON.stringify(ADDON_MESSAGE_EVENT),
      parsedBody: ADDON_MESSAGE_EVENT,
      requestId: "req-dup"
    };
    await plugin.definition.onWebhook!(delivery);
    await plugin.definition.onWebhook!(delivery); // retry of same message.name

    const sends = fetchMock.mock.calls.filter(([u]) => u.includes("chat.googleapis.com"));
    expect(sends).toHaveLength(1);
  });

  it("acknowledges non-message events without calling the Chat API", async () => {
    const harness = createTestHarness({
      manifest,
      config: { serviceAccountSecretRef: "sa-ref", verifyInbound: false }
    });
    const fetchMock = vi.fn(async () => jsonResponse({}));
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;
    harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());

    await plugin.definition.setup(harness.ctx);
    await plugin.definition.onWebhook!({
      endpointKey: WEBHOOK_KEY,
      headers: {},
      rawBody: JSON.stringify({ chat: { addedToSpacePayload: {} } }),
      parsedBody: { chat: { addedToSpacePayload: {} } },
      requestId: "req-2"
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsigned request when verifyInbound is on, without replying", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        serviceAccountSecretRef: "sa-ref",
        verifyInbound: true,
        senderServiceAccountEmail: "service-455778754146@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"
      }
    });
    const fetchMock = vi.fn(async () => jsonResponse({}));
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;

    await plugin.definition.setup(harness.ctx);
    await expect(
      plugin.definition.onWebhook!({
        endpointKey: WEBHOOK_KEY,
        headers: {}, // no Authorization header
        rawBody: JSON.stringify(ADDON_MESSAGE_EVENT),
        parsedBody: ADDON_MESSAGE_EVENT,
        requestId: "req-unsigned"
      })
    ).rejects.toThrow(/Authorization header/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown webhook endpoint key", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await expect(
      plugin.definition.onWebhook!({
        endpointKey: "wrong-key",
        headers: {},
        rawBody: "{}",
        parsedBody: {},
        requestId: "req-3"
      })
    ).rejects.toThrow(/Unsupported webhook endpoint/);
  });
});

describe("findDirectMessageSpace", () => {
  it("returns the DM space name on success", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "spaces/DM1" })
    );
    const space = await findDirectMessageSpace(fetchMock, "ya29.test", "users/123");
    expect(space).toBe("spaces/DM1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://chat.googleapis.com/v1/spaces:findDirectMessage?name=users%2F123"
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ya29.test");
  });

  it("returns null when no DM exists yet (404)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "not found" }, 404));
    expect(await findDirectMessageSpace(fetchMock, "t", "users/999")).toBeNull();
  });
});

describe("send_chat_message tool (DM by email)", () => {
  it("learns the sender's DM space on inbound, then messages them by email", async () => {
    const harness = createTestHarness({
      manifest,
      config: { serviceAccountSecretRef: "sa-ref", echoMode: true, verifyInbound: false }
    });
    harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes("oauth2.googleapis.com")
        ? jsonResponse({ access_token: "ya29.test", expires_in: 3600 })
        : jsonResponse({ name: "spaces/AAAA/messages/x" })
    );
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;

    await plugin.definition.setup(harness.ctx);
    // jay@example.org DMs the bot from spaces/AAAA (event type is "DM").
    await plugin.definition.onWebhook!({
      endpointKey: WEBHOOK_KEY,
      headers: {},
      rawBody: JSON.stringify(ADDON_MESSAGE_EVENT),
      parsedBody: ADDON_MESSAGE_EVENT,
      requestId: "req-learn"
    });

    const result = await harness.executeTool(SEND_DM_TOOL, {
      email: "jay@example.org",
      text: "Heads up: your report is ready."
    });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("jay@example.org");

    const dmSend = fetchMock.mock.calls.find(
      ([u, i]) =>
        u === "https://chat.googleapis.com/v1/spaces/AAAA/messages" &&
        JSON.parse(String(i?.body)).text === "Heads up: your report is ready."
    );
    expect(dmSend).toBeDefined();
  });

  it("errors for an email that has never messaged the bot, without calling Chat", async () => {
    const harness = createTestHarness({
      manifest,
      config: { serviceAccountSecretRef: "sa-ref", verifyInbound: false }
    });
    harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("oauth2.googleapis.com")
        ? jsonResponse({ access_token: "ya29.test", expires_in: 3600 })
        : jsonResponse({})
    );
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;

    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool(SEND_DM_TOOL, {
      email: "stranger@example.org",
      text: "hi"
    });
    expect(result.error).toMatch(/No known Google Chat DM/);
    expect(fetchMock.mock.calls.some(([u]) => u.includes("chat.googleapis.com"))).toBe(false);
  });
});

describe("access gating (assigned users only)", () => {
  function gatingHarness() {
    const harness = createTestHarness({
      manifest,
      config: {
        serviceAccountSecretRef: "sa-ref",
        verifyInbound: false,
        echoMode: false,
        routingEnabled: true,
        gateUnassigned: true,
        companyId: "co1"
      }
    });
    harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());
    const chatPosts: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return jsonResponse({ access_token: "ya29.test", expires_in: 3600 });
      }
      chatPosts.push(JSON.parse(String(init?.body)).text);
      return jsonResponse({ name: "spaces/AAAA/messages/r1" });
    });
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;
    harness.ctx.agents.list = vi.fn(async () => [
      { id: "ag1", urlKey: "finance", name: "Finance" }
    ]) as unknown as typeof harness.ctx.agents.list;
    const createIssue = vi.fn(async () => ({ id: "iss1" }));
    harness.ctx.issues = {
      ...harness.ctx.issues,
      create: createIssue,
      update: vi.fn(async () => ({})),
      requestWakeup: vi.fn(async () => ({}))
    } as unknown as typeof harness.ctx.issues;
    return { harness, chatPosts, createIssue };
  }

  const deliver = () =>
    plugin.definition.onWebhook!({
      endpointKey: WEBHOOK_KEY,
      headers: {},
      rawBody: JSON.stringify(ADDON_MESSAGE_EVENT),
      parsedBody: ADDON_MESSAGE_EVENT,
      requestId: "req-gate"
    });

  it("turns away an unassigned sender with the contact-IT message and creates no issue", async () => {
    const { harness, chatPosts, createIssue } = gatingHarness();
    await plugin.definition.setup(harness.ctx);
    await deliver();
    expect(createIssue).not.toHaveBeenCalled();
    expect(chatPosts.some((t) => /資訊部|IT/.test(t))).toBe(true);
  });

  it("routes an assigned sender to their agent", async () => {
    const { harness, createIssue } = gatingHarness();
    await plugin.definition.setup(harness.ctx);
    // jay@example.org is the sender in ADDON_MESSAGE_EVENT.
    await harness.performAction("assignments.set", {
      email: "jay@example.org",
      agentId: "ag1",
      companyId: "co1"
    });
    await deliver();
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "co1", assigneeAgentId: "ag1" })
    );
  });
});

describe("assignments admin (data + actions)", () => {
  it("sets, lists, and removes assignments (case-insensitive)", async () => {
    const harness = createTestHarness({
      manifest,
      config: { serviceAccountSecretRef: "sa-ref", companyId: "co1" }
    });
    harness.ctx.agents.list = vi.fn(async () => [
      { id: "ag1", urlKey: "finance", name: "Finance" }
    ]) as unknown as typeof harness.ctx.agents.list;

    await plugin.definition.setup(harness.ctx);

    const setRes = (await harness.performAction("assignments.set", {
      email: "Sinney@seasonart.org",
      agentId: "ag1",
      companyId: "co1"
    })) as { ok?: boolean };
    expect(setRes.ok).toBe(true);

    const listed = await harness.getData<{ assignments: Array<{ email: string; agentName?: string }> }>(
      "assignments",
      { companyId: "co1" }
    );
    expect(listed.assignments).toHaveLength(1);
    expect(listed.assignments[0]).toMatchObject({ email: "Sinney@seasonart.org", agentName: "Finance" });

    await harness.performAction("assignments.remove", { email: "sinney@seasonart.org" });
    const after = await harness.getData<{ assignments: unknown[] }>("assignments", { companyId: "co1" });
    expect(after.assignments).toHaveLength(0);
  });

  it("rejects assigning to an agent that doesn't exist", async () => {
    const harness = createTestHarness({
      manifest,
      config: { serviceAccountSecretRef: "sa-ref", companyId: "co1" }
    });
    harness.ctx.agents.list = vi.fn(async () => []) as unknown as typeof harness.ctx.agents.list;
    await plugin.definition.setup(harness.ctx);
    const res = (await harness.performAction("assignments.set", {
      email: "x@seasonart.org",
      agentId: "ghost",
      companyId: "co1"
    })) as { ok?: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no longer exists/);
  });
});

describe("comment mirroring to Chat", () => {
  // Seed a chat-target for issue "iss1" and capture every text posted to Chat.
  async function mirrorHarness(comments: unknown[]) {
    const harness = createTestHarness({
      manifest,
      config: { serviceAccountSecretRef: "sa-ref", verifyInbound: false }
    });
    harness.ctx.secrets.resolve = vi.fn(async () => makeServiceAccountJson());
    const chatPosts: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return jsonResponse({ access_token: "ya29.test", expires_in: 3600 });
      }
      chatPosts.push(JSON.parse(String(init?.body)).text);
      return jsonResponse({ name: "spaces/AAAA/messages/x" });
    });
    harness.ctx.http.fetch = fetchMock as typeof harness.ctx.http.fetch;
    harness.ctx.issues = {
      ...harness.ctx.issues,
      listComments: vi.fn(async () => comments)
    } as unknown as typeof harness.ctx.issues;

    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: "chat-task:iss1" },
      { spaceName: "spaces/AAAA", threadName: "spaces/AAAA/threads/T1", companyId: "co1", senderEmail: "jay@example.org" }
    );
    const fire = () => harness.emit("issue.comment.created", {}, { entityId: "iss1" });
    return { harness, chatPosts, fire };
  }

  it("forwards Chinese answers (even mis-attributed) but filters English notes + system_notice", async () => {
    const { chatPosts, fire } = await mirrorHarness([
      // The real answer, posted via the API → mis-attributed to "local-board".
      // Must STILL be forwarded (this is the bug we fixed).
      { id: "c1", authorType: "local-board", body: "先看一下資料，總部代辦品…", createdAt: "2026-06-02T00:00:01Z" },
      { id: "c2", authorType: "agent", body: "GC 批次摘要：已採購 10 筆", createdAt: "2026-06-02T00:00:02Z", presentation: { kind: "message" } },
      // English heartbeat self-talk attributed to "agent" → must be filtered.
      { id: "c3", authorType: "agent", body: "Wake comment is an acknowledgement. SEAAA-22 stays blocked. Exiting heartbeat.", createdAt: "2026-06-02T00:00:03Z" },
      { id: "c4", authorType: "agent", body: "系統狀態變更", createdAt: "2026-06-02T00:00:04Z", presentation: { kind: "system_notice" } }
    ]);
    await fire();
    expect(chatPosts.some((t) => t.includes("先看一下資料"))).toBe(true);
    expect(chatPosts.some((t) => t.includes("GC 批次摘要"))).toBe(true);
    expect(chatPosts.some((t) => /Exiting heartbeat|stays blocked/.test(t))).toBe(false);
    expect(chatPosts).not.toContain("系統狀態變更"); // system_notice filtered
  });

  it("is idempotent across repeated events and de-dups identical bodies", async () => {
    const comments = [
      { id: "a1", authorType: "agent", body: "歷史銷售結果", createdAt: "2026-06-02T00:00:01Z" }
    ];
    const { chatPosts, fire, harness } = await mirrorHarness(comments);
    await fire();
    await fire(); // retry / another comment event for the same issue
    expect(chatPosts.filter((t) => t === "歷史銷售結果")).toHaveLength(1);

    // A second comment with an identical body (agent reposted) is not re-sent.
    (harness.ctx.issues.listComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...comments,
      { id: "a2", authorType: "agent", body: "歷史銷售結果", createdAt: "2026-06-02T00:00:09Z" }
    ]);
    await fire();
    expect(chatPosts.filter((t) => t === "歷史銷售結果")).toHaveLength(1);
  });

  it("renders a markdown table as a monospace code block when mirroring", async () => {
    const body = ["# 結果", "| 單號 | 狀態 |", "| --- | --- |", "| GC/00002 | purchased |"].join("\n");
    const { chatPosts, fire } = await mirrorHarness([
      { id: "t1", authorType: "agent", body, createdAt: "2026-06-02T00:00:01Z" }
    ]);
    await fire();
    expect(chatPosts.some((t) => t.includes("```") && t.includes("purchased"))).toBe(true);
  });
});
