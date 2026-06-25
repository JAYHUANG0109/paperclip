import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projects, issues } from "@paperclipai/db";

/**
 * Phase 8 — server-side wiki distillation (route B2).
 *
 * The plugin-llm-wiki "Wiki Maintainer" agent cannot auto-distill on the
 * claude-local adapter (no wiki MCP tools at runtime + the wiki root lives
 * outside the agent sandbox). This module bypasses the agent: it reads
 * Paperclip data directly from the DB and renders deterministic, executive
 * standup pages into the same wiki tree the plugin serves — no LLM required,
 * so it is cheap, reproducible, and safe to run on a daily schedule.
 *
 * It can later be upgraded to LLM-summarized prose without changing the
 * scheduling/IO around it (swap the render* functions).
 */

const ACTIVE_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

export interface DistillProjectRow {
  id: string;
  name: string;
  status: string;
  targetDate: string | null;
}

export interface DistillIssueRow {
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  updatedAt: Date;
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return base || "project";
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Pure: render one project's standup page (today's concise status). */
export function renderProjectStandup(
  project: DistillProjectRow,
  projectIssues: DistillIssueRow[],
  now: Date,
): string {
  const today = isoDate(now);
  const slug = slugify(project.name);
  const active = projectIssues.filter((i) => ACTIVE_STATUSES.has(i.status));
  const blocked = projectIssues.filter((i) => i.status === "blocked");
  const inReview = projectIssues.filter((i) => i.status === "in_review");
  const done = projectIssues.filter((i) => i.status === "done");

  const fmtIssue = (i: DistillIssueRow) =>
    `- ${i.identifier ? `\`${i.identifier}\` ` : ""}${i.title} _(${i.priority})_${
      i.dueDate ? ` · due ${i.dueDate}` : ""
    }`;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: ${project.name} — Standup`);
  lines.push("type: project");
  lines.push("tags: [standup, auto-distilled]");
  lines.push(`created: ${today}`);
  lines.push(`updated: ${today}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${project.name} — Standup`);
  lines.push("");
  lines.push(
    `_Auto-distilled ${today}. Status: **${project.status}**${
      project.targetDate ? ` · target ${project.targetDate}` : ""
    }._`,
  );
  lines.push("");
  lines.push(
    `Durable page: [[wiki/projects/${slug}/index]] · ${active.length} active · ${done.length} done · ${blocked.length} blocked.`,
  );
  lines.push("");

  if (blocked.length) {
    lines.push("## Blockers");
    lines.push(...blocked.map(fmtIssue));
    lines.push("");
  }
  if (inReview.length) {
    lines.push("## In review");
    lines.push(...inReview.map(fmtIssue));
    lines.push("");
  }
  lines.push("## Active work");
  lines.push(
    ...(active.filter((i) => i.status !== "blocked" && i.status !== "in_review").length
      ? active.filter((i) => i.status !== "blocked" && i.status !== "in_review").map(fmtIssue)
      : ["_(none)_"]),
  );
  lines.push("");
  if (done.length) {
    lines.push("## Recently completed");
    lines.push(...done.slice(0, 10).map(fmtIssue));
    lines.push("");
  }
  return lines.join("\n");
}

/** Pure: render the durable project index page (created once, kept if present). */
export function renderProjectIndex(project: DistillProjectRow, now: Date): string {
  const today = isoDate(now);
  const slug = slugify(project.name);
  return [
    "---",
    `title: ${project.name}`,
    "type: project",
    "tags: [auto-distilled]",
    `created: ${today}`,
    `updated: ${today}`,
    "---",
    "",
    `# ${project.name}`,
    "",
    "_Durable knowledge page. Edit freely — the distiller will not overwrite this file once it exists._",
    "",
    "## What this is",
    "",
    "_(describe the project's purpose, scope, and long-lived context)_",
    "",
    "## Current status",
    "",
    `See the live standup: [[wiki/projects/${slug}/standup]].`,
    "",
  ].join("\n");
}

/** Pure: render the top-level index Projects section. */
export function renderIndex(projectList: DistillProjectRow[], now: Date): string {
  const today = isoDate(now);
  const projectLines = projectList.length
    ? projectList
        .map(
          (p) =>
            `- [[wiki/projects/${slugify(p.name)}/standup]] — ${p.name} _(${p.status})_`,
        )
        .join("\n")
    : "_(none yet)_";
  return [
    "# Index",
    "",
    `Catalog of durable wiki pages and linked project standups. Updated on every ingest or Paperclip distill. Last auto-distill: ${today}.`,
    "",
    "## Projects",
    "",
    projectLines,
    "",
    "## Entities",
    "",
    "_(maintained by the wiki maintainer)_",
    "",
    "## Concepts",
    "",
    "_(maintained by the wiki maintainer)_",
    "",
  ].join("\n");
}

export interface DistillResult {
  projectsWritten: number;
  wikiRoot: string;
  ranAt: string;
}

/**
 * Run a full company distillation pass: query projects + issues and write
 * standup pages, durable index stubs, the top-level index, and a log entry.
 */
export async function distillCompanyWiki(opts: {
  db: Db;
  companyId: string;
  wikiRoot: string;
  now?: Date;
}): Promise<DistillResult> {
  const { db, companyId, wikiRoot } = opts;
  const now = opts.now ?? new Date();
  const wikiDir = join(wikiRoot, "wiki");
  const projectsDir = join(wikiDir, "projects");

  const projectRows = (await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      targetDate: projects.targetDate,
    })
    .from(projects)
    .where(eq(projects.companyId, companyId))) as DistillProjectRow[];

  for (const project of projectRows) {
    const projectIssues = (await db
      .select({
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        dueDate: issues.dueDate,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.projectId, project.id)))
      .orderBy(desc(issues.updatedAt))) as DistillIssueRow[];

    const slug = slugify(project.name);
    const dir = join(projectsDir, slug);
    await mkdir(dir, { recursive: true });

    // Standup is always rewritten (today's concise status).
    await writeFile(join(dir, "standup.md"), renderProjectStandup(project, projectIssues, now), "utf8");

    // Durable index is created once, then left for humans/the maintainer to edit.
    const indexPath = join(dir, "index.md");
    if (!(await fileExists(indexPath))) {
      await writeFile(indexPath, renderProjectIndex(project, now), "utf8");
    }
  }

  await mkdir(wikiDir, { recursive: true });
  await writeFile(join(wikiDir, "index.md"), renderIndex(projectRows, now), "utf8");

  await appendLog(
    join(wikiDir, "log.md"),
    `## [${isoDate(now)}] distill | server-side auto-distill\n- rewrote ${projectRows.length} project standup page(s)\n- refreshed \`wiki/index.md\`\n`,
  );

  return { projectsWritten: projectRows.length, wikiRoot, ranAt: now.toISOString() };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function appendLog(logPath: string, entry: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(logPath, "utf8");
  } catch {
    existing = "# Log\n\nAppend-only chronological record of wiki operations.\n";
  }
  await writeFile(logPath, `${existing.trimEnd()}\n\n${entry.trimEnd()}\n`, "utf8");
}
