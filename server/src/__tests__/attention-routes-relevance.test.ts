import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 待決議 shows what needs YOU.
 *
 * The page previously handed anyone with company scope the whole company's feed,
 * which made it useless for exactly the people with the most reports: an admin
 * opened it and saw every pending approval, with the two things actually waiting
 * on them buried inside. 收件匣 is the oversight view; this is the to-do list.
 *
 * These cases pin the distinction that is easy to lose again — being PERMITTED to
 * see a decision is not a reason to put it on someone's list.
 */

const COMPANY = "22222222-2222-4222-8222-222222222222";
const ME = "user-me";

const feedItems = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));
const relevance = vi.hoisted(() => ({ current: new Map<string, boolean | null>() }));
const issueReadable = vi.hoisted(() => ({ current: new Map<string, boolean>() }));
const companyScopeAllowed = vi.hoisted(() => ({ current: true }));
const relevanceCalls = vi.hoisted(() => [] as string[]);

vi.mock("../services/attention.js", () => ({
  attentionService: () => ({
    list: async () => ({
      items: feedItems.current,
      totalCount: feedItems.current.length,
      countsBySourceKind: {},
      generatedAt: new Date().toISOString(),
    }),
  }),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    decide: async (input: { action: string; resource: { issueId?: string } }) => {
      if (input.action === "company_scope:read") {
        return { allowed: companyScopeAllowed.current };
      }
      const issueId = input.resource.issueId ?? "";
      return { allowed: issueReadable.current.get(issueId) ?? true };
    },
    issueIsRelevantToUser: async (_companyId: string, _userId: string, issueId: string) => {
      relevanceCalls.push(issueId);
      return relevance.current.get(issueId) ?? false;
    },
    // Batched form the route now uses. Same map, same semantics — records each
    // id so the "asks once per distinct issue" assertions still hold.
    issuesRelevantToUser: async (_companyId: string, _userId: string, issueIds: readonly string[]) => {
      const out = new Set<string>();
      for (const id of new Set(issueIds)) {
        relevanceCalls.push(id);
        if (relevance.current.get(id) === true) out.add(id);
      }
      return out;
    },
  }),
}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  return {
    assertCompanyAccess: () => {},
    assertBoard: (req: Express.Request) => {
      if (req.actor.type !== "board") throw forbidden("Board required");
    },
  };
});

const { attentionRoutes } = await import("../routes/attention.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: ME, companyIds: [COMPANY], source: "session" } as never;
    next();
  });
  app.use(attentionRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function issueItem(issueId: string, sourceKind = "approval") {
  return { sourceKind, subject: { kind: "issue", id: issueId } };
}

beforeEach(() => {
  feedItems.current = [];
  relevance.current = new Map();
  issueReadable.current = new Map();
  companyScopeAllowed.current = true;
  relevanceCalls.length = 0;
});

describe("the decisions feed", () => {
  /**
   * The reported problem, as a test: a privileged user seeing other people's
   * decisions. Company scope no longer means "show me everything".
   */
  it("hides another person's decision from an admin", async () => {
    feedItems.current = [issueItem("issue-mine"), issueItem("issue-theirs")];
    relevance.current.set("issue-mine", true);
    relevance.current.set("issue-theirs", false);

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].subject.id).toBe("issue-mine");
    expect(res.body.totalCount).toBe(1);
  });

  // There is deliberately no company-wide mode: 收件匣 already is that view.
  it("ignores an attempt to ask for everything", async () => {
    feedItems.current = [issueItem("issue-mine"), issueItem("issue-theirs")];
    relevance.current.set("issue-mine", true);

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention?scope=all`);

    expect(res.body.items).toHaveLength(1);
  });

  /**
   * Permission is still the floor. A caller without company scope must not see
   * an issue they may not read, even if the relevance rule would have kept it.
   */
  it("still refuses an issue the caller may not read", async () => {
    companyScopeAllowed.current = false;
    feedItems.current = [issueItem("issue-forbidden")];
    relevance.current.set("issue-forbidden", true);
    issueReadable.current.set("issue-forbidden", false);

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention`);

    expect(res.body.items).toHaveLength(0);
  });

  // An item the rule cannot judge is not evidence that it needs you.
  it("withholds an item whose relevance cannot be judged", async () => {
    feedItems.current = [issueItem("issue-unknown")];
    relevance.current.set("issue-unknown", null);

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention`);

    expect(res.body.items).toHaveLength(0);
  });

  it("withholds anything not anchored to an issue, rather than guessing", async () => {
    feedItems.current = [{ sourceKind: "budget", subject: { kind: "company", id: COMPANY } }];

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention`);

    expect(res.body.items).toHaveLength(0);
  });

  /**
   * A feed repeats the same issue across several items. Re-deciding per item
   * turns one page load into hundreds of queries, so the verdict is memoised.
   */
  it("judges each issue once however many items reference it", async () => {
    feedItems.current = [
      issueItem("issue-mine", "approval"),
      issueItem("issue-mine", "interaction"),
      issueItem("issue-mine", "review"),
    ];
    relevance.current.set("issue-mine", true);

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention`);

    expect(res.body.items).toHaveLength(3);
    expect(relevanceCalls).toEqual(["issue-mine"]);
  });

  it("recounts by source kind after filtering, so the badges match the list", async () => {
    feedItems.current = [
      issueItem("issue-mine", "approval"),
      issueItem("issue-theirs", "approval"),
      issueItem("issue-mine", "review"),
    ];
    relevance.current.set("issue-mine", true);

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention`);

    expect(res.body.countsBySourceKind).toEqual({ approval: 1, review: 1 });
  });

  /**
   * Reported as "待決議 17" sitting above an empty page that said 你都處理完了.
   * The service computes deskBadgeCount company-wide, BEFORE the relevance
   * filter above; spreading it through unchanged made the sidebar advertise
   * other people's decisions, which reads as "something is hidden from me".
   */
  it("recounts the desk badge after filtering, so it can never exceed the list", async () => {
    const today = new Date().toISOString();
    feedItems.current = [
      { ...issueItem("issue-mine", "approval"), createdAt: today },
      { ...issueItem("issue-theirs", "approval"), createdAt: today },
      { ...issueItem("issue-theirs", "review"), createdAt: today },
    ];
    relevance.current.set("issue-mine", true);

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.deskBadgeCount).toBe(1);
    expect(res.body.deskBadgeCount).toBeLessThanOrEqual(res.body.totalCount);
  });

  it("shows a zero badge when nothing is relevant, not the company-wide count", async () => {
    const today = new Date().toISOString();
    feedItems.current = [
      { ...issueItem("issue-theirs", "approval"), createdAt: today },
      { ...issueItem("issue-other", "review"), createdAt: today },
    ];
    // nothing marked relevant → the page is empty, so the badge must be too

    const res = await request(createApp()).get(`/companies/${COMPANY}/attention`);

    expect(res.body.items).toHaveLength(0);
    expect(res.body.deskBadgeCount).toBe(0);
  });
});
