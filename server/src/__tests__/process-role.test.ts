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

describe("cluster worker count parsing", () => {
  // Mirrors resolveClusterWorkerCount in index.ts. Clustering must be OFF unless
  // deliberately turned on: shipping the code should not enable it.
  function resolve(raw: string | undefined, cpuCount = 14): number {
    if (!raw) return 0;
    if (raw.trim().toLowerCase() === "auto") return Math.max(2, Math.min(8, cpuCount - 2));
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed < 0) return 0;
    return parsed;
  }

  it("is off when unset", () => {
    expect(resolve(undefined)).toBe(0);
    expect(resolve("")).toBe(0);
  });

  it("treats 0 and 1 as not-clustered", () => {
    expect(resolve("0")).toBe(0);
    expect(resolve("1")).toBe(1); // < 2, so the caller runs single-process
  });

  it("leaves headroom on auto rather than claiming every core", () => {
    expect(resolve("auto", 14)).toBe(8);
    expect(resolve("auto", 4)).toBe(2);
  });

  it("ignores garbage instead of guessing a worker count", () => {
    expect(resolve("banana")).toBe(0);
    expect(resolve("-3")).toBe(0);
    expect(resolve("2.5")).toBe(0);
  });
});
