import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CAMPUSES, POSITIONS, groupsForCampuses } from "@/lib/org-chart-options";

/**
 * Structured intake for "add a colleague's agent".
 *
 * The fields are deliberately the six that IT actually types — 名字/綽號/email/
 * 職位/組別/校區 — and everything else (instructions, skills, access level,
 * reporting line) is left to the agent that fulfils the request, which reads
 * `doc/sa-org-chart.md` and the `paperclip-create-agent` skill.
 *
 * email is the load-bearing one: it becomes `adapterConfig.assignedUserEmail`,
 * which is what lets the person be claimed at sign-in (company membership +
 * agent ownership) and what the Google Chat 代理指派 reconciler keys on. An agent
 * created without it can never be paired to a human.
 */
export type ColleagueAgentDraft = {
  name: string;
  nickname: string;
  email: string;
  campuses: string[];
  groups: string[];
  positions: string[];
};

function Chips({
  options, selected, onToggle, emptyHint,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
  emptyHint?: string;
}) {
  if (options.length === 0 && emptyHint) {
    return <p className="text-xs text-muted-foreground">{emptyHint}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const on = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(opt)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              on
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Compose the request body the fulfilling agent reads.
 *
 * i18n-exempt: this is written FOR an agent, not shown to a user. It names
 * Chinese org-chart concepts (校區／組別／職位) that the agent matches against
 * doc/sa-org-chart.md, so translating it would break the lookup.
 */
export function buildColleagueAgentRequest(draft: ColleagueAgentDraft): string {
  const line = (k: string, v: string) => `- **${k}**：${v || "（未填）"}`;
  return [
    "請依下列資料建立一支同仁的 AI 代理人。",
    "",
    line("姓名", draft.name),
    line("綽號", draft.nickname),
    line("公司 Email", draft.email),
    line("校區", draft.campuses.join("、")),
    line("組別／部門", draft.groups.join("、")),
    line("職位", draft.positions.join("、")),
    "",
    "### 建置要求",
    "1. 使用 `paperclip-create-agent` 技能建立。",
    "2. **必須**把上面的 Email 寫進 `adapterConfig.assignedUserEmail`；沒有這個欄位，本人登入後不會自動取得公司權限與代理人綁定，代理人會變成沒有負責人的孤兒。",
    "3. `metadata.teams` 依「校區＋組別」設定，第一個 team 為主校區（跨校者依 `doc/sa-org-chart.md` 的可見度規則帶入所有統籌校區）。",
    "4. `reportsTo`、`title` 依 `doc/sa-org-chart.md` 的回報線規則推導，不要自行臆測。",
    "5. 指令、技能與權限層級沿用同組同職位的既有代理人慣例。",
    "",
    "建立完成後請回報：代理人 ID、reportsTo 掛在誰身上、以及 `assignedUserEmail` 是否已生效。",
  ].join("\n");
}

export function NewColleagueAgentForm({
  onSubmit, onBack, submitting, assignableAgents = [], assigneeAgentId, onAssigneeAgentIdChange,
}: {
  onSubmit: (draft: ColleagueAgentDraft, body: string) => void;
  onBack: () => void;
  submitting?: boolean;
  /** Agents this user may hand the request to. Empty hides the picker. */
  assignableAgents?: readonly { id: string; name: string }[];
  /** Defaults to the requester's own paired agent; see NewAgentDialog. */
  assigneeAgentId?: string | null;
  onAssigneeAgentIdChange?: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ColleagueAgentDraft>({
    name: "", nickname: "", email: "", campuses: [], groups: [], positions: [],
  });

  const groupOptions = useMemo(() => groupsForCampuses(draft.campuses), [draft.campuses]);

  const toggle = (key: "campuses" | "groups" | "positions") => (value: string) =>
    setDraft((d) => {
      const next = d[key].includes(value) ? d[key].filter((v) => v !== value) : [...d[key], value];
      // Dropping a campus must drop groups that campus was the only source of,
      // otherwise a stale 部門 rides along after switching to a school.
      if (key === "campuses") {
        const allowed = groupsForCampuses(next);
        return { ...d, campuses: next, groups: d.groups.filter((g) => allowed.includes(g)) };
      }
      return { ...d, [key]: next };
    });

  const emailLooksValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.email.trim());
  const canSubmit = draft.name.trim().length > 0 && emailLooksValid && !submitting;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium">{t("newAgent.colleague.name")} <span className="text-destructive">*</span></span>
          <Input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={t("newAgent.colleague.namePlaceholder")}
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium">{t("newAgent.colleague.nickname")}</span>
          <Input
            value={draft.nickname}
            onChange={(e) => setDraft((d) => ({ ...d, nickname: e.target.value }))}
            placeholder={t("newAgent.colleague.nicknamePlaceholder")}
          />
        </label>
      </div>

      <label className="space-y-1.5 block">
        <span className="text-xs font-medium">{t("newAgent.colleague.email")} <span className="text-destructive">*</span></span>
        <Input
          type="email"
          value={draft.email}
          onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
          placeholder="someone@seasonart.org"
        />
        <span className="text-xs text-muted-foreground">
          {t("newAgent.colleague.emailHint")}
        </span>
      </label>

      <div className="space-y-1.5">
        <span className="text-xs font-medium">{t("newAgent.colleague.campus")}</span>
        <Chips options={CAMPUSES} selected={draft.campuses} onToggle={toggle("campuses")} />
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium">{t("newAgent.colleague.group")}</span>
        <Chips
          options={groupOptions}
          selected={draft.groups}
          onToggle={toggle("groups")}
          emptyHint={t("newAgent.colleague.groupNeedsCampus")}
        />
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium">{t("newAgent.colleague.position")}</span>
        <Chips options={POSITIONS} selected={draft.positions} onToggle={toggle("positions")} />
      </div>

      {assignableAgents.length > 0 && onAssigneeAgentIdChange ? (
        <div className="space-y-1.5">
          <span className="text-xs font-medium">{t("newAgent.colleague.assignTo")}</span>
          <Select value={assigneeAgentId ?? undefined} onValueChange={onAssigneeAgentIdChange}>
            <SelectTrigger className="w-full text-xs">
              <SelectValue placeholder={t("newAgent.colleague.assignToPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {assignableAgents.map((a) => (
                <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {t("newAgent.colleague.assignToHint")}
          </span>
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="outline" onClick={onBack} disabled={submitting}>{t("newAgent.colleague.back")}</Button>
        <Button
          className="flex-1"
          disabled={!canSubmit}
          onClick={() => onSubmit(draft, buildColleagueAgentRequest(draft))}
        >
          {t("newAgent.colleague.submit")}
        </Button>
      </div>
      {draft.email.trim() && !emailLooksValid ? (
        <p className="text-xs text-destructive">{t("newAgent.colleague.emailInvalid")}</p>
      ) : null}
    </div>
  );
}
