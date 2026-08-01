import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { authUsers, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { VIEW_AS_HEADER } from "../services/view-as-policy.js";

const LEAD = { id: "user-lead", email: "jay20020109@seasonart.org", name: "Jay" };
const MEMBER = { id: "user-member", email: "member@seasonart.org", name: "Member" };
const OTHER_ADMIN = { id: "user-tang", email: "tang@seasonart.org", name: "Tang" };

const USERS = [LEAD, MEMBER, OTHER_ADMIN];

/** Lead + Tang are instance admins; the member is not. */
const ADMIN_IDS = new Set([LEAD.id, OTHER_ADMIN.id]);

const MEMBERSHIPS: Record<string, Array<{ companyId: string; membershipRole: string; status: string }>> = {
  [LEAD.id]: [
    { companyId: "company-1", membershipRole: "owner", status: "active" },
    { companyId: "company-2", membershipRole: "owner", status: "active" },
  ],
  [MEMBER.id]: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
  [OTHER_ADMIN.id]: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
};

type Captured = { table: unknown; values: unknown };

function createDb(activity: Captured[]) {
  // The middleware filters by userId in SQL; the stub cannot read the where
  // clause, so it returns rows for whichever user the current chain asked
  // about, captured from the `eq` arguments the middleware builds.
  function select(fields?: Record<string, unknown>) {
    return {
      from(table: unknown) {
        return {
          where(condition: unknown) {
            const userId = extractUserId(condition);
            if (table === authUsers) {
              const user = USERS.find((u) => u.id === userId);
              return Promise.resolve(user ? [user] : []);
            }
            if (table === instanceUserRoles) {
              return Promise.resolve(userId && ADMIN_IDS.has(userId) ? [{ id: `role-${userId}` }] : []);
            }
            if (table === companyMemberships) {
              return Promise.resolve(userId ? MEMBERSHIPS[userId] ?? [] : []);
            }
            return Promise.resolve([]);
          },
        };
      },
    };
  }

  return {
    select,
    insert(table: unknown) {
      return {
        values(values: unknown) {
          activity.push({ table, values });
          return Promise.resolve();
        },
      };
    },
  } as never;
}

/**
 * drizzle builds an opaque condition object; walk it for the first string that
 * looks like one of our user ids so the stub can answer per-user.
 */
function extractUserId(condition: unknown): string | null {
  const seen = new Set<unknown>();
  const stack = [condition];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === "string" && USERS.some((u) => u.id === value)) return value;
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return null;
}

function createApp(sessionUser: { id: string; email: string; name: string }, activity: Captured[]) {
  const app = express();
  app.use(
    actorMiddleware(createDb(activity), {
      deploymentMode: "authenticated",
      resolveSession: async () =>
        ({
          user: { id: sessionUser.id, email: sessionUser.email, name: sessionUser.name },
          session: { id: "session-1" },
        }) as never,
    }),
  );
  app.get("/probe", (req, res) => {
    res.json({
      userId: req.actor.userId,
      userEmail: req.actor.userEmail,
      companyIds: req.actor.companyIds,
      isInstanceAdmin: req.actor.isInstanceAdmin,
      viewAs: req.actor.viewAs ?? null,
    });
  });
  app.post("/probe", (req, res) => res.json({ userId: req.actor.userId }));
  app.use(errorHandler);
  return app;
}

describe("view-as middleware", () => {
  it("scopes the request to the viewed user for the lead developer", async () => {
    const activity: Captured[] = [];
    const res = await request(createApp(LEAD, activity)).get("/probe").set(VIEW_AS_HEADER, MEMBER.id);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(MEMBER.id);
    expect(res.body.userEmail).toBe(MEMBER.email);
  });

  // Rail 2 — replaces, never unions. The lead is in two companies; the member
  // is in one. Seeing both would defeat the entire purpose of the tool.
  it("narrows the company list to the viewed user's, not the union", async () => {
    const res = await request(createApp(LEAD, [])).get("/probe").set(VIEW_AS_HEADER, MEMBER.id);

    expect(res.body.companyIds).toEqual(["company-1"]);
  });

  // Rail 3 — the flag that would otherwise silently re-grant everything.
  it("drops instance admin while viewing a non-admin", async () => {
    const res = await request(createApp(LEAD, [])).get("/probe").set(VIEW_AS_HEADER, MEMBER.id);

    expect(res.body.isInstanceAdmin).toBe(false);
  });

  it("keeps instance admin when the viewed user has it in their own right", async () => {
    const res = await request(createApp(LEAD, [])).get("/probe").set(VIEW_AS_HEADER, OTHER_ADMIN.id);

    expect(res.body.isInstanceAdmin).toBe(true);
  });

  // Rail 1 — the rail that means no action is ever recorded as someone else's.
  it("refuses a write while viewing as another user", async () => {
    const res = await request(createApp(LEAD, [])).post("/probe").set(VIEW_AS_HEADER, MEMBER.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("read-only");
  });

  // Rail 4 — another instance admin must not get this.
  it("refuses a non-allowlisted instance admin", async () => {
    const res = await request(createApp(OTHER_ADMIN, [])).get("/probe").set(VIEW_AS_HEADER, MEMBER.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("not permitted");
  });

  it("refuses an ordinary user", async () => {
    const res = await request(createApp(MEMBER, [])).get("/probe").set(VIEW_AS_HEADER, LEAD.id);

    expect(res.status).toBe(403);
  });

  // Refusing loudly matters more than it looks: silently ignoring the header
  // would show the viewer their OWN data while they believe they are seeing
  // someone else's, which is the worst outcome for a verification tool.
  it("refuses rather than silently falling back to the viewer's own scope", async () => {
    const res = await request(createApp(OTHER_ADMIN, [])).get("/probe").set(VIEW_AS_HEADER, MEMBER.id);

    expect(res.status).toBe(403);
    expect(res.body.userId).toBeUndefined();
  });

  it("refuses an unknown target user", async () => {
    const res = await request(createApp(LEAD, [])).get("/probe").set(VIEW_AS_HEADER, "user-ghost");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("no such user");
  });

  it("leaves a request without the header completely untouched", async () => {
    const activity: Captured[] = [];
    const res = await request(createApp(LEAD, activity)).get("/probe");

    expect(res.body.userId).toBe(LEAD.id);
    expect(res.body.isInstanceAdmin).toBe(true);
    expect(res.body.viewAs).toBeNull();
    expect(activity).toHaveLength(0);
  });

  describe("audit", () => {
    it("records the real user, not the viewed one", async () => {
      const activity: Captured[] = [];
      await request(createApp(LEAD, activity)).get("/probe").set(VIEW_AS_HEADER, MEMBER.id);

      expect(activity).toHaveLength(1);
      expect(activity[0].values).toMatchObject({
        actorId: LEAD.id,
        responsibleUserId: LEAD.id,
        action: "user.viewed_as",
        entityId: MEMBER.id,
      });
    });

    it("carries the real user through on the actor for downstream code", async () => {
      const res = await request(createApp(LEAD, [])).get("/probe").set(VIEW_AS_HEADER, MEMBER.id);

      expect(res.body.viewAs).toEqual({
        realUserId: LEAD.id,
        realUserEmail: LEAD.email,
        viewingUserId: MEMBER.id,
      });
    });

    it("does not audit a refused attempt as though it succeeded", async () => {
      const activity: Captured[] = [];
      await request(createApp(OTHER_ADMIN, activity)).get("/probe").set(VIEW_AS_HEADER, MEMBER.id);

      expect(activity).toHaveLength(0);
    });
  });
});
