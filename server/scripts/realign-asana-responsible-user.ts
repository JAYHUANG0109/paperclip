/**
 * Realign the Asana per-user token from the pseudo-user `local-board` to the
 * real human owner so it's manageable from the My secrets UI.
 *  - sets companies.defaultResponsibleUserId to the target user (so autonomous
 *    runs resolve to them), and
 *  - copies the ASANA_TOKEN value onto the target user (keeps local-board's too
 *    as a fallback for pre-existing runs).
 * Usage: cd server && npx tsx scripts/realign-asana-responsible-user.ts <companyId> <userId>
 */
import { createDb, companies } from "@paperclipai/db";
import { readFileSync } from "node:fs"; import { homedir } from "node:os";
import { eq } from "drizzle-orm";
import { secretService } from "../src/services/secrets.js";
import { ASANA_USER_SECRET_KEY } from "../src/services/agent-asana.js";

const companyId = process.argv[2] || "0980d089-ebdf-4f54-9576-1a9150c5d6f9";
const targetUserId = process.argv[3] || "VlUltPjTs93WeaTOCepzIjLod629qi62"; // 黃睦傑
const port = readFileSync(homedir()+"/.paperclip/instances/default/db/postmaster.pid","utf8").split("\n")[3].trim();
const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`);
const svc = secretService(db);

// 1) default responsible user -> target
await db.update(companies).set({ defaultResponsibleUserId: targetUserId }).where(eq(companies.id, companyId));
console.log(`✓ companies.defaultResponsibleUserId = ${targetUserId}`);

// 2) copy the token value from local-board to the target user (idempotent)
const src = await svc.resolveUserSecretValue(companyId, { definitionKey: ASANA_USER_SECRET_KEY, responsibleUserId: "local-board", required: false });
if (!src?.value) { console.log("! no local-board ASANA_TOKEN value found — nothing to copy"); process.exit(0); }
const existing = await svc.resolveUserSecretValue(companyId, { definitionKey: ASANA_USER_SECRET_KEY, responsibleUserId: targetUserId, required: false });
if (existing?.value) {
  console.log(`~ target user already has an ASANA_TOKEN (${existing.value.length} chars) — leaving as-is`);
} else {
  await svc.createCurrentUserSecretValue(companyId, targetUserId, { definitionKey: ASANA_USER_SECRET_KEY, value: src.value }, { userId: targetUserId, agentId: null });
  console.log(`✓ copied ASANA_TOKEN (${src.value.length} chars) to user ${targetUserId}`);
}
process.exit(0);
