import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { customFieldsApi, type CustomFieldType } from "../api/custom-fields";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, X, Check, ChevronDown, Settings2 } from "lucide-react";

interface Props {
  projectId: string;
  companyId: string;
}

const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "文字 Text",
  number: "數字 Number",
  single_select: "單選 Single-select",
  multi_select: "多選 Multi-select",
  date: "日期 Date",
  people: "人員 People",
};

const SELECT_TYPES: CustomFieldType[] = ["single_select", "multi_select"];

// Lets a project owner create company custom fields and attach/detach them to this project.
export function ProjectCustomFieldsManager({ projectId, companyId }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const libraryKey = ["custom-fields", "library", companyId] as const;
  const projectKey = ["custom-fields", "project", projectId] as const;

  const { data: library } = useQuery({
    queryKey: libraryKey,
    queryFn: () => customFieldsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: attached } = useQuery({
    queryKey: projectKey,
    queryFn: () => customFieldsApi.listForProject(projectId, companyId),
    enabled: !!projectId && !!companyId,
  });

  const attachedIds = useMemo(
    () => new Set((attached ?? []).map((f) => f.fieldId)),
    [attached],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: libraryKey });
    void queryClient.invalidateQueries({ queryKey: projectKey });
  };

  const attach = useMutation({
    mutationFn: (fieldId: string) => customFieldsApi.attach(projectId, companyId, fieldId),
    onSuccess: invalidate,
  });
  const detach = useMutation({
    mutationFn: (fieldId: string) => customFieldsApi.detach(projectId, fieldId),
    onSuccess: invalidate,
  });

  // New-field form state
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [optionsText, setOptionsText] = useState("");
  const [typeOpen, setTypeOpen] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const options = SELECT_TYPES.includes(type)
        ? {
            options: optionsText
              .split(/[\n,，]/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((label, i) => ({ id: `opt-${i}-${label.replace(/\s+/g, "-")}`, label })),
          }
        : null;
      const field = await customFieldsApi.create(companyId, { name: trimmed, type, options });
      // Auto-attach the newly created field to this project.
      await customFieldsApi.attach(projectId, companyId, field.id);
      return field;
    },
    onSuccess: () => {
      setName("");
      setOptionsText("");
      setType("text");
      setCreating(false);
      invalidate();
    },
  });

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">
          {t("customFields.manageTitle", { defaultValue: "自訂欄位 Custom fields" })}
        </h3>
      </div>

      {/* Attached fields */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(attached ?? []).length === 0 ? (
          <span className="text-[13px] text-muted-foreground">
            {t("customFields.noneAttached", { defaultValue: "尚未加入欄位" })}
          </span>
        ) : (
          (attached ?? []).map((f) => (
            <span
              key={f.fieldId}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-accent/40 px-2 py-0.5 text-[12px]"
            >
              {f.name}
              <span className="text-muted-foreground">· {FIELD_TYPE_LABELS[f.type]?.split(" ")[0]}</span>
              <button
                type="button"
                onClick={() => detach.mutate(f.fieldId)}
                className="text-muted-foreground hover:text-foreground"
                title={t("customFields.detach", { defaultValue: "移除" })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
      </div>

      {/* Attach existing library field */}
      {(library ?? []).some((f) => !attachedIds.has(f.id)) && (
        <div className="mb-3">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("customFields.addExisting", { defaultValue: "加入既有欄位" })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(library ?? [])
              .filter((f) => !attachedIds.has(f.id))
              .map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => attach.mutate(f.id)}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[12px] text-muted-foreground hover:border-ring hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  {f.name}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Create new field */}
      {creating ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("customFields.namePlaceholder", { defaultValue: "欄位名稱" })}
            className="w-full rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
          />
          <Popover open={typeOpen} onOpenChange={setTypeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded border border-input bg-transparent px-2 py-1 text-left text-[13px] hover:border-ring"
              >
                {FIELD_TYPE_LABELS[type]}
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-1" align="start">
              {(Object.keys(FIELD_TYPE_LABELS) as CustomFieldType[]).map((tk) => (
                <button
                  key={tk}
                  type="button"
                  onClick={() => {
                    setType(tk);
                    setTypeOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                >
                  {FIELD_TYPE_LABELS[tk]}
                  {tk === type && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          {SELECT_TYPES.includes(type) && (
            <textarea
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder={t("customFields.optionsPlaceholder", {
                defaultValue: "選項，以逗號或換行分隔 (one per line / comma)",
              })}
              rows={3}
              className="w-full rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {t("common.create", { defaultValue: "建立" })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("customFields.createNew", { defaultValue: "建立新欄位" })}
        </button>
      )}
    </div>
  );
}
