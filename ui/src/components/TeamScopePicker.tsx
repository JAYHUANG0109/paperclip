import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { makeScopedTeamToken } from "@paperclipai/shared";
import {
  ALL_DEPARTMENTS,
  CAMPUS_DEPARTMENTS,
  CAMPUS_ORDER,
  CROSS_CAMPUS_GROUPS,
  formatTeamToken,
  localizeTeamName,
} from "../lib/agent-teams";
import { cn } from "../lib/utils";

/**
 * Cascading 校區 › 部門 team-scope picker. Emits sharing tokens:
 *  - whole campus            → "北屯"
 *  - a campus's department    → "北屯／幼教教學組"   (scoped, AND-matched)
 *  - a cross-campus group      → "領導團隊"
 *  - a department, all campuses → "幼教教學組"
 *
 * `availableTeams` is the set of teams the user may share to; when
 * `canShareToAll` is true the full catalog is offered (so you can pre-share to a
 * team that has no agent yet), otherwise options gate to `availableTeams`.
 */
export function TeamScopePicker({
  value,
  onChange,
  availableTeams,
  canShareToAll,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  availableTeams: string[];
  canShareToAll?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const shareable = useMemo(() => new Set(availableTeams), [availableTeams]);
  const offerable = (team: string) => canShareToAll || shareable.has(team);

  const selected = useMemo(() => new Set(value), [value]);
  const toggle = (token: string) => {
    onChange(selected.has(token) ? value.filter((v) => v !== token) : [...value, token]);
  };

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpand = (campus: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(campus)) next.delete(campus);
      else next.add(campus);
      return next;
    });

  const chipCls = (on: boolean) =>
    cn(
      "rounded-full border px-2.5 py-1 text-xs transition-colors",
      on
        ? "border-foreground bg-foreground text-background"
        : "border-border text-foreground/80 hover:border-foreground/40",
    );

  // Campuses with at least one offerable node (whole-campus or a department).
  const campuses = CAMPUS_ORDER.filter(
    (c) => offerable(c) || (CAMPUS_DEPARTMENTS[c] ?? []).some(offerable),
  );
  const crossGroups = CROSS_CAMPUS_GROUPS.filter(offerable);
  const crossDepts = ALL_DEPARTMENTS.filter(offerable);

  const nothingOffered = campuses.length === 0 && crossGroups.length === 0 && crossDepts.length === 0;

  return (
    <div className="space-y-3">
      {/* Selected tokens as removable chips */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((token) => (
            <span
              key={token}
              className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-xs text-foreground"
            >
              {formatTeamToken(token, lang)}
              <button
                type="button"
                aria-label={t("common.remove", { defaultValue: "Remove" })}
                onClick={() => toggle(token)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {nothingOffered ? (
        <p className="text-xs text-muted-foreground">
          {t("companySkills.noTeams", { defaultValue: "You don't belong to any team yet." })}
        </p>
      ) : (
        <div className="space-y-1.5 rounded-lg border border-border p-2">
          {/* Campus groups */}
          {campuses.map((campus) => {
            const open = expanded.has(campus);
            const depts = (CAMPUS_DEPARTMENTS[campus] ?? []).filter(offerable);
            return (
              <div key={campus} className="rounded-md">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleExpand(campus)}
                    className="flex flex-1 items-center gap-1.5 py-1 text-sm font-medium text-foreground"
                    aria-expanded={open}
                  >
                    {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {localizeTeamName(campus, lang)}
                  </button>
                  {offerable(campus) && (
                    <button type="button" onClick={() => toggle(campus)} className={chipCls(selected.has(campus))}>
                      {t("teamPicker.wholeCampus", { defaultValue: "Whole {{name}}", name: localizeTeamName(campus, lang) })}
                    </button>
                  )}
                </div>
                {open && depts.length > 0 && (
                  <div className="ml-5 flex flex-wrap gap-1.5 pb-2">
                    {depts.map((dept) => {
                      const token = makeScopedTeamToken(campus, dept);
                      return (
                        <button key={token} type="button" onClick={() => toggle(token)} className={chipCls(selected.has(token))}>
                          {localizeTeamName(dept, lang)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Cross-campus / all-campuses section */}
          {(crossGroups.length > 0 || crossDepts.length > 0) && (
            <div className="border-t border-border pt-2">
              <div className="mb-1 px-0.5 text-xs font-medium text-muted-foreground">
                {t("teamPicker.crossCampus", { defaultValue: "Cross-campus / all campuses" })}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {crossGroups.map((g) => (
                  <button key={g} type="button" onClick={() => toggle(g)} className={chipCls(selected.has(g))}>
                    {localizeTeamName(g, lang)}
                  </button>
                ))}
                {crossDepts.map((d) => (
                  <button key={d} type="button" onClick={() => toggle(d)} className={chipCls(selected.has(d))}>
                    {t("teamPicker.deptAllCampuses", { defaultValue: "{{name}} (all campuses)", name: localizeTeamName(d, lang) })}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
