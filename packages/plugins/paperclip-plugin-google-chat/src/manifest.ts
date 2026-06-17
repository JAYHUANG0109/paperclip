import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/** Stable webhook endpoint key. The host routes
 *  `POST /api/plugins/<id>/webhooks/google-chat-events` to `onWebhook`. */
export const WEBHOOK_KEY = "google-chat-events" as const;

/** Agent tool name for proactively DMing a person on Google Chat by email.
 *  Namespaced by the plugin id at runtime. */
export const SEND_DM_TOOL = "send_chat_message" as const;

/** Default config values, mirrored by the worker's `getConfig` fallback. */
export const DEFAULT_CONFIG = {
  /** Secret reference (a Paperclip secret UUID, resolved via ctx.secrets)
   *  holding the Google service account JSON key used to mint Chat API tokens.
   *  Set via the config UI's secret picker; empty until chosen. */
  serviceAccountSecretRef: "",
  /** When true, prefix replies with "echo:" — the bring-up smoke behaviour.
   *  Used as the fallback when routing is disabled. */
  echoMode: true,
  /** Master switch: relay messages to a Paperclip agent instead of echoing. */
  routingEnabled: false,
  /** Company whose agent handles messages. Empty = the sole company, if one. */
  companyId: "",
  /** Agent to route to, by urlKey or name. Empty = the sole agent, if one. */
  defaultAgentUrlKey: "",
  /** Access control: when true, only senders with an explicit email→agent
   *  assignment (managed on the Google Chat settings page) get a real response;
   *  unassigned senders receive `unassignedMessage` and no agent runs.
   *  Defaults OFF so a fresh install keeps answering (everyone → default agent);
   *  turn it ON once assignments exist, especially before going org-wide. */
  gateUnassigned: false,
  /** Reply sent to an unassigned sender when `gateUnassigned` is on. */
  unassignedMessage:
    "您好！您目前還沒有專屬的 AI 助理，請聯絡資訊部 (IT) 協助為您設定。\n\n" +
    "Hi! You don't have an assigned AI agent yet — please contact 資訊部 (IT) to set one up.",
  /** Verify the Google-signed Bearer JWT on every inbound webhook. */
  verifyInbound: true,
  /** The Workspace add-on service account that signs inbound events. Its name
   *  embeds the GCP project number (455778754146 = "Paperclip Seasonarts"). */
  senderServiceAccountEmail: "service-455778754146@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
  /** Optional: if set, the inbound JWT `aud` must equal this (the app's public
   *  HTTPS endpoint URL). Left empty by default since the Funnel host can change. */
  expectedAudience: ""
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-google-chat",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Google Chat",
  description: "Bridge Paperclip agents to Google Chat for the 四季 deployment",
  author: "Jay Huang",
  categories: ["connector"],
  capabilities: [
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "companies.read",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.read",
    "issue.comments.create",
    "issue.attachments.write",
    "agent.tools.register",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "ui.action.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEY,
      displayName: "Google Chat Events",
      description:
        "Receives MESSAGE / ADDED_TO_SPACE / REMOVED_FROM_SPACE events from the Google Chat app."
    }
  ],
  tools: [
    {
      name: SEND_DM_TOOL,
      displayName: "Send Google Chat message",
      description:
        "Send a direct message to a person on Google Chat, addressed by their email. " +
        "Only reaches people who have messaged the SeasonartsAI bot before.",
      parametersSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "The recipient's Google Chat (Workspace) email." },
          text: { type: "string", description: "The message text to send." }
        },
        required: ["email", "text"]
      }
    }
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      serviceAccountSecretRef: {
        type: "string",
        format: "secret-ref",
        title: "Service Account Secret",
        description:
          "Paperclip secret holding the Google service account JSON key (scope chat.bot).",
        default: DEFAULT_CONFIG.serviceAccountSecretRef
      },
      echoMode: {
        type: "boolean",
        title: "Echo Mode",
        description:
          "Fallback when routing is off: reply by echoing the message text back.",
        default: DEFAULT_CONFIG.echoMode
      },
      routingEnabled: {
        type: "boolean",
        title: "Route to Agent",
        description:
          "Relay each message to a Paperclip agent session and post its reply back.",
        default: DEFAULT_CONFIG.routingEnabled
      },
      companyId: {
        type: "string",
        title: "Company ID",
        description:
          "Company whose agent handles messages. Leave empty if the instance has one company.",
        default: DEFAULT_CONFIG.companyId
      },
      defaultAgentUrlKey: {
        type: "string",
        title: "Default Agent (urlKey or name)",
        description:
          "Fallback agent when gating is OFF and a sender has no assignment. " +
          "Leave empty if the company has one agent.",
        default: DEFAULT_CONFIG.defaultAgentUrlKey
      },
      gateUnassigned: {
        type: "boolean",
        title: "Restrict to assigned users",
        description:
          "Only people with an email→agent assignment (managed on the Google Chat " +
          "settings page) get a response. Unassigned senders get the message below.",
        default: DEFAULT_CONFIG.gateUnassigned
      },
      unassignedMessage: {
        type: "string",
        title: "Reply for unassigned users",
        description: "Sent to senders who have no assigned agent when gating is on.",
        default: DEFAULT_CONFIG.unassignedMessage
      },
      verifyInbound: {
        type: "boolean",
        title: "Verify Inbound Requests",
        description:
          "Verify Google's signed OIDC token on every webhook against the sender email below.",
        default: DEFAULT_CONFIG.verifyInbound
      },
      senderServiceAccountEmail: {
        type: "string",
        title: "Add-on Sender Service Account",
        description:
          "The service-<projectNumber>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com email Google signs events as.",
        default: DEFAULT_CONFIG.senderServiceAccountEmail
      },
      expectedAudience: {
        type: "string",
        title: "Expected Audience URL (optional)",
        description:
          "If set, the inbound JWT audience must equal this exact HTTPS endpoint URL.",
        default: DEFAULT_CONFIG.expectedAudience
      }
    }
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Google Chat Health",
        exportName: "DashboardWidget"
      },
      // Top-level "Chat" nav section (not under Settings). The host renders these
      // page slots as a dedicated section via ui/src/components/SidebarChat.tsx,
      // and the catch-all company route mounts them at /:companyPrefix/<routePath>.
      {
        type: "page",
        id: "chat-logs-page",
        displayName: "Chat Logs",
        exportName: "ChatLogsPage",
        routePath: "chat-logs",
        order: 1
      },
      {
        type: "page",
        id: "assignments-page",
        displayName: "Assignments",
        exportName: "AssignmentsSettingsPage",
        routePath: "chat-assignments",
        order: 2
      }
    ]
  }
};

export default manifest;
