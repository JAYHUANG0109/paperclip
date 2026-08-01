import { describe, expect, it } from "vitest";
import {
  VIEW_AS_ALLOWED_EMAILS,
  VIEW_AS_HEADER,
  buildViewAsActor,
  mayUseViewAs,
  readViewAsHeader,
  viewAsDenialReason,
  type ViewAsTarget,
  type ViewAsViewer,
} from "../services/view-as-policy.js";

const LEAD = "jay20020109@seasonart.org";

function viewer(over: Partial<ViewAsViewer> = {}): ViewAsViewer {
  return {
    type: "board",
    userId: "user-lead",
    userEmail: LEAD,
    isInstanceAdmin: true,
    source: "session",
    ...over,
  };
}

function target(over: Partial<ViewAsTarget> = {}): ViewAsTarget {
  return {
    userId: "user-member",
    userEmail: "member@seasonart.org",
    userName: "Member",
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
    ...over,
  };
}

describe("mayUseViewAs", () => {
  it("allows the lead developer's signed-in session", () => {
    expect(mayUseViewAs(viewer())).toBe(true);
  });

  it("is case- and whitespace-insensitive about the email", () => {
    expect(mayUseViewAs(viewer({ userEmail: "  JAY20020109@SeasonArt.org " }))).toBe(true);
  });

  describe("refuses everyone else", () => {
    it("another instance admin", () => {
      expect(mayUseViewAs(viewer({ userEmail: "tang@seasonart.org" }))).toBe(false);
    });

    it("the lead developer without instance admin", () => {
      expect(mayUseViewAs(viewer({ isInstanceAdmin: false }))).toBe(false);
    });

    // Rail 4: an allowlisted email is not enough. A key is not a person, and a
    // leaked key must not be able to assume another identity.
    it("a board API key, even with the allowlisted email", () => {
      expect(mayUseViewAs(viewer({ source: "board_key" }))).toBe(false);
    });

    it("the local implicit board", () => {
      expect(mayUseViewAs(viewer({ source: "local_implicit" }))).toBe(false);
    });

    it("an agent actor", () => {
      expect(mayUseViewAs(viewer({ type: "agent" }))).toBe(false);
    });

    it("an unauthenticated actor", () => {
      expect(mayUseViewAs(viewer({ type: "none", userEmail: null }))).toBe(false);
    });

    it("an actor with no email", () => {
      expect(mayUseViewAs(viewer({ userEmail: null }))).toBe(false);
      expect(mayUseViewAs(viewer({ userEmail: "   " }))).toBe(false);
    });
  });

  it("keeps the allowlist to exactly one account", () => {
    expect(VIEW_AS_ALLOWED_EMAILS).toEqual([LEAD]);
  });
});

describe("viewAsDenialReason", () => {
  it("permits a GET for a permitted viewer", () => {
    expect(viewAsDenialReason(viewer(), "GET", "user-member")).toBeNull();
  });

  it("permits HEAD and OPTIONS", () => {
    expect(viewAsDenialReason(viewer(), "HEAD", "user-member")).toBeNull();
    expect(viewAsDenialReason(viewer(), "options", "user-member")).toBeNull();
  });

  // Rail 1 — the rail that removes most of the risk surface. Without it, a
  // write would be recorded against the viewed user rather than the viewer.
  it.each(["POST", "PATCH", "PUT", "DELETE"])("refuses %s", (method) => {
    expect(viewAsDenialReason(viewer(), method, "user-member")).toContain("read-only");
  });

  it("refuses a viewer who is not permitted, before checking the method", () => {
    expect(viewAsDenialReason(viewer({ userEmail: "other@seasonart.org" }), "GET", "user-member")).toBe(
      "viewer is not permitted to view as another user",
    );
  });

  it("refuses when no target is named", () => {
    expect(viewAsDenialReason(viewer(), "GET", null)).toBe("no target user");
  });

  it("refuses viewing as yourself", () => {
    expect(viewAsDenialReason(viewer(), "GET", "user-lead")).toBe("already the acting user");
  });

  it("gives a reason rather than a bare boolean, so refusals can be logged", () => {
    const reason = viewAsDenialReason(viewer({ source: "board_key" }), "GET", "user-member");
    expect(typeof reason).toBe("string");
    expect(reason).not.toBe("");
  });
});

describe("buildViewAsActor", () => {
  it("takes the target's identity and scoping", () => {
    const actor = buildViewAsActor(viewer(), target());

    expect(actor.userId).toBe("user-member");
    expect(actor.userEmail).toBe("member@seasonart.org");
    expect(actor.companyIds).toEqual(["company-1"]);
    expect(actor.memberships).toEqual([
      { companyId: "company-1", membershipRole: "operator", status: "active" },
    ]);
  });

  // Rail 3. Carrying the viewer's admin flag would both show more than the
  // target sees and make this an escalation path.
  it("drops instance admin when the target is not one", () => {
    expect(buildViewAsActor(viewer(), target()).isInstanceAdmin).toBe(false);
  });

  it("keeps instance admin when the target has it in their own right", () => {
    expect(buildViewAsActor(viewer(), target({ isInstanceAdmin: true })).isInstanceAdmin).toBe(true);
  });

  // Rail 2 — replaces, never unions. A viewer in many companies viewing a
  // member of one must see exactly that one.
  it("does not union the viewer's companies with the target's", () => {
    const wide = viewer() as ViewAsViewer & { companyIds: string[] };
    wide.companyIds = ["company-1", "company-2", "company-3"];

    expect(buildViewAsActor(wide, target()).companyIds).toEqual(["company-1"]);
  });

  it("records the real user for the audit log", () => {
    const actor = buildViewAsActor(viewer(), target());

    expect(actor.viewAs).toEqual({
      realUserId: "user-lead",
      realUserEmail: LEAD,
      viewingUserId: "user-member",
    });
  });

  it("does not mutate the actor it was given", () => {
    const original = viewer();
    const snapshot = { ...original };
    buildViewAsActor(original, target());

    expect(original).toEqual(snapshot);
  });

  it("copies the company list so later mutation cannot leak between actors", () => {
    const t = target();
    const actor = buildViewAsActor(viewer(), t);
    t.companyIds.push("company-sneaked-in");

    expect(actor.companyIds).toEqual(["company-1"]);
  });
});

describe("readViewAsHeader", () => {
  it("reads the header", () => {
    expect(readViewAsHeader({ [VIEW_AS_HEADER]: "user-member" })).toBe("user-member");
  });

  it("trims and ignores blanks", () => {
    expect(readViewAsHeader({ [VIEW_AS_HEADER]: "  user-member  " })).toBe("user-member");
    expect(readViewAsHeader({ [VIEW_AS_HEADER]: "   " })).toBeNull();
  });

  it("takes the first value when the header repeats", () => {
    expect(readViewAsHeader({ [VIEW_AS_HEADER]: ["user-a", "user-b"] })).toBe("user-a");
  });

  it("returns null when absent", () => {
    expect(readViewAsHeader({})).toBeNull();
  });
});
