import { describe, it, expect } from "vitest";
import {
  slugify,
  renderProjectStandup,
  renderIndex,
  type DistillProjectRow,
  type DistillIssueRow,
} from "../wiki-distillation.js";

const NOW = new Date("2026-06-25T00:00:00Z");

describe("wiki-distillation render", () => {
  it("slugifies names (incl. CJK)", () => {
    expect(slugify("Finance Pilot")).toBe("finance-pilot");
    expect(slugify("  Spaces  &  Symbols!! ")).toBe("spaces-symbols");
    expect(slugify("四季 藝術")).toBe("四季-藝術");
    expect(slugify("")).toBe("project");
  });

  it("renders a standup with frontmatter, blockers, and active work", () => {
    const project: DistillProjectRow = {
      id: "p1",
      name: "Finance Pilot",
      status: "in_progress",
      targetDate: "2026-07-01",
    };
    const issues: DistillIssueRow[] = [
      { identifier: "SEAAA-1", title: "Connect Odoo", status: "blocked", priority: "high", dueDate: "2026-06-30", updatedAt: NOW },
      { identifier: "SEAAA-2", title: "Build dashboard", status: "in_progress", priority: "medium", dueDate: null, updatedAt: NOW },
      { identifier: "SEAAA-3", title: "Kickoff", status: "done", priority: "low", dueDate: null, updatedAt: NOW },
    ];
    const md = renderProjectStandup(project, issues, NOW);
    expect(md).toContain("title: Finance Pilot — Standup");
    expect(md).toContain("type: project");
    expect(md).toContain("updated: 2026-06-25");
    expect(md).toContain("Status: **in_progress**");
    expect(md).toContain("target 2026-07-01");
    expect(md).toContain("## Blockers");
    expect(md).toContain("`SEAAA-1` Connect Odoo");
    expect(md).toContain("due 2026-06-30");
    expect(md).toContain("## Active work");
    expect(md).toContain("`SEAAA-2` Build dashboard");
    expect(md).toContain("## Recently completed");
    expect(md).toContain("[[wiki/projects/finance-pilot/index]]");
  });

  it("renders active work fallback when empty", () => {
    const md = renderProjectStandup(
      { id: "p", name: "Empty", status: "backlog", targetDate: null },
      [],
      NOW,
    );
    expect(md).toContain("## Active work");
    expect(md).toContain("_(none)_");
  });

  it("renders the index with project standup backlinks", () => {
    const projects: DistillProjectRow[] = [
      { id: "p1", name: "Finance Pilot", status: "in_progress", targetDate: null },
      { id: "p2", name: "IT Pilot", status: "planned", targetDate: null },
    ];
    const md = renderIndex(projects, NOW);
    expect(md).toContain("[[wiki/projects/finance-pilot/standup]] — Finance Pilot");
    expect(md).toContain("[[wiki/projects/it-pilot/standup]] — IT Pilot");
    expect(md).toContain("Last auto-distill: 2026-06-25");
  });
});
