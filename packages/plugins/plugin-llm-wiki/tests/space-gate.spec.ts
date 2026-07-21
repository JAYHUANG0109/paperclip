import { describe, expect, it } from "vitest";
import { resolveSpace } from "../src/wiki/core.js";

// Minimal fake PluginContext: resolveSpace(non-default slug) issues exactly one
// db.query (the space SELECT); we return a personal space owned by "alice".
function ctxReturning(rows: unknown[]) {
  return {
    db: {
      namespace: "test_ns",
      query: async () => rows,
      execute: async () => undefined,
    },
  } as unknown as Parameters<typeof resolveSpace>[0];
}

const personalAlice = {
  id: "s1",
  company_id: "c1",
  wiki_id: "default",
  slug: "p-alice",
  display_name: "Alice private",
  space_type: "local_folder",
  folder_mode: "managed_subfolder",
  root_folder_key: "wiki-root",
  path_prefix: "spaces/p-alice",
  configured_root_path: null,
  access_scope: "personal",
  owner_user_id: "alice",
  owner_agent_id: null,
  team_key: null,
  settings: "{}",
  status: "active",
  created_at: null,
  updated_at: null,
};

// This is the deploy gate: every guarded board handler funnels through
// resolveSpace(...viewer). If this denies a non-owner, the gate denies.
describe("wiki space gate — resolveSpace enforcement (deploy gate)", () => {
  it("DENIES a non-owner viewer a personal space", async () => {
    const ctx = ctxReturning([personalAlice]);
    await expect(
      resolveSpace(ctx, { companyId: "c1", spaceSlug: "p-alice", viewer: { userId: "bob" } }),
    ).rejects.toThrow(/Access denied/);
  });

  it("ALLOWS the owner", async () => {
    const ctx = ctxReturning([personalAlice]);
    const s = await resolveSpace(ctx, { companyId: "c1", spaceSlug: "p-alice", viewer: { userId: "alice" } });
    expect(s.slug).toBe("p-alice");
  });

  it("ALLOWS a privileged viewer (owner/admin/instance-admin)", async () => {
    const ctx = ctxReturning([personalAlice]);
    const s = await resolveSpace(ctx, { companyId: "c1", spaceSlug: "p-alice", viewer: { isPrivileged: true } });
    expect(s.slug).toBe("p-alice");
  });

  it("NO viewer = trusted/system path (agent tools, distillation) — not gated", async () => {
    const ctx = ctxReturning([personalAlice]);
    const s = await resolveSpace(ctx, { companyId: "c1", spaceSlug: "p-alice" });
    expect(s.slug).toBe("p-alice");
  });
});
