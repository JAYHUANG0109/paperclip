import { describe, expect, it } from "vitest";
import { extractWakeCommentIds } from "../services/heartbeat.js";

// Regression: optimistic dashboard comments carry a synthetic id like
// "pending-<uuid>". That id must never reach the run-setup query that looks
// comments up by `issue_comments.id` (a uuid column) — it would crash setup with
// `invalid input syntax for type uuid`. extractWakeCommentIds drops non-uuids.
describe("extractWakeCommentIds uuid filtering", () => {
  const realUuid = "f2a9a21b-4c64-4b69-91b0-5627825511ed";

  it("keeps valid uuids and drops synthetic/non-uuid ids", () => {
    const ids = extractWakeCommentIds({
      wakeCommentIds: [realUuid, `pending-${realUuid}`, "not-a-uuid", "", null],
    });
    expect(ids).toEqual([realUuid]);
  });

  it("returns [] when there are no valid ids", () => {
    expect(extractWakeCommentIds({ wakeCommentIds: ["pending-x", "nope"] })).toEqual([]);
    expect(extractWakeCommentIds({})).toEqual([]);
    expect(extractWakeCommentIds(null)).toEqual([]);
  });
});
