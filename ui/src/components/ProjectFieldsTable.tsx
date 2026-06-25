import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { customFieldsApi, type ProjectCustomField } from "../api/custom-fields";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { projectRouteRef } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";

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
    const list = issues ?? [];
    if (!q) return list;
    return list.filter((issue) => {
      if (issue.title.toLowerCase().includes(q)) return true;
      const fv = valueMap.get(issue.id);
      if (!fv) return false;
      for (const field of fields ?? []) {
        if (formatValue(field, fv.get(field.fieldId) ?? null).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [issues, filter, valueMap, fields]);

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
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("customFields.tableFilter", { defaultValue: "篩選議題或欄位值… Filter" })}
        className="w-full max-w-xs rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
      />
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
