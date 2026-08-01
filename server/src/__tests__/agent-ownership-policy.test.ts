import { describe, expect, it } from "vitest";
import {
  agentOwnershipConfigChanges,
  mayChangeAgentOwnership,
  preserveAgentOwnershipConfig,
  stripAgentOwnershipConfig,
} from "../services/agent-ownership-policy.js";

const OPERATOR = { actorType: "board", isPrivileged: false };
const ADMIN = { actorType: "board", isPrivileged: true };
const AGENT = { actorType: "agent", isPrivileged: true };

describe("agent ownership config policy", () => {
  describe("what counts as a change", () => {
    it("flags a newly set owner email", () => {
      expect(agentOwnershipConfigChanges({ assignedUserEmail: "bob@x.org" }, {}))
        .toEqual(["adapterConfig.assignedUserEmail"]);
    });

    it("flags a role escalation to owner", () => {
      expect(agentOwnershipConfigChanges(
        { assignedUserRole: "owner" },
        { assignedUserRole: "operator" },
      )).toEqual(["adapterConfig.assignedUserRole"]);
    });

    it("flags both keys when the whole mapping is rewritten", () => {
      expect(agentOwnershipConfigChanges(
        { assignedUserEmail: "attacker@x.org", assignedUserRole: "owner" },
        { assignedUserEmail: "victim@x.org", assignedUserRole: "operator" },
      )).toEqual(["adapterConfig.assignedUserEmail", "adapterConfig.assignedUserRole"]);
    });

    // The UI PATCHes the entire adapterConfig back on every edit, so echoing the
    // stored value must stay free — otherwise operators lose the ability to edit
    // anything at all on an agent that has an owner.
    it("does NOT flag an unchanged value echoed back", () => {
      expect(agentOwnershipConfigChanges(
        { assignedUserEmail: "bob@x.org", cwd: "/srv/new" },
        { assignedUserEmail: "bob@x.org", cwd: "/srv/old" },
      )).toEqual([]);
    });

    // Compared the way the sign-in matcher compares (trim + lowercase), so a
    // re-cased echo is not treated as a privilege change.
    it("does NOT flag a value differing only by case or padding", () => {
      expect(agentOwnershipConfigChanges(
        { assignedUserEmail: "  Bob@X.org " },
        { assignedUserEmail: "bob@x.org" },
      )).toEqual([]);
    });

    it("does NOT flag a write that omits the keys entirely", () => {
      expect(agentOwnershipConfigChanges({ cwd: "/srv" }, { assignedUserEmail: "bob@x.org" }))
        .toEqual([]);
    });

    it("flags an explicit null as a change (clearing is a change)", () => {
      expect(agentOwnershipConfigChanges(
        { assignedUserEmail: null },
        { assignedUserEmail: "bob@x.org" },
      )).toEqual(["adapterConfig.assignedUserEmail"]);
    });

    it("ignores non-ownership keys", () => {
      expect(agentOwnershipConfigChanges({ cwd: "/srv", env: { A: "1" } }, {})).toEqual([]);
    });
  });

  describe("who may change ownership", () => {
    // THE ESCALATION THIS POLICY EXISTS TO STOP: an operator tagging any agent
    // with their own email at role "owner" would, at their next sign-in, be
    // granted company owner membership plus instance_admin.
    it("DENIES an operator", () => {
      expect(mayChangeAgentOwnership(OPERATOR)).toBe(false);
    });

    it("ALLOWS a company owner/admin", () => {
      expect(mayChangeAgentOwnership(ADMIN)).toBe(true);
    });

    // An agent must not be able to re-home itself, even though agent actors are
    // reported as "privileged" by the member-view predicate.
    it("DENIES an agent-authenticated caller even when privileged", () => {
      expect(mayChangeAgentOwnership(AGENT)).toBe(false);
    });

    it("DENIES an unauthenticated caller", () => {
      expect(mayChangeAgentOwnership({ actorType: "none", isPrivileged: false })).toBe(false);
    });

    // isPrivilegedMemberViewer — the source of `isPrivileged` — reports EVERY
    // non-board actor as privileged, so it hands this function isPrivileged:true
    // for an unauthenticated caller. Testing isPrivileged alone would let that
    // through; the actor-type allowlist is what stops it.
    it("DENIES an unauthenticated caller even when reported as privileged", () => {
      expect(mayChangeAgentOwnership({ actorType: "none", isPrivileged: true })).toBe(false);
    });

    it("DENIES an unrecognized actor type", () => {
      expect(mayChangeAgentOwnership({ actorType: "cloud_tenant", isPrivileged: true })).toBe(false);
    });
  });

  describe("ownership keys are sticky", () => {
    // A replaceAdapterConfig write that omits the keys would otherwise unlink the
    // agent from its owner and revoke that person's access at next sign-in.
    it("carries the owner forward when the write omits it", () => {
      expect(preserveAgentOwnershipConfig(
        { assignedUserEmail: "bob@x.org", assignedUserRole: "operator" },
        { cwd: "/srv" },
      )).toEqual({ cwd: "/srv", assignedUserEmail: "bob@x.org", assignedUserRole: "operator" });
    });

    it("does not overwrite an explicitly provided owner", () => {
      expect(preserveAgentOwnershipConfig(
        { assignedUserEmail: "bob@x.org" },
        { assignedUserEmail: "carol@x.org" },
      )).toEqual({ assignedUserEmail: "carol@x.org" });
    });

    // Clearing must remain possible — it just has to be explicit, and explicit
    // means it registers as a change and needs admin rights.
    it("preserves an explicit null so an authorized clear still clears", () => {
      expect(preserveAgentOwnershipConfig(
        { assignedUserEmail: "bob@x.org" },
        { assignedUserEmail: null },
      )).toEqual({ assignedUserEmail: null });
    });

    it("adds nothing when there was no owner to begin with", () => {
      expect(preserveAgentOwnershipConfig({}, { cwd: "/srv" })).toEqual({ cwd: "/srv" });
    });
  });

  describe("stripping ownership from untrusted input", () => {
    // Company import creates AND updates agents straight from a manifest, and
    // importing into an existing company needs only company access. Without the
    // strip, an operator could import an agent tagged with their own email at
    // role "owner" and reach instance_admin the same way the route guard blocks.
    it("removes both ownership keys and reports them", () => {
      expect(stripAgentOwnershipConfig({
        cwd: "/srv",
        assignedUserEmail: "attacker@x.org",
        assignedUserRole: "owner",
      })).toEqual({
        adapterConfig: { cwd: "/srv" },
        stripped: ["assignedUserEmail", "assignedUserRole"],
      });
    });

    it("leaves everything else alone and reports nothing when there is nothing to strip", () => {
      expect(stripAgentOwnershipConfig({ cwd: "/srv", env: { A: "1" } })).toEqual({
        adapterConfig: { cwd: "/srv", env: { A: "1" } },
        stripped: [],
      });
    });

    // An explicit null still overwrites on import, so it has to go too.
    it("strips an explicit null", () => {
      expect(stripAgentOwnershipConfig({ assignedUserEmail: null })).toEqual({
        adapterConfig: {},
        stripped: ["assignedUserEmail"],
      });
    });

    it("does not mutate the input", () => {
      const input = { assignedUserEmail: "a@x.org", cwd: "/srv" };
      stripAgentOwnershipConfig(input);
      expect(input).toEqual({ assignedUserEmail: "a@x.org", cwd: "/srv" });
    });
  });
});
