/**
 * Creates a test Paperclip agent using the codex_local adapter pointed at OpenRouter.
 * The agent uses GPT-4o-mini (or any OpenRouter model) via Codex CLI's provider config.
 *
 * Usage:
 *   cd server && OPENROUTER_API_KEY=sk-or-v1-... npx tsx scripts/seed-openrouter-agent.ts [companyId] [userId] [model]
 *
 * Defaults:
 *   companyId — Season Arts (0980d089-...)
 *   userId    — Jay (jay20020109@seasonart.org) -- provide your actual user UUID
 *   model     — openai/gpt-4o-mini  (any OpenRouter model ID works)
 *
 * For local Ollama (once installed), set model to e.g. "llama3.3:70b" and
 * PAPERCLIP_CODEX_PROVIDERS will be auto-set to point at localhost:11434.
 *
 * After running, the agent appears in the Paperclip UI. You can assign it tasks
 * or fire a manual heartbeat run to verify it works end-to-end.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDb, agents, agentMemberships, authUsers } from "@paperclipai/db";
import { eq } from "drizzle-orm";

const COMPANY_ID = process.argv[2] || "0980d089-ebdf-4f54-9576-1a9150c5d6f9";
const USER_EMAIL = process.argv[3] || "jay20020109@seasonart.org";
const MODEL = process.argv[4] || "openai/gpt-4o-mini";
const DB_URL = process.env.SEED_DB_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

// OpenRouter API key — read from env so it's never hardcoded here
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";

// --- Determine provider config -------------------------------------------------
// Detect local Ollama models (no slash → assume ollama, e.g. "llama3.3:70b")
const isLocalModel = !MODEL.includes("/");
const providerConfig = isLocalModel
  ? JSON.stringify({
      providers: {
        ollama: {
          name: "Ollama (local)",
          base_url: "http://localhost:11434/v1",
          env_key: "OPENAI_API_KEY", // ollama doesn't require a real key
          wire_api: "responses",
        },
      },
      model_provider: "ollama",
    })
  : JSON.stringify({
      providers: {
        openrouter: {
          name: "OpenRouter",
          base_url: "https://openrouter.ai/api/v1",
          env_key: "OPENROUTER_API_KEY",
          wire_api: "responses",
        },
      },
      model_provider: "openrouter",
    });

// --- Write AGENTS.md -----------------------------------------------------------
const AGENTS_MD = `# OpenRouter Test Agent

你是 Paperclip 的測試 agent，透過 OpenRouter 使用模型 ${MODEL}。

## 基本行為
- 回應使用者指派的任務。
- 完成任務後，把狀態更新為 done 並附上簡短摘要。
- 如有不確定的事，用留言詢問，並把狀態設為 in_review。
- 語言：依使用者習慣（中文或英文均可）。

## API 存取
環境變數 \`PAPERCLIP_API_URL\` / \`PAPERCLIP_API_KEY\` / \`PAPERCLIP_AGENT_ID\` / \`PAPERCLIP_COMPANY_ID\` 已注入。
所有對 Paperclip 的請求都用 \`Authorization: Bearer $PAPERCLIP_API_KEY\`，並附 \`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\`。
`;

// --- Main ---------------------------------------------------------------------
async function main() {
  const db = createDb(DB_URL);

  // Resolve user
  const [user] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, USER_EMAIL));
  if (!user) {
    console.error(`User not found: ${USER_EMAIL}`);
    process.exit(1);
  }
  console.log(`User: ${USER_EMAIL} → ${user.id}`);

  // Write AGENTS.md to a stable path in the instance workspace
  const instanceBase = path.join(os.homedir(), ".paperclip", "instances", "default");
  const agentId = crypto.randomUUID();
  const wsDir = path.join(instanceBase, "companies", COMPANY_ID, "agents", agentId, "workspace");
  await fs.mkdir(wsDir, { recursive: true });
  const agentsMdPath = path.join(wsDir, "AGENTS.md");
  await fs.writeFile(agentsMdPath, AGENTS_MD, "utf8");
  console.log(`AGENTS.md written → ${agentsMdPath}`);

  // Build adapterConfig
  const adapterConfig: Record<string, unknown> = {
    cwd: wsDir,
    instructionsFilePath: agentsMdPath,
    model: MODEL,
    dangerouslyBypassApprovalsAndSandbox: true, // required for non-interactive heartbeat runs
    env: {
      PAPERCLIP_CODEX_PROVIDERS: providerConfig,
      ...(isLocalModel ? { OPENAI_API_KEY: "ollama" } : { OPENROUTER_API_KEY }),
    },
  };

  // Create agent row
  await db.insert(agents).values({
    id: agentId,
    companyId: COMPANY_ID,
    name: isLocalModel
      ? `Local Ollama — ${MODEL}`
      : `OpenRouter — ${MODEL}`,
    adapterType: "codex_local",
    adapterConfig,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`Agent created: ${agentId}`);

  // Add membership so Jay can see / manage it
  await db.insert(agentMemberships).values({
    id: crypto.randomUUID(),
    companyId: COMPANY_ID,
    agentId,
    userId: user.id,
    role: "admin",
    state: "joined",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`Membership added for ${USER_EMAIL}`);

  console.log(`\n✅  Done! Agent "${isLocalModel ? "Local Ollama" : "OpenRouter"} — ${MODEL}" is ready.`);
  console.log(`   ID: ${agentId}`);
  console.log(`   Open Paperclip and assign it a task to test.\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
