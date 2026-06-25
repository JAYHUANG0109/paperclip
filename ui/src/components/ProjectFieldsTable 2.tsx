import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { customFieldsApi, type ProjectCustomField } from "../api/custom-fields";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "./StatusIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronDown, X } from "lucide-react";

interface Props {
  projectId: string;
  companyId: string;
  projectRef: string;
}

// Phase 9: a spreadsheet-style view — issues as rows, custom fields as columns.
// Uses the batch values endpoint (one query) so it scales without N+1.
export function ProjectFieldsTable({ projectId, companyId, projectRef }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");

  const { data: fields } = useQuery({
    queryKey: ["custom-fields", "project", projectId],
    queryFn: () => customFieldsApi.listForProject(projectId, companyId),
    enabled: !!projectId && !!companyId,
  });
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });
  const { data: values } = useQuery({
    queryKey: ["custom-fields", "project-values", projectId],
    queryFn: () => customFieldsApi.listValuesForProject(projectId, companyId),
    enabled: !!projectId && !!companyId,
  });
  const hasPeople = (fields ?? []).some((f) => f.type === "people");
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId && hasPeople,
  });

  const agentName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents ?? []) m.set(a.id, a.name);
    return m;
  }, [agents]);

  // Per-field, selection-based filters (for select / multi-select / people fields).
  // fieldId -> set of selected option/agent ids. A row passes a field's filter
  // when its value intersects the selected set; empty set = no filter on that field.
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const toggleSelected = (fieldId: string, id: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      const set = new Set(next[fieldId] ?? []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      next[fieldId] = set;
      return next;
    });
  };
  const clearFieldFilter = (fieldId: string) =>
    setSelected((prev) => ({ ...prev, [fieldId]: new Set() }));

  // Options offered by a filterable field.
  const optionsForField = (field: ProjectCustomField): { id: string; label: string }[] => {
    if (field.type === "people") return (agents ?? []).map((a) => ({ id: a.id, label: a.name }));
    if (field.type === "single_select" || field.type === "multi_select") {
      return (field.options?.options ?? []).map((o) => ({ id: o.id, label: o.label }));
    }
    return [];
  };
  const filterableFields = useMemo(
    () => (fields ?? []).filter((f) => ["single_select", "multi_select", "people"].includes(f.type)),
    [fields],
  );

  // Does an issue's value for a field intersect the selected set?
  const matchesFieldFilter = (
    field: ProjectCustomField,
    value: Record<string, unknown> | null,
    chosen: Set<string>,
  ): boolean => {
    if (chosen.size === 0) return true;
    if (!value) return false;
    if (field.type === "single_select") return typeof value.optionId === "string" && chosen.has(value.optionId);
    if (field.type === "people") return typeof value.agentId === "string" && chosen.has(value.agentId);
    if (field.type === "multi_select") {
      const ids = Array.isArray(value.optionIds) ? (value.optionIds as string[]) : [];
      return ids.some((id) => chosen.has(id));
    }
    return true;
  };

  // issueId -> fieldId -> value
  const valueMap = useMemo(() => {
    const m = new Map<string, Map<string, Record<string, unknown> | null>>();
    for (const v of values ?? []) {
      if (!m.has(v.issueId)) m.set(v.issueId, new Map());
      m.get(v.issueId)!.set(v.fieldId, v.value);
    }
    return m;
  }, [values]);

  const formatValue = (field: ProjectCustomField, value: Record<string, unknown> | null): string => {
    if (!value) return "—";
    switch (field.type) {
      case "text":
        return typeof value.text === "string" ? value.text : "—";
      case "number":
        return typeof value.number === "number" ? String(value.number) : "—";
      case "date":
        return typeof value.date === "string" ? value.date : "—";
      case "single_select": {
        const opt = field.options?.options?.find((o) => o.id === value.optionId);
        return opt?.label ?? "—";
      }
      case "multi_select": {
        const ids = Array.isArray(value.optionIds) ? (value.optionIds as string[]) : [];
        const labels = ids
          .map((id) => field.options?.options?.find((o) => o.id === id)?.label)
          .filter(Boolean);
        return labels.length ? labels.join(", ") : "—";
      }
      case "people":
        return typeof value.agentId === "string" ? agentName.get(value.agentId) ?? "—" : "—";
      default:
        return "—";
    }
  };

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const activeFieldFilters = (fields ?? []).filter((f) => (selected[f.fieldId]?.size ?? 0) > 0);
    return (issues ?? []).filter((issue) => {
      const fv = valueMap.get(issue.id);
      // Selection filters (AND across fields, OR within a field).
      for (const field of activeFieldFilters) {
        if (!matchesFieldFilter(field, fv?.get(field.fieldId) ?? null, selected[field.fieldId]!)) {
          return false;
        }
      }
      // Free-text filter over title + formatted field values.
      if (!q) return true;
      if (issue.title.toLowerCase().includes(q)) return true;
      if (!fv) return false;
      for (const field of fields ?? []) {
        if (formatValue(field, fv.get(field.fieldId) ?? null).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [issues, filter, valueMap, fields, selected, agentName]);

  if (!fields || fields.length === 0) {
    return (
      <div className="rounded-lg border border-border p-6 text-sm text-muted-foreground">
        {t("customFields.tableEmpty", {
          defaultValue: "此專案尚未加入自訂欄位。到「總覽」分頁建立欄位後即可在此以欄位檢視。",
        })}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("customFields.tableFilter", { defaultValue: "篩選議題或欄位值… Filter" })}
          className="w-full max-w-xs rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
        />
        {filterableFields.map((field) => {
          const chosen = selected[field.fieldId] ?? new Set<string>();
          const opts = optionsForField(field);
          return (
            <Popover key={field.fieldId}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={[
                    "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] transition-colors",
                    chosen.size > 0
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-input text-muted-foreground hover:border-ring hover:text-foreground",
                  ].join(" ")}
                >
                  <span className="truncate max-w-[10rem]">{field.name}</span>
                  {chosen.size > 0 && (
                    <span className="rounded-full bg-primary/20 px-1.5 text-[11px]">{chosen.size}</span>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="start">
                {chosen.size > 0 && (
                  <button
                    type="button"
                    onClick={() => clearFieldFilter(field.fieldId)}
                    className="mb-1 flex w-full items-center gap-1 rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent"
                  >
                    <X className="h-3 w-3" /> {t("customFields.clearFilter", { defaultValue: "清除" })}
                  </button>
                )}
                {opts.length === 0 ? (
                  <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                    {t("customFields.noOptions", { defaultValue: "尚無選項" })}
                  </div>
                ) : (
                  opts.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggleSelected(field.fieldId, o.id)}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                    >
                      <span className="truncate">{o.label}</span>
                      {chosen.has(o.id) && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))
                )}
              </PopoverContent>
            </Popover>
          );
        })}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left">
              <th className="px-3 py-2 font-medium">{t("customFields.tableIssue", { defaultValue: "議題" })}</th>
              {fields.map((f) => (
                <th key={f.fieldId} className="px-3 py-2 font-medium whitespace-nowrap" title={f.name}>
                  {f.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((issue) => {
              const fv = valueMap.get(issue.id);
              return (
                <tr key={issue.id} className="border-b border-border/60 hover:bg-accent/30">
                  <td className="px-3 py-2">
                    <Link
                      to={`/projects/${projectRef}/issues/${issue.identifier ?? issue.id}`}
                      className="flex items-center gap-1.5 hover:underline"
                    >
                      <StatusIcon status={issue.status} className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{issue.title}</span>
                    </Link>
                  </td>
                  {fields.map((f) => (
                    <td key={f.fieldId} className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {formatValue(f, fv?.get(f.fieldId) ?? null)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={fields.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                  {t("customFields.tableNoRows", { defaultValue: "沒有符合的議題" })}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
