import { describe, expect, it } from "vitest";
import { buildColleagueAgentRequest } from "./NewColleagueAgentForm";
import { groupsForCampuses } from "@/lib/org-chart-options";

describe("groupsForCampuses", () => {
  it("offers 部門 for 總管理處 and 組 for schools", () => {
    expect(groupsForCampuses(["總管理處"])).toContain("資訊部");
    expect(groupsForCampuses(["總管理處"])).not.toContain("幼教教學組");
    expect(groupsForCampuses(["市政"])).toContain("幼教教學組");
    expect(groupsForCampuses(["市政"])).not.toContain("資訊部");
  });

  // 跨校巡輔 exists only at 仁美 per doc/sa-org-chart.md; offering it elsewhere
  // would invite a reporting line the org chart has no rule for.
  it("offers 跨校巡輔 only when 仁美 is selected", () => {
    expect(groupsForCampuses(["仁美"])).toContain("跨校巡輔");
    expect(groupsForCampuses(["北屯"])).not.toContain("跨校巡輔");
  });

  it("merges options when a cross-campus person spans both", () => {
    const g = groupsForCampuses(["仁美", "總管理處"]);
    expect(g).toContain("跨校巡輔");
    expect(g).toContain("資訊部");
  });
});

describe("buildColleagueAgentRequest", () => {
  const draft = {
    name: "王小明", nickname: "小明", email: "ming@seasonart.org",
    campuses: ["市政"], groups: ["註冊組"], positions: ["註冊組長"],
  };

  it("carries every field into the request", () => {
    const body = buildColleagueAgentRequest(draft);
    for (const v of ["王小明", "小明", "ming@seasonart.org", "市政", "註冊組", "註冊組長"]) {
      expect(body).toContain(v);
    }
  });

  // The whole point of the form: without assignedUserEmail the agent can never
  // be claimed at sign-in, so the instruction must survive verbatim.
  it("instructs the fulfilling agent to set assignedUserEmail", () => {
    expect(buildColleagueAgentRequest(draft)).toContain("adapterConfig.assignedUserEmail");
  });

  it("points at the org chart rather than letting the agent guess reportsTo", () => {
    expect(buildColleagueAgentRequest(draft)).toContain("doc/sa-org-chart.md");
  });

  it("marks blanks explicitly so they are not silently invented", () => {
    const body = buildColleagueAgentRequest({ ...draft, nickname: "", positions: [] });
    expect(body).toContain("（未填）");
  });
});
