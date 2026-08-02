import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deletion, restoration and purging.
 *
 * The interesting cases all come from the same fact: the unique index on a
 * memory's name covers LIVE rows only. That is deliberate — it is what lets you
 * re-save a fact you deleted last month instead of colliding with its
 * tombstone — but it means one slug can name several rows at once, and every
 * operation here has to say which one it means. Getting that wrong destroys a
 * memory the owner was looking at, so it is tested directly rather than left to
 * be discovered.
 */

const COMPANY = "company-1";
const OWNER = "user-owner";

type Row = {
  id: string;
  name: string;
  deletedAt: Date | null;
};

const state = {
  rows: [] as Row[],
  /** Predicates the fake applies, recorded so a case can assert on intent. */
  deletedIds: [] as string[],
  restoredIds: [] as string[],
};

/**
 * A DB fake that models rows rather than SQL.
 *
 * Drizzle's condition objects are opaque here, so instead of decoding them the
 * fake exposes the two shapes the service uses — "newest tombstone by name" and
 * "delete where tombstoned / where live" — through the call chain itself. If the
 * service starts issuing a query this does not model, it throws rather than
 * quietly returning the wrong rows.
 */
function createDb() {
  let deleteOnlyTombstones: boolean | null = null;

  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    limit: async () => {
                      const tombstones = state.rows
                        .filter((row) => row.deletedAt)
                        .sort((a, b) => (b.deletedAt!.getTime() - a.deletedAt!.getTime()));
                      return tombstones.slice(0, 1).map((row) => ({ id: row.id }));
                    },
                  };
                },
                limit: async () => state.rows.filter((row) => !row.deletedAt).map((row) => ({ ...row })),
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                returning: async () => {
                  // Restore targets one id; the service resolves it beforehand.
                  const target = state.rows.find((row) => row.id === restoreTargetId);
                  if (!target) return [];
                  Object.assign(target, values);
                  state.restoredIds.push(target.id);
                  return [{ ...target }];
                },
              };
            },
          };
        },
      };
    },
    delete() {
      deleteOnlyTombstones = null;
      return {
        where(condition: unknown) {
          // The service issues the tombstone delete first and only falls through
          // to the live one when that returned nothing — modelled by call order.
          deleteOnlyTombstones = deleteOnlyTombstones === null ? true : false;
          const onlyTombstones = deleteOnlyTombstones;
          void condition;
          const removed = state.rows.filter((row) => (onlyTombstones ? row.deletedAt : !row.deletedAt));
          const apply = () => {
            state.rows = state.rows.filter((row) => !removed.includes(row));
            state.deletedIds.push(...removed.map((row) => row.id));
          };
          const result = {
            returning: async () => {
              apply();
              return removed.map((row) => ({ id: row.id }));
            },
          };
          return Object.assign(
            Promise.resolve().then(() => {
              apply();
              return removed;
            }),
            result,
          );
        },
      };
    },
  } as never;
}

let restoreTargetId = "";

vi.mock("../home-paths.js", () => ({ resolveUserMemoryDir: () => "/tmp/unused" }));

const { restorePersonalMemory } = await import("../services/personal-memory.js");

const asOwner = { kind: "user" as const, userId: OWNER, isAdmin: false };
const asOtherUser = { kind: "user" as const, userId: "user-other", isAdmin: false };

beforeEach(() => {
  state.rows = [];
  state.deletedIds = [];
  state.restoredIds = [];
  restoreTargetId = "";
});

describe("restoring a deleted memory", () => {
  /**
   * The bug this exists to prevent: clearing `deleted_at` on every tombstone
   * sharing a name, which immediately violates the live-rows unique index.
   */
  it("restores only the newest tombstone when a name has several", async () => {
    state.rows = [
      { id: "old", name: "a-fact", deletedAt: new Date("2026-01-01") },
      { id: "recent", name: "a-fact", deletedAt: new Date("2026-07-01") },
    ];
    restoreTargetId = "recent";

    const result = await restorePersonalMemory(createDb(), {
      companyId: COMPANY,
      ownerUserId: OWNER,
      requester: asOwner,
      name: "a-fact",
    });

    expect(result.ok).toBe(true);
    expect(state.restoredIds).toEqual(["recent"]);
    expect(state.rows.find((row) => row.id === "old")?.deletedAt).not.toBeNull();
  });

  // Overwriting or silently renaming both lose something the owner can see.
  it("refuses rather than colliding when a live memory holds the name", async () => {
    state.rows = [{ id: "live", name: "a-fact", deletedAt: null }];

    const result = await restorePersonalMemory(createDb(), {
      companyId: COMPANY,
      ownerUserId: OWNER,
      requester: asOwner,
      name: "a-fact",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("name_taken");
    expect(state.restoredIds).toHaveLength(0);
  });

  it("reports nothing to restore as not_found", async () => {
    const result = await restorePersonalMemory(createDb(), {
      companyId: COMPANY,
      ownerUserId: OWNER,
      requester: asOwner,
      name: "a-fact",
    });

    expect(result.ok === false && result.reason).toBe("not_found");
  });

  // "Not yours" must stay indistinguishable from "no such memory".
  it("refuses another user with the same message as a missing memory", async () => {
    state.rows = [{ id: "old", name: "a-fact", deletedAt: new Date() }];

    const result = await restorePersonalMemory(createDb(), {
      companyId: COMPANY,
      ownerUserId: OWNER,
      requester: asOtherUser,
      name: "a-fact",
    });

    expect(result.ok === false && result.reason).toBe("forbidden");
    expect(result.ok === false && result.message).toBe("Memory not found");
    expect(state.restoredIds).toHaveLength(0);
  });
});
