import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { skillBounties } from "@paperclipai/db";

export type BountyStatus = "open" | "claimed" | "done" | "cancelled";

export function bountyService(db: Db) {
  function list(companyId: string) {
    return db
      .select()
      .from(skillBounties)
      .where(eq(skillBounties.companyId, companyId))
      .orderBy(desc(skillBounties.createdAt));
  }

  async function create(companyId: string, input: {
    title: string;
    description?: string | null;
    estimatedMinutes?: number;
    postedByUserId?: string | null;
    postedByName?: string | null;
  }) {
    const [row] = await db
      .insert(skillBounties)
      .values({
        companyId,
        title: input.title.trim().slice(0, 200),
        description: input.description?.trim().slice(0, 4000) ?? null,
        estimatedMinutes: Math.max(0, Math.min(100000, Math.round(input.estimatedMinutes ?? 0))),
        postedByUserId: input.postedByUserId ?? null,
        postedByName: input.postedByName ?? null,
        status: "open",
      })
      .returning();
    return row;
  }

  async function claim(companyId: string, bountyId: string, userId: string | null, name: string | null) {
    const [row] = await db
      .update(skillBounties)
      .set({ status: "claimed", claimedByUserId: userId, claimedByName: name, claimedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(skillBounties.id, bountyId), eq(skillBounties.companyId, companyId), eq(skillBounties.status, "open")))
      .returning();
    return row ?? null;
  }

  async function complete(companyId: string, bountyId: string, linkedSkillId: string | null) {
    const [row] = await db
      .update(skillBounties)
      .set({ status: "done", completedAt: new Date(), linkedSkillId: linkedSkillId ?? null, updatedAt: new Date() })
      .where(and(eq(skillBounties.id, bountyId), eq(skillBounties.companyId, companyId)))
      .returning();
    return row ?? null;
  }

  async function setStatus(companyId: string, bountyId: string, status: BountyStatus) {
    const [row] = await db
      .update(skillBounties)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(skillBounties.id, bountyId), eq(skillBounties.companyId, companyId)))
      .returning();
    return row ?? null;
  }

  async function remove(companyId: string, bountyId: string) {
    return db
      .delete(skillBounties)
      .where(and(eq(skillBounties.id, bountyId), eq(skillBounties.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  // Users who completed a bounty within the last `days` get the bounty bonus.
  async function recentCompleters(companyId: string, sinceMs: number): Promise<Set<string>> {
    const rows = await db
      .select({ userId: skillBounties.claimedByUserId, completedAt: skillBounties.completedAt })
      .from(skillBounties)
      .where(and(eq(skillBounties.companyId, companyId), eq(skillBounties.status, "done")));
    const out = new Set<string>();
    for (const r of rows) {
      if (r.userId && r.completedAt && r.completedAt.getTime() >= sinceMs) out.add(r.userId);
    }
    return out;
  }

  return { list, create, claim, complete, setStatus, remove, recentCompleters };
}
