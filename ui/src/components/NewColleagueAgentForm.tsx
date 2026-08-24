import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/** Compose the request body the fulfilling agent reads. */
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
  onSubmit, onBack, submitting,
}: {
  onSubmit: (draft: ColleagueAgentDraft, body: string) => void;
  onBack: () => void;
  submitting?: boolean;
}) {
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
          <span className="text-xs font-medium">姓名 <span className="text-destructive">*</span></span>
          <Input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="王小明"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium">綽號</span>
          <Input
            value={draft.nickname}
            onChange={(e) => setDraft((d) => ({ ...d, nickname: e.target.value }))}
            placeholder="小明"
          />
        </label>
      </div>

      <label className="space-y-1.5 block">
        <span className="text-xs font-medium">公司 Email <span className="text-destructive">*</span></span>
        <Input
          type="email"
          value={draft.email}
          onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
          placeholder="someone@seasonart.org"
        />
        <span className="text-xs text-muted-foreground">
          本人用這個帳號登入後，會自動取得公司權限並綁定這支代理人。填錯就無法配對。
        </span>
      </label>

      <div className="space-y-1.5">
        <span className="text-xs font-medium">校區</span>
        <Chips options={CAMPUSES} selected={draft.campuses} onToggle={toggle("campuses")} />
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium">組別／部門</span>
        <Chips
          options={groupOptions}
          selected={draft.groups}
          onToggle={toggle("groups")}
          emptyHint="請先選校區。"
        />
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium">職位</span>
        <Chips options={POSITIONS} selected={draft.positions} onToggle={toggle("positions")} />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button variant="outline" onClick={onBack} disabled={submitting}>返回</Button>
        <Button
          className="flex-1"
          disabled={!canSubmit}
          onClick={() => onSubmit(draft, buildColleagueAgentRequest(draft))}
        >
          建立代理人請求
        </Button>
      </div>
      {draft.email.trim() && !emailLooksValid ? (
        <p className="text-xs text-destructive">Email 格式看起來不正確。</p>
      ) : null}
    </div>
  );
}
