import { useState, useMemo, useRef, useLayoutEffect, useEffect } from "react";
import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { OfficeAvatar } from "./OfficeAvatar";
import { agentTeams } from "../lib/agent-teams";
import { resolveGender } from "../lib/office-avatars";
import { CATALOG_MANIFEST_URL, CATALOG_BY_ID, type CatalogManifest, type SpriteSet } from "../lib/office-sprite-catalog";

// ── Floor / zone definitions ───────────────────────────────────────────────
interface Zone {
  id: string;
  name: string;
  // Room rectangle (walls) — used for the overlay border + label. % of map.
  x: number;
  y: number;
  w: number;
  h: number;
  // Interior floor rectangle — where agents are actually seated. % of map.
  // Tighter than the room so avatars sit on open floor, not on walls/furniture.
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  color: string;
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
const FLOORS: FloorDef[] = [
  {
    id: "floor1",
    label: "Floor 1",
    image: "/assets/pixelart/Office%20Level%204.png",
    natW: 640,
    natH: 800,
    zones: [
      { id: "planning", name: "Planning Studio", x: 32, y: 3,  w: 36, h: 27, fx: 35, fy: 15, fw: 30, fh: 14, color: "#8B5CF6" },
      { id: "shipyard", name: "Shipyard",        x: 4,  y: 32, w: 50, h: 37, fx: 8,  fy: 46, fw: 44, fh: 22, color: "#3B82F6" },
      { id: "systems",  name: "Systems Bay",     x: 64, y: 45, w: 32, h: 18, fx: 66, fy: 47, fw: 29, fh: 14, color: "#10B981" },
      { id: "commons",  name: "Commons",         x: 4,  y: 69, w: 50, h: 28, fx: 7,  fy: 76, fw: 45, fh: 20, color: "#F59E0B" },
      { id: "signal",   name: "Signal Room",     x: 64, y: 69, w: 32, h: 28, fx: 66, fy: 73, fw: 29, fh: 22, color: "#EC4899" },
    ],
  },
];

// Native-pixel area of a zone's FLOOR — used for capacity-aware team placement.
function zoneAreaPx(z: Zone, f: FloorDef) {
  return (z.fw / 100) * f.natW * (z.fh / 100) * f.natH;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
              width: size * 1.9, height: size * 1.9, objectFit: "contain",
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
          {agent.name}
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
  const isActive = workingCount > 0;
  const label = teamName && teamName !== "__ungrouped__" ? teamName : zone.name;
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{
      position: "absolute", left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.w}%`, height: `${zone.h}%`,
      border: `1.5px solid ${zone.color}${hovered ? "90" : "40"}`, borderRadius: 6,
      background: hovered ? `${zone.color}1a` : isActive ? `${zone.color}0c` : "transparent",
      boxShadow: isActive ? `inset 0 0 24px ${zone.color}10` : "none",
      transition: "border-color .2s, background .2s", zIndex: 2, cursor: "default",
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [userZoom, setUserZoom] = useState<number | null>(null); // null = auto-fit

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
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
    return (agent: Agent): SpriteSet | null => {
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
    // Contain-fit the whole floor to the viewport — fill the limiting dimension so
    // the map (and everyone on it) is as large as fits without cropping. Uniform
    // scale, so proportions are always preserved. Users can still zoom with +/−.
    const contain = Math.min(viewport.w / mapW, viewport.h / mapH);
    return clamp(contain, 0.3, 3);
  }, [viewport, mapW, mapH]);
  const zoom = userZoom ?? fitZoom;

  const bubbles = useMemo(() => new Map<string, string>(
    (liveRuns ?? []).filter(r => r.currentStatusMessage).map(r => [r.agentId, r.currentStatusMessage!])
  ), [liveRuns]);

  // Teams sorted by size (largest first)
  const teamList = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const a of agents) {
      const key = agentTeams(a)[0] ?? "__ungrouped__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [agents]);

  // Capacity-aware assignment: fill Floor 1 rooms first (biggest team → biggest
  // room by native-pixel area), then overflow to Floor 2. This keeps the default
  // floor populated and routes large teams into the largest rooms.
  const zoneAssignments = useMemo(() => {
    const ordered = FLOORS.flatMap((f, fi) =>
      f.zones
        .map(z => ({ zone: z, floorIdx: fi, area: zoneAreaPx(z, f) }))
        .sort((a, b) => b.area - a.area)   // within a floor, biggest first
    ); // floor 0 zones (by area) then floor 1 zones (by area)

    const assignments = ordered.map(o => ({
      zone: o.zone, floorIdx: o.floorIdx, teamName: "", members: [] as Agent[],
    }));

    teamList.forEach(([name, members], i) => {
      if (i < assignments.length) {
        assignments[i].teamName = name;
        assignments[i].members  = members;
      } else {
        const zi = i % assignments.length; // rare overflow: merge into an existing room
        assignments[zi].members = [...assignments[zi].members, ...members];
      }
    });
    return assignments;
  }, [teamList]);

  const floorZones = useMemo(
    () => zoneAssignments.filter(za => za.floorIdx === floorIdx),
    [zoneAssignments, floorIdx]
  );

  // Pin layout + DYNAMIC avatar size per room. Avatars shrink as a room fills so
  // crowded teams never overlap, and grow when a room is sparse.
  const { pins, labelSize } = useMemo(() => {
    const out: { agent: Agent; x: number; y: number; size: number; floor: { fx: number; fy: number; fw: number; fh: number } }[] = [];
    let minSize = Infinity;
    for (const za of floorZones) {
      const { zone, members } = za;
      const N = members.length;
      if (N === 0) continue;

      // Place agents in an aligned grid centered on the room's INTERIOR FLOOR
      // rectangle (fx/fy/fw/fh) so they sit on open floor in tidy rows.
      const usableWpx = (zone.fw / 100) * mapW;
      const usableHpx = (zone.fh / 100) * mapH;

      // columns matched to room aspect ratio, then a square cell
      const cols = clamp(Math.round(Math.sqrt(N * (usableWpx / usableHpx))), 1, N);
      const rows = Math.ceil(N / cols);
      const cellW = usableWpx / cols;
      const cellH = usableHpx / rows;
      const size = clamp(Math.min(cellW * 0.92, cellH * 0.8), 24, 84);
      minSize = Math.min(minSize, size);

      const stepXpct = zone.fw / cols;
      const stepYpct = zone.fh / rows;

      members.forEach((agent, i) => {
        const c = i % cols, rr = Math.floor(i / cols);
        // Center the last (possibly short) row so rows stay visually balanced.
        const inRow = Math.min(cols, N - rr * cols);
        const rowOffset = (cols - inRow) / 2;
        out.push({
          agent,
          x: zone.fx + (c + rowOffset + 0.5) * stepXpct,
          y: zone.fy + (rr + 0.5) * stepYpct,
          size,
          floor: { fx: zone.fx, fy: zone.fy, fw: zone.fw, fh: zone.fh },
        });
      });
    }
    // Hide name labels only when avatars get very small (would collide).
    return { pins: out, labelSize: minSize };
  }, [floorZones, mapW, mapH]);

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
  // An agent may wander only if it has a full directional sprite set — otherwise
  // a front-facing sprite sliding sideways looks like moonwalking. Agents without
  // the full set stay seated until their sprites are generated.
  const ALL_DIRS: Dir[] = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];
  const hasAllDirs = (set?: Partial<Record<Dir, string>>) => !!set && ALL_DIRS.every(d => !!set[d]);
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
      const walkable = hasAllDirs(spriteSetFor(p.agent) ?? undefined);
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
              m.waitUntil = now + 3000 + Math.random() * 9000;
            } else {
              m.x += (dx / dist) * step; m.y += (dy / dist) * step;
              m.dir = dirFromVelocity(dx, dy);
            }
          } else if (m.walkable && now >= m.waitUntil && Math.random() < dt * 0.12) {
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
    <div style={{ position: "relative" }}>
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
      <div ref={viewportRef} style={{
        height: "calc(100vh - 112px)", minHeight: 480, overflow: "auto", position: "relative",
        borderRadius: 12,
      }}>
        <div style={{
          width: Math.max(viewport.w, scaledW), height: Math.max(viewport.h, scaledH), position: "relative",
        }}>
          <div style={{
            position: "absolute", left: offsetX, top: offsetY, width: mapW, height: mapH,
            transform: `scale(${zoom})`, transformOrigin: "top left",
          }}>
            <img src={floor.image} alt={floor.label} draggable={false} style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              imageRendering: "pixelated", display: "block", userSelect: "none", pointerEvents: "none",
              boxShadow: "0 0 80px rgba(0,0,0,.6)", borderRadius: 2,
            }} />
            {floorZones.map(za => (
              <ZoneOverlay key={za.zone.id} zone={za.zone} teamName={za.teamName}
                count={za.members.length}
                workingCount={za.members.filter(a => workingIds.has(a.id)).length} />
            ))}
            {pins.map((pin, idx) => {
              const m = motion.current.get(pin.agent.id);
              const lx = m?.x ?? pin.x;
              const ly = m?.y ?? pin.y;
              const dir = m?.dir ?? "south";
              const set = spriteSetFor(pin.agent);
              const spriteUrl = set ? (set[dir] ?? set.south ?? null) : null;
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
  );
}

const zoomBtnStyle: React.CSSProperties = {
  width: 24, height: 24, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6,
  background: "rgba(255,255,255,0.04)", color: "#94a3b8", cursor: "pointer",
  fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center",
  justifyContent: "center", lineHeight: 1, padding: 0, outline: "none",
};
