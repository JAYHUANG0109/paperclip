import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { AttentionSortMode } from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import { accessService } from "../services/access.js";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}

export function attentionRoutes(db: Db) {
  const router = Router();
  const svc = attentionService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const userId = req.actor.userId;
    const includeDismissed = req.query.includeDismissed === "true";
    const archived = req.query.archived === "true";
    const all = req.query.all === "true";
    const activitySince = optionalQueryString(req.query.activitySince, "activitySince");
    const activityUntil = optionalQueryString(req.query.activityUntil, "activityUntil");
    const queue = optionalQueryString(req.query.queue, "queue");
    const cursor = optionalQueryString(req.query.cursor, "cursor");
    const sortValue = optionalQueryString(req.query.sort, "sort");
    if (sortValue !== undefined && sortValue !== "activity" && sortValue !== "decide") {
      throw badRequest("sort must be 'activity' or 'decide'");
    }
    const limitValue = optionalQueryString(req.query.limit, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (limit !== undefined && !Number.isInteger(limit)) throw badRequest("limit must be an integer");
    const feed = await svc.list(companyId, {
      userId,
      includeDismissed,
      archived,
      all,
      allowUnscopedAll: all,
      activitySince,
      activityUntil,
      queue,
      cursor,
      sort: sortValue as AttentionSortMode | undefined,
      limit,
    });

    /**
     * 待決議 answers exactly one question: what needs ME?
     *
     * Two different questions used to be conflated here:
     *
     *   PERMISSION — may I see this decision? A decision is about an issue, so
     *   that is "may I see its issue". Non-negotiable, and still enforced below.
     *
     *   RELEVANCE — does this need me? Previously anyone with company scope got
     *   the company-wide feed, which is what made the page unusable for exactly
     *   the people with the most reports: an admin or a campus head opened it and
     *   saw every pending approval in the company, with the two things actually
     *   waiting on them buried inside. A queue nobody can read is a queue where
     *   real decisions sit.
     *
     * So it is scoped to the caller's own world for EVERYONE, privileged or not,
     * with no company-wide mode. There is deliberately no `scope=all` escape
     * hatch: 收件匣 already is the oversight view, and a second one here would
     * just be two places showing the same thing while neither reliably answers
     * "what is waiting on me".
     *
     * Being permitted to see something is not a reason to put it on someone's
     * list.
     */
    const companyScope = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });

    // One verdict per distinct issue: a feed repeats the same issue across
    // several items, and re-deciding each time turns a page load into hundreds
    // of queries.
    const verdicts = new Map<string, Promise<boolean>>();
    const keepIssue = (issueId: string) => {
      const cached = verdicts.get(issueId);
      if (cached) return cached;
      const pending = (async () => {
        // Permission first — it is the floor, and a caller who may not read the
        // issue must not see it whatever the scope.
        if (!companyScope.allowed) {
          const decision = await access.decide({
            actor: req.actor,
            action: "issue:read",
            resource: { type: "issue", companyId, issueId },
          });
          if (!decision.allowed) return false;
        }
        // Then relevance. `null` means the rule could not judge this issue, and
        // an unjudgeable item is not evidence that it needs you — so it stays
        // out. Anything wrongly hidden is still reachable through 收件匣 and the
        // task itself; the cost of being wrong here is a click, not a loss.
        const relevant = await access.issueIsRelevantToUser(companyId, userId, issueId);
        return relevant === true;
      })();
      verdicts.set(issueId, pending);
      return pending;
    };

    const keep = await Promise.all(
      feed.items.map(async (item) => {
        // Anything not anchored to an issue cannot be scoped by this rule, so
        // withhold it rather than guess — silence is recoverable, a leak is not.
        if (item.subject.kind !== "issue") return false;
        return keepIssue(item.subject.id);
      }),
    );
    const items = feed.items.filter((_, index) => keep[index]);

    res.json({
      ...feed,
      items,
      totalCount: items.length,
      countsBySourceKind: items.reduce(
        (counts, item) => ({ ...counts, [item.sourceKind]: (counts[item.sourceKind] ?? 0) + 1 }),
        {} as Record<string, number>,
      ) as typeof feed.countsBySourceKind,
    });
  });

  return router;
}
