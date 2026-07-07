import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { companySkillService } from "./company-skills.js";
import { secretService } from "./secrets.js";
import { skillVersionSelectionMap } from "./runtime-skill-selections.js";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";

/**
 * Auto-adopt user-installed (unmanaged) local skills into the MANAGED company
 * library so they become viewable (檢視), versioned, and distributable — without
 * the authoring agent having to call the create API. When an agent writes a
 * SKILL.md into its local Claude skills home, that skill shows up as
 * `origin: "user_installed"` (managed:false). This pass reads each such skill and
 * registers it as a managed company skill via `createLocalSkill`.
 *
 * Idempotent: `createLocalSkill` throws a conflict when the slug already exists,
 * which we treat as "already adopted" and skip. Adopt-only — it never deletes or
 * re-equips; the agent keeps using its local copy, and the managed copy is what
 * the dashboard shows and `/skills/distribute` can hand to a team.
 */
export async function reconcileUserInstalledSkills(
  db: Db,
): Promise<{ scannedAgents: number; adopted: number }> {
  const companySkills = companySkillService(db);
  const secrets = secretService(db);
  let scannedAgents = 0;
  let adopted = 0;

  const rows = await db.select().from(agentsTable);
  for (const agent of rows) {
    const adapter = findActiveServerAdapter(agent.adapterType);
    if (!adapter?.listSkills) continue; // only local adapters that expose skills
    // Skip decommissioned agents.
    if (agent.status === "terminated") continue;
    scannedAgents += 1;
    try {
      const { config: runtimeConfig } = await secrets.resolveAdapterConfigForRuntime(
        agent.companyId,
        agent.adapterConfig as Record<string, unknown>,
      );
      const preference = readPaperclipSkillSyncPreference(runtimeConfig as Record<string, unknown>);
      const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId, {
        materializeMissing: false,
        versionSelections: skillVersionSelectionMap(preference.desiredSkillEntries),
      });
      const snapshot = await adapter.listSkills({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        config: { ...runtimeConfig, paperclipRuntimeSkills: runtimeSkillEntries },
      });

      for (const entry of snapshot.entries) {
        if (entry.origin !== "user_installed") continue; // only unmanaged user skills
        const dir = entry.targetPath ?? entry.sourcePath;
        if (!dir) continue;
        const slug = (entry.runtimeName || entry.key || "").trim();
        if (!slug) continue;

        // Read the skill's SKILL.md (dir may be the skill folder or the file).
        let markdown: string | null = null;
        try {
          const st = await fs.stat(dir);
          const file = st.isDirectory() ? path.join(dir, "SKILL.md") : dir;
          markdown = await fs.readFile(file, "utf8");
        } catch {
          continue; // unreadable — leave it, try again next pass
        }
        if (!markdown.trim()) continue;

        // Prefer the frontmatter's own name/description for a clean record.
        let name = slug;
        let description: string | null = null;
        const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const nm = fm[1].match(/^name:\s*(.+)$/m);
          const dm = fm[1].match(/^description:\s*(.+)$/m);
          if (nm) name = nm[1].trim();
          if (dm) description = dm[1].trim();
        }

        try {
          const created = await companySkills.createLocalSkill(
            agent.companyId,
            { name, slug, description, markdown },
            { type: "agent", agentId: agent.id },
            { isPrivileged: true },
          );
          adopted += 1;
          logger.info(
            { companyId: agent.companyId, agentId: agent.id, slug, skillId: created.id },
            "auto-adopted user-installed skill into managed company library",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Already a company skill → nothing to do (idempotent). Anything else is noteworthy.
          if (!/already exists/i.test(msg)) {
            logger.warn({ companyId: agent.companyId, slug, err: msg }, "auto-adopt skill: create failed");
          }
        }
      }
    } catch (err) {
      logger.warn(
        { agentId: agent.id, err: err instanceof Error ? err.message : String(err) },
        "auto-adopt skill: listSkills failed for agent",
      );
    }
  }
  return { scannedAgents, adopted };
}
