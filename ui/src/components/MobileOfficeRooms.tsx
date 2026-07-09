import { useMemo } from "react";
import type { Agent } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { OfficeAvatar } from "./OfficeAvatar";
import { displayAgentName } from "../lib/agent-name";
import { localizeTeamName } from "../lib/agent-teams";
import { groupAgentsByRoom } from "../lib/office-rooms";
import { cn } from "../lib/utils";

// Mobile-only Virtual Office layout: a vertical, scrollable list of room cards.
// Replaces the desktop pixel floor (a single wide background image that scales
// down to an unreadable size on phones). Founder's room is pinned top, then
// rooms are ordered by agent count; empty decorative rooms are dropped. Tapping
// an agent opens the same player-card modal the floor/catalog use.
export function MobileOfficeRooms({
  agents,
  workingIds,
  onOpen,
}: {
  agents: Agent[];
  workingIds: Set<string>;
  onOpen: (agent: Agent) => void;
}) {
  const { t, i18n } = useTranslation();
  const rooms = useMemo(() => groupAgentsByRoom(agents), [agents]);

  if (rooms.length === 0) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        {t("office.noAgents", { defaultValue: "No agents match this filter." })}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rooms.map(({ room, members }) => {
        const working = members.filter((m) => workingIds.has(m.id)).length;
        return (
          <div key={room.id} className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3.5 py-2.5">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {localizeTeamName(room.team ?? room.name, i18n.language)}
              </h3>
              <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
                {working > 0 && (
                  <span className="inline-flex items-center gap-1 text-emerald-500">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    {working}
                  </span>
                )}
                {t("office.agentCount", { count: members.length, defaultValue: "{{count}} agents" })}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 p-3 sm:grid-cols-5">
              {members.map((agent) => (
                <MobileAgentTile
                  key={agent.id}
                  agent={agent}
                  working={workingIds.has(agent.id)}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MobileAgentTile({
  agent,
  working,
  onOpen,
}: {
  agent: Agent;
  working: boolean;
  onOpen: (agent: Agent) => void;
}) {
  // Status ring mirrors the floor: green (working) / red (needs attention) /
  // amber (paused) / plain border (idle).
  const ring = working
    ? "border-emerald-400/70"
    : agent.errorReason
      ? "border-red-500/70"
      : agent.pauseReason
        ? "border-amber-500/60"
        : "border-border";
  return (
    <button
      type="button"
      onClick={() => onOpen(agent)}
      className="flex min-w-0 flex-col items-center gap-1 rounded-lg p-1.5 text-center transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className={cn("relative flex h-16 w-16 items-center justify-center rounded-full border-2 bg-background", ring)}>
        <OfficeAvatar agent={agent} size={56} animated={false} clip={false} />
        {working && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />}
      </div>
      <span className="w-full truncate text-[11px] font-medium leading-tight">{displayAgentName(agent.name)}</span>
    </button>
  );
}
