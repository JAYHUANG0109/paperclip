import { useState, useMemo, useRef, useLayoutEffect, useEffect } from "react";
import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { OfficeAvatar } from "./OfficeAvatar";
import { agentTeams } from "../lib/agent-teams";
import { resolveGender } from "../lib/office-avatars";
import { displayAgentName } from "../lib/agent-name";
import { CATALOG_MANIFEST_URL, CATALOG_BY_ID, bustCache, characterScale, resolveAgentCharacterId, type CatalogManifest, type SpriteSet } from "../lib/office-sprite-catalog";

// ── Floor / zone definitions ───────────────────────────────────────────────
interface Zone {
  id: string;
  name: string;
  // The team whose agents sit here (must match agentTeams()). null = a decorative
  // room (meeting/lounge/茶水間) with no agents.
  team: string | null;
  // Room rectangle (walls) — used for the overlay label + hover. % of map.
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  // Exact desk seat positions (% of map) generated with the map. Agent i sits at
  // seats[i]; overflow beyond the seats falls into a grid in the room.
  seats?: { x: number; y: number }[];
}

interface FloorDef {
  id: string;
  label: string;
  image: string;
  natW: number;
  natH: number;
  zones: Zone[];
}

// Coordinates below are hand-tuned to the two pixel-art maps so agents land on
// the open floor of each room (roughly on the workstation rows), not on walls.
// Square office generated from the Donarg tileset by scripts/office-map/generate-office.mjs.
// Rooms are sized to team headcount (教學組 biggest, 系統自動化 smallest) + meeting/
// lounge/茶水間. Each zone maps to one team; decorative rooms have team: null.
const FLOORS: FloorDef[] = [
  {
    id: "square",
    label: "Office",
    image: "/assets/pixelart/Office%20Square.png",
    natW: 1344,
    natH: 896,
    zones: [
      { id: "meeting", name: "會議室", team: null, x: 4.8, y: 7.1, w: 16.7, h: 25, color: "#10B981" },
      { id: "teaching", name: "教學組", team: "教學組", x: 26.2, y: 1.8, w: 52.4, h: 35.7, color: "#8B5CF6", seats: [{"x":34.08,"y":12.86},{"x":46.28,"y":12.86},{"x":58.48,"y":12.86},{"x":70.68,"y":12.86},{"x":34.08,"y":27.59},{"x":46.28,"y":27.59},{"x":58.48,"y":27.59},{"x":70.68,"y":27.59}] },
      { id: "talent", name: "人才發展", team: "人才發展", x: 81, y: 7.1, w: 15.5, h: 23.2, color: "#6366F1", seats: [{"x":88.69,"y":18.21}] },
      { id: "lead", name: "領導團隊", team: "領導團隊", x: 1.2, y: 39.3, w: 23.8, h: 35.7, color: "#F59E0B", seats: [{"x":8.04,"y":50.36},{"x":18.15,"y":50.36},{"x":8.04,"y":65.09},{"x":18.15,"y":65.09}] },
      { id: "it", name: "資訊部", team: "資訊部", x: 26.2, y: 39.3, w: 52.4, h: 35.7, color: "#3B82F6", seats: [{"x":34.08,"y":50.36},{"x":46.28,"y":50.36},{"x":58.48,"y":50.36},{"x":70.68,"y":50.36},{"x":40.18,"y":65.09},{"x":52.38,"y":65.09},{"x":64.58,"y":65.09}] },
      { id: "lounge", name: "休息室", team: null, x: 81, y: 46.4, w: 15.5, h: 21.4, color: "#EC4899" },
      { id: "pantry", name: "茶水間", team: null, x: 4.8, y: 78.6, w: 16.7, h: 17.9, color: "#14B8A6" },
      { id: "reception", name: "接待處", team: null, x: 36.9, y: 78.6, w: 31, h: 17.9, color: "#A855F7" },
      { id: "auto", name: "系統自動化", team: "系統自動化", x: 82.1, y: 78.6, w: 14.3, h: 17.9, color: "#F97316", seats: [{"x":89.29,"y":89.64}] },
    ],
  },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Fixed on-floor character footprint in native map px — uniform for every agent
// (≈ chair-sized). Visible sprite is AGENT_SIZE * SPRITE_SCALE. NOTE: the sprite
// img used to be silently clamped to AGENT_SIZE by the global `img{max-width}`
// reset, so SPRITE_SCALE was effectively ~1. Now that the clamp is removed
// (maxWidth:none on the img), SPRITE_SCALE=1 keeps that same visible size while
// per-character scale (male 1.3×) finally takes effect.
const AGENT_SIZE = 84;
const SPRITE_SCALE = 1.0;

// 8-way facing from a screen-space velocity (y points down → south).
type Dir = "south" | "south-east" | "east" | "north-east" | "north" | "north-west" | "west" | "south-west";
const DIR_SECTORS: Dir[] = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
function dirFromVelocity(dx: number, dy: number): Dir {
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  return DIR_SECTORS[(Math.round(((ang % 360) + 360) % 360 / 45)) % 8];
}

// ── Status ─────────────────────────────────────────────────────────────────
type Status = "working" | "attention" | "paused" | "idle";

function getStatus(agent: Agent, working: boolean): Status {
  // A live run wins over everything: if the agent is executing right now it is
  // working (green), even if it carries a stale errorReason/pauseReason from a
  // previous run. Only when it is NOT running do those prior states show.
  if (working)           return "working";
  if (agent.errorReason) return "attention";
  if (agent.pauseReason) return "paused";
  return "idle";
}

const STATUS_COLOR: Record<Status, string> = {
  working: "#22c55e", attention: "#ef4444", paused: "#f59e0b", idle: "#6b7280",
};
const STATUS_GLOW: Record<Status, string> = {
  working: "rgba(34,197,94,0.65)", attention: "rgba(239,68,68,0.55)",
  paused: "rgba(245,158,11,0.4)", idle: "transparent",
};

// ── Speech bubble ──────────────────────────────────────────────────────────
function SpeechBubble({ text, color }: { text: string; color: string }) {
  const short = text.length > 42 ? text.slice(0, 41) + "…" : text;
  return (
    <div className="office-speech-bubble" style={{
      position: "absolute", bottom: "calc(100% + 5px)", left: "50%",
      transform: "translateX(-50%)", zIndex: 30, pointerEvents: "none", whiteSpace: "nowrap",
    }}>
      <div style={{
        background: "rgba(6,9,18,0.95)", border: `1px solid ${color}60`, borderRadius: 6,
        padding: "2px 7px", fontSize: 9, fontWeight: 600, color: "#cdd7ed",
        boxShadow: `0 2px 12px rgba(0,0,0,.55), 0 0 0 1px ${color}22`,
      }}>{short}</div>
      <div style={{
        position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)",
        width: 0, height: 0, borderLeft: "4px solid transparent", borderRight: "4px solid transparent",
        borderTop: `4px solid ${color}60`,
      }} />
    </div>
  );
}

// ── Desk monitor: sits on the desk, whole screen is the agent's status colour ──
function DeskMonitor({ x, y, size, status }: { x: number; y: number; size: number; status: Status }) {
  const screen = STATUS_COLOR[status];
  const working = status === "working";
  const w = size * 0.52, h = size * 0.38;
  return (
    <div style={{
      position: "absolute", left: `${x}%`,
      // Sit the monitor on the desk (~0.9*AGENT_SIZE above the seat). The offset
      // lives in `top` (reliable calc of % − px); doing it inside transform's
      // translate() left the monitor stuck at the seat/torso.
      top: `calc(${y}% - ${size * 0.9}px)`,
      transform: "translate(-50%, -50%)",
      width: w, height: h, zIndex: 6, pointerEvents: "none",
      // no bezel — the whole monitor is the status colour
      background: screen, borderRadius: 2,
      opacity: status === "idle" ? 0.6 : 1,
      boxShadow: working ? `0 0 ${size*0.28}px ${screen}` : "none",
      animation: working ? "office-agent-ring-pulse 1.8s ease-in-out infinite" : "none",
    }} />
  );
}

// ── Agent pin on map (size is dynamic per room) ────────────────────────────
function AgentPin({ agent, x, y, size, status, bubble, showLabel, spriteUrl, spriteScale = SPRITE_SCALE, moving, delayMs, onOpen }: {
  agent: Agent; x: number; y: number; size: number; status: Status;
  bubble: string | null; showLabel: boolean; spriteUrl?: string | null; spriteScale?: number;
  moving?: boolean; delayMs: number; onOpen: () => void;
}) {
  const r        = size / 2;
  const color    = STATUS_COLOR[status];
  const glow     = STATUS_GLOW[status];
  const isActive = status === "working";
  // No pulse ring around agents — status is shown by the desk monitor colour and
  // the dot on the name label. (Working agents also face their screen at the desk.)
  const ring     = false;

  return (
    <div style={{
      position: "absolute", left: `${x}%`, top: `${y}%`, width: size, height: size,
      marginLeft: -r, marginTop: -r, zIndex: isActive ? 12 : 10, overflow: "visible",
    }}>
      {ring && (
        <div className="office-agent-ring" style={{
          position: "absolute", left: -size * 0.18, top: -size * 0.18,
          width: size * 1.36, height: size * 1.36, borderRadius: "50%",
          border: `${Math.max(1.5, size * 0.05)}px solid ${color}`, boxShadow: `0 0 10px ${glow}`,
          animationDelay: `${delayMs}ms`, pointerEvents: "none",
        }} />
      )}
      {bubble && isActive && <SpeechBubble text={bubble} color={color} />}

      <button type="button" onClick={onOpen} title={agent.name ?? undefined}
        className={(isActive || moving) ? "office-agent-working" : undefined}
        style={{
          position: "absolute", inset: 0, padding: 0, background: "none", border: "none",
          cursor: "pointer", borderRadius: "50%", outline: "none", animationDelay: `${delayMs * 0.6}ms`,
        }}>
        {spriteUrl ? (
          <>
            {/* Ground shadow, directly under the character's feet. The sprite is
                centred with a -52% offset and its feet sit ~0.4*spriteH below the
                box centre, so shadow centre = pin + size*0.4*scale. The label is
                pushed below this (see below) so the shadow reads as under the feet,
                not detached beneath the name. */}
            <div style={{
              position: "absolute", left: "50%", top: size * (0.5 + 0.36 * spriteScale),
              transform: "translate(-50%,-50%)",
              width: size * 0.34 * spriteScale, height: size * 0.09 * spriteScale, borderRadius: "50%",
              background: "rgba(0,0,0,0.38)", filter: "blur(1px)", pointerEvents: "none",
            }} />
            <img src={spriteUrl} alt={agent.name ?? ""} draggable={false} style={{
              position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-52%)",
              width: size * spriteScale, height: size * spriteScale, objectFit: "contain",
              // Override the global Tailwind `img{max-width:100%}` reset — without
              // this the sprite is clamped to its container width, so spriteScale
              // (incl. the male 1.3×) has NO visible effect on the floor.
              maxWidth: "none", maxHeight: "none",
              imageRendering: "pixelated", pointerEvents: "none",
              // No status-based dimming — every agent renders at full brightness so
              // skin tones are uniform. Status is conveyed by the desk monitor
              // colour, the label dot, and the working ring instead.
              filter: `drop-shadow(0 0 ${ring ? 6 : 0}px ${glow})`,
            }} />
          </>
        ) : (
          <OfficeAvatar agent={agent} size={size} animated={isActive} style={{
            borderRadius: "50%", border: `${Math.max(1.5, size * 0.055)}px solid ${color}90`,
            boxShadow: ring ? `0 0 14px ${glow}, 0 2px 7px rgba(0,0,0,.65)` : "0 1px 5px rgba(0,0,0,.55)",
          }} />
        )}
      </button>

      {showLabel && (
        <div style={{
          // Sit just below the feet/shadow (which are at ~0.4*spriteH below the
          // box centre), so the name never overlaps the character's legs.
          position: "absolute", top: size * (0.5 + 0.36 * spriteScale) + size * 0.16, left: "50%", transform: "translateX(-50%)",
          maxWidth: Math.max(60, size * 2.4), overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", fontSize: clamp(size * 0.24, 7.5, 10), fontWeight: 700, color: "#c6d2e8",
          background: "rgba(6,9,18,0.90)", borderRadius: 4, padding: "1px 5px", pointerEvents: "none",
          lineHeight: "1.35", zIndex: 3,
        }}>
          <span style={{
            display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: color,
            marginRight: 3, marginBottom: 1, verticalAlign: "middle",
            boxShadow: status !== "idle" ? `0 0 5px ${color}` : undefined,
          }} />
          {displayAgentName(agent.name)}
        </div>
      )}
    </div>
  );
}

// ── Zone overlay ───────────────────────────────────────────────────────────
function ZoneOverlay({ zone, teamName, count, workingCount }: {
  zone: Zone; teamName: string; count: number; workingCount: number;
}) {
  const [hovered, setHovered] = useState(false);
  const label = teamName && teamName !== "__ungrouped__" ? teamName : zone.name;
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{
      // The map image already has painted walls, so no border here — just a subtle
      // hover tint + the room label.
      position: "absolute", left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.w}%`, height: `${zone.h}%`,
      background: hovered ? `${zone.color}14` : "transparent",
      transition: "background .2s", zIndex: 2, cursor: "default",
    }}>
      <div style={{
        position: "absolute", top: 4, left: 5, fontSize: 8, fontWeight: 800, color: zone.color,
        background: "rgba(6,9,18,0.82)", borderRadius: 4, padding: "1px 6px", letterSpacing: "0.04em",
        opacity: hovered ? 1 : 0.78, transition: "opacity .2s", pointerEvents: "none",
        whiteSpace: "nowrap", lineHeight: "15px",
      }}>{label}{count > 0 && <span style={{ opacity: 0.6 }}> · {count}</span>}</div>
      {workingCount > 0 && (
        <div style={{
          position: "absolute", top: 4, right: 5, fontSize: 8, fontWeight: 700, color: "#22c55e",
          background: "rgba(34,197,94,.14)", border: "1px solid rgba(34,197,94,.38)", borderRadius: 4,
          padding: "1px 5px", pointerEvents: "none", whiteSpace: "nowrap", lineHeight: "15px",
        }}>{workingCount} ⚡</div>
      )}
    </div>
  );
}

// ── Public export ──────────────────────────────────────────────────────────
export function LivingOfficeFloor({ agents, workingIds, liveRuns, onOpen }: {
  agents: Agent[];
  workingIds: Set<string>;
  skillCounts?: Record<string, number>;
  liveRuns?: LiveRunForIssue[];
  onOpen: (agent: Agent) => void;
}) {
  const floorIdx = 0; // single floor (Office Level 4) — Floor 2 removed

  // Map viewport measurement → contain-fit zoom so the whole floor is as large as it can be.
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  // Height available from the map's top edge to the bottom of the screen — measured
  // (not a 100vh guess) so the page never overflows into a scrollbar regardless of
  // the breadcrumb bar, filter row, or <main> padding above it.
  const [availH, setAvailH] = useState(560);
  const [userZoom, setUserZoom] = useState<number | null>(null); // null = auto-fit

  useLayoutEffect(() => {
    const el = viewportRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const update = () => {
      const top = root.getBoundingClientRect().top;
      const h = Math.max(360, Math.round(window.innerHeight - top - 34)); // clears <main>'s bottom padding
      setAvailH(h);
      setViewport({ w: el.clientWidth, h: el.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => { ro.disconnect(); window.removeEventListener("resize", update); };
  }, []);

  // Reset to auto-fit whenever the floor changes.
  // Pixel-art character sprites, generated per agent via PixelLab. Loaded from a
  // static manifest; agents without a sprite fall back to the circular avatar.
  const [sprites, setSprites] = useState<Record<string, Partial<Record<Dir, string>> & { name?: string }>>({});
  useEffect(() => {
    let alive = true;
    fetch(bustCache("/assets/agent-sprites/manifest.json"))
      .then(r => (r.ok ? r.json() : {}))
      .then(m => { if (alive) setSprites(m ?? {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Shared CHARACTER CATALOG sprites (the pickable roster). An agent's chosen
  // catalog character wins over its bespoke per-agent sprite; if it hasn't picked,
  // its bespoke sprite wins, then the gender-default catalog character.
  const [catalog, setCatalog] = useState<CatalogManifest>({});
  useEffect(() => {
    let alive = true;
    fetch(bustCache(CATALOG_MANIFEST_URL))
      .then(r => (r.ok ? r.json() : {}))
      .then(m => { if (alive) setCatalog(m ?? {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Resolve the directional sprite SET an agent should render (or null → circular
  // avatar fallback). Priority: explicit catalog pick → uniform gender default
  // (the shared man/woman set) → bespoke per-agent sprite. The gender default
  // outranks bespoke so the whole floor shares one consistent look until a user
  // picks a specific character.
  const spriteSetFor = useMemo(() => {
    return (agent: Agent): (SpriteSet & { walk?: SpriteSet; walkScale?: number; scale?: number }) | null => {
      const chosen = agent.metadata?.officeCharacterId;
      if (typeof chosen === "string" && CATALOG_BY_ID.has(chosen)) {
        const set = catalog[chosen];
        if (set && Object.keys(set).length) return set;
      }
      const def = catalog[resolveGender(agent)];
      if (def && Object.keys(def).length) return def;
      const own = sprites[agent.id];
      if (own && Object.keys(own).some(k => k !== "name")) return own;
      return null;
    };
  }, [sprites, catalog]);

  const floor = FLOORS[floorIdx];
  const mapW  = floor.natW;
  const mapH  = floor.natH;

  const fitZoom = useMemo(() => {
    if (!viewport.w || !viewport.h) return 1;
    // Contain-fit the whole floor to the viewport, leaving a small gutter so the
    // map never quite touches the edges — this prevents the scrollbar-appears →
    // width-shrinks → refit → scrollbar-disappears feedback loop that made the map
    // twitch (時大時小). Rounded to 2dp to kill sub-pixel jitter. Uniform scale, so
    // proportions are always preserved.
    const contain = Math.min((viewport.w - 4) / mapW, (viewport.h - 4) / mapH);
    return Math.round(clamp(contain, 0.3, 3) * 100) / 100;
  }, [viewport, mapW, mapH]);
  const zoom = userZoom ?? fitZoom;

  const bubbles = useMemo(() => new Map<string, string>(
    (liveRuns ?? []).filter(r => r.currentStatusMessage).map(r => [r.agentId, r.currentStatusMessage!])
  ), [liveRuns]);

  // Group agents by their team.
  const byTeam = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const a of agents) {
      const key = agentTeams(a)[0] ?? "__ungrouped__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return map;
  }, [agents]);

  // Explicit team→room mapping: each zone declares its team (decorative rooms have
  // team: null). Agents whose team has no room fall into the first team-less spare
  // room, else the biggest room.
  const zoneAssignments = useMemo(() => {
    const zones = FLOORS[floorIdx].zones;
    const assignments = zones.map(zone => ({
      zone, floorIdx, teamName: zone.team ?? zone.name, members: [] as Agent[],
    }));
    const claimed = new Set<string>();
    for (const a of assignments) {
      if (a.zone.team && byTeam.has(a.zone.team)) { a.members = byTeam.get(a.zone.team)!; claimed.add(a.zone.team); }
    }
    // Any team without a matching room → drop into the largest team room.
    const spare = assignments.filter(a => a.zone.team).sort((x, y) =>
      (y.zone.w * y.zone.h) - (x.zone.w * x.zone.h))[0];
    for (const [team, members] of byTeam) {
      if (!claimed.has(team) && spare) spare.members = [...spare.members, ...members];
    }
    return assignments;
  }, [byTeam, floorIdx]);

  const floorZones = useMemo(
    () => zoneAssignments.filter(za => za.floorIdx === floorIdx),
    [zoneAssignments, floorIdx]
  );

  // Pin layout: each agent sits at a generated desk SEAT. Overflow beyond the
  // seats falls into a tidy grid in the lower half of the room. Size is fixed.
  const { pins, labelSize } = useMemo(() => {
    const out: { agent: Agent; x: number; y: number; size: number; floor: { fx: number; fy: number; fw: number; fh: number } }[] = [];
    for (const za of floorZones) {
      const { zone, members } = za;
      if (members.length === 0) continue;
      const seats = zone.seats ?? [];
      // Full room interior — used to clamp wandering so an agent never leaves its
      // own room. Wandering itself stays within a small radius of each desk (below).
      const floor = { fx: zone.x + 2, fy: zone.y + 3, fw: zone.w - 4, fh: zone.h - 5 };
      // Overflow (more members than seats) tiles into the lower half of the room.
      const lower = { lx: zone.x + 2, ly: zone.y + zone.h * 0.55, lw: zone.w - 4 };
      const overflow = members.length - seats.length;
      const cols = Math.max(1, Math.min(overflow, Math.floor(lower.lw / 7)));

      members.forEach((agent, i) => {
        let x: number, y: number;
        if (i < seats.length) { x = seats[i]!.x; y = seats[i]!.y; }
        else {
          const j = i - seats.length, c = j % cols, r = Math.floor(j / cols);
          x = lower.lx + (c + 0.5) * (lower.lw / cols);
          y = lower.ly + (r + 0.5) * 6;
        }
        out.push({ agent, x, y, size: AGENT_SIZE, floor });
      });
    }
    return { pins: out, labelSize: AGENT_SIZE };
  }, [floorZones]);

  // ── Wandering engine ──────────────────────────────────────────────────────
  // Agents mostly sit at their desk (facing south). Occasionally one strolls to
  // a nearby spot inside its room and back, facing its direction of travel — so
  // the office feels alive without descending into chaos. Honors reduced-motion.
  interface Motion {
    x: number; y: number; hx: number; hy: number; dir: Dir;
    moving: boolean; tx: number; ty: number; waitUntil: number;
    walkable: boolean;
    floor: { fx: number; fy: number; fw: number; fh: number };
  }
  // Agents now sit at fixed desk seats, so wandering is off (walkable: false) — a
  // seated office reads cleaner than sprites sliding between desks.
  const motion = useRef<Map<string, Motion>>(new Map());
  const [, setMotionTick] = useState(0);
  const reduceMotion = useRef(false);
  // Live working set, read by the animation tick (which closes over stale props)
  // so working agents can be kept parked at their desks.
  const workingRef = useRef<Set<string>>(workingIds);
  workingRef.current = workingIds;
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotion.current = mq.matches;
    const on = () => { reduceMotion.current = mq.matches; };
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  // (Re)seed motion state when the layout changes — keep live position if the
  // agent already exists so a re-layout doesn't teleport anyone.
  useEffect(() => {
    const next = new Map<string, Motion>();
    for (const p of pins) {
      // Agents wander in the open area of their room and return to their desk (home).
      const walkable = true;
      const prev = motion.current.get(p.agent.id);
      next.set(p.agent.id, prev
        ? { ...prev, hx: p.x, hy: p.y, floor: p.floor, walkable }
        : { x: p.x, y: p.y, hx: p.x, hy: p.y, dir: "south", moving: false, tx: p.x, ty: p.y, waitUntil: 0, walkable, floor: p.floor });
    }
    motion.current = next;
  }, [pins, spriteSetFor]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastRender = 0;
    const SPEED = 7;          // % of map per second (gentle stroll)
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!reduceMotion.current) {
        for (const [id, m] of motion.current.entries()) {
          // A live/working agent stays put at its desk — it returns home if it was
          // mid-stroll and never starts a new wander while working.
          const working = workingRef.current.has(id);
          if (m.moving) {
            if (working) { m.tx = m.hx; m.ty = m.hy; }
            const dx = m.tx - m.x, dy = m.ty - m.y;
            const dist = Math.hypot(dx, dy);
            const step = SPEED * dt;
            if (dist <= step || dist < 0.3) {
              m.x = m.tx; m.y = m.ty; m.moving = false; m.dir = "south";
              m.waitUntil = now + 1500 + Math.random() * 4500;
            } else {
              m.x += (dx / dist) * step; m.y += (dy / dist) * step;
              m.dir = dirFromVelocity(dx, dy);
            }
          } else if (working) {
            // Working but standing away from the desk → walk back and stay.
            if (Math.abs(m.x - m.hx) > 0.3 || Math.abs(m.y - m.hy) > 0.3) {
              m.tx = m.hx; m.ty = m.hy; m.moving = true;
            }
          } else if (m.walkable && now >= m.waitUntil && Math.random() < dt * 0.3) {
            // Take a small step near the agent's OWN desk — a tight radius so
            // everyone mills around their workstation instead of roaming the room,
            // still clamped to the room interior so no one walks through a wall.
            const R = 4.5; // radius in % of map around the home desk
            m.tx = clamp(m.hx + (Math.random() - 0.5) * 2 * R, m.floor.fx, m.floor.fx + m.floor.fw);
            m.ty = clamp(m.hy + (Math.random() - 0.5) * 2 * R, m.floor.fy, m.floor.fy + m.floor.fh);
            m.moving = true;
          }
        }
      }
      if (now - lastRender > 50) { lastRender = now; setMotionTick(t => (t + 1) % 1000000); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const scaledW = mapW * zoom;
  const scaledH = mapH * zoom;
  const offsetX = Math.max(0, (viewport.w - scaledW) / 2);
  const offsetY = Math.max(0, (viewport.h - scaledH) / 2);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      {/* Floating zoom control (no frame/top bar — team filters live above the map) */}
      <div style={{
        position: "absolute", top: 10, right: 10, zIndex: 20,
        display: "flex", gap: 3, alignItems: "center",
        background: "rgba(10,13,20,0.6)", backdropFilter: "blur(4px)",
        borderRadius: 8, padding: 3,
      }}>
        <button type="button" onClick={() => setUserZoom(z => clamp((z ?? fitZoom) - 0.2, 0.3, 4))} style={zoomBtnStyle} title="Zoom out">−</button>
        <button type="button" onClick={() => setUserZoom(null)} style={{ ...zoomBtnStyle, width: "auto", padding: "0 8px", fontSize: 10, fontWeight: 700 }} title="Fit to screen">FIT</button>
        <button type="button" onClick={() => setUserZoom(z => clamp((z ?? fitZoom) + 0.2, 0.3, 4))} style={zoomBtnStyle} title="Zoom in">+</button>
      </div>

      {/* ── Body: full-bleed map, frameless ──────────────────────────── */}
      {/* Outer is MEASURED and overflow:hidden so it never grows a scrollbar — that
          stability is what stops the resize↔scrollbar twitch. The inner layer does
          the actual scrolling (only when the user zooms in past fit). */}
      <div ref={viewportRef} style={{
        height: availH, minHeight: 360, overflow: "hidden", position: "relative",
        borderRadius: 12,
      }}>
        {/* Scroll only when zoomed in PAST fit; at fit, clip so big agent sprites
            overflowing the map edge don't spawn scrollbars. */}
        <div style={{ position: "absolute", inset: 0, overflow: (userZoom != null && userZoom > fitZoom) ? "auto" : "hidden" }}>
        <div style={{
          width: Math.max(viewport.w, scaledW), height: Math.max(viewport.h, scaledH), position: "relative",
        }}>
          <div style={{
            position: "absolute", left: offsetX, top: offsetY, width: mapW, height: mapH,
            transform: `scale(${zoom})`, transformOrigin: "top left",
          }}>
            <img src={bustCache(floor.image)} alt={floor.label} draggable={false} style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              imageRendering: "pixelated", display: "block", userSelect: "none", pointerEvents: "none",
              boxShadow: "0 0 80px rgba(0,0,0,.6)", borderRadius: 2,
            }} />
            {floorZones.map(za => (
              <ZoneOverlay key={za.zone.id} zone={za.zone} teamName={za.teamName}
                count={za.members.length}
                workingCount={za.members.filter(a => workingIds.has(a.id)).length} />
            ))}
            {/* Desk monitors — fixed at each agent's home desk, screen tinted by that
                agent's status (green working / red attention / amber paused / grey idle). */}
            {pins.map((pin) => {
              const st = getStatus(pin.agent, workingIds.has(pin.agent.id));
              return <DeskMonitor key={`mon-${pin.agent.id}`} x={pin.x} y={pin.y} size={pin.size} status={st} />;
            })}
            {pins.map((pin, idx) => {
              const m = motion.current.get(pin.agent.id);
              const working = workingIds.has(pin.agent.id);
              const gender = resolveGender(pin.agent);
              const lx = working ? pin.x : (m?.x ?? pin.x);
              // A working agent steps up between its chair and desk and faces its
              // screen (male → north, female → north-west). The monitor now sits
              // up on the desk, so this small forward shift doesn't cover it.
              const ly = (working ? pin.y : (m?.y ?? pin.y)) - (working ? 4 : 0);
              const dir = working ? (gender === "male" ? "north" : "north-west") : (m?.dir ?? "south");
              const set = spriteSetFor(pin.agent);
              // While moving (never while working), play the walk GIF for the
              // current direction; otherwise show the static rotation.
              const moving = !working && (m?.moving ?? false);
              const walkUrl = moving && set?.walk ? (set.walk[dir] ?? set.walk.south ?? null) : null;
              const rawSprite = walkUrl ?? (set ? (set[dir] ?? set.south ?? null) : null);
              const spriteUrl = rawSprite ? bustCache(rawSprite) : null;
              // Walk GIFs are re-framed to match the static sprite (walkScale ≈ 1).
              // A per-character scale then sizes the whole look (e.g. male 1.3×),
              // applied to both the static PNG and the walk GIF. Resolved purely in
              // code (characterScale) — the single source of truth — so it always
              // applies regardless of whether the catalog manifest carries `scale`.
              const charScale = characterScale(resolveAgentCharacterId(pin.agent, gender));
              const base = walkUrl ? SPRITE_SCALE * (set?.walkScale ?? 1) : SPRITE_SCALE;
              const spriteScale = base * charScale;
              return (
              <AgentPin key={pin.agent.id} agent={pin.agent} x={lx} y={ly} size={pin.size}
                status={getStatus(pin.agent, working)}
                bubble={bubbles.get(pin.agent.id) ?? null}
                showLabel={labelSize >= 17}
                moving={moving}
                spriteUrl={spriteUrl}
                spriteScale={spriteScale}
                delayMs={idx * 120} onOpen={() => onOpen(pin.agent)} />
              );
            })}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  width: 24, height: 24, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6,
  background: "rgba(255,255,255,0.04)", color: "#94a3b8", cursor: "pointer",
  fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center",
  justifyContent: "center", lineHeight: 1, padding: 0, outline: "none",
};
