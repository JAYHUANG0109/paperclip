import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { OfficeAvatar } from "./OfficeAvatar";
import { displayAgentName } from "../lib/agent-name";
import { agentTeams, localizeTeamName } from "../lib/agent-teams";
import { FLOORS, AGENT_SIZE, AVATAR_FIT, DeskFurniture, type Zone } from "./LivingOfficeFloor";
import { computeWorkstations } from "../lib/officeLayout";
import { bustCache } from "../lib/office-sprite-catalog";
import { cn } from "../lib/utils";

// Mobile-only Virtual Office layout: the SAME pixel-art office as the desktop
// floor, but with each room cropped out of the shared floor image and stacked
// vertically — one room per card, each scaled to the phone's width so the room
// (and the characters in it) are readable instead of a single wide map shrunk to
// nothing. Rooms are dynamic (scale with the viewport); the founder's room is
// pinned first, then the rest by headcount. Tapping an agent opens the same
// player-card modal as the floor/catalog.
const FLOOR = FLOORS[0]!;

interface RoomAssignment {
  zone: Zone;
  members: Agent[];
}

// Which agents sit in which room — mirrors LivingOfficeFloor: a solo-reserved
// agent (founder) claims its own room; team rooms take their team's remaining
// agents; decorative rooms (no team, no solo) drop out.
function assignRooms(agents: Agent[]): RoomAssignment[] {
  const solo = new Set<string>();
  const out: RoomAssignment[] = FLOOR.zones.map((zone) => ({ zone, members: [] }));
  for (const entry of out) {
    if (!entry.zone.soloAgent) continue;
    const match = agents.find((a) => (a.name ?? "").includes(entry.zone.soloAgent!));
    if (match) { entry.members = [match]; solo.add(match.id); }
  }
  for (const entry of out) {
    if (entry.zone.team) {
      entry.members = agents.filter((a) => !solo.has(a.id) && agentTeams(a).includes(entry.zone.team!));
    }
  }
  return out
    .filter((e) => e.members.length > 0)
    .sort((a, b) => {
      // Founder / solo rooms first, then by headcount.
      const sa = a.zone.soloAgent ? 1 : 0;
      const sb = b.zone.soloAgent ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return b.members.length - a.members.length;
    });
}

// Desk seats for a room, in map-% (mirrors LivingOfficeFloor's pin layout):
// solo (founder) keeps its baked seat; team rooms get one procedurally-drawn
// workstation per agent (grid scales with headcount). `furnished` = draw a
// runtime desk/chair/keyboard (false for the founder's baked desk).
function seatPositions(
  zone: Zone,
  members: Agent[],
): { agent: Agent; x: number; y: number; scale: number; cellW: number; furnished: boolean }[] {
  if (zone.soloAgent) {
    const seat = (zone.seats ?? [])[0] ?? { x: zone.x + zone.w / 2, y: zone.y + zone.h * 0.7 };
    // cellW big enough that the founder avatar caps at full AGENT_SIZE.
    return members.slice(0, 1).map((agent) => ({ agent, x: seat.x, y: seat.y, scale: 1, cellW: AGENT_SIZE / AVATAR_FIT, furnished: false }));
  }
  const stations = computeWorkstations(zone, members.length, FLOOR.natW, FLOOR.natH);
  return members.map((agent, i) => ({ agent, x: stations[i]!.x, y: stations[i]!.y, scale: stations[i]!.scale, cellW: stations[i]!.cellW, furnished: true }));
}

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
  const rooms = useMemo(() => assignRooms(agents), [agents]);

  // Measure the list width so each room can scale its characters proportionally
  // (a card is full width, so cardWidth ≈ containerWidth).
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (rooms.length === 0) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        {t("office.noAgents", { defaultValue: "No agents match this filter." })}
      </div>
    );
  }

  return (
    <div ref={ref} className="space-y-3">
      {rooms.map(({ zone, members }) => (
        <RoomScene
          key={zone.id}
          zone={zone}
          members={members}
          workingIds={workingIds}
          onOpen={onOpen}
          cardWidth={width}
          lang={i18n.language}
        />
      ))}
    </div>
  );
}

function RoomScene({
  zone,
  members,
  workingIds,
  onOpen,
  cardWidth,
  lang,
}: {
  zone: Zone;
  members: Agent[];
  workingIds: Set<string>;
  onOpen: (agent: Agent) => void;
  cardWidth: number;
  lang: string;
}) {
  const { t } = useTranslation();
  const seats = useMemo(() => seatPositions(zone, members), [zone, members]);
  const working = members.filter((m) => workingIds.has(m.id)).length;

  // Room rect in map-%; the card body shows exactly this slice of the floor
  // image. Character px scales with how much the room was blown up to fill the
  // card width (uniform with the desktop floor's map-px AGENT_SIZE).
  const roomPxW = (zone.w / 100) * FLOOR.natW;
  const scale = cardWidth > 0 ? cardWidth / roomPxW : 0;
  // Fit the avatar to its grid cell (native px) so crowded rooms shrink agents,
  // then scale to the card. Sparse rooms cap at AGENT_SIZE.
  const avatarNative = Math.min(AGENT_SIZE, (seats[0]?.cellW ?? AGENT_SIZE / AVATAR_FIT) * AVATAR_FIT);
  const agentPx = Math.max(24, Math.round(avatarNative * scale));

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3.5 py-2.5">
        <h3 className="truncate text-sm font-semibold text-foreground">
          {localizeTeamName(zone.team ?? zone.name, lang)}
        </h3>
        <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          {working > 0 && (
            <span className="inline-flex items-center gap-1 text-emerald-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              {working}
            </span>
          )}
          {t("office.agentCount", { count: members.length, defaultValue: "{{count}} agents" })}
        </span>
      </div>
      {/* Cropped floor slice: the full image is enlarged so this room fills the
          card width, then offset so only the room's rectangle is visible. Width%
          is of the card, height% of the card height; because the card's aspect
          ratio equals the room's, the image keeps its true proportions. */}
      <div
        className="relative w-full overflow-hidden bg-background"
        style={{ aspectRatio: `${zone.w * FLOOR.natW} / ${zone.h * FLOOR.natH}` }}
      >
        <img
          src={bustCache(FLOOR.image)}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            width: `${(100 / zone.w) * 100}%`,
            height: `${(100 / zone.h) * 100}%`,
            left: `${-(zone.x / zone.w) * 100}%`,
            top: `${-(zone.y / zone.h) * 100}%`,
            imageRendering: "pixelated",
            pointerEvents: "none",
            userSelect: "none",
            maxWidth: "none",
            maxHeight: "none",
          }}
        />
        {/* Per-agent furniture (chair/desk/keyboard), drawn behind the avatars.
            pxScale maps native map px → this card's px (same as agentPx). */}
        {seats.map(({ agent, x, y, scale: fScale, furnished }) => furnished ? (
          <DeskFurniture
            key={`furn-${agent.id}`}
            x={((x - zone.x) / zone.w) * 100}
            y={((y - zone.y) / zone.h) * 100}
            scale={fScale}
            pxScale={scale}
          />
        ) : null)}
        {seats.map(({ agent, x, y }) => {
          const lx = ((x - zone.x) / zone.w) * 100;
          const ly = ((y - zone.y) / zone.h) * 100;
          const isWorking = workingIds.has(agent.id);
          const ring = isWorking
            ? "border-emerald-400/80"
            : agent.errorReason
              ? "border-red-500/70"
              : agent.pauseReason
                ? "border-amber-500/60"
                : "border-transparent";
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onOpen(agent)}
              title={agent.name ?? undefined}
              className="absolute flex flex-col items-center focus-visible:outline-none"
              style={{ left: `${lx}%`, top: `${ly}%`, transform: "translate(-50%, -58%)", width: agentPx }}
            >
              <div
                className={cn("relative flex items-center justify-center rounded-full", isWorking && "border-2", ring)}
                style={{ width: agentPx, height: agentPx }}
              >
                <OfficeAvatar agent={agent} size={agentPx} animated={false} clip={false} />
                {isWorking && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />}
              </div>
              <span className="mt-0.5 max-w-[86px] truncate rounded bg-background/85 px-1 text-[9px] font-medium leading-tight text-foreground">
                {displayAgentName(agent.name)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
