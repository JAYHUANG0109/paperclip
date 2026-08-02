import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/manifest.js";

/**
 * The shipped defaults are a security surface, so they get asserted directly.
 *
 * Every other test in this suite passes an explicit config, which means none of
 * them would notice `gateUnassigned` flipping back to `false`. That matters more
 * than usual here: the live value lives in the `plugin_config` table, so restoring
 * a database snapshot from before an operator turned it on silently reopens the
 * bot to anyone who can find it. That is exactly what happened during the
 * 2026-08-02 Mac mini host migration. Keeping the safe value in code — and pinned
 * by this test — means a restore can no longer undo it.
 */
describe("google-chat shipped defaults", () => {
  it("gates unassigned senders out of the box", () => {
    // A fresh install must not answer arbitrary senders via defaultAgentUrlKey.
    expect(DEFAULT_CONFIG.gateUnassigned).toBe(true);
  });

  it("has a message to send the senders it turns away", () => {
    // gateUnassigned is only humane if the turned-away sender is told what to do.
    expect(DEFAULT_CONFIG.unassignedMessage.trim()).not.toBe("");
    expect(DEFAULT_CONFIG.unassignedMessage).toContain("資訊部");
  });

  it("verifies Google's signature on inbound webhooks out of the box", () => {
    expect(DEFAULT_CONFIG.verifyInbound).toBe(true);
  });

  it("does not ship a host-specific audience", () => {
    // expectedAudience is the app's own public URL, which differs per deployment
    // and changes whenever the Funnel host moves. An empty default skips only the
    // audience comparison; signature and issuer checks are unaffected.
    expect(DEFAULT_CONFIG.expectedAudience).toBe("");
  });

  it("still ships bring-up echo mode — known gap, pinned deliberately", () => {
    // NOT an endorsement. echoMode is the bring-up aid from the original transport
    // test (worker.ts replies `echo: <text>` instead of routing to an agent), and
    // real routing has long since landed — the live instance has it off.
    //
    // It has the same shape of problem `gateUnassigned` had: the correct value only
    // exists as an operator-set row in `plugin_config`, so restoring an older
    // database snapshot would put a production bot back into parroting messages.
    // Flipping the default is a behaviour change for every install, so it is left
    // for an explicit decision rather than folded into the gateUnassigned change.
    //
    // This assertion exists so that decision is conscious: change the default and
    // this test fails, prompting you to update it.
    expect(DEFAULT_CONFIG.echoMode).toBe(true);
  });
});
