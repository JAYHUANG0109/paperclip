/**
 * "View as" — let the lead developer load the app scoped to another user, to
 * check what that person actually sees. PURE decision logic; the middleware
 * wiring lives in server/src/middleware/auth.ts.
 *
 * This exists to verify per-user agent visibility (PAPERCLIP_RESTRICT_AGENT_
 * VISIBILITY): with restriction on, "does this campus member see only their own
 * agent?" is otherwise unanswerable without borrowing their credentials.
 *
 * It is deliberately the narrowest thing that answers that question.
 *
 * ─── Rails ───
 *
 *  1. READS ONLY. A view-as request may not mutate anything, so there is no
 *     path by which one person's action is recorded as another's, and no way to
 *     launder a privileged write through a less privileged identity. This one
 *     rail removes most of the risk surface, which is why it is first.
 *
 *  2. REPLACES, never unions. The effective actor takes the target's companies,
 *     memberships and admin flag — it does not keep the viewer's. Keeping them
 *     would both defeat the purpose (you would see more than the target does)
 *     and make this an escalation path.
 *
 *  3. Instance-admin is DROPPED unless the target has it in their own right.
 *
 *  4. Allowlisted by email AND gated on instance admin AND on a real session.
 *     An allowlisted email alone is not enough: an API key or agent token must
 *     never be able to assume another identity.
 *
 *  5. Audited on every request, against the REAL user — `viewAs.realUserId` is
 *     carried on the actor precisely so the log can name who was really acting.
 *
 * ─── What must NOT follow ───
 *
 * Personal memory must never follow a view-as. Memory belongs to a user and is
 * reachable by the agents MAPPED to that user (their `agent_memberships` rows),
 * so it is resolved from the agent, never from whoever is driving the request.
 * That makes memory orthogonal to this module by construction — as long as
 * memory resolution never reads `req.actor.userId`. If you are adding memory
 * code and reaching for the request's user, that is the bug this paragraph is
 * here to stop.
 *
 * ─── Known boundary ───
 *
 * The selection travels as a request header, and `EventSource` cannot set
 * headers. Plugin SSE streams (ui/src/plugins/bridge.ts) therefore stay on the
 * real user's scope while a view-as is active. Nothing leaks the other way —
 * the viewer only ever sees their OWN stream, never the viewed user's — so this
 * is a completeness gap in the simulation, not a disclosure. Worth knowing
 * before concluding "this person sees no live updates".
 *
 * The user-facing copy in this repo never says "impersonate" (see
 * packages/shared/src/responsible-user-denial.ts and its test); "view as" is
 * the term, because the viewer is looking, not acting.
 */

/** Request header carrying the user id to view as. */
export const VIEW_AS_HEADER = "x-paperclip-view-as-user";

/**
 * Who may use this at all. The lead developer's account only — this is a
 * debugging affordance for the person who maintains the visibility rules, not
 * a general admin capability. Deliberately not configurable at runtime: a
 * setting that widens who can assume another identity is exactly the setting an
 * attacker would go for.
 */
export const VIEW_AS_ALLOWED_EMAILS: readonly string[] = ["jay20020109@seasonart.org"];

/** HTTP methods a view-as request may use. Rail 1. */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ViewAsViewer = {
  type: string;
  userId?: string;
  userEmail?: string | null;
  isInstanceAdmin?: boolean;
  source?: string;
};

export type ViewAsTarget = {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  companyIds: string[];
  memberships: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
  isInstanceAdmin: boolean;
};

export type ViewAsProvenance = {
  realUserId: string;
  realUserEmail: string | null;
  viewingUserId: string;
};

function normalizeEmail(email: unknown): string | null {
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
}

/** Rail 4: allowlisted email, instance admin, board actor, real session. */
export function mayUseViewAs(viewer: ViewAsViewer): boolean {
  // Already viewing as someone: the actor has been swapped to the TARGET, who
  // is normally not permitted. Judging the swapped identity would 403 the very
  // request that lists who you may switch to, stranding the real person in
  // another identity with no way back. The permission belongs to whoever
  // started this — and the swap only happened because they passed this same
  // check — so re-check against the recorded real email.
  const provenance = (viewer as { viewAs?: { realUserEmail?: string | null } }).viewAs;
  if (provenance) return isViewAsAllowedEmail(provenance.realUserEmail);

  if (viewer.type !== "board") return false;
  // A board API key is not a person; only an interactive session may view as.
  if (viewer.source !== "session") return false;
  if (!viewer.isInstanceAdmin) return false;
  return isViewAsAllowedEmail(viewer.userEmail);
}

/** The allowlist test, shared by both branches above. */
function isViewAsAllowedEmail(rawEmail: string | null | undefined): boolean {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;
  return VIEW_AS_ALLOWED_EMAILS.some((allowed) => allowed.toLowerCase() === email);
}

/**
 * Why this view-as request is refused, or `null` when it is allowed.
 *
 * Returns a reason rather than a boolean so the middleware can log WHY a
 * refusal happened — a rejected view-as attempt is a security-relevant event,
 * and "denied" with no cause is not worth logging.
 */
export function viewAsDenialReason(
  viewer: ViewAsViewer,
  method: string,
  targetUserId: string | null,
): string | null {
  if (!targetUserId) return "no target user";
  if (!mayUseViewAs(viewer)) return "viewer is not permitted to view as another user";
  if (!READ_ONLY_METHODS.has(method.toUpperCase())) {
    return `view-as is read-only; ${method.toUpperCase()} is not permitted`;
  }
  if (viewer.userId && viewer.userId === targetUserId) return "already the acting user";
  return null;
}

/**
 * Build the effective actor for a permitted view-as request.
 *
 * Rails 2 and 3 live here: every scoping field comes from the target, and the
 * viewer's own privileges are not carried over. The only trace of the viewer is
 * `viewAs`, which exists for the audit log and must not be read as authority.
 */
export function buildViewAsActor<T extends Record<string, unknown>>(
  realActor: T & ViewAsViewer,
  target: ViewAsTarget,
): T & { viewAs: ViewAsProvenance } {
  return {
    ...realActor,
    type: "board",
    userId: target.userId,
    userName: target.userName ?? null,
    userEmail: target.userEmail ?? null,
    companyIds: [...target.companyIds],
    memberships: target.memberships,
    // Rail 3 — the target's own flag, never the viewer's.
    isInstanceAdmin: target.isInstanceAdmin,
    viewAs: {
      realUserId: String(realActor.userId ?? ""),
      realUserEmail: normalizeEmail(realActor.userEmail),
      viewingUserId: target.userId,
    },
  } as T & { viewAs: ViewAsProvenance };
}

/** Read the target user id from request headers, if present. */
export function readViewAsHeader(headers: Record<string, unknown>): string | null {
  const raw = headers[VIEW_AS_HEADER] ?? headers[VIEW_AS_HEADER.toUpperCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
