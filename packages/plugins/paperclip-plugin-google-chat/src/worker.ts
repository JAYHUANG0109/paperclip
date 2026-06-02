import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginWebhookInput, ToolResult } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, SEND_DM_TOOL, WEBHOOK_KEY } from "./manifest.js";
import {
  type AccessToken,
  mintAccessToken,
  parseServiceAccountKey
} from "./google-auth.js";
import { extractInboundMessage, type InboundMessage, sendMessage } from "./chat.js";
import { rememberDmTarget, resolveDmSpace } from "./dm.js";
import {
  type AgentAssignment,
  getAssignment,
  listAssignments,
  removeAssignment,
  setAssignment
} from "./assignments.js";
import { formatForChat } from "./format.js";
import { commentSignature, orderedForwardable } from "./mirror.js";
import { verifyInboundRequest } from "./verify.js";
import {
  dispatchToAgent,
  getChatTarget,
  resolveAgentId,
  resolveCompanyId
} from "./routing.js";

interface GoogleChatConfig {
  serviceAccountSecretRef: string;
  echoMode: boolean;
  verifyInbound: boolean;
  senderServiceAccountEmail: string;
  expectedAudience: string;
  routingEnabled: boolean;
  companyId: string;
  defaultAgentUrlKey: string;
  gateUnassigned: boolean;
  unassignedMessage: string;
}

/** Set during setup() so the context-less onWebhook handler can reach host APIs. */
let currentContext: PluginContext | null = null;

/** In-process access-token cache; refreshed when within 60s of expiry. */
let cachedToken: AccessToken | null = null;

async function getConfig(ctx: PluginContext): Promise<GoogleChatConfig> {
  const raw = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(raw as Partial<GoogleChatConfig>) };
}

/** Resolve a valid Chat API access token, minting (and caching) as needed. */
async function getAccessToken(ctx: PluginContext, config: GoogleChatConfig): Promise<string> {
  const nowMs = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - nowMs > 60_000) {
    return cachedToken.token;
  }
  const rawKey = await ctx.secrets.resolve(config.serviceAccountSecretRef);
  const key = parseServiceAccountKey(rawKey);
  cachedToken = await mintAccessToken(key, (url, init) => ctx.http.fetch(url, init), { nowMs });
  return cachedToken.token;
}

/** Post a single short text message to a Chat space (acks, errors). */
async function postToChat(
  ctx: PluginContext,
  config: GoogleChatConfig,
  target: { spaceName: string; threadName?: string },
  text: string
): Promise<void> {
  const token = await getAccessToken(ctx, config);
  await sendMessage((url, init) => ctx.http.fetch(url, init), token, {
    spaceName: target.spaceName,
    threadName: target.threadName,
    text
  });
}

/**
 * Post an agent's markdown reply to Chat: convert to Chat's text dialect
 * (tables→monospace, headers/bold/links) and split into <4096-char messages,
 * posted in order on the same thread. One token mint for the whole reply.
 */
async function postFormatted(
  ctx: PluginContext,
  config: GoogleChatConfig,
  target: { spaceName: string; threadName?: string },
  markdown: string
): Promise<void> {
  const token = await getAccessToken(ctx, config);
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
  for (const chunk of formatForChat(markdown)) {
    await sendMessage(fetchImpl, token, {
      spaceName: target.spaceName,
      threadName: target.threadName,
      text: chunk
    });
  }
}

/** Per-issue record of which agent comments we've already mirrored to Chat. */
interface DeliveredRecord {
  ids: string[];
  sigs: string[];
}

const DELIVERED_CAP = 200;

function deliveredKey(issueId: string) {
  return { scopeKind: "instance" as const, stateKey: `delivered:${issueId}` };
}

async function getDelivered(ctx: PluginContext, issueId: string): Promise<DeliveredRecord> {
  const rec = (await ctx.state.get(deliveredKey(issueId))) as DeliveredRecord | null;
  return { ids: rec?.ids ?? [], sigs: rec?.sigs ?? [] };
}

async function saveDelivered(
  ctx: PluginContext,
  issueId: string,
  rec: DeliveredRecord
): Promise<void> {
  // Bound growth: keep only the most recent ids/sigs.
  await ctx.state.set(deliveredKey(issueId), {
    ids: rec.ids.slice(-DELIVERED_CAP),
    sigs: rec.sigs.slice(-DELIVERED_CAP)
  });
}

/**
 * Routing path: hand the message to the agent as a Paperclip issue and post a
 * quick acknowledgement. The agent's actual reply arrives later as an issue
 * comment, delivered by the issue.updated handler registered in setup().
 */
async function routeToAgent(
  ctx: PluginContext,
  config: GoogleChatConfig,
  inbound: InboundMessage
): Promise<void> {
  if (!inbound.senderEmail) {
    await postToChat(ctx, config, inbound, "Sorry — I couldn't identify who you are.");
    return;
  }

  // Access control: a sender's assignment decides which agent answers them.
  // When gating is on, anyone without an assignment is turned away politely and
  // no agent run is created.
  const assignment = await getAssignment(ctx, inbound.senderEmail);
  let companyId: string;
  let agentId: string;
  if (assignment) {
    companyId = assignment.companyId;
    agentId = assignment.agentId;
  } else if (config.gateUnassigned) {
    await postToChat(ctx, config, inbound, config.unassignedMessage);
    ctx.logger.info("Turned away unassigned sender", { email: inbound.senderEmail });
    return;
  } else {
    companyId = await resolveCompanyId(ctx, config.companyId);
    agentId = await resolveAgentId(ctx, companyId, config.defaultAgentUrlKey);
  }
  const issueId = await dispatchToAgent(ctx, {
    companyId,
    agentId,
    text: inbound.text,
    senderDisplayName: inbound.senderDisplayName,
    target: {
      spaceName: inbound.spaceName,
      threadName: inbound.threadName,
      companyId,
      senderEmail: inbound.senderEmail
    }
  });
  ctx.logger.info("Dispatched Chat message to agent", { issueId, agentId });
  await postToChat(ctx, config, inbound, "⏳ Working on it…");
}

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    cachedToken = null;

    ctx.data.register("health", async () => {
      return {
        status: currentContext ? "ok" : "not-initialized",
        tokenCached: cachedToken !== null,
        checkedAt: new Date().toISOString()
      };
    });

    // Agent-callable tool: proactively message a person on Google Chat by email.
    // Works for anyone who has DM'd the bot (we learn their DM space from inbound
    // messages); an app can't open a brand-new DM itself, so unknown emails get a
    // clear "they must message the bot first" error.
    ctx.tools.register(
      SEND_DM_TOOL,
      {
        displayName: "Send Google Chat message",
        description:
          "Send a direct message to a person on Google Chat, addressed by their email. " +
          "Only works for people who have messaged the SeasonartsAI bot before.",
        parametersSchema: {
          type: "object",
          properties: {
            email: { type: "string", description: "The recipient's Google Chat (Workspace) email." },
            text: { type: "string", description: "The message text to send." }
          },
          required: ["email", "text"]
        }
      },
      async (params): Promise<ToolResult> => {
        const { email, text } = (params ?? {}) as { email?: string; text?: string };
        if (!email || !text) {
          return { error: "Both 'email' and 'text' are required." };
        }
        const config = await getConfig(ctx);
        const token = await getAccessToken(ctx, config);
        const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
        const spaceName = await resolveDmSpace(ctx, fetchImpl, token, email);
        if (!spaceName) {
          return {
            error:
              `No known Google Chat DM for ${email}. They need to message SeasonartsAI at ` +
              `least once first (an app can't open a brand-new DM on its own).`
          };
        }
        try {
          await postFormatted(ctx, config, { spaceName }, text);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        ctx.logger.info("Sent Chat DM via tool", { email, space: spaceName });
        return { content: `Message sent to ${email}.`, data: { spaceName } };
      }
    );

    // Liveness check backing the dashboard widget's "Ping Worker" button.
    ctx.actions.register("ping", async () => ({ ok: true, at: new Date().toISOString() }));

    // ----- Assignments admin (backs the Google Chat company-settings page) -----

    // Read: current email→agent assignments plus the agents available to pick.
    ctx.data.register("assignments", async (params) => {
      const config = await getConfig(ctx);
      const companyId = await resolveCompanyId(
        ctx,
        (typeof params.companyId === "string" && params.companyId) || config.companyId
      );
      const agents = await ctx.agents.list({ companyId });
      return {
        companyId,
        gateUnassigned: config.gateUnassigned,
        assignments: await listAssignments(ctx),
        agents: agents.map((a) => ({ id: a.id, name: a.name, urlKey: a.urlKey }))
      };
    });

    // Write: assign an email to an agent.
    ctx.actions.register("assignments.set", async (params) => {
      const email = typeof params.email === "string" ? params.email.trim() : "";
      const agentId = typeof params.agentId === "string" ? params.agentId : "";
      if (!email || !agentId) {
        return { ok: false, error: "Both email and agent are required." };
      }
      const config = await getConfig(ctx);
      const companyId = await resolveCompanyId(
        ctx,
        (typeof params.companyId === "string" && params.companyId) || config.companyId
      );
      const agent = (await ctx.agents.list({ companyId })).find((a) => a.id === agentId);
      if (!agent) {
        return { ok: false, error: "That agent no longer exists in this company." };
      }
      const assignment: AgentAssignment = {
        email,
        agentId,
        agentName: agent.name,
        companyId,
        updatedAt: new Date().toISOString()
      };
      await setAssignment(ctx, assignment);
      ctx.logger.info("Set Chat assignment", { email, agentId });
      return { ok: true, assignments: await listAssignments(ctx) };
    });

    // Write: remove an assignment.
    ctx.actions.register("assignments.remove", async (params) => {
      const email = typeof params.email === "string" ? params.email.trim() : "";
      if (!email) return { ok: false, error: "email is required." };
      await removeAssignment(ctx, email);
      ctx.logger.info("Removed Chat assignment", { email });
      return { ok: true, assignments: await listAssignments(ctx) };
    });

    // Mirror the agent conversation: forward each NEW agent message on a
    // Chat-originated issue to the originating space, as it's posted. This
    // replaces the old "deliver once when status hits done" logic, which lost
    // the real answer whenever the issue churned through `done` (e.g. a CEO
    // dispatching to a sub-issue) before the answer was written.
    ctx.events.on("issue.comment.created", async (event) => {
      try {
        const issueId = event.entityId;
        if (!issueId) return;
        const target = await getChatTarget(ctx, issueId);
        if (!target) return; // not a Chat-originated issue

        const config = await getConfig(ctx);
        const comments = await ctx.issues.listComments(issueId, target.companyId);
        const delivered = await getDelivered(ctx, issueId);

        for (const comment of orderedForwardable(comments)) {
          const id = comment.id ?? "";
          if (id && delivered.ids.includes(id)) continue;
          const sig = commentSignature(comment.body ?? "");
          if (delivered.sigs.includes(sig)) {
            if (id) delivered.ids.push(id); // mark seen, skip the duplicate body
            continue;
          }
          await postFormatted(ctx, config, target, comment.body ?? "");
          if (id) delivered.ids.push(id);
          delivered.sigs.push(sig);
          ctx.logger.info("Mirrored agent comment to Chat", { issueId, commentId: id });
        }
        await saveDelivered(ctx, issueId, delivered);
      } catch (err) {
        ctx.logger.error("Failed to mirror comment to Chat", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });
  },

  async onWebhook(input: PluginWebhookInput) {
    const ctx = currentContext;
    if (!ctx) throw new Error("Plugin context not initialized");
    if (input.endpointKey !== WEBHOOK_KEY) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }

    const config = await getConfig(ctx);

    // Authenticate the request as genuinely from Google Chat before acting on it.
    if (config.verifyInbound) {
      if (!config.senderServiceAccountEmail) {
        throw new Error("verifyInbound is on but no sender service account email is configured");
      }
      try {
        await verifyInboundRequest(input.headers, (url, init) => ctx.http.fetch(url, init), {
          expectedEmail: config.senderServiceAccountEmail,
          expectedAudience: config.expectedAudience || undefined
        });
      } catch (err) {
        ctx.logger.warn("Rejected unverified inbound webhook", {
          requestId: input.requestId,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    }

    // ADDED_TO_SPACE / REMOVED_FROM_SPACE / CARD_CLICKED are acknowledged
    // (HTTP 200) without a reply.
    const inbound = extractInboundMessage(input.parsedBody);
    if (!inbound) {
      ctx.logger.info("Acknowledged non-message Chat event", { requestId: input.requestId });
      return;
    }

    // Idempotency: Google retries webhooks on timeout, and agent runs can be
    // slow. Mark the message seen BEFORE the slow relay so a retry is a no-op.
    if (inbound.messageName) {
      const seenKey = { scopeKind: "instance" as const, stateKey: `seen:${inbound.messageName}` };
      if (await ctx.state.get(seenKey)) {
        ctx.logger.info("Skipping duplicate message delivery", { messageName: inbound.messageName });
        return;
      }
      await ctx.state.set(seenKey, true);
    }

    // Learn how to reach this person later: a DM space we can post to by email.
    // Only from genuine DMs — a room's space isn't anyone's personal channel.
    if (inbound.senderEmail && inbound.spaceType === "DM") {
      await rememberDmTarget(ctx, inbound.senderEmail, {
        spaceName: inbound.spaceName,
        userName: inbound.senderUserName
      });
    }

    if (config.routingEnabled) {
      try {
        await routeToAgent(ctx, config, inbound);
      } catch (err) {
        ctx.logger.warn("Routing failed", {
          requestId: input.requestId,
          error: err instanceof Error ? err.message : String(err)
        });
        await postToChat(ctx, config, inbound, "Sorry — I couldn't route your message to an agent.");
      }
      return;
    }

    // Echo fallback (routing disabled).
    const reply = config.echoMode ? `echo: ${inbound.text}` : inbound.text;
    await postToChat(ctx, config, inbound, reply);
    ctx.logger.info("Echoed Chat message", {
      space: inbound.spaceName,
      sender: inbound.senderDisplayName,
      requestId: input.requestId
    });
  },

  async onHealth() {
    return {
      status: currentContext ? "ok" : "error",
      message: currentContext ? "Plugin worker is running" : "Worker not initialized"
    };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
