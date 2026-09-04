import { describe, expect, it } from "vitest";
import { groupItemsByTeam } from "./agent-teams";

type Item = { id: string; teams: string[] };
const item = (id: string, teams: string[]): Item => ({ id, teams });

describe("groupItemsByTeam", () => {
  it("groups by campus (teams[0]) with departments nested under (teams[1])", () => {
    const groups = groupItemsByTeam(
      [
        item("a", ["西屯", "幼教教學組"]),
        item("b", ["西屯", "幼教教學組"]),
        item("c", ["西屯", "外師教學組"]),
        item("d", ["西屯"]), // campus, no department
      ],
      (i) => i.teams,
    );
    expect(groups).toHaveLength(1);
    const xitun = groups[0]!;
    expect(xitun.team).toBe("西屯");
    expect(xitun.items.map((i) => i.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(xitun.directItems.map((i) => i.id)).toEqual(["d"]);
    expect(xitun.subGroups.map((s) => s.team)).toEqual(["幼教教學組", "外師教學組"]);
    expect(xitun.subGroups[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("keeps top-level groups DISJOINT — an agent lands in exactly one campus", () => {
    // The same department name under two campuses stays separate, and no agent
    // appears under more than one top. This is what stops a selection in one
    // campus from bleeding a partial state into another.
    const groups = groupItemsByTeam(
      [
        item("x", ["西屯", "幼教教學組"]),
        item("y", ["仁美", "幼教教學組"]),
      ],
      (i) => i.teams,
    );
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids.sort()).toEqual(["x", "y"]);
    // Each campus is its own top with its own 幼教教學組 subgroup.
    expect(groups.map((g) => g.team).sort()).toEqual(["仁美", "西屯"]);
    for (const g of groups) expect(g.items).toHaveLength(1);
  });

  it("omits items with no team (they are shared individually, not as a team)", () => {
    const groups = groupItemsByTeam([item("a", []), item("b", ["黎明"])], (i) => i.teams);
    expect(groups.map((g) => g.team)).toEqual(["黎明"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("sorts infrastructure teams (系統自動化) last", () => {
    const groups = groupItemsByTeam(
      [item("infra", ["系統自動化"]), item("user", ["仁美"])],
      (i) => i.teams,
    );
    expect(groups.map((g) => g.team)).toEqual(["仁美", "系統自動化"]);
  });
});
