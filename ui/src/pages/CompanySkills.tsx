import { useEffect, useMemo, useRef, useState, type SVGProps } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentDesiredSkillEntry,
  Agent,
  CatalogSkill,
  CatalogSkillFileDetail,
  CatalogSkillSource,
  CompanySkillCompatibility,
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillListItem,
  CompanySkillProjectScanResult,
  CompanySkillSharingScope,
  CompanySkillSourceBadge,
  CompanySkillTrustLevel,
  CompanySkillUpdateStatus,
  CompanySkillVersion,
} from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { CopyText } from "../components/CopyText";
import { Identity } from "../components/Identity";
import { AgentIcon } from "../components/AgentIconPicker";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { t, useTranslation } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildLineDiff, type DiffRow } from "../lib/line-diff";
import { cn, relativeTime } from "../lib/utils";
import { resolveSkillSummaryText } from "../lib/company-skill-summary";
import {
  parseSkillRoute,
  skillRoute,
  withRouteSkill,
  resolveSkillRouteToken,
  type CompanySkillRouteSubject,
} from "../lib/company-skill-routes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  ArrowUpCircle,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  Eye,
  Filter,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitFork,
  Github,
  Globe,
  HelpCircle,
  LayoutGrid,
  Link2,
  Lock,
  ExternalLink,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Plus,
  Copy,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  Users,
  History,
  XOctagon,
} from "lucide-react";

type SkillTreeNode = {
  name: string;
  path: string | null;
  kind: "dir" | "file";
  fileKind?: CompanySkillFileInventoryEntry["kind"];
  children: SkillTreeNode[];
};

const SKILL_TREE_BASE_INDENT = 16;
const SKILL_TREE_STEP_INDENT = 24;
const SKILL_TREE_ROW_HEIGHT_CLASS = "min-h-9";

function VercelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 4 21 19H3z" />
    </svg>
  );
}

function stripFrontmatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized.trim();
  return normalized.slice(closing + 5).trim();
}

function splitFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: null, body: normalized };
  }
  return {
    frontmatter: normalized.slice(4, closing).trim(),
    body: normalized.slice(closing + 5).trimStart(),
  };
}

function mergeFrontmatter(markdown: string, body: string) {
  const parsed = splitFrontmatter(markdown);
  if (!parsed.frontmatter) return body;
  return ["---", parsed.frontmatter, "---", "", body].join("\n");
}

function buildTree(entries: CompanySkillFileInventoryEntry[]) {
  const root: SkillTreeNode = { name: "", path: null, kind: "dir", children: [] };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (const [index, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      let next = current.children.find((child) => child.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: isLeaf ? entry.path : currentPath,
          kind: isLeaf ? "file" : "dir",
          fileKind: isLeaf ? entry.kind : undefined,
          children: [],
        };
        current.children.push(next);
      }
      current = next;
    }
  }

  function sortNode(node: SkillTreeNode) {
    node.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      if (left.name === "SKILL.md") return -1;
      if (right.name === "SKILL.md") return 1;
      return left.name.localeCompare(right.name);
    });
    node.children.forEach(sortNode);
  }

  sortNode(root);
  return root.children;
}

function sourceMeta(sourceBadge: CompanySkillSourceBadge, sourceLabel: string | null) {
  const normalizedLabel = sourceLabel?.toLowerCase() ?? "";
  const isSkillsShManaged =
    normalizedLabel.includes("skills.sh") || normalizedLabel.includes("vercel-labs/skills");

  switch (sourceBadge) {
    case "skills_sh":
      return { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" };
    case "github":
      return isSkillsShManaged
        ? { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" }
        : { icon: Github, label: sourceLabel ?? "GitHub", managedLabel: "GitHub managed" };
    case "url":
      return { icon: Link2, label: sourceLabel ?? "URL", managedLabel: "URL managed" };
    case "local":
      return { icon: Folder, label: sourceLabel ?? "Folder", managedLabel: "Folder managed" };
    case "paperclip":
      return { icon: Paperclip, label: sourceLabel ?? "Paperclip", managedLabel: "Paperclip managed" };
    default:
      return { icon: Boxes, label: sourceLabel ?? "Catalog", managedLabel: "Catalog managed" };
  }
}

function shortRef(ref: string | null | undefined) {
  if (!ref) return null;
  return ref.slice(0, 7);
}

function middleTruncate(value: string, maxLength = 72) {
  if (value.length <= maxLength) return value;
  const edgeLength = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, edgeLength)}...${value.slice(value.length - edgeLength)}`;
}

function formatProjectScanSummary(result: CompanySkillProjectScanResult) {
  const parts = [
    t("companySkills.scanFound", { count: result.discovered }),
    t("companySkills.scanImported", { count: result.imported.length }),
    t("companySkills.scanUpdated", { count: result.updated.length }),
  ];
  if (result.conflicts.length > 0) parts.push(t("companySkills.scanConflicts", { count: result.conflicts.length }));
  if (result.skipped.length > 0) parts.push(t("companySkills.scanSkipped", { count: result.skipped.length }));
  return t("companySkills.scanSummary", { parts: parts.join(", "), count: result.scannedWorkspaces });
}

function fileIcon(kind: CompanySkillFileInventoryEntry["kind"]) {
  if (kind === "script" || kind === "reference") return FileCode2;
  return FileText;
}

function catalogSkillRoute(catalogRef: string) {
  return `/skills?view=catalog&catalog=${encodeURIComponent(catalogRef)}`;
}

function parentDirectoryPaths(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return parents;
}

type SourceFilter = "all" | "company" | "bundled" | "optional" | "external";

const SOURCE_FILTER_LABELS: Record<SourceFilter, string> = {
  all: "All",
  company: "Company",
  bundled: "Bundled",
  optional: "Optional",
  external: "External",
};

function readonlyMetadataValue(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readonlyMetadataKind(metadata: Record<string, unknown> | null | undefined): "bundled" | "optional" | null {
  const value = readonlyMetadataValue(metadata, "sourceKind") ?? readonlyMetadataValue(metadata, "catalogKind");
  if (value === "bundled") return "bundled";
  if (value === "optional") return "optional";
  return null;
}

function classifySource(skill: {
  sourceBadge: CompanySkillSourceBadge;
  sourceType: string;
  catalogKind?: "bundled" | "optional" | null;
  metadata?: Record<string, unknown> | null;
}): SourceFilter {
  if (skill.sourceBadge === "paperclip") return "company";
  if (skill.sourceType === "local_path" && !skill.sourceBadge.toString().includes("github")) {
    return "company";
  }
  if (skill.sourceType === "catalog" || skill.sourceBadge === "catalog") {
    const kind = skill.catalogKind ?? readonlyMetadataKind(skill.metadata);
    if (kind === "bundled") return "bundled";
    if (kind === "optional") return "optional";
    return "company";
  }
  if (skill.sourceBadge === "github" || skill.sourceBadge === "skills_sh" || skill.sourceBadge === "url" || skill.sourceBadge === "local") {
    return "external";
  }
  return "company";
}

function SourceFilterMenu({
  counts,
  value,
  onChange,
}: {
  counts: Record<SourceFilter, number>;
  value: SourceFilter;
  onChange: (next: SourceFilter) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div className="border-b border-border px-4 py-4">
      <div className="space-y-3">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("companySkills.skillNamePlaceholder")}
          className="h-9 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <Input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder={t("companySkills.slugPlaceholder")}
          className="h-9 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("companySkills.shortDescriptionPlaceholder")}
          className="min-h-20 rounded-none border-0 border-b border-border px-0 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSubmit(Array.from(draft), draftVersionId);
              setOpen(false);
            }}
            disabled={pending}
          >
            {isPending ? t("common.creating") : t("companySkills.createSkill")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SkillTree({
  nodes,
  skillId,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelectPath,
  fileHref = (currentSkillId, path) => skillRoute(currentSkillId, path),
  depth = 0,
}: {
  nodes: SkillTreeNode[];
  skillId: string;
  selectedPath: string;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string) => void;
  fileHref?: (skillId: string, path?: string | null) => string;
  depth?: number;
}) {
  return (
    <div>
      {nodes.map((node) => {
        const expanded = node.kind === "dir" && node.path ? expandedDirs.has(node.path) : false;
        if (node.kind === "dir") {
          return (
            <div key={node.path ?? node.name}>
              <div
                className={cn(
                  "group grid w-full grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                  SKILL_TREE_ROW_HEIGHT_CLASS,
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 py-1 text-left"
                  style={{ paddingLeft: `${SKILL_TREE_BASE_INDENT + depth * SKILL_TREE_STEP_INDENT}px` }}
                  onClick={() => node.path && onToggleDir(node.path)}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {expanded ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
                  </span>
                  <span className="truncate">{node.name}</span>
                </button>
                <button
                  type="button"
                  className="flex h-9 w-9 items-center justify-center self-center rounded-sm text-muted-foreground opacity-70 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  onClick={() => node.path && onToggleDir(node.path)}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              </div>
              {expanded && (
                <SkillTree
                  nodes={node.children}
                  skillId={skillId}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  onSelectPath={onSelectPath}
                  fileHref={fileHref}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        }

        const FileIcon = fileIcon(node.fileKind ?? "other");
        return (
          <Link
            key={node.path ?? node.name}
            className={cn(
              "flex w-full items-center gap-2 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
              SKILL_TREE_ROW_HEIGHT_CLASS,
              node.path === selectedPath && "text-foreground",
            )}
            style={{ paddingInlineStart: `${SKILL_TREE_BASE_INDENT + depth * SKILL_TREE_STEP_INDENT}px` }}
            to={fileHref(skillId, node.path)}
            onClick={() => node.path && onSelectPath(node.path)}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <FileIcon className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{node.name}</span>
          </Link>
        );
      })}
    </div>
  );
}

function SkillList({
  skills,
  selectedSkillId,
  skillFilter,
  sourceFilter,
  expandedSkillId,
  expandedDirs,
  selectedPaths,
  onToggleSkill,
  onToggleDir,
  onSelectSkill,
  onSelectPath,
  onClearFilters,
}: {
  skills: CompanySkillListItem[];
  selectedSkillId: string | null;
  skillFilter: string;
  sourceFilter: SourceFilter;
  expandedSkillId: string | null;
  expandedDirs: Record<string, Set<string>>;
  selectedPaths: Record<string, string>;
  onToggleSkill: (skillId: string) => void;
  onToggleDir: (skillId: string, path: string) => void;
  onSelectSkill: (skillId: string) => void;
  onSelectPath: (skillId: string, path: string) => void;
  onClearFilters: () => void;
}) {
  const filteredSkills = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.key} ${skill.slug} ${skill.sourceLabel ?? ""}`.toLowerCase();
    if (!haystack.includes(skillFilter.toLowerCase())) return false;
    if (sourceFilter === "all") return true;
    const skillSource = classifySource(skill);
    return skillSource === sourceFilter;
  });

  if (filteredSkills.length === 0) {
    if (sourceFilter !== "all" && skills.length > 0) {
      return (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No {SOURCE_FILTER_LABELS[sourceFilter].toLowerCase()} skills installed.{" "}
          <button type="button" className="text-foreground underline" onClick={onClearFilters}>
            Clear filter
          </button>
        </div>
      );
    }
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        No skills match this filter.
      </div>
    );
  }

  return (
    <div>
      {filteredSkills.map((skill) => {
        const expanded = expandedSkillId === skill.id;
        const tree = buildTree(skill.fileInventory);
        const source = sourceMeta(skill.sourceBadge, skill.sourceLabel);
        const SourceIcon = source.icon;

        return (
          <div key={skill.id} className="border-b border-border">
            <div
              className={cn(
                "group grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 px-3 py-1.5 hover:bg-accent/30",
                skill.id === selectedSkillId && "text-foreground",
              )}
            >
              <Link
                to={skillRoute(skill, skills)}
                className="flex min-w-0 items-center self-stretch pr-2 text-left no-underline"
                onClick={() => onSelectSkill(skill.id)}
              >
                <span className="flex min-w-0 items-center gap-2 self-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-75 transition-opacity group-hover:opacity-100">
                        <SourceIcon className="h-3.5 w-3.5" />
                        <span className="sr-only">{source.managedLabel}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{source.managedLabel}</TooltipContent>
                  </Tooltip>
                  <span className="min-w-0 overflow-hidden text-[13px] font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                    {skill.name}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground opacity-80 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                onClick={() => onToggleSkill(skill.id)}
                aria-label={expanded ? `Collapse ${skill.name}` : `Expand ${skill.name}`}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div
              aria-hidden={!expanded}
              className={cn(
                "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
                expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <SkillTree
                  nodes={tree}
                  skillId={skill.id}
                  selectedPath={selectedPaths[skill.id] ?? "SKILL.md"}
                  expandedDirs={expandedDirs[skill.id] ?? new Set<string>()}
                  onToggleDir={(path) => onToggleDir(skill.id, path)}
                  onSelectPath={(path) => onSelectPath(skill.id, path)}
                  fileHref={(_, path) => skillRoute(skill, skills, path)}
                  depth={1}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type SkillDetailTab = "overview" | "files" | "versions" | "agents";

const SKILL_DETAIL_TABS: Array<{ value: SkillDetailTab; label: string; icon: typeof FileText }> = [
  { value: "overview", label: "Overview", icon: FileText },
  { value: "files", label: "Files", icon: FolderOpen },
  { value: "versions", label: "Versions", icon: History },
  { value: "agents", label: "Agents", icon: Users },
];

function currentVersionSelection(detail: CompanySkillDetail | null | undefined) {
  const selected = detail?.usedByAgents.find((agent) => agent.versionId)?.versionId;
  return selected ?? null;
}

function versionLabel(version: CompanySkillVersion | null | undefined) {
  if (!version) return "Latest";
  return `v${version.revisionNumber}${version.label ? ` · ${version.label}` : ""}`;
}

export function getSkillVersionDiffSelection(versions: CompanySkillVersion[], targetVersionId?: string | null) {
  const sorted = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const right = targetVersionId
    ? sorted.find((version) => version.id === targetVersionId) ?? null
    : sorted[0] ?? null;
  if (!right) return { leftVersionId: null, rightVersionId: null };

  const left = sorted.find((version) => version.revisionNumber < right.revisionNumber) ?? null;
  return {
    leftVersionId: left?.id ?? null,
    rightVersionId: right.id,
  };
}

function SkillVersionDiffDialog({
  open,
  onOpenChange,
  versions,
  leftVersionId,
  rightVersionId,
  onLeftVersionChange,
  onRightVersionChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: CompanySkillVersion[];
  leftVersionId: string | null;
  rightVersionId: string | null;
  onLeftVersionChange: (id: string | null) => void;
  onRightVersionChange: (id: string | null) => void;
}) {
  const sorted = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const left = sorted.find((version) => version.id === leftVersionId) ?? null;
  const right = sorted.find((version) => version.id === rightVersionId) ?? null;
  const allPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const file of left?.fileInventory ?? []) paths.add(file.path);
    for (const file of right?.fileInventory ?? []) paths.add(file.path);
    return Array.from(paths).sort((a, b) => {
      if (a === "SKILL.md") return -1;
      if (b === "SKILL.md") return 1;
      return a.localeCompare(b);
    });
  }, [left, right]);
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const effectivePath = allPaths.includes(selectedPath) ? selectedPath : allPaths[0] ?? "SKILL.md";
  const leftFile = left?.fileInventory.find((file) => file.path === effectivePath);
  const rightFile = right?.fileInventory.find((file) => file.path === effectivePath);
  const diffRows = useMemo(
    () => buildLineDiff(leftFile?.content ?? "", rightFile?.content ?? ""),
    [leftFile?.content, rightFile?.content],
  );
  const lineClassesByKind: Record<DiffRow["kind"], string> = {
    context: "bg-transparent",
    removed: "bg-red-500/10 text-red-100",
    added: "bg-green-500/10 text-green-100",
  };
  const markerByKind: Record<DiffRow["kind"], string> = {
    context: " ",
    removed: "-",
    added: "+",
  };

  useEffect(() => {
    if (open && allPaths.length > 0 && !allPaths.includes(selectedPath)) {
      setSelectedPath(allPaths[0]!);
    }
  }, [allPaths, open, selectedPath]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full !max-w-[90%] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>Diff · skill files</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 font-medium uppercase tracking-wider text-red-400">Old</span>
              <select
                value={leftVersionId ?? ""}
                onChange={(event) => onLeftVersionChange(event.target.value || null)}
                className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value="">Initial</option>
                {sorted.map((version) => (
                  <option key={version.id} value={version.id}>{versionLabel(version)}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 font-medium uppercase tracking-wider text-green-400">New</span>
              <select
                value={right?.id ?? ""}
                onChange={(event) => onRightVersionChange(event.target.value || null)}
                className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
              >
                {sorted.map((version) => (
                  <option key={version.id} value={version.id}>{versionLabel(version)}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 gap-3">
          <aside className="hidden w-56 shrink-0 overflow-auto border-r border-border pr-3 md:block">
            {allPaths.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => setSelectedPath(path)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                  effectivePath === path && "bg-accent/50 text-foreground",
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{path}</span>
              </button>
            ))}
          </aside>
          <div className="min-w-0 flex-1 overflow-auto rounded-md border border-border text-xs">
            {!right ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Select a version to compare.</div>
            ) : left?.id === right.id ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Both sides are the same version.</div>
            ) : (
              <div className="font-mono text-[12px] leading-6">
                <div className="grid grid-cols-[56px_56px_24px_minmax(0,1fr)] border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <span>Old</span>
                  <span>New</span>
                  <span />
                  <span>{effectivePath}</span>
                </div>
                {diffRows.map((row, index) => (
                  <div
                    key={`${row.kind}-${index}-${row.oldLineNumber ?? "x"}-${row.newLineNumber ?? "x"}`}
                    className={cn("grid grid-cols-[56px_56px_24px_minmax(0,1fr)] gap-0 border-b border-border/30 px-3", lineClassesByKind[row.kind])}
                  >
                    <span className="select-none border-r border-border/30 pr-3 text-right text-muted-foreground">{row.oldLineNumber ?? ""}</span>
                    <span className="select-none border-r border-border/30 px-3 text-right text-muted-foreground">{row.newLineNumber ?? ""}</span>
                    <span className="select-none px-3 text-center text-muted-foreground">{markerByKind[row.kind]}</span>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-0 text-inherit">{row.text.length > 0 ? row.text : " "}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SkillDetailPage({
  detail,
  catalogSource,
  routeSkills,
  loading,
  activeTab,
  onTabChange,
  selectedPath,
  file,
  fileLoading,
  viewMode,
  editMode,
  draft,
  setViewMode,
  setEditMode,
  setDraft,
  onSave,
  savePending,
  versions,
  versionsLoading,
  attachAgents,
  onSubmitAttach,
  attachPending,
  expandedDirs,
  onToggleDir,
  onSelectPath,
  updateStatus,
  updateStatusLoading,
  onCheckUpdates,
  checkUpdatesPending,
  onInstallUpdate,
  installUpdatePending,
  onToggleStar,
  starPending,
  onFork,
  onUpdateSharingScope,
  updateSharingPending,
  onDelete,
  deletePending,
}: {
  detail: CompanySkillDetail | null | undefined;
  catalogSource?: CatalogSkillSource | null;
  routeSkills?: CompanySkillRouteSubject[];
  loading: boolean;
  activeTab: SkillDetailTab;
  onTabChange: (tab: SkillDetailTab) => void;
  selectedPath: string;
  file: CompanySkillFileDetail | null | undefined;
  fileLoading: boolean;
  viewMode: "preview" | "code";
  editMode: boolean;
  draft: string;
  setViewMode: (mode: "preview" | "code") => void;
  setEditMode: (value: boolean) => void;
  setDraft: (value: string) => void;
  onSave: () => void;
  savePending: boolean;
  versions: CompanySkillVersion[];
  versionsLoading: boolean;
  attachAgents: AttachAgentOption[];
  onSubmitAttach: (ids: string[], versionId: string | null) => void;
  attachPending: boolean;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string) => void;
  updateStatus: CompanySkillUpdateStatus | null | undefined;
  updateStatusLoading: boolean;
  onCheckUpdates: () => void;
  checkUpdatesPending: boolean;
  onInstallUpdate: () => void;
  installUpdatePending: boolean;
  onToggleStar: () => void;
  starPending: boolean;
  onFork: () => void;
  onUpdateSharingScope: (scope: Exclude<CompanySkillSharingScope, "public_link">) => void;
  updateSharingPending: boolean;
  onDelete: () => void;
  deletePending: boolean;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Top-level description is clamped to four lines; "View all" expands it. We
  // only surface the toggle when the text actually overflows the clamp.
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  useEffect(() => {
    const el = descriptionRef.current;
    if (!el || descExpanded) return;
    setDescClamped(el.scrollHeight - el.clientHeight > 1);
  }, [detail?.description, detail?.tagline, detail?.id, descExpanded]);
  useEffect(() => {
    setDescExpanded(false);
  }, [detail?.id]);
  const sortedVersions = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const [leftVersionId, setLeftVersionId] = useState<string | null>(null);
  const [rightVersionId, setRightVersionId] = useState<string | null>(null);

  function openVersionDiff(targetVersionId?: string | null) {
    const selection = getSkillVersionDiffSelection(sortedVersions, targetVersionId);
    setLeftVersionId(selection.leftVersionId);
    setRightVersionId(selection.rightVersionId);
    setDiffOpen(Boolean(selection.rightVersionId));
  }

  // Track unsaved edits so we can float a save bar and warn before the page is
  // unloaded with a dirty draft (PAP-10907 J).
  const savedFileContent = file?.content ?? "";
  const isDirty = editMode && Boolean(file?.editable) && draft !== savedFileContent;
  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  if (!detail) {
    return loading ? <PageSkeleton variant="detail" /> : <EmptyState icon={Boxes} message="Skill not found." />;
  }

  const skill = detail;
  const source = sourceMeta(skill.sourceBadge, skill.sourceLabel);
  const SourceIcon = source.icon;
  const body = file?.markdown ? stripFrontmatter(file.content) : file?.content ?? "";
  const currentPin = shortRef(skill.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);
  const selectedVersion = versions.find((version) => version.id === currentVersionSelection(skill)) ?? null;
  const subtitleText = resolveSkillSummaryText(skill) ?? source.label;
  // Look up the richer agent record (icon, paused) for agents using this skill.
  const attachAgentMetaById = new Map(attachAgents.map((agent) => [agent.id, agent]));

  // Sidebar provenance: prefer the rich upstream attribution from the catalog
  // entry (GitHub owner/repo/path with a real link). Catalog-installed skills
  // only persist a local staging path, so without this they'd show a long,
  // unhelpful filesystem path (PAP-10907).
  const githubSource = catalogSource && catalogSource.type === "github" ? catalogSource : null;
  const githubLabel = githubSource
    ? githubSource.hostname === "github.com"
      ? "GitHub"
      : githubSource.hostname
    : null;
  const githubRepoText = githubSource
    ? `${githubSource.owner}/${githubSource.repo}${githubSource.path ? `/${githubSource.path}` : ""}`
    : null;
  const githubHref = githubSource
    ? githubSource.url
      ?? `https://${githubSource.hostname}/${githubSource.owner}/${githubSource.repo}/tree/${githubSource.ref}/${githubSource.path}`.replace(/\/$/, "")
    : null;
  // Fallback for non-catalog skills: the recorded locator/path, middle-truncated
  // so long file paths stay readable in the narrow sidebar.
  const sourceLocatorText = skill.sourcePath || skill.sourceLocator || null;
  const sourceLocatorDisplay = sourceLocatorText ? middleTruncate(sourceLocatorText, 44) : null;
  const sourceHref =
    skill.homepageUrl
    ?? (sourceLocatorText && /^(https?:\/\/|[\w.-]+\.[a-z]{2,}\/)/i.test(sourceLocatorText)
      ? sourceLocatorText.startsWith("http")
        ? sourceLocatorText
        : `https://${sourceLocatorText}`
      : null);

  function renderFilesBody() {
    return (
      <div className="grid min-h-[560px] gap-0 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="border-b border-border pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</div>
          <SkillTree
            nodes={buildTree(skill.fileInventory)}
            skillId={skill.id}
            selectedPath={selectedPath}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onSelectPath={onSelectPath}
            fileHref={(_, path) => skillRoute(skill, routeSkills ?? [skill], path)}
          />
        </aside>
        <section className="min-w-0 lg:pl-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <div className="min-w-0 truncate font-mono text-sm">{file?.path ?? selectedPath}</div>
            <div className="flex items-center gap-2">
              {file?.markdown && !editMode ? (
                <div className="flex items-center border border-border">
                  <button
                    className={cn("px-3 py-1.5 text-sm", viewMode === "preview" ? "text-foreground" : "text-muted-foreground")}
                    onClick={() => setViewMode("preview")}
                  >
                    <span className="flex items-center gap-1.5"><Eye className="h-3.5 w-3.5" /> View</span>
                  </button>
                  <button
                    className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" ? "text-foreground" : "text-muted-foreground")}
                    onClick={() => setViewMode("code")}
                  >
                    <span className="flex items-center gap-1.5"><Code2 className="h-3.5 w-3.5" /> Code</span>
                  </button>
                </div>
              ) : null}
              {skill.editable && file?.editable ? (
                editMode ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>Cancel</Button>
                    <Button size="sm" onClick={onSave} disabled={savePending}>
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                      {savePending ? "Saving..." : "Save"}
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setEditMode(true)}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                  </Button>
                )
              ) : null}
            </div>
          </div>
          {fileLoading ? (
            <PageSkeleton variant="detail" />
          ) : !file ? (
            <div className="text-sm text-muted-foreground">Select a file to inspect.</div>
          ) : editMode && file.editable ? (
            file.markdown ? (
              <MarkdownEditor value={draft} onChange={setDraft} bordered={false} className="min-h-[520px]" />
            ) : (
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-[520px] rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
              />
            )
          ) : file.markdown && viewMode === "preview" ? (
            <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body}</MarkdownBody>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word border-0 bg-transparent p-0 font-mono text-sm text-foreground">
              <code>{file.content}</code>
            </pre>
          )}
        </section>
      </div>
    );
  }

  function renderOverviewBody() {
    return (
      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-sm font-medium">About</h2>
          {fileLoading ? (
            <PageSkeleton variant="detail" />
          ) : file?.markdown ? (
            <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body || skill.description || "No overview yet."}</MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">{skill.description ?? "No overview yet."}</p>
          )}
        </section>
        <section className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">Key</div>
            <div className="mt-1 truncate font-mono">{skill.key}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">Source</div>
            <div className="mt-1 truncate">{skill.sourcePath ?? source.label}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">Version</div>
            <div className="mt-1">{versionLabel(skill.currentVersion ?? null)}</div>
          </div>
          <div className="min-w-0 border-b border-border py-2">
            <div className="text-xs text-muted-foreground">Mode</div>
            <div className="mt-1">{skill.editable ? "Editable" : skill.editableReason ?? "Read only"}</div>
          </div>
        </section>
      </div>
    );
  }

  function renderVersionsBody() {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            {versionsLoading ? "Loading versions..." : `${versions.length} ${versions.length === 1 ? "version" : "versions"}`}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openVersionDiff()}
            disabled={sortedVersions.length < 2}
          >
            <History className="mr-1.5 h-3.5 w-3.5" /> Compare
          </Button>
        </div>
        <div className="border-y border-border">
          {versionsLoading ? (
            <PageSkeleton variant="list" />
          ) : sortedVersions.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">No saved versions yet.</div>
          ) : (
            sortedVersions.map((version) => (
              <div key={version.id} className="grid gap-2 border-b border-border px-0 py-3 text-sm last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="font-medium">{versionLabel(version)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {relativeTime(version.createdAt)} · {version.fileInventory.length} files
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openVersionDiff(version.id)}
                >
                  View diff
                </Button>
              </div>
            ))
          )}
        </div>
        <SkillVersionDiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          versions={sortedVersions}
          leftVersionId={leftVersionId}
          rightVersionId={rightVersionId}
          onLeftVersionChange={setLeftVersionId}
          onRightVersionChange={setRightVersionId}
        />
      </div>
    );
  }

  function renderAgentsBody() {
    // Only the agents actually using this skill are listed (PAP-10907); the
    // multi-selector behind "Add to agent" is where you attach more.
    const attached = skill.usedByAgents;
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {attached.length} {attached.length === 1 ? "agent" : "agents"} attached
            {selectedVersion ? ` · ${versionLabel(selectedVersion)}` : " · Latest"}
          </p>
          <AttachAgentsPopover
            agents={attachAgents}
            attachedAgentIds={attached.map((agent) => agent.id)}
            versions={versions}
            selectedVersionId={currentVersionSelection(skill)}
            pending={attachPending}
            onSubmit={onSubmitAttach}
          />
        </div>
        {attached.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            No agents are using this skill yet. Use “Add to agent” to attach it.
          </div>
        ) : (
          <div className="border-y border-border">
            {attached.map((agent) => {
              const meta = attachAgentMetaById.get(agent.id);
              return (
                <div key={agent.id} className="flex items-center gap-3 border-b border-border py-3 text-sm last:border-b-0">
                  <AgentIcon icon={meta?.icon ?? null} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{agent.name}</span>
                      {meta?.paused ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-500">
                          <Pause className="h-2.5 w-2.5" aria-hidden="true" />
                          Paused
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{agent.adapterType}</div>
                  </div>
                  <Link
                    to={`/agents/${agent.urlKey}/skills`}
                    className="shrink-0 text-xs text-muted-foreground no-underline hover:text-foreground"
                  >
                    View
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const tabBody = activeTab === "files"
    ? renderFilesBody()
    : activeTab === "versions"
      ? renderVersionsBody()
      : activeTab === "agents"
        ? renderAgentsBody()
        : renderOverviewBody();

  return (
    <div className="min-h-[calc(100vh-12rem)]">
      <div className="border-b border-border px-4 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-start gap-3">
              <SkillCardIcon
                card={{
                  key: detail.key,
                  skillId: detail.id,
                  catalogRef: null,
                  name: detail.name,
                  slug: detail.slug,
                  author: detail.authorName ?? source.label,
                  version: null,
                  tagline: detail.tagline,
                  description: detail.description,
                  categories: detail.categories,
                  iconUrl: detail.iconUrl,
                  color: detail.color,
                  starCount: detail.starCount,
                  agentCount: detail.attachedAgentCount,
                  forkCount: detail.forkCount,
                  installed: true,
                  required: false,
                  forkedFrom: Boolean(detail.forkedFromSkillId),
                  updatedAt: new Date(detail.updatedAt).getTime() || 0,
                }}
                size={44}
              />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate text-2xl font-semibold">{detail.name}</h1>
                  {/* Source icon sits right after the title; the tooltip names
                      where the skill was installed from (PAP-10907). */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={`Installed from ${source.label}`}
                      >
                        <SourceIcon className="h-4 w-4" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Installed from {source.label}</TooltipContent>
                  </Tooltip>
                </div>
                {/* GitHub-style "by" attribution sits directly under the title. */}
                {detail.authorName ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    by <span className="text-foreground">{detail.authorName}</span>
                  </p>
                ) : null}
                {subtitleText ? (
                  <div className="mt-1 max-w-2xl">
                    <p
                      ref={descriptionRef}
                      className={cn(
                        "text-sm text-muted-foreground",
                        !descExpanded && "line-clamp-4",
                      )}
                    >
                      {subtitleText}
                    </p>
                    {descClamped ? (
                      <button
                        type="button"
                        onClick={() => setDescExpanded((value) => !value)}
                        className="mt-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {descExpanded ? "Show less" : "View all"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {detail.categories.slice(0, 4).map((category) => (
                <SkillCategoryChip key={category} label={category} />
              ))}
            </div>
          </div>
          {/* GitHub-style social proof, top-right: installs · stars · fork.
              "Installs" counts agents that currently have this skill attached
              (PAP-10907); stars and fork are interactive. */}
          <div className="flex flex-wrap items-center justify-end gap-1">
            <div className="flex items-center overflow-hidden rounded-md border border-border">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="font-medium text-foreground">{detail.attachedAgentCount}</span>
                    <span className="hidden sm:inline">{detail.attachedAgentCount === 1 ? "install" : "installs"}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Agents in this company that currently have this skill installed.</TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={onToggleStar}
                disabled={starPending}
                className="inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
                title={detail.starredByCurrentActor ? "Unstar this skill" : "Star this skill"}
              >
                <Star className={cn("h-3.5 w-3.5", detail.starredByCurrentActor && "fill-current text-yellow-400")} />
                <span className="hidden sm:inline">{detail.starredByCurrentActor ? "Starred" : "Star"}</span>
                <span className="font-medium text-foreground">{detail.starCount}</span>
              </button>
              <button
                type="button"
                onClick={onFork}
                className="inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                title="Fork this skill"
              >
                <GitFork className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Fork</span>
                <span className="font-medium text-foreground">{detail.forkCount}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <main className="min-w-0">
          <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as SkillDetailTab)}>
            {/* Underlined tab strip: the bottom padding keeps the active-tab
                underline inside the horizontal-scroll clip box (PAP-10907). */}
            <TabsList variant="line" className="mb-5 w-full max-w-full justify-start overflow-x-auto border-b border-border p-0 pb-1.5 [scrollbar-width:none]">
              {SKILL_DETAIL_TABS.map((tab) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger key={tab.value} value={tab.value} className="px-3">
                    <Icon className="mr-1.5 h-3.5 w-3.5" />
                    {tab.label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          {tabBody}
        </main>

        <aside className="min-w-0 space-y-6 border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</div>
            <div className="space-y-3">
              {/* Big primary action opens the agent multi-selector (PAP-10907). */}
              <AttachAgentsPopover
                agents={attachAgents}
                attachedAgentIds={detail.usedByAgents.map((agent) => agent.id)}
                versions={versions}
                selectedVersionId={currentVersionSelection(detail)}
                pending={attachPending}
                onSubmit={onSubmitAttach}
                fullWidth
              />
              {detail.usedByAgents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No agents attached yet.</p>
              ) : (
                <div className="space-y-0.5">
                  {/* Preview up to three attached agents, then summarise the rest. */}
                  {detail.usedByAgents.slice(0, 3).map((agent) => {
                    const meta = attachAgentMetaById.get(agent.id);
                    return (
                      <Link
                        key={agent.id}
                        to={`/agents/${agent.urlKey}/skills`}
                        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm no-underline hover:bg-accent/40"
                      >
                        <AgentIcon icon={meta?.icon ?? null} className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
                        {meta?.paused ? (
                          <Pause className="h-3 w-3 shrink-0 text-amber-500" aria-label="Paused" />
                        ) : null}
                      </Link>
                    );
                  })}
                  {detail.usedByAgents.length > 3 ? (
                    <p className="px-1.5 pt-0.5 text-xs text-muted-foreground">
                      and {detail.usedByAgents.length - 3} more
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </section>

          {/* Provenance: where this skill came from, with org/path linked when
              available. Bundled/catalog skills surface their source label too
              (PAP-10907). */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</div>
            {githubSource ? (
              <div className="flex items-start gap-2 text-sm">
                <Github className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-foreground">{githubLabel}</div>
                  <a
                    href={githubHref ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    title={githubRepoText ?? undefined}
                    className="mt-0.5 flex max-w-full items-center gap-1 text-xs text-muted-foreground no-underline transition-colors hover:text-foreground"
                  >
                    <span className="truncate">{githubRepoText}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                  </a>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={githubSource.commit}>
                    {githubSource.ref}
                    {githubSource.commit ? ` · ${githubSource.commit.slice(0, 7)}` : ""}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm">
                <SourceIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-foreground">{source.label}</div>
                  {sourceLocatorDisplay ? (
                    sourceHref ? (
                      <a
                        href={sourceHref}
                        target="_blank"
                        rel="noreferrer"
                        title={sourceLocatorText ?? undefined}
                        className="mt-0.5 flex max-w-full items-center gap-1 text-xs text-muted-foreground no-underline transition-colors hover:text-foreground"
                      >
                        <span className="truncate">{sourceLocatorDisplay}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      </a>
                    ) : (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={sourceLocatorText ?? undefined}>
                        {sourceLocatorDisplay}
                      </div>
                    )
                  ) : (
                    <div className="mt-0.5 text-xs text-muted-foreground">{source.managedLabel}</div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Revision / update controls sit under Agents, above the config gear
              (PAP-10907 F). Only GitHub-sourced skills can pull updates. */}
          {detail.sourceType === "github" ? (
            <section>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Updates</div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Pin className="h-3.5 w-3.5 shrink-0" aria-label="Pinned source revision" />
                    </TooltipTrigger>
                    <TooltipContent>Pinned source revision</TooltipContent>
                  </Tooltip>
                  <span className="truncate font-mono text-foreground">{currentPin ?? "untracked"}</span>
                </div>
                <Button variant="outline" size="sm" className="w-full" onClick={onCheckUpdates} disabled={checkUpdatesPending || updateStatusLoading}>
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  Check for updates
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate ? (
                  <Button size="sm" className="w-full" onClick={onInstallUpdate} disabled={installUpdatePending}>
                    <ArrowUpCircle className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    Install update{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                ) : updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading ? (
                  <p className="text-xs text-muted-foreground">Up to date.</p>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Config lives behind a gear; sharing + danger zone open in a modal
              (PAP-10907 A). */}
          <section>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
            >
              <Settings className="h-4 w-4 shrink-0" />
              <span className="flex-1">Settings</span>
            </button>
          </section>
        </aside>
      </div>

      {/* Floating save bar: stays visible while a file edit is dirty so the
          unsaved state is obvious (PAP-10907 J). */}
      {isDirty ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
          <span className="text-sm text-muted-foreground">Unsaved changes</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(savedFileContent);
              setEditMode(false);
            }}
            disabled={savePending}
          >
            Discard
          </Button>
          <Button size="sm" onClick={onSave} disabled={savePending}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {savePending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      ) : null}

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Skill settings</DialogTitle>
            <DialogDescription>Manage how {detail.name} is shared.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sharing</label>
              <select
                value={detail.sharingScope === "public_link" ? "company" : detail.sharingScope}
                onChange={(event) => onUpdateSharingScope(event.target.value as Exclude<CompanySkillSharingScope, "public_link">)}
                disabled={updateSharingPending}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                <option value="company">Company — visible inside this company</option>
                <option value="private">Private — only visible in your library</option>
              </select>
              <p className="text-xs text-muted-foreground">Public link sharing is coming later.</p>
            </div>
            {detail.editable ? (
              <div className="rounded-md border border-destructive/40 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-destructive">Danger zone</div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="min-w-0 text-xs text-muted-foreground">Remove this skill from the company library.</p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0"
                    onClick={onDelete}
                    disabled={deletePending}
                    title={detail.usedByAgents.length > 0 ? "Detach this skill from all agents before removing it." : undefined}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {deletePending ? "Removing…" : "Remove"}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillPane({
  loading,
  detail,
  file,
  fileLoading,
  updateStatus,
  updateStatusLoading,
  viewMode,
  editMode,
  draft,
  setViewMode,
  setEditMode,
  setDraft,
  onCheckUpdates,
  checkUpdatesPending,
  onInstallUpdate,
  installUpdatePending,
  onDelete,
  deletePending,
  onSave,
  savePending,
  attachAgents,
  versions,
  onSubmitAttach,
  attachPending,
}: {
  loading: boolean;
  detail: CompanySkillDetail | null | undefined;
  file: CompanySkillFileDetail | null | undefined;
  fileLoading: boolean;
  updateStatus: CompanySkillUpdateStatus | null | undefined;
  updateStatusLoading: boolean;
  viewMode: "preview" | "code";
  editMode: boolean;
  draft: string;
  setViewMode: (mode: "preview" | "code") => void;
  setEditMode: (value: boolean) => void;
  setDraft: (value: string) => void;
  onCheckUpdates: () => void;
  checkUpdatesPending: boolean;
  onInstallUpdate: () => void;
  installUpdatePending: boolean;
  onDelete: () => void;
  deletePending: boolean;
  onSave: () => void;
  savePending: boolean;
  attachAgents: AttachAgentOption[];
  versions: CompanySkillVersion[];
  onSubmitAttach: (ids: string[], versionId: string | null) => void;
  attachPending: boolean;
}) {
  const { t } = useTranslation();
  if (!detail) {
    if (loading) {
      return <PageSkeleton variant="detail" />;
    }
    return (
      <EmptyState
        icon={Boxes}
        message={t("companySkills.selectSkillToInspect")}
      />
    );
  }

  const source = sourceMeta(detail.sourceBadge, detail.sourceLabel);
  const SourceIcon = source.icon;
  const usedBy = detail.usedByAgents;
  const body = file?.markdown ? stripFrontmatter(file.content) : file?.content ?? "";
  const currentPin = shortRef(detail.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);
  const displaySourcePath = detail.sourcePath ? middleTruncate(detail.sourcePath) : null;
  const removeBlocked = usedBy.length > 0;
  const removeDisabledReason = removeBlocked
    ? t("companySkills.detachBeforeRemove")
    : null;

  return (
    <div className="min-w-0">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-2xl font-semibold">
              <SourceIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
              {detail.name}
            </h1>
            {detail.description && (
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{detail.description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={deletePending}
              title={removeDisabledReason ?? undefined}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {deletePending ? t("companySkills.removing") : t("common.remove")}
            </Button>
            {detail.editable ? (
              <button
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setEditMode(!editMode)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {editMode ? t("companySkills.stopEditing") : t("common.edit")}
              </button>
            ) : (
              <div className="text-sm text-muted-foreground">{detail.editableReason}</div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("companySkills.source")}</span>
              <span className="flex min-w-0 items-center gap-2">
                <SourceIcon className="h-3.5 w-3.5 text-muted-foreground" />
                {detail.sourcePath && displaySourcePath ? (
                  <>
                    <span
                      className="block min-w-0 max-w-[min(34rem,55vw)] truncate font-mono text-xs text-muted-foreground"
                      title={detail.sourcePath}
                    >
                      {displaySourcePath}
                    </span>
                    <CopyText
                      text={detail.sourcePath}
                      copiedLabel={t("companySkills.copiedPath")}
                      ariaLabel={t("companySkills.copySourcePath")}
                      title={t("companySkills.copySourcePath")}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </>
                ) : (
                  <span className="truncate">{source.label}</span>
                )}
              </span>
            </div>
            {detail.sourceType === "github" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("companySkills.pin")}</span>
                <span className="font-mono text-xs">{currentPin ?? t("companySkills.untracked")}</span>
                {updateStatus?.trackingRef && (
                  <span className="text-xs text-muted-foreground">{t("companySkills.tracking", { ref: updateStatus.trackingRef })}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCheckUpdates}
                  disabled={checkUpdatesPending || updateStatusLoading}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  {t("companySkills.checkForUpdates")}
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate && (
                  <Button
                    size="sm"
                    onClick={onInstallUpdate}
                    disabled={installUpdatePending}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    {t("companySkills.installUpdate")}{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                )}
                {updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading && (
                  <span className="text-xs text-muted-foreground">{t("companySkills.upToDate")}</span>
                )}
                {!updateStatus?.supported && updateStatus?.reason && (
                  <span className="text-xs text-muted-foreground">{updateStatus.reason}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("companySkills.key")}</span>
              <span className="font-mono text-xs">{detail.key}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("companySkills.mode")}</span>
              <span>{detail.editable ? t("companySkills.editable") : t("companySkills.readOnly")}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("companySkills.usedBy")}</span>
            {usedBy.length === 0 ? (
              <span className="text-muted-foreground">{t("companySkills.noAgentsAttached")}</span>
            ) : (
              <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {usedBy.map((agent) => (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.urlKey}/skills`}
                    className="group rounded-md border border-transparent p-2 no-underline hover:border-border hover:bg-accent/40"
                  >
                    <Identity name={agent.name} size="sm" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm">{file?.path ?? "SKILL.md"}</div>
          </div>
          <div className="flex items-center gap-2">
            {file?.markdown && !editMode && (
              <div className="flex items-center border border-border">
                <button
                  className={cn("px-3 py-1.5 text-sm", viewMode === "preview" && "text-foreground", viewMode !== "preview" && "text-muted-foreground")}
                  onClick={() => setViewMode("preview")}
                >
                  <span className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5" />
                    {t("companySkills.view")}
                  </span>
                </button>
                <button
                  className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" && "text-foreground", viewMode !== "code" && "text-muted-foreground")}
                  onClick={() => setViewMode("code")}
                >
                  <span className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5" />
                    {t("companySkills.code")}
                  </span>
                </button>
              </div>
            )}
            {editMode && file?.editable && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" onClick={onSave} disabled={savePending}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {savePending ? t("common.saving") : t("common.save")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-[560px] px-5 py-5">
        {fileLoading ? (
          <PageSkeleton variant="detail" />
        ) : !file ? (
          <div className="text-sm text-muted-foreground">{t("companySkills.selectFileToInspect")}</div>
        ) : editMode && file.editable ? (
          file.markdown ? (
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              bordered={false}
              className="min-h-[520px]"
            />
          ) : (
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[520px] rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
            />
          )
        ) : file.markdown && viewMode === "preview" ? (
          <MarkdownBody softBreaks={false} linkIssueReferences={false}>{body}</MarkdownBody>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word border-0 bg-transparent p-0 font-mono text-sm text-foreground">
            <code>{file.content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function CompanySkills() {
  const { t } = useTranslation();
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const adapterCaps = useAdapterCapabilities();
  const [skillFilter, setSkillFilter] = useState("");
  const [source, setSource] = useState("");
  const [emptySourceHelpOpen, setEmptySourceHelpOpen] = useState(false);
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, Set<string>>>({});
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [displayedDetail, setDisplayedDetail] = useState<CompanySkillDetail | null>(null);
  const [displayedFile, setDisplayedFile] = useState<CompanySkillFileDetail | null>(null);
  const [scanStatusMessage, setScanStatusMessage] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTargetSkillId, setDeleteTargetSkillId] = useState<string | null>(null);
  const [deleteTargetDetail, setDeleteTargetDetail] = useState<CompanySkillDetail | null>(null);
  const [catalogFilter, setCatalogFilter] = useState("");
  const [catalogKindFilter, setCatalogKindFilter] = useState<"all" | "bundled" | "optional">("all");
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState<string>("");
  const [catalogSelectedPath, setCatalogSelectedPath] = useState<string>("SKILL.md");
  const [expandedCatalogSkillId, setExpandedCatalogSkillId] = useState<string | null>(null);
  const [expandedCatalogDirs, setExpandedCatalogDirs] = useState<Record<string, Set<string>>>({});
  const [installDialogState, setInstallDialogState] = useState<{
    open: boolean;
    catalogSkill: CatalogSkill | null;
    conflict: CompanySkillListItem | null;
    defaultSlug: string | null;
    defaultForce: boolean;
    defaultAction: "install" | "update" | "replace";
    error: string | null;
  }>({ open: false, catalogSkill: null, conflict: null, defaultSlug: null, defaultForce: false, defaultAction: "install", error: null });
  const [discoverySearch, setDiscoverySearch] = useState("");
  const [discoverySort, setDiscoverySort] = useState<DiscoverySort>("agents");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<SkillCreateDraft>(() => buildBlankSkillDraft());
  const [createError, setCreateError] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const routeSkillToken = parsedRoute.skillToken;
  const selectedPath = parsedRoute.filePath;
  const viewParam = searchParams.get("view");
  const activeView: "installed" | "catalog" = viewParam === "catalog" ? "catalog" : "installed";
  const sourceFilterParam = searchParams.get("source") ?? "all";
  const sourceFilter: SourceFilter = (["all", "company", "bundled", "optional", "external"] as SourceFilter[]).includes(sourceFilterParam as SourceFilter)
    ? (sourceFilterParam as SourceFilter)
    : "all";
  const selectedCatalogRef = searchParams.get("catalog");
  const tabParam = searchParams.get("tab");
  const discoveryTab: DiscoveryTab = DISCOVERY_TABS.includes(tabParam as DiscoveryTab)
    ? (tabParam as DiscoveryTab)
    : "all";
  const detailTab: SkillDetailTab = (["overview", "files", "versions", "agents"] as SkillDetailTab[]).includes(tabParam as SkillDetailTab)
    ? (tabParam as SkillDetailTab)
    : parsedRoute.hasExplicitFilePath || selectedPath !== "SKILL.md"
      ? "files"
      : "overview";
  const discoveryCategory = searchParams.get("category");
  // Discovery grid owns `/skills` whenever no specific skill or catalog entry is
  // selected; selecting either drops into the existing master/detail surfaces.
  const isDiscovery = !routeSkillToken && !selectedCatalogRef;

  function setDiscoveryTab(tab: DiscoveryTab) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (tab === "all") params.delete("tab");
      else params.set("tab", tab);
      params.delete("category");
      return params;
    });
  }

  function setDetailTab(tab: SkillDetailTab) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (tab === "overview") params.delete("tab");
      else params.set("tab", tab);
      return params;
    });
  }

  function setDiscoveryCategory(slug: string | null) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (slug) params.set("category", slug);
      else params.delete("category");
      return params;
    });
  }

  function setSourceFilter(next: SourceFilter) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === "all") params.delete("source");
      else params.set("source", next);
      return params;
    });
  }

  function selectCatalog(catalogRef: string | null, path = "SKILL.md") {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (catalogRef) params.set("catalog", catalogRef);
      else params.delete("catalog");
      return params;
    });
    setCatalogSelectedPath(path);
  }

  function openCreateWizard(initialDraft: SkillCreateDraft = buildBlankSkillDraft()) {
    setCreateDraft(initialDraft);
    setCreateError(null);
    setCreateDialogOpen(true);
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: t("nav.skills"), href: "/skills" },
      ...(routeSkillId ? [{ label: t("companySkills.detail") }] : []),
    ]);
  }, [routeSkillId, setBreadcrumbs, t]);

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const installedSkills = skillsQuery.data ?? [];
  const routeResolution = useMemo(
    () => resolveSkillRouteToken(routeSkillToken, installedSkills),
    [routeSkillToken, installedSkills],
  );

  // At `/skills` root the discovery grid is shown, so we no longer auto-select
  // the first skill; a skill is only "selected" once it is in the route.
  const selectedSkillId = routeResolution.skill?.id ?? null;

  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.detail(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(selectedCompanyId && selectedSkillId),
  });

  const fileQuery = useQuery({
    queryKey: queryKeys.companySkills.file(selectedCompanyId ?? "", selectedSkillId ?? "", selectedPath),
    queryFn: () => companySkillsApi.file(selectedCompanyId!, selectedSkillId!, selectedPath),
    enabled: Boolean(selectedCompanyId && selectedSkillId && selectedPath),
  });

  const versionsQuery = useQuery({
    queryKey: queryKeys.companySkills.versions(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.versions(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(selectedCompanyId && selectedSkillId),
  });

  const updateStatusQuery = useQuery({
    queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.updateStatus(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(
      selectedCompanyId
      && selectedSkillId
      && (detailQuery.data?.sourceType === "github" || displayedDetail?.sourceType === "github"),
    ),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!routeResolution.skill || !routeResolution.shouldRedirect || skillsQuery.isLoading) return;
    const search = searchParams.toString();
    navigate(
      {
        pathname: skillRoute(routeResolution.skill, installedSkills, selectedPath),
        search: search ? `?${search}` : "",
      },
      { replace: true },
    );
  }, [installedSkills, navigate, routeResolution, searchParams, selectedPath, skillsQuery.isLoading]);

  useEffect(() => {
    setExpandedSkillId(selectedSkillId);
  }, [selectedSkillId]);

  useEffect(() => {
    if (!selectedSkillId || selectedPath === "SKILL.md") return;
    const parents = parentDirectoryPaths(selectedPath);
    if (parents.length === 0) return;
    setExpandedDirs((current) => {
      const next = new Set(current[selectedSkillId] ?? []);
      let changed = false;
      for (const parent of parents) {
        if (!next.has(parent)) {
          next.add(parent);
          changed = true;
        }
      }
      return changed ? { ...current, [selectedSkillId]: next } : current;
    });
  }, [selectedPath, selectedSkillId]);

  useEffect(() => {
    setEditMode(false);
  }, [selectedSkillId, selectedPath]);

  useEffect(() => {
    if (detailQuery.data) {
      setDisplayedDetail(detailQuery.data);
    }
  }, [detailQuery.data]);

  useEffect(() => {
    if (fileQuery.data) {
      setDisplayedFile(fileQuery.data);
      setDraft(fileQuery.data.markdown ? splitFrontmatter(fileQuery.data.content).body : fileQuery.data.content);
    }
  }, [fileQuery.data]);

  useEffect(() => {
    if (selectedSkillId) return;
    setDisplayedDetail(null);
    setDisplayedFile(null);
  }, [selectedSkillId]);

  const activeDetail = detailQuery.data ?? displayedDetail;
  const activeFile = fileQuery.data ?? displayedFile;

  function routeForSkill(skill: CompanySkillRouteSubject, path?: string | null) {
    return skillRoute(skill, withRouteSkill(installedSkills, skill), path);
  }

  function routeForSkillId(skillId: string, path?: string | null) {
    const skill = installedSkills.find((entry) => entry.id === skillId)
      ?? (activeDetail?.id === skillId ? activeDetail : null);
    return skill ? routeForSkill(skill, path) : skillRoute(skillId, path);
  }

  function openDeleteDialog() {
    setDeleteTargetSkillId(selectedSkillId);
    setDeleteTargetDetail(activeDetail ?? null);
    setDeleteOpen(true);
  }

  function closeDeleteDialog(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteTargetSkillId(null);
      setDeleteTargetDetail(null);
    }
  }

  const importSkill = useMutation({
    mutationFn: (importSource: string) => companySkillsApi.importFromSource(selectedCompanyId!, importSource),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      if (result.imported[0]) navigate(routeForSkill(result.imported[0]));
      pushToast({
        tone: "success",
        title: t("companySkills.skillsImported"),
        body: t("companySkills.skillsAdded", { count: result.imported.length }),
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: t("companySkills.importWarnings"), body: result.warnings[0] });
      }
      setSource("");
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.importFailed"),
        body: error instanceof Error ? error.message : t("companySkills.importFailedBody"),
      });
    },
  });

  const createSkill = useMutation({
    mutationFn: (payload: CompanySkillCreateRequest) => companySkillsApi.create(selectedCompanyId!, payload),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      navigate(routeForSkill(skill));
      setCreateDialogOpen(false);
      setCreateError(null);
      setCreateDraft(buildBlankSkillDraft());
      pushToast({
        tone: "success",
        title: t("companySkills.skillCreated"),
        body: t("companySkills.skillCreatedBody", { name: skill.name }),
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to create skill.";
      setCreateError(message);
      pushToast({
        tone: "error",
        title: t("companySkills.creationFailed"),
        body: error instanceof Error ? error.message : t("companySkills.creationFailedBody"),
      });
    },
  });

  const scanProjects = useMutation({
    mutationFn: () => companySkillsApi.scanProjects(selectedCompanyId!),
    onMutate: () => {
      setScanStatusMessage(t("companySkills.scanning"));
    },
    onSuccess: async (result) => {
      setScanStatusMessage(t("companySkills.refreshingList"));
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      const summary = formatProjectScanSummary(result);
      setScanStatusMessage(summary);
      pushToast({
        tone: "success",
        title: t("companySkills.scanComplete"),
        body: summary,
      });
      if (result.conflicts[0]) {
        pushToast({
          tone: "warn",
          title: t("companySkills.conflictsFound"),
          body: result.conflicts[0].reason,
        });
      } else if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: t("companySkills.scanWarnings"),
          body: result.warnings[0],
        });
      }
    },
    onError: (error) => {
      setScanStatusMessage(null);
      pushToast({
        tone: "error",
        title: t("companySkills.scanFailed"),
        body: error instanceof Error ? error.message : t("companySkills.scanFailedBody"),
      });
    },
  });

  const saveFile = useMutation({
    mutationFn: () => companySkillsApi.updateFile(
      selectedCompanyId!,
      selectedSkillId!,
      selectedPath,
      activeFile?.markdown ? mergeFrontmatter(activeFile.content, draft) : draft,
    ),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(selectedCompanyId!, selectedSkillId!, selectedPath) }),
      ]);
      setDraft(result.markdown ? splitFrontmatter(result.content).body : result.content);
      setEditMode(false);
      pushToast({
        tone: "success",
        title: t("companySkills.skillSaved"),
        body: result.path,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.saveFailed"),
        body: error instanceof Error ? error.message : t("companySkills.saveFailedBody"),
      });
    },
  });

  const toggleStar = useMutation({
    mutationFn: () => {
      if (!activeDetail) throw new Error("Select a skill first.");
      return activeDetail.starredByCurrentActor
        ? companySkillsApi.unstar(selectedCompanyId!, activeDetail.id)
        : companySkillsApi.star(selectedCompanyId!, activeDetail.id);
    },
    onSuccess: async () => {
      if (!activeDetail) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, activeDetail.id) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Star failed",
        body: error instanceof Error ? error.message : "Failed to update star.",
      });
    },
  });

  const updateSkillSettings = useMutation({
    mutationFn: (payload: { skillId: string; sharingScope: Exclude<CompanySkillSharingScope, "public_link"> }) =>
      companySkillsApi.update(selectedCompanyId!, payload.skillId, { sharingScope: payload.sharingScope }),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, skill.id) }),
      ]);
      pushToast({ tone: "success", title: "Sharing updated", body: skill.sharingScope === "private" ? "Private" : "Company" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Sharing update failed",
        body: error instanceof Error ? error.message : "Failed to update sharing scope.",
      });
    },
  });

  const installUpdate = useMutation({
    mutationFn: () => companySkillsApi.installUpdate(selectedCompanyId!, selectedSkillId!),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(selectedCompanyId!, selectedSkillId!, selectedPath) }),
      ]);
      navigate(routeForSkill(skill, selectedPath));
      pushToast({
        tone: "success",
        title: t("companySkills.skillUpdated"),
        body: skill.sourceRef ? t("companySkills.pinnedTo", { ref: shortRef(skill.sourceRef) }) : skill.name,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.updateFailed"),
        body: error instanceof Error ? error.message : t("companySkills.updateFailedBody"),
      });
    },
  });

  const catalogListQuery = useQuery({
    queryKey: queryKeys.companySkills.catalog(),
    queryFn: () => companySkillsApi.catalogList(),
    enabled: Boolean(selectedCompanyId),
    staleTime: 60_000,
  });

  const catalogDetailQuery = useQuery({
    queryKey: queryKeys.companySkills.catalogDetail(selectedCatalogRef ?? ""),
    queryFn: () => companySkillsApi.catalogDetail(selectedCatalogRef!),
    enabled: Boolean(selectedCompanyId && selectedCatalogRef),
    staleTime: 60_000,
  });

  const catalogFileQuery = useQuery({
    queryKey: queryKeys.companySkills.catalogFile(selectedCatalogRef ?? "", catalogSelectedPath),
    queryFn: () => companySkillsApi.catalogFile(selectedCatalogRef!, catalogSelectedPath),
    enabled: Boolean(selectedCompanyId && selectedCatalogRef && catalogSelectedPath),
    staleTime: 60_000,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const installedByKey = useMemo(
    () => new Map(installedSkills.map((skill) => [skill.key, skill])),
    [installedSkills],
  );
  const catalogCategories = useMemo(() => {
    const set = new Set<string>();
    for (const skill of catalogListQuery.data ?? []) set.add(skill.category);
    return Array.from(set).sort();
  }, [catalogListQuery.data]);

  // --- Discovery grid derived data (PAP-10879) ---
  const discoveryCards = useMemo(
    () => buildDiscoveryCards(installedSkills, catalogListQuery.data ?? []),
    [installedSkills, catalogListQuery.data],
  );
  const discoveryTabCounts = useMemo(() => ({
    all: discoveryCards.length,
    installed: discoveryCards.filter((card) => card.installed).length,
    catalog: discoveryCards.filter((card) => card.catalogRef != null).length,
    bundled: discoveryCards.filter((card) => card.required).length,
  }), [discoveryCards]);
  const discoveryTabCards = useMemo(
    () => cardsForTab(discoveryCards, discoveryTab),
    [discoveryCards, discoveryTab],
  );
  const discoveryCategoryCounts = useMemo<DiscoveryCategory[]>(() => {
    const counts = new Map<string, number>();
    for (const card of discoveryTabCards) {
      for (const category of card.categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([slug, count]) => ({ slug, count }))
      .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  }, [discoveryTabCards]);
  const visibleDiscoveryCards = useMemo(() => {
    const filtered = discoveryTabCards.filter((card) => {
      if (discoveryCategory && !card.categories.includes(discoveryCategory)) return false;
      return discoveryMatchesSearch(card, discoverySearch.trim());
    });
    return sortDiscoveryCards(filtered, discoverySort, discoveryTab !== "bundled");
  }, [discoveryTabCards, discoveryCategory, discoverySearch, discoverySort, discoveryTab]);

  const selectedCatalogSkill = catalogDetailQuery.data
    ?? (catalogListQuery.data ?? []).find((entry) => entry.id === selectedCatalogRef || entry.key === selectedCatalogRef)
    ?? null;

  useEffect(() => {
    setExpandedCatalogSkillId(selectedCatalogSkill?.id ?? null);
  }, [selectedCatalogSkill?.id]);

  useEffect(() => {
    if (!selectedCatalogSkill || catalogSelectedPath === "SKILL.md") return;
    const parents = parentDirectoryPaths(catalogSelectedPath);
    if (parents.length === 0) return;
    setExpandedCatalogDirs((current) => {
      const next = new Set(current[selectedCatalogSkill.id] ?? []);
      let changed = false;
      for (const parent of parents) {
        if (!next.has(parent)) {
          next.add(parent);
          changed = true;
        }
      }
      return changed ? { ...current, [selectedCatalogSkill.id]: next } : current;
    });
  }, [catalogSelectedPath, selectedCatalogSkill]);

  const sourceCounts = useMemo<Record<SourceFilter, number>>(() => {
    const counts: Record<SourceFilter, number> = { all: installedSkills.length, company: 0, bundled: 0, optional: 0, external: 0 };
    for (const skill of installedSkills) {
      const cls = classifySource(skill);
      counts[cls] += 1;
    }
    return counts;
  }, [installedSkills]);
  const installCatalog = useMutation({
    mutationFn: (payload: { catalogSkillId: string; slug: string | null; force: boolean }) =>
      companySkillsApi.installCatalog(selectedCompanyId!, {
        catalogSkillId: payload.catalogSkillId,
        slug: payload.slug,
        force: payload.force,
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, result.skill.id) }),
      ]);
      setInstallDialogState((current) => ({ ...current, open: false, error: null }));
      pushToast({
        tone: "success",
        title: result.action === "created" ? "Skill installed" : result.action === "updated" ? "Skill updated" : "Skill is up to date",
        body: result.skill.name,
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: "Install warnings", body: result.warnings[0] });
      }
      if (result.action === "created") {
        navigate(routeForSkill(result.skill));
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to install catalog skill.";
      setInstallDialogState((current) => ({ ...current, error: message }));
    },
  });

  const eligibleAgentsForAttach = useMemo(() => {
    const data = agentsQuery.data ?? [];
    return data.map((agent: Agent) => {
      const caps = adapterCaps(agent.adapterType);
      const requiredKeys: string[] = [];
      const usedSet = new Set((activeDetail?.usedByAgents ?? []).map((entry) => entry.id));
      const isRequired = false; // detection currently lives server-side; default false until detail surfaces required state
      return {
        id: agent.id,
        name: agent.name,
        adapterType: agent.adapterType,
        supportsSkills: Boolean(caps.supportsSkills),
        required: isRequired,
        icon: agent.icon,
        paused: agent.status === "paused" || agent.pausedAt != null,
        attached: usedSet.has(agent.id),
        requiredKeys,
      };
    });
  }, [agentsQuery.data, adapterCaps, activeDetail]);

  const attachAgentsMutation = useMutation({
    mutationFn: async (input: { agentId: string; desiredSkills: Array<string | AgentDesiredSkillEntry> }) => {
      return agentsApi.syncSkills(input.agentId, input.desiredSkills, selectedCompanyId ?? undefined);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId ?? "") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.versions(selectedCompanyId!, selectedSkillId ?? "") }),
      ]);
    },
  });

  async function handleAttachSubmit(nextAgentIds: string[], versionId: string | null = null) {
    if (!activeDetail) return;
    const skillKey = activeDetail.key;
    const targetSet = new Set(nextAgentIds);
    const current = (activeDetail.usedByAgents ?? []).map((entry) => entry.id);
    const currentSet = new Set(current);
    const currentVersionByAgent = new Map(
      (activeDetail.usedByAgents ?? []).map((entry) => [entry.id, entry.versionId ?? null]),
    );
    const toAdd = nextAgentIds.filter((id) => !currentSet.has(id));
    const toRemove = current.filter((id) => !targetSet.has(id));
    const toUpdateVersion = nextAgentIds.filter((id) =>
      currentSet.has(id) && (currentVersionByAgent.get(id) ?? null) !== versionId,
    );
    const affected = new Set<string>([...toAdd, ...toRemove, ...toUpdateVersion]);
    if (affected.size === 0) {
      return;
    }
    try {
      for (const agentId of affected) {
        const snapshot = await agentsApi.skills(agentId, selectedCompanyId ?? undefined);
        const currentEntries: AgentDesiredSkillEntry[] = (snapshot.desiredSkillEntries ?? snapshot.desiredSkills.map((key) => ({ key, versionId: null })))
          .filter((entry) => entry.key !== skillKey);
        if (targetSet.has(agentId)) {
          currentEntries.push({ key: skillKey, versionId });
        }
        await attachAgentsMutation.mutateAsync({ agentId, desiredSkills: currentEntries });
      }
      pushToast({ tone: "success", title: "Agents updated", body: `${nextAgentIds.length} agent(s) attached.` });
    } catch (error) {
      pushToast({ tone: "error", title: "Update failed", body: error instanceof Error ? error.message : "Failed to update agent skills." });
    }
  }

  function openInstallDialog(catalogSkill: CatalogSkill) {
    const existing = installedByKey.get(catalogSkill.key) ?? null;
    const installedHash = existing?.originHash ?? null;
    const action: "install" | "update" | "replace" = existing
      ? installedHash && installedHash !== catalogSkill.contentHash
        ? "update"
        : existing.sourceType !== "catalog"
          ? "replace"
          : "update"
      : "install";
    setInstallDialogState({
      open: true,
      catalogSkill,
      conflict: existing,
      defaultSlug: existing?.slug ?? catalogSkill.slug,
      defaultForce: action === "replace",
      defaultAction: action,
      error: null,
    });
  }

  const deleteSkill = useMutation({
    mutationFn: () => companySkillsApi.delete(selectedCompanyId!, deleteTargetSkillId!),
    onSuccess: async (skill) => {
      closeDeleteDialog(false);
      setDisplayedDetail(null);
      setDisplayedFile(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        ...(deleteTargetSkillId ? [
          queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, deleteTargetSkillId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId!, deleteTargetSkillId) }),
        ] : []),
        ...(deleteTargetSkillId ? [
          queryClient.invalidateQueries({
            queryKey: queryKeys.companySkills.file(selectedCompanyId!, deleteTargetSkillId, selectedPath),
          }),
        ] : []),
      ]);
      await queryClient.refetchQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
        type: "active",
      });
      navigate("/skills", { replace: true });
      pushToast({
        tone: "success",
        title: t("companySkills.skillRemoved"),
        body: t("companySkills.skillRemovedBody", { name: skill.name }),
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("companySkills.removeFailed"),
        body: error instanceof Error ? error.message : t("companySkills.removeFailedBody"),
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message={t("companySkills.selectCompany")} />;
  }

  function handleAddSkillSource() {
    const trimmedSource = source.trim();
    if (trimmedSource.length === 0) {
      setEmptySourceHelpOpen(true);
      return;
    }
    importSkill.mutate(trimmedSource);
  }

  // Opening a card stays inside the new store and always lands on a regular full
  // page: installed skills go to their detail route; catalog/bundled/optional
  // skills open the standalone catalog page (no modal, no legacy split view).
  function openDiscoveryCard(card: DiscoveryCard) {
    if (card.skillId) {
      navigate(routeForSkillId(card.skillId));
      return;
    }
    if (card.catalogRef) {
      selectCatalog(card.catalogRef);
    }
  }

  // "Back to store" returns to the discovery grid while keeping the tab /
  // category / source filters the user arrived with (PAP-10907).
  const backToStoreParams = new URLSearchParams(searchParams);
  backToStoreParams.delete("catalog");
  const backToStoreParamString = backToStoreParams.toString();
  const backToStoreHref = backToStoreParamString ? `/skills?${backToStoreParamString}` : "/skills";

  // Surface the upstream catalog source (GitHub owner/repo/path) on the installed
  // skill detail, matched by canonical key (PAP-10907).
  const catalogSourceForDetail = activeDetail
    ? (catalogListQuery.data ?? []).find((entry) => entry.key === activeDetail.key)?.source ?? null
    : null;

  return (
    <>
      <Dialog open={deleteOpen} onOpenChange={closeDeleteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companySkills.removeSkill")}</DialogTitle>
            <DialogDescription>
              {t("companySkills.removeSkillDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {deleteTargetDetail
                ? t("companySkills.aboutToRemoveNamed", { name: deleteTargetDetail.name })
                : t("companySkills.aboutToRemove")}
            </p>
            {deleteTargetDetail?.usedByAgents?.length ? (
              <div className="rounded-md border border-border px-3 py-3 text-muted-foreground">
                {t("companySkills.currentlyUsedBy", { agents: deleteTargetDetail.usedByAgents.map((agent) => agent.name).join(", ") })}
              </div>
            ) : null}
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                {t("companySkills.detachToEnableRemoval")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {(deleteTargetDetail?.usedByAgents.length ?? 0) > 0 ? (
              <Button variant="ghost" onClick={() => closeDeleteDialog(false)}>
                {t("common.close")}
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => closeDeleteDialog(false)} disabled={deleteSkill.isPending}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteSkill.mutate()}
                  disabled={deleteSkill.isPending || !deleteTargetSkillId}
                >
                  {deleteSkill.isPending ? t("companySkills.removing") : t("companySkills.removeSkill")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emptySourceHelpOpen} onOpenChange={setEmptySourceHelpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companySkills.addSkillSource")}</DialogTitle>
            <DialogDescription>
              {t("companySkills.addSkillSourceDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">{t("companySkills.browseSkillsSh")}</span>
                <span className="mt-1 block text-muted-foreground">
                  {t("companySkills.browseSkillsShHint")}
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
            <a
              href="https://github.com/search?q=SKILL.md&type=code"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">{t("companySkills.searchGitHub")}</span>
                <span className="mt-1 block text-muted-foreground">
                  {t("companySkills.searchGitHubHint")}
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <div className="grid min-h-[calc(100vh-12rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="border-r border-border">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h1 className="text-base font-semibold">{t("nav.skills")}</h1>
                <p className="text-xs text-muted-foreground">
                  {t("companySkills.availableCount", { count: skillsQuery.data?.length ?? 0 })}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => scanProjects.mutate()}
                  disabled={scanProjects.isPending}
                  title={t("companySkills.scanWorkspacesTitle")}
                >
                  <RefreshCw className={cn("h-4 w-4", scanProjects.isPending && "animate-spin")} />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setCreateOpen((value) => !value)}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={skillFilter}
                onChange={(event) => setSkillFilter(event.target.value)}
                placeholder={t("companySkills.filterSkills")}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Import a skill</DialogTitle>
            <DialogDescription>
              Paste a local path, GitHub URL, or `skills.sh` command to import a skill into this company.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-border pb-2">
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder={t("companySkills.sourcePlaceholder")}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={handleAddSkillSource}
                disabled={importSkill.isPending}
              >
                {importSkill.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : t("common.add")}
              </Button>
            </div>
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-sm text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">Browse skills.sh</span>
                <span className="mt-1 block text-muted-foreground">Find install commands and paste one here.</span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
            <a
              href="https://github.com/search?q=SKILL.md&type=code"
              target="_blank"
              rel="noreferrer"
              className="flex items-start justify-between rounded-md border border-border px-3 py-3 text-sm text-foreground no-underline transition-colors hover:bg-accent/40"
            >
              <span>
                <span className="block font-medium">Search GitHub</span>
                <span className="mt-1 block text-muted-foreground">Look for repositories with `SKILL.md`, then paste the repo URL.</span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          </div>
        </DialogContent>
      </Dialog>

      {isDiscovery ? (
        <DiscoveryGrid
          tab={discoveryTab}
          tabCounts={discoveryTabCounts}
          onTabChange={setDiscoveryTab}
          categories={discoveryCategoryCounts}
          categoryTotal={discoveryTabCards.length}
          activeCategory={discoveryCategory}
          onCategoryChange={setDiscoveryCategory}
          search={discoverySearch}
          onSearchChange={setDiscoverySearch}
          sort={discoverySort}
          onSortChange={setDiscoverySort}
          cards={visibleDiscoveryCards}
          onOpenCard={openDiscoveryCard}
          loading={skillsQuery.isLoading || catalogListQuery.isLoading}
          error={skillsQuery.error?.message ?? catalogListQuery.error?.message ?? null}
          totalCount={discoveryCards.length}
          onCreate={() => openCreateWizard()}
          onImport={() => setImportDialogOpen(true)}
          onBrowseCatalog={() => setDiscoveryTab("catalog")}
          onScan={() => scanProjects.mutate()}
          scanPending={scanProjects.isPending}
          scanStatus={scanStatusMessage}
        />
      ) : activeView === "installed" && selectedSkillId ? (
        <SkillDetailPage
          detail={activeDetail}
          catalogSource={catalogSourceForDetail}
          routeSkills={installedSkills}
          loading={skillsQuery.isLoading || detailQuery.isLoading}
          activeTab={detailTab}
          onTabChange={setDetailTab}
          selectedPath={selectedPath}
          file={activeFile}
          fileLoading={fileQuery.isLoading && !activeFile}
          viewMode={viewMode}
          editMode={editMode}
          draft={draft}
          setViewMode={setViewMode}
          setEditMode={setEditMode}
          setDraft={setDraft}
          onSave={() => saveFile.mutate()}
          savePending={saveFile.isPending}
          versions={versionsQuery.data ?? []}
          versionsLoading={versionsQuery.isLoading}
          attachAgents={eligibleAgentsForAttach}
          onSubmitAttach={handleAttachSubmit}
          attachPending={attachAgentsMutation.isPending}
          expandedDirs={expandedDirs[selectedSkillId] ?? new Set<string>()}
          onToggleDir={(path) => {
            setExpandedDirs((current) => {
              const next = new Set(current[selectedSkillId] ?? []);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return { ...current, [selectedSkillId]: next };
            });
          }}
          onSelectPath={(path) => {
            setDetailTab("files");
            navigate(routeForSkillId(selectedSkillId, path));
          }}
          updateStatus={updateStatusQuery.data}
          updateStatusLoading={updateStatusQuery.isLoading}
          onCheckUpdates={() => {
            void updateStatusQuery.refetch();
          }}
          checkUpdatesPending={updateStatusQuery.isFetching}
          onInstallUpdate={() => installUpdate.mutate()}
          installUpdatePending={installUpdate.isPending}
          onToggleStar={() => toggleStar.mutate()}
          starPending={toggleStar.isPending}
          onFork={() => activeDetail && openCreateWizard(buildForkSkillDraft(activeDetail))}
          onUpdateSharingScope={(sharingScope) => activeDetail && updateSkillSettings.mutate({ skillId: activeDetail.id, sharingScope })}
          updateSharingPending={updateSkillSettings.isPending}
          onDelete={openDeleteDialog}
          deletePending={deleteSkill.isPending}
        />
      ) : selectedCatalogRef ? (
        // Catalog / optional / bundled skills open as a regular full page in the
        // new store — no modal, no legacy split view (PAP-10907).
        <div className="min-h-[calc(100vh-12rem)]">
          <div className="border-b border-border px-4 py-3">
            <Link
              to={backToStoreHref}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              Back to store
            </Link>
          </div>
          {catalogListQuery.isLoading || catalogDetailQuery.isLoading ? (
            <PageSkeleton variant="detail" />
          ) : !selectedCatalogSkill ? (
            <EmptyState icon={Boxes} message="Catalog skill not found." />
          ) : (
            <div className="grid gap-0 xl:grid-cols-[14rem_minmax(0,1fr)]">
              <aside className="border-b border-border px-3 py-4 xl:border-b-0 xl:border-r">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</div>
                <SkillTree
                  nodes={buildTree(selectedCatalogSkill.files.map((file) => ({ path: file.path, kind: file.kind })))}
                  skillId={selectedCatalogSkill.id}
                  selectedPath={catalogSelectedPath}
                  expandedDirs={expandedCatalogDirs[selectedCatalogSkill.id] ?? new Set<string>()}
                  onToggleDir={(path) =>
                    setExpandedCatalogDirs((current) => {
                      const next = new Set(current[selectedCatalogSkill.id] ?? []);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return { ...current, [selectedCatalogSkill.id]: next };
                    })
                  }
                  onSelectPath={(path) => setCatalogSelectedPath(path)}
                  fileHref={() => `/skills?catalog=${encodeURIComponent(selectedCatalogRef)}`}
                />
              </aside>
              <div className="min-w-0">
                <CatalogDetailPane
                  skill={selectedCatalogSkill}
                  packageName={selectedCatalogSkill.packageName ?? installedByKey.get(selectedCatalogSkill.key)?.packageName ?? null}
                  packageVersion={selectedCatalogSkill.packageVersion ?? installedByKey.get(selectedCatalogSkill.key)?.packageVersion ?? null}
                  installedSkill={installedByKey.get(selectedCatalogSkill.key) ?? null}
                  installedSkillId={installedByKey.get(selectedCatalogSkill.key)?.id ?? null}
                  fileQuery={catalogFileQuery}
                  selectedPath={catalogSelectedPath}
                  onInstall={() => openInstallDialog(selectedCatalogSkill)}
                  onUpdate={() => openInstallDialog(selectedCatalogSkill)}
                  onOpenInstalled={(skillId) => navigate(routeForSkillId(skillId))}
                  loadingPrimaryAction={installCatalog.isPending}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-[calc(100vh-12rem)]">
          {skillsQuery.isLoading ? (
            <PageSkeleton variant="detail" />
          ) : (
            <EmptyState icon={Boxes} message="Skill not found." />
          )}
        </div>
      )}
    </>
  );
}
