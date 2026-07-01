import { useState, useMemo, useRef, useLayoutEffect, useEffect } from "react";
import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { OfficeAvatar } from "./OfficeAvatar";
import { agentTeams } from "../lib/agent-teams";
import { resolveGender } from "../lib/office-avatars";
import { displayAgentName } from "../lib/agent-name";
import { CATALOG_MANIFEST_URL, CATALOG_BY_ID, bustCache, type CatalogManifest, type SpriteSet } from "../lib/office-sprite-catalog";

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
    natW: 1248,
    natH: 880,
    zones: [
      { id: "meeting", name: "會議室", team: null, x: 1.3, y: 3.6, w: 24.4, h: 30.9, color: "#10B981" },
      { id: "teaching", name: "教學組", team: "教學組", x: 28.2, y: 1.8, w: 43.6, h: 34.5, color: "#8B5CF6", seats: [{"x":38.27,"y":16.36},{"x":46.09,"y":16.36},{"x":53.91,"y":16.36},{"x":61.73,"y":16.36},{"x":38.27,"y":27.64},{"x":46.09,"y":27.64},{"x":53.91,"y":27.64},{"x":61.73,"y":27.64}] },
      { id: "talent", name: "人才發展", team: "人才發展", x: 75.6, y: 3.6, w: 20.5, h: 29.1, color: "#6366F1", seats: [{"x":85.9,"y":21.09}] },
      { id: "lead", name: "領導團隊", team: "領導團隊", x: 1.3, y: 38.2, w: 25.6, h: 34.5, color: "#F59E0B", seats: [{"x":10.19,"y":52.73},{"x":18.01,"y":52.73},{"x":10.19,"y":64},{"x":18.01,"y":64}] },
      { id: "it", name: "資訊部", team: "資訊部", x: 28.2, y: 38.2, w: 43.6, h: 34.5, color: "#3B82F6", seats: [{"x":38.27,"y":52.73},{"x":46.09,"y":52.73},{"x":53.91,"y":52.73},{"x":61.73,"y":52.73},{"x":38.27,"y":64},{"x":46.09,"y":64},{"x":53.91,"y":64}] },
      { id: "lounge", name: "休息室", team: null, x: 75.6, y: 40, w: 20.5, h: 29.1, color: "#EC4899" },
      { id: "pantry", name: "茶水間", team: null, x: 2.6, y: 74.5, w: 21.8, h: 21.8, color: "#14B8A6" },
      { id: "reception", name: "接待處", team: null, x: 32.1, y: 74.5, w: 35.9, h: 21.8, color: "#A855F7" },
      { id: "auto", name: "系統自動化", team: "系統自動化", x: 75.6, y: 74.5, w: 19.2, h: 21.8, color: "#F97316", seats: [{"x":85.26,"y":88.36}] },
    ],
  },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Fixed on-floor character footprint in native map px — uniform for every agent
// (≈ chair-sized). Visible sprite is AGENT_SIZE * SPRITE_SCALE.
const AGENT_SIZE = 84;
const SPRITE_SCALE = 2.0;

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
  if (agent.errorReason) return "attention";
  if (agent.pauseReason) return "paused";
  if (working)           return "working";
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
      position: "absolute", left: `${x}%`, top: `${y}%`,
      // sit the monitor on the desk, which is ~2 tiles above the agent's seat
      transform: `translate(-50%, calc(-50% - ${size * 0.9}px))`,
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
function AgentPin({ agent, x, y, size, status, bubble, showLabel, spriteUrl, moving, delayMs, onOpen }: {
  agent: Agent; x: number; y: number; size: number; status: Status;
  bubble: string | null; showLabel: boolean; spriteUrl?: string | null;
  moving?: boolean; delayMs: number; onOpen: () => void;
}) {
  const r        = size / 2;
  const color    = STATUS_COLOR[status];
  const glow     = STATUS_GLOW[status];
  const isActive = status === "working";
  // Only WORKING agents get the animated pulse ring — otherwise a floor full of
  // idle/blocked agents becomes a wall of distracting rings. Status for the rest
  // is conveyed by the sprite tint + the dot on the name label.
  const ring     = isActive;

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
            {/* ground shadow so the character reads as standing on the floor */}
            <div style={{
              position: "absolute", left: "50%", bottom: -size * 0.04, transform: "translateX(-50%)",
              width: size * 0.62, height: size * 0.16, borderRadius: "50%",
              background: "rgba(0,0,0,0.38)", filter: "blur(1px)", pointerEvents: "none",
            }} />
            <img src={spriteUrl} alt={agent.name ?? ""} draggable={false} style={{
              position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-52%)",
              width: size * SPRITE_SCALE, height: size * SPRITE_SCALE, objectFit: "contain",
              imageRendering: "pixelated", pointerEvents: "none",
              filter: status === "idle" || status === "paused"
                ? "saturate(0.7) brightness(0.85)"
                : `drop-shadow(0 0 ${ring ? 6 : 0}px ${glow})`,
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
          position: "absolute", top: size + 2, left: "50%", transform: "translateX(-50%)",
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
    fetch("/assets/agent-sprites/manifest.json")
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
    fetch(CATALOG_MANIFEST_URL)
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
    return (agent: Agent): (SpriteSet & { walk?: SpriteSet }) | null => {
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
      // interior box for overflow placement + (unused) wander bounds
      const floor = { fx: zone.x + 2, fy: zone.y + zone.h * 0.55, fw: zone.w - 4, fh: zone.h * 0.4 };
      const overflow = members.length - seats.length;
      const cols = Math.max(1, Math.min(overflow, Math.floor(floor.fw / 7)));

      members.forEach((agent, i) => {
        let x: number, y: number;
        if (i < seats.length) { x = seats[i]!.x; y = seats[i]!.y; }
        else {
          const j = i - seats.length, c = j % cols, r = Math.floor(j / cols);
          x = floor.fx + (c + 0.5) * (floor.fw / cols);
          y = floor.fy + (r + 0.5) * 6;
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
        for (const m of motion.current.values()) {
          if (m.moving) {
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
          } else if (m.walkable && now >= m.waitUntil && Math.random() < dt * 0.3) {
            // start a short wander within the room floor (kept off the edges)
            const mx = m.floor.fw * 0.16, my = m.floor.fh * 0.16;
            m.tx = clamp(m.hx + (Math.random() - 0.5) * m.floor.fw * 0.6, m.floor.fx + mx, m.floor.fx + m.floor.fw - mx);
            m.ty = clamp(m.hy + (Math.random() - 0.5) * m.floor.fh * 0.6, m.floor.fy + my, m.floor.fy + m.floor.fh - my);
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
        <div style={{ position: "absolute", inset: 0, overflow: "auto" }}>
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
              const lx = m?.x ?? pin.x;
              const ly = m?.y ?? pin.y;
              const dir = m?.dir ?? "south";
              const set = spriteSetFor(pin.agent);
              // While moving, play the walk GIF for the current direction (if the
              // character has one); otherwise show the static rotation.
              const moving = m?.moving ?? false;
              const walkUrl = moving && set?.walk ? (set.walk[dir] ?? set.walk.south ?? null) : null;
              const rawSprite = walkUrl ?? (set ? (set[dir] ?? set.south ?? null) : null);
              const spriteUrl = rawSprite ? bustCache(rawSprite) : null;
              return (
              <AgentPin key={pin.agent.id} agent={pin.agent} x={lx} y={ly} size={pin.size}
                status={getStatus(pin.agent, workingIds.has(pin.agent.id))}
                bubble={bubbles.get(pin.agent.id) ?? null}
                showLabel={labelSize >= 17}
                moving={m?.moving ?? false}
                spriteUrl={spriteUrl}
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
