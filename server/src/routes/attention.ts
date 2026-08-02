import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { attentionService } from "../services/attention.js";
import { accessService } from "../services/access.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

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

    const includeDismissed = req.query.includeDismissed === "true";
    const feed = await svc.list(companyId, {
      userId: req.actor.userId,
      includeDismissed,
    });

    // The service takes a userId, but only to resolve dismissals — it never
    // scoped WHICH decisions you see, so every member got the same company-wide
    // feed. A decision is about an issue, so "may I see this decision" is "may
    // I see its issue".
    //
    // Only for actors without company scope; owners/admins keep the full feed.
    const companyScope = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (companyScope.allowed) {
      res.json(feed);
      return;
    }

    // One decision per distinct issue: a feed repeats the same issue across
    // several items, and re-deciding each time turns a page load into hundreds
    // of queries.
    const verdicts = new Map<string, Promise<boolean>>();
    const mayRead = (issueId: string) => {
      const cached = verdicts.get(issueId);
      if (cached) return cached;
      const pending = access
        .decide({
          actor: req.actor,
          action: "issue:read",
          resource: { type: "issue", companyId, issueId },
        })
        .then((decision) => decision.allowed);
      verdicts.set(issueId, pending);
      return pending;
    };

    const keep = await Promise.all(
      feed.items.map(async (item) => {
        // Anything not anchored to an issue cannot be scoped by this rule, so
        // withhold it rather than guess — silence is recoverable, a leak is not.
        if (item.subject.kind !== "issue") return false;
        return mayRead(item.subject.id);
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
