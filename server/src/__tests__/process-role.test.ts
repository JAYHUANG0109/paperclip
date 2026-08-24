import { afterEach, describe, expect, it } from "vitest";
import { isSchedulerLeader, ownsSingletonResources, processRole } from "../lib/process-role.ts";

const ORIGINAL = process.env.PAPERCLIP_PROCESS_ROLE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PAPERCLIP_PROCESS_ROLE;
  else process.env.PAPERCLIP_PROCESS_ROLE = ORIGINAL;
});

describe("process role", () => {
  /**
   * The whole point of landing this before clustering: today's single process
   * must keep running every scheduler exactly as it does now. If this ever goes
   * false in an unclustered deployment, heartbeats and digests silently stop.
   */
  it("defaults an unclustered process to leader, so nothing changes today", () => {
    delete process.env.PAPERCLIP_PROCESS_ROLE;
    expect(processRole()).toBe("leader");
    expect(isSchedulerLeader()).toBe(true);
    expect(ownsSingletonResources()).toBe(true);
  });

  it("honours an explicit worker role", () => {
    process.env.PAPERCLIP_PROCESS_ROLE = "worker";
    expect(processRole()).toBe("worker");
    expect(isSchedulerLeader()).toBe(false);
    // A worker must never touch embedded PG's data directory.
    expect(ownsSingletonResources()).toBe(false);
  });

  it("honours an explicit leader role", () => {
    process.env.PAPERCLIP_PROCESS_ROLE = "leader";
    expect(isSchedulerLeader()).toBe(true);
  });

  it("ignores an unrecognised value rather than guessing", () => {
    process.env.PAPERCLIP_PROCESS_ROLE = "banana";
    expect(processRole()).toBe("leader");
  });

  it("is case- and whitespace-insensitive", () => {
    process.env.PAPERCLIP_PROCESS_ROLE = "  WORKER ";
    expect(processRole()).toBe("worker");
  });
});
