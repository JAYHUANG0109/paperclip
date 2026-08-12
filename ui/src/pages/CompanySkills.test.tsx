// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { CompanySkillDetail, CompanySkillVersion, FolderListResult } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscoveryGrid,
  SkillDetailPage,
  getSkillVersionDiffSelection,
  resolveDiscoveryTab,
  withDiscoveryTab,
  skillDetailBreadcrumbs,
} from "./CompanySkills";
import { skillStudioNewRoute } from "../lib/company-skill-routes";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type = "button",
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: ComponentProps<"button"> & { asChild?: boolean; variant?: string; size?: string }) => (
    <button type={type} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>{children}</button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>{children}</button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (props: ComponentProps<"input">) => <input type="checkbox" {...props} />,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <textarea readOnly value={value} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function makeVersion(revisionNumber: number, content: string): CompanySkillVersion {
  return {
    id: `version-${revisionNumber}`,
    companyId: "company-1",
    companySkillId: "skill-1",
    revisionNumber,
    label: null,
    releaseId: null,
    releaseName: null,
    releasedAt: null,
    fileInventory: [
      {
        path: "SKILL.md",
        kind: "skill",
        content,
      },
    ],
    authorAgentId: null,
    authorUserId: null,
    createdAt: new Date(`2026-01-0${revisionNumber}T00:00:00Z`),
  };
}

/**
 * Set a controlled input/select through the native value setter so React picks up
 * the change. Both helpers were called by cases in this file but never defined —
 * the calls arrived from upstream while the definitions did not.
 */
async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}


function makeDetail(
  currentVersion: CompanySkillVersion,
  overrides: Partial<CompanySkillDetail> = {},
): CompanySkillDetail {
  return {
    id: "skill-1",
    companyId: "company-1",
    key: "demo-skill",
    slug: "demo-skill",
    name: "Demo Skill",
    description: "A demo skill.",
    markdown: "# Demo Skill",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    iconUrl: null,
    color: null,
    tagline: null,
    authorName: null,
    homepageUrl: null,
    categories: [],
    sharingScope: "private",
    sharingTeams: [],
    createdByUserId: null,
    minutesPerUse: 0,
    approvalStatus: "approved",
    approvalNote: null,
    reviewedByUserId: null,
    reviewedAt: null,
    submittedAt: null,
    publicShareToken: null,
    forkedFromSkillId: null,
    forkedFromCompanyId: null,
    starCount: 0,
    installCount: 0,
    forkCount: 0,
    currentVersionId: currentVersion.id,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    attachedAgentCount: 0,
    usedByAgents: [],
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: null,
    currentVersion,
    starredByCurrentActor: false,
    ...overrides,
  } as CompanySkillDetail;
}

function skillDetailElement(
  versions: CompanySkillVersion[],
  props: Partial<ComponentProps<typeof SkillDetailPage>>,
) {
  return (
    <SkillDetailPage
      detail={makeDetail(versions[0]!)}
      loading={false}
      activeTab="versions"
      onTabChange={vi.fn()}
      onUpdateSettings={vi.fn()}
      updateSettingsPending={false}
      selectedPath="SKILL.md"
      file={null}
      fileLoading={false}
      viewMode="preview"
      editMode={false}
      draft=""
      setViewMode={vi.fn()}
      setEditMode={vi.fn()}
      setDraft={vi.fn()}
      onSave={vi.fn()}
      savePending={false}
      versions={versions}
      versionsLoading={false}
      attachAgents={[]}
      onSubmitAttach={vi.fn()}
      attachPending={false}
      expandedDirs={new Set()}
      onToggleDir={vi.fn()}
      onSelectPath={vi.fn()}
      updateStatus={null}
      updateStatusLoading={false}
      onCheckUpdates={vi.fn()}
      checkUpdatesPending={false}
      onInstallUpdate={vi.fn()}
      installUpdatePending={false}
      onToggleStar={vi.fn()}
      starPending={false}
      onFork={vi.fn()}
      onUpdateSharingScope={vi.fn()}
      updateSharingPending={false}
      onDelete={vi.fn()}
      deletePending={false}
      {...props}
    />
  );
}

async function renderSkillDetail(
  versions: CompanySkillVersion[],
  props: Partial<ComponentProps<typeof SkillDetailPage>> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(skillDetailElement(versions, props));
  });

  return container;
}

/** Re-render into the SAME root so component-local state (draft tags) survives. */
async function rerenderSkillDetail(
  versions: CompanySkillVersion[],
  props: Partial<ComponentProps<typeof SkillDetailPage>> = {},
) {
  await act(async () => {
    root?.render(skillDetailElement(versions, props));
  });
  return container!;
}

async function pressEnter(input: HTMLElement) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function tagInputOf(node: ParentNode) {
  return Array.from(node.querySelectorAll("input")).find(
    (input) => input.getAttribute("placeholder") === "Add a tag…",
  ) as HTMLInputElement;
}

async function renderDiscoveryGrid(props: Partial<ComponentProps<typeof DiscoveryGrid>> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      <DiscoveryGrid
        tab="all"
        tabCounts={{ all: 0, installed: 0, catalog: 0, bundled: 0 }}
        onTabChange={vi.fn()}
        onAddFolder={vi.fn()}
        categories={[]}
        categoryTotal={0}
        activeCategory={null}
        onCategoryChange={vi.fn()}
        search=""
        onSearchChange={vi.fn()}
        sort="agents"
        onSortChange={vi.fn()}
        cards={[]}
        onOpenCard={vi.fn()}
        loading={false}
        error={null}
        totalCount={0}
        onCreate={vi.fn()}
        onImport={vi.fn()}
        onImportFromProject={vi.fn()}
        onBrowseCatalog={vi.fn()}
        onScan={vi.fn()}
        scanPending={false}
        scanStatus={null}
        {...props}
      />,
    );
  });

  return container;
}

function buttonsNamed(node: ParentNode, name: string) {
  return Array.from(node.querySelectorAll("button")).filter((button) => button.textContent?.trim() === name);
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("getSkillVersionDiffSelection", () => {
  it("selects the previous saved revision or the initial baseline for row diffs", () => {
    const v1 = makeVersion(1, "first");
    const v2 = makeVersion(2, "second");

    expect(getSkillVersionDiffSelection([v2, v1], v2.id)).toEqual({
      leftVersionId: v1.id,
      rightVersionId: v2.id,
    });
    expect(getSkillVersionDiffSelection([v2, v1], v1.id)).toEqual({
      leftVersionId: null,
      rightVersionId: v1.id,
    });
  });
});

describe("DiscoveryGrid Studio entry points", () => {
  it("links the header Studio button to Skill Studio", async () => {
    const node = await renderDiscoveryGrid();
    const studioLink = Array.from(node.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Studio"),
    );

    expect(studioLink?.getAttribute("href")).toBe("/skills/studio");
  });

  it("uses the create callback from the New menu and empty state", async () => {
    const onCreate = vi.fn();
    const node = await renderDiscoveryGrid({ onCreate });

    await click(buttonsNamed(node, "Create new skill")[0] as HTMLButtonElement);
    await click(buttonsNamed(node, "Create a skill")[0] as HTMLButtonElement);

    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it("does not open a skill when keyboard-activating its actions button", async () => {
    const onOpenCard = vi.fn();
    const card = {
      key: "demo-skill",
      skillId: "skill-1",
      folderId: null,
      catalogRef: null,
      name: "Demo Skill",
      slug: "demo-skill",
      author: "Paperclip",
      version: null,
      tagline: null,
      description: null,
      categories: [],
      iconUrl: null,
      color: null,
      starCount: 0,
      agentCount: 0,
      forkCount: 0,
      installed: true,
      required: false,
      forkedFrom: false,
      updatedAt: 0,
    };
    const node = await renderDiscoveryGrid({
      cards: [card],
      totalCount: 1,
      onOpenCard,
      folderResult: { kind: "skill", folders: [], allCount: 1, unfiledCount: 1 },
      onMoveCard: vi.fn(),
      onCreateFolderAndMoveCard: vi.fn(),
    });
    const actionsButton = node.querySelector<HTMLButtonElement>('[aria-label="More actions for Demo Skill"]');

    await act(async () => {
      actionsButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onOpenCard).not.toHaveBeenCalled();
  });

  it("does not offer move actions for skills in the bundled folder", async () => {
    const card = {
      key: "bundled-skill",
      skillId: "skill-1",
      folderId: "bundled-folder",
      catalogRef: null,
      name: "Bundled Skill",
      slug: "bundled-skill",
      author: "Paperclip",
      version: null,
      tagline: null,
      description: null,
      categories: [],
      iconUrl: null,
      color: null,
      starCount: 0,
      agentCount: 0,
      forkCount: 0,
      installed: true,
      required: false,
      forkedFrom: false,
      updatedAt: 0,
    };
    const node = await renderDiscoveryGrid({
      cards: [card],
      totalCount: 1,
      selectMode: true,
      folderResult: {
        kind: "skill",
        folders: [{
          id: "bundled-folder",
          companyId: "company-1",
          kind: "skill",
          parentId: null,
          name: "Bundled",
          slug: "bundled",
          systemKey: "bundled",
          path: "bundled",
          depth: 1,
          color: null,
          position: 0,
          scope: "company",
          sharingTeams: [],
          sharedUserIds: [],
          createdByUserId: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          itemCount: 1,
        }],
        allCount: 1,
        unfiledCount: 0,
      },
      onMoveCard: vi.fn(),
      onCreateFolderAndMoveCard: vi.fn(),
      onOpenMoveCard: vi.fn(),
    });

    expect(node.querySelector('[aria-label="More actions for Bundled Skill"]')).toBeNull();
    expect(node.querySelector('input[type="checkbox"]')).toBeNull();
    expect(node.textContent).not.toContain("Move to folder");
  });
});

describe("skills discovery tab routing", () => {
  it("opens the folder-first installed view when the URL has no tab", () => {
    expect(resolveDiscoveryTab(null)).toBe("installed");
    expect(resolveDiscoveryTab("all")).toBe("all");
  });

  it("keeps All explicit and makes Installed the canonical default URL", () => {
    const allParams = withDiscoveryTab(new URLSearchParams("folder=my&category=writing"), "all");
    expect(allParams.toString()).toBe("tab=all");

    const installedParams = withDiscoveryTab(new URLSearchParams("tab=all&folder=my"), "installed");
    expect(installedParams.toString()).toBe("folder=my");
  });
});

describe("skill detail breadcrumbs", () => {
  it("links each folder ancestor back to the installed folder view", () => {
    const folders: FolderListResult = {
      kind: "skill",
      allCount: 1,
      unfiledCount: 0,
      folders: [
        {
          id: "my-root",
          companyId: "company-1",
          kind: "skill",
          parentId: null,
          name: "My Skills",
          slug: "my",
          systemKey: "my",
          path: "my",
          depth: 1,
          color: null,
          position: 0,
          itemCount: 1,
          scope: "company",
          sharingTeams: [],
          sharedUserIds: [],
          createdByUserId: null,
          createdAt: new Date("2026-07-16T00:00:00.000Z"),
          updatedAt: new Date("2026-07-16T00:00:00.000Z"),
        },
        {
          id: "review-folder",
          companyId: "company-1",
          kind: "skill",
          parentId: "my-root",
          name: "Review",
          slug: "review",
          systemKey: null,
          path: "my/review",
          depth: 2,
          color: null,
          position: 0,
          itemCount: 1,
          scope: "company",
          sharingTeams: [],
          sharedUserIds: [],
          createdByUserId: null,
          createdAt: new Date("2026-07-16T00:00:00.000Z"),
          updatedAt: new Date("2026-07-16T00:00:00.000Z"),
        },
      ],
    };

    expect(skillDetailBreadcrumbs({ name: "Deal with PR", folderId: "review-folder" }, folders)).toEqual([
      { label: "Skills", href: "/skills" },
      { label: "My Skills", href: "/skills?folder=my-root" },
      { label: "Review", href: "/skills?folder=review-folder" },
      { label: "Deal with PR" },
    ]);
  });
});

describe("skillStudioNewRoute", () => {
  it("builds a direct fork draft URL for a specific skill", () => {
    expect(skillStudioNewRoute("skill 1")).toBe("/skills/studio/new?forkFrom=skill%201");
  });
});

describe("SkillDetailPage versions tab", () => {
  it("opens per-row version diffs for newest and oldest revisions", async () => {
    const v1 = makeVersion(1, "# Demo Skill\n\nFirst line");
    const v2 = makeVersion(2, "# Demo Skill\n\nSecond line");
    const node = await renderSkillDetail([v2, v1]);
    const viewDiffButtons = buttonsNamed(node, "View diff") as HTMLButtonElement[];

    expect(viewDiffButtons).toHaveLength(2);

    await click(viewDiffButtons[0]!);
    let dialog = node.querySelector('[role="dialog"]') as HTMLElement;
    let selects = Array.from(dialog.querySelectorAll("select"));

    expect(dialog.textContent).toContain("Diff");
    expect(selects[0]?.value).toBe(v1.id);
    expect(selects[1]?.value).toBe(v2.id);
    expect(dialog.textContent).toContain("Second line");

    await click(viewDiffButtons[1]!);
    dialog = node.querySelector('[role="dialog"]') as HTMLElement;
    selects = Array.from(dialog.querySelectorAll("select"));

    expect(selects[0]?.value).toBe("");
    expect(selects[1]?.value).toBe(v1.id);
    expect(dialog.textContent).toContain("Initial");
    expect(dialog.textContent).toContain("First line");
    expect(dialog.textContent).not.toContain("Both sides are the same version");
  });
});

describe("SkillDetailPage settings", () => {
  it("humanizes the server folder path on a cold detail render", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail: makeDetail(v1, { folderPath: "engineering/code-review" }),
    });

    expect(node.textContent).toContain("Company / Engineering / Code Review");
  });

  it("offers a fork action even for read-only skills", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const onFork = vi.fn();
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail: makeDetail(v1, {
        editable: false,
        editableReason: "Remote GitHub skills are read-only. Fork or import locally to edit them.",
        sourceBadge: "github",
        sourceLabel: "GitHub",
        sourceType: "github",
      }),
      onFork,
    });

    // The GitHub-style social-proof bar always surfaces a fork action, even when
    // the skill itself is read-only. It's the "Fork" button in that bar.
    const forkButton = Array.from(node.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Fork"),
    ) as HTMLButtonElement | undefined;
    expect(forkButton).toBeTruthy();

    await click(forkButton!);

    expect(onFork).toHaveBeenCalledOnce();
  });

  it("middle-truncates a long source path but keeps the full path in its title", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const longSourcePath = "/srv/paperclip/home/paperclipai/paperclip/.agents/skills/prepare-pr/SKILL.md";
    const node = await renderSkillDetail([v1], {
      activeTab: "agents",
      detail: makeDetail(v1, {
        sourcePath: longSourcePath,
        sourceLocator: null,
      }),
    });

    // The provenance row compacts the path for the narrow sidebar (middleTruncate)
    // but exposes the full path via the title attribute, so nothing is lost.
    const sourceRow = Array.from(node.querySelectorAll("[title]")).find(
      (element) => element.getAttribute("title") === longSourcePath,
    );
    expect(sourceRow).toBeTruthy();
    expect(sourceRow?.textContent).not.toBe(longSourcePath); // shown compactly, not verbatim
  });

  it("adds a normalized (trimmed + lowercased) tag through the sidebar tags editor", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const onUpdateSettings = vi.fn();
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail: makeDetail(v1, {
        categories: ["engineering"],
        sharingScope: "company",
      }),
      onUpdateSettings,
    });

    // Categories are edited as chips in the sidebar tags editor: type + Enter adds
    // one normalized tag and immediately persists via onUpdateSettings, carrying
    // the current sharing scope.
    const tagInput = tagInputOf(node);
    expect(tagInput).toBeTruthy();

    await inputValue(tagInput, "  Memory Tools  ");
    await pressEnter(tagInput);

    expect(onUpdateSettings).toHaveBeenCalledWith({
      sharingScope: "company",
      categories: ["engineering", "memory tools"],
    });
  });

  it("removes a tag via its chip and applies a sharing change immediately", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const onUpdateSettings = vi.fn();
    const onUpdateSharingScope = vi.fn();
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail: makeDetail(v1, {
        categories: ["engineering"],
        sharingScope: "company",
      }),
      onUpdateSettings,
      onUpdateSharingScope,
    });

    // Removing the only chip clears categories (persisted immediately).
    await click(node.querySelector('[aria-label="Remove tag engineering"]') as HTMLButtonElement);
    expect(onUpdateSettings).toHaveBeenCalledWith({ sharingScope: "company", categories: [] });

    // Sharing is applied the moment the select changes — no batched "Save".
    await click(buttonsNamed(node, "Settings")[0] as HTMLButtonElement);
    const select = node.querySelector('[role="dialog"] select') as HTMLSelectElement;
    await selectValue(select, "private");
    expect(onUpdateSharingScope).toHaveBeenCalledWith("private");
  });

  it("ignores re-adding an existing tag case-insensitively, never re-saving", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const onUpdateSettings = vi.fn();
    const node = await renderSkillDetail([v1], {
      activeTab: "overview",
      detail: makeDetail(v1, {
        categories: ["memory", "review"],
        sharingScope: "company",
      }),
      onUpdateSettings,
    });

    const tagInput = tagInputOf(node);
    await inputValue(tagInput, "Memory");
    await pressEnter(tagInput);

    // "Memory" normalizes to the existing "memory" → no-op, and the draft clears.
    expect(onUpdateSettings).not.toHaveBeenCalled();
    expect(tagInput.value).toBe("");
  });

  it("keeps a partially typed tag in the input across a detail re-render", async () => {
    const v1 = makeVersion(1, "# Demo Skill");
    const detail = makeDetail(v1, {
      categories: ["engineering"],
      sharingScope: "company",
    });
    const node = await renderSkillDetail([v1], { activeTab: "overview", detail });

    const tagInput = tagInputOf(node);
    await inputValue(tagInput, "memo");

    // An unrelated refetch re-renders the same tree; the un-submitted draft survives.
    await rerenderSkillDetail([v1], { activeTab: "overview", detail });

    expect(tagInputOf(node).value).toBe("memo");
  });
});
