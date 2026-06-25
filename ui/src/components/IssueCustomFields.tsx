import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import {
  customFieldsApi,
  type ProjectCustomField,
  type IssueCustomFieldValue,
} from "../api/custom-fields";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";

interface IssueCustomFieldsProps {
  issueId: string;
  projectId: string | null | undefined;
  companyId: string | null | undefined;
}

// Renders the custom fields attached to the issue's project and lets the user edit values.
export function IssueCustomFields({ issueId, projectId, companyId }: IssueCustomFieldsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const projectFieldsKey = ["custom-fields", "project", projectId] as const;
  const issueValuesKey = ["custom-fields", "issue", issueId] as const;

  const { data: projectFields } = useQuery({
    queryKey: projectFieldsKey,
    queryFn: () => customFieldsApi.listForProject(projectId!, companyId!),
    enabled: !!projectId && !!companyId,
  });

  const { data: issueValues } = useQuery({
    queryKey: issueValuesKey,
    queryFn: () => customFieldsApi.listForIssue(issueId),
    enabled: !!issueId,
  });

  const valueByFieldId = useMemo(() => {
    const map = new Map<string, IssueCustomFieldValue>();
    for (const v of issueValues ?? []) map.set(v.fieldId, v);
    return map;
  }, [issueValues]);

  const setValue = useMutation({
    mutationFn: ({ fieldId, value }: { fieldId: string; value: Record<string, unknown> | null }) =>
      customFieldsApi.setValue(issueId, fieldId, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: issueValuesKey });
    },
  });

  if (!projectFields || projectFields.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("customFields.title", { defaultValue: "自訂欄位" })}
      </div>
      <div className="space-y-1.5">
        {projectFields.map((field) => (
          <FieldRow
            key={field.fieldId}
            field={field}
            value={valueByFieldId.get(field.fieldId)?.value ?? null}
            disabled={setValue.isPending}
            onChange={(value) => setValue.mutate({ fieldId: field.fieldId, value })}
          />
        ))}
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: ProjectCustomField;
  value: Record<string, unknown> | null;
  disabled: boolean;
  onChange: (value: Record<string, unknown> | null) => void;
}

function FieldRow({ field, value, disabled, onChange }: FieldRowProps) {
  const { t } = useTranslation();
  const options = field.options?.options ?? [];

  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span className="w-28 shrink-0 truncate text-muted-foreground" title={field.name}>
        {field.name}
      </span>
      <div className="min-w-0 flex-1">
        {field.type === "text" && (
          <input
            type="text"
            disabled={disabled}
            defaultValue={typeof value?.text === "string" ? (value.text as string) : ""}
            onBlur={(e) => {
              const next = e.target.value.trim();
              onChange(next ? { text: next } : null);
            }}
            className="w-full rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
            placeholder="—"
          />
        )}

        {field.type === "number" && (
          <input
            type="number"
            disabled={disabled}
            defaultValue={typeof value?.number === "number" ? (value.number as number) : ""}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              onChange(raw === "" ? null : { number: Number(raw) });
            }}
            className="w-full rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
            placeholder="—"
          />
        )}

        {field.type === "date" && (
          <input
            type="date"
            disabled={disabled}
            defaultValue={typeof value?.date === "string" ? (value.date as string) : ""}
            onChange={(e) => {
              const raw = e.target.value;
              onChange(raw ? { date: raw } : null);
            }}
            className="w-full rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
          />
        )}

        {field.type === "single_select" && (
          <SelectEditor
            options={options}
            multi={false}
            selectedIds={typeof value?.optionId === "string" ? [value.optionId as string] : []}
            disabled={disabled}
            onChange={(ids) => onChange(ids.length ? { optionId: ids[0] } : null)}
          />
        )}

        {field.type === "multi_select" && (
          <SelectEditor
            options={options}
            multi
            selectedIds={Array.isArray(value?.optionIds) ? (value!.optionIds as string[]) : []}
            disabled={disabled}
            onChange={(ids) => onChange(ids.length ? { optionIds: ids } : null)}
          />
        )}

        {field.type === "people" && (
          <span className="text-[12px] italic text-muted-foreground">
            {t("customFields.peopleUnsupported", { defaultValue: "（人員欄位即將推出）" })}
          </span>
        )}
      </div>
    </div>
  );
}

interface SelectEditorProps {
  options: { id: string; label: string; color?: string }[];
  multi: boolean;
  selectedIds: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}

function SelectEditor({ options, multi, selectedIds, disabled, onChange }: SelectEditorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = options.filter((o) => selectedIds.includes(o.id));

  const toggle = (id: string) => {
    if (multi) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id];
      onChange(next);
    } else {
      onChange(selectedIds.includes(id) ? [] : [id]);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex w-full items-center justify-between gap-1 rounded border border-input bg-transparent px-2 py-1 text-left text-[13px] outline-none hover:border-ring"
        >
          <span className="flex min-w-0 flex-wrap gap-1">
            {selected.length === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              selected.map((o) => (
                <span
                  key={o.id}
                  className="rounded px-1.5 py-0.5 text-[11px]"
                  style={{ backgroundColor: o.color ?? "hsl(var(--muted))" }}
                >
                  {o.label}
                </span>
              ))
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-1" align="start">
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
            {t("customFields.noOptions", { defaultValue: "尚無選項" })}
          </div>
        ) : (
          options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => toggle(o.id)}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
            >
              <span className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: o.color ?? "hsl(var(--muted-foreground))" }}
                />
                {o.label}
              </span>
              {selectedIds.includes(o.id) && <Check className="h-3.5 w-3.5" />}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
