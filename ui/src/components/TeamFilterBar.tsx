import { useTranslation } from "@/i18n";
import { cn } from "../lib/utils";

/**
 * Visual multiselect team filter: a wrapping bar of toggle chips (one per team)
 * plus an "All teams" chip. Shared by the Agents page and the Virtual Office;
 * the selection lives in useAgentTeamFilter (persisted per company), so this is
 * a pure control. An empty selection means "all teams".
 */
export function TeamFilterBar({
  teams,
  selected,
  onToggle,
  onClear,
}: {
  teams: string[];
  selected: string[];
  onToggle: (team: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  if (teams.length === 0) return null;
  const none = selected.length === 0;

  const chip = (active: boolean) =>
    cn(
      "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
      active
        ? "border-foreground bg-foreground text-background"
        : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={onClear} className={chip(none)}>
        {t("agents.allTeams", { defaultValue: "All teams" })}
      </button>
      {teams.map((team) => (
        <button
          key={team}
          type="button"
          onClick={() => onToggle(team)}
          aria-pressed={selected.includes(team)}
          className={chip(selected.includes(team))}
        >
          {team}
        </button>
      ))}
    </div>
  );
}
