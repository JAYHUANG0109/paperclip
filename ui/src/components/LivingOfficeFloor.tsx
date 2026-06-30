import type { Agent } from "@paperclipai/shared";
import { Wrench } from "lucide-react";
import { OfficeAvatar } from "./OfficeAvatar";
import { useTranslation } from "@/i18n";
import { cn } from "../lib/utils";

// The office scene: a room of workstations where every teammate sits at their
// own desk. Uses the original avatars (no pipeline change) — the same agents,
// the same live working/idle signal. Working desks get a lit monitor + a pulse;
// idle/attention/paused are shown by the status dot. Everyone stays seated.

type StatusKey = "working" | "idle" | "attention" | "paused";

function statusOf(agent: Agent, working: boolean): { key: StatusKey; dot: string; label: { working: string } } {
  if (agent.pauseReason) return { key: "paused", dot: "bg-muted-foreground/50", label: { working: "" } };
  if (agent.errorReason) return { key: "attention", dot: "bg-red-500", label: { working: "" } };
  if (working) return { key: "working", dot: "bg-emerald-500 animate-pulse", label: { working: "" } };
  return { key: "idle", dot: "bg-muted-foreground/40", label: { working: "" } };
}

export function LivingOfficeFloor({
  agents,
  workingIds,
  skillCounts,
  onOpen,
}: {
  agents: Agent[];
  workingIds: Set<string>;
  skillCounts?: Record<string, number>;
  onOpen: (agent: Agent) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {agents.map((agent, i) => (
        <DeskCell
          key={agent.id}
          agent={agent}
          working={workingIds.has(agent.id)}
          skillCount={skillCounts?.[agent.id] ?? 0}
          floatDelay={(i % 7) * 0.28}
          onOpen={() => onOpen(agent)}
        />
      ))}
    </div>
  );
}

function DeskCell({
  agent,
  working,
  skillCount,
  floatDelay,
  onOpen,
}: {
  agent: Agent;
  working: boolean;
  skillCount: number;
  floatDelay: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const status = statusOf(agent, working);
  const statusLabel = working
    ? t("office.busy", { defaultValue: "Working" })
    : status.key === "attention"
      ? t("office.error", { defaultValue: "Needs attention" })
      : status.key === "paused"
        ? t("office.paused", { defaultValue: "Paused" })
        : t("office.idle", { defaultValue: "Idle" });

  return (
    <button
      type="button"
      onClick={onOpen}
      title={agent.name}
      className="group relative flex h-[156px] w-full flex-col items-center justify-end rounded-xl px-1 pb-1 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* chair back, behind the avatar */}
      <div className="absolute bottom-[50px] left-1/2 z-0 h-10 w-12 -translate-x-1/2 rounded-t-[14px] border border-border bg-muted/50" />

      {/* avatar, seated (the desk overlaps its lower edge so it reads as sitting) */}
      <div
        className="office-avatar-idle absolute bottom-[46px] left-1/2 z-10 -translate-x-1/2"
        style={{ animationDelay: `${floatDelay}s` }}
      >
        <OfficeAvatar agent={agent} size={58} animated={false} className="drop-shadow-sm" />
      </div>

      {/* desk surface — in front of avatar's waist so it reads as sitting behind it */}
      <div
        className={cn(
          "absolute bottom-9 left-1/2 z-20 h-[26px] w-[78px] -translate-x-1/2 rounded-md border bg-card",
          working ? "border-border" : "border-border/70",
        )}
      >
        {/* keyboard hint */}
        <div className="absolute bottom-1 right-2 h-1 w-7 rounded-full bg-muted-foreground/25" />
      </div>

      {/* monitor — in front of desk + avatar (z-[25]) so the status glow is always readable.
          Screen is at the agent's bottom edge, so it must win the z-battle. */}
      <div
        className={cn(
          "absolute left-1/2 z-[25] h-[15px] w-[22px] -translate-x-1/2 rounded-sm border transition-colors",
          status.key === "working" && "border-emerald-400 bg-emerald-300/50 shadow-[0_0_6px_rgba(52,211,153,0.6)]",
          status.key === "attention" && "border-red-400 bg-red-400/50 shadow-[0_0_6px_rgba(248,113,113,0.55)]",
          status.key === "paused" && "border-amber-400/60 bg-amber-300/20",
          status.key === "idle" && "border-border bg-muted",
        )}
        style={{ bottom: "calc(2.25rem + 12px)" }}
      />

      {/* contact shadow */}
      <div className="absolute bottom-[33px] left-1/2 z-0 h-1.5 w-12 -translate-x-1/2 rounded-full bg-foreground/10 blur-[1px]" />

      {/* name + status */}
      <div className="z-30 flex flex-col items-center gap-0.5">
        <div className="max-w-[7.5rem] truncate text-xs font-medium">{agent.name}</div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
          {statusLabel}
        </div>
        <div className="flex h-[16px] items-center justify-center">
          {skillCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Wrench className="h-2.5 w-2.5" />
              {skillCount} {t("office.skills", { defaultValue: "skills" })}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
