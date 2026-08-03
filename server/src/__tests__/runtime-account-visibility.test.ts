import { describe, expect, it } from "vitest";
import {
  mayViewRuntimeAccounts,
  runtimeAccountViewerReason,
} from "../services/runtime-account-visibility.js";
import { IT_EDITOR_USER_EMAILS } from "../services/agent-edit-policy.js";

describe("mayViewRuntimeAccounts", () => {
  it("allows the instance admin / local board", () => {
    expect(mayViewRuntimeAccounts({ isInstanceAdmin: true })).toBe(true);
    expect(runtimeAccountViewerReason({ isInstanceAdmin: true })).toBe("instance_admin");
  });

  it("allows company owners and admins without needing a grant row", () => {
    expect(mayViewRuntimeAccounts({ membershipRole: "owner" })).toBe(true);
    expect(mayViewRuntimeAccounts({ membershipRole: "admin" })).toBe(true);
    expect(runtimeAccountViewerReason({ membershipRole: "admin" })).toBe("company_admin");
  });

  it("allows every 資訊部 member from the shared allowlist", () => {
    for (const email of IT_EDITOR_USER_EMAILS) {
      expect(mayViewRuntimeAccounts({ email })).toBe(true);
      expect(runtimeAccountViewerReason({ email })).toBe("it_department");
    }
  });

  it("matches 資訊部 emails case-insensitively", () => {
    expect(mayViewRuntimeAccounts({ email: "IT-Jessica@SeasonArt.org" })).toBe(true);
  });

  it("allows anyone holding an explicit runtime:view_accounts grant", () => {
    expect(mayViewRuntimeAccounts({ hasExplicitGrant: true })).toBe(true);
    expect(runtimeAccountViewerReason({ hasExplicitGrant: true })).toBe("explicit_grant");
  });

  it("denies an ordinary member with no grant", () => {
    const viewer = { membershipRole: "operator", email: "someone@seasonart.org" };
    expect(mayViewRuntimeAccounts(viewer)).toBe(false);
    expect(runtimeAccountViewerReason(viewer)).toBeNull();
  });

  it("denies viewers and unauthenticated-shaped input", () => {
    expect(mayViewRuntimeAccounts({ membershipRole: "viewer" })).toBe(false);
    expect(mayViewRuntimeAccounts({})).toBe(false);
    expect(mayViewRuntimeAccounts({ email: null, membershipRole: null })).toBe(false);
  });

  // Read-only visibility must not be widened by runtime *control* permissions
  // arriving on the actor from elsewhere — the only grant that counts is the
  // one this module names.
  it("does not treat an unrelated role string as privileged", () => {
    expect(mayViewRuntimeAccounts({ membershipRole: "tools:manage_runtime" })).toBe(false);
    expect(mayViewRuntimeAccounts({ membershipRole: "Owner" })).toBe(false);
  });
});
