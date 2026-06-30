import { useState, useMemo, useRef, useLayoutEffect, useEffect } from "react";
import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { OfficeAvatar } from "./OfficeAvatar";
import { agentTeams } from "../lib/agent-teams";

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
  {
    id: "floor2",
    label: "Floor 2",
    image: "/assets/pixelart/Office%20Level%203.jpeg",
    natW: 768,
    natH: 672,
    zones: [
      { id: "main",        name: "Main Floor",  x: 5,  y: 9,  w: 50, h: 82, fx: 8,  fy: 30, fw: 44, fh: 58, color: "#3B82F6" },
      { id: "northOffice", name: "North Office", x: 61, y: 9, w: 35, h: 33, fx: 64, fy: 24, fw: 30, fh: 15, color: "#8B5CF6" },
      { id: "eastOffice",  name: "East Office",  x: 57, y: 44, w: 39, h: 24, fx: 60, fy: 47, fw: 34, fh: 17, color: "#10B981" },
      { id: "lounge",      name: "Lounge",       x: 57, y: 69, w: 39, h: 22, fx: 60, fy: 71, fw: 34, fh: 18, color: "#F97316" },
    ],
  },
];

// Native-pixel area of a zone's FLOOR — used for capacity-aware team placement.
function zoneAreaPx(z: Zone, f: FloorDef) {
  return (z.fw / 100) * f.natW * (z.fh / 100) * f.natH;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
const STATUS_LABEL: Record<Status, string> = {
  working: "ACTIVE", attention: "BLOCKED", paused: "PAUSED", idle: "IDLE",
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
function AgentPin({ agent, x, y, size, status, bubble, highlight, showLabel, spriteUrl, delayMs, onOpen }: {
  agent: Agent; x: number; y: number; size: number; status: Status;
  bubble: string | null; highlight: boolean; showLabel: boolean; spriteUrl?: string | null;
  delayMs: number; onOpen: () => void;
}) {
  const r        = size / 2;
  const color    = STATUS_COLOR[status];
  const glow     = STATUS_GLOW[status];
  const isActive = status === "working";
  // Only WORKING agents get the animated pulse ring — otherwise a floor full of
  // idle/blocked agents becomes a wall of distracting rings. Status for the rest
  // is conveyed by the avatar border + the dot on the name label + roster badge.
  const ring     = isActive;

  return (
    <div style={{
      position: "absolute", left: `${x}%`, top: `${y}%`, width: size, height: size,
      marginLeft: -r, marginTop: -r, zIndex: highlight ? 25 : isActive ? 12 : 10, overflow: "visible",
    }}>
      {ring && (
        <div className="office-agent-ring" style={{
          position: "absolute", left: -size * 0.18, top: -size * 0.18,
          width: size * 1.36, height: size * 1.36, borderRadius: "50%",
          border: `${Math.max(1.5, size * 0.05)}px solid ${color}`, boxShadow: `0 0 10px ${glow}`,
          animationDelay: `${delayMs}ms`, pointerEvents: "none",
        }} />
      )}
      {highlight && (
        <div style={{
          position: "absolute", left: -size * 0.3, top: -size * 0.3,
          width: size * 1.6, height: size * 1.6, borderRadius: "50%",
          border: "2px solid #e2e8f0", boxShadow: "0 0 16px rgba(255,255,255,.5)", pointerEvents: "none",
        }} />
      )}
      {bubble && isActive && <SpeechBubble text={bubble} color={color} />}

      <button type="button" onClick={onOpen} title={agent.name ?? undefined}
        className={isActive ? "office-agent-working" : undefined}
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
              width: size * 1.55, height: size * 1.55, imageRendering: "pixelated", pointerEvents: "none",
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

// ── Roster row (right panel) ───────────────────────────────────────────────
function RosterRow({ agent, status, teamName, onOpen, onHover, onLeave }: {
  agent: Agent; status: Status; teamName: string;
  onOpen: () => void; onHover: () => void; onLeave: () => void;
}) {
  const color = STATUS_COLOR[status];
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onOpen}
      onMouseEnter={() => { setHover(true); onHover(); }}
      onMouseLeave={() => { setHover(false); onLeave(); }}
      style={{
        display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
        padding: "7px 9px", borderRadius: 9, border: "1px solid",
        borderColor: hover ? `${color}55` : "transparent",
        background: hover ? "rgba(255,255,255,0.05)" : "transparent",
        cursor: "pointer", transition: "all .12s", outline: "none",
      }}>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <OfficeAvatar agent={agent} size={30} animated={false} style={{
          borderRadius: "50%", border: `1.5px solid ${color}80`,
        }} />
        <span style={{
          position: "absolute", right: -1, bottom: -1, width: 9, height: 9, borderRadius: "50%",
          background: color, border: "2px solid #0d1117",
          boxShadow: status === "working" ? `0 0 6px ${color}` : undefined,
        }} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: "#e2e8f0", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{agent.name}</div>
        <div style={{
          fontSize: 10, color: "#7b8aa3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{agent.title ?? agent.role ?? teamName}</div>
      </div>
      <span style={{
        fontSize: 8, fontWeight: 800, letterSpacing: "0.06em", color,
        background: `${color}1f`, border: `1px solid ${color}40`, borderRadius: 5,
        padding: "2px 5px", flexShrink: 0,
      }}>{STATUS_LABEL[status]}</span>
    </button>
  );
}

// ── Public export ──────────────────────────────────────────────────────────
const ROSTER_ORDER: Record<Status, number> = { working: 0, attention: 1, paused: 2, idle: 3 };

export function LivingOfficeFloor({ agents, workingIds, liveRuns, onOpen }: {
  agents: Agent[];
  workingIds: Set<string>;
  skillCounts?: Record<string, number>;
  liveRuns?: LiveRunForIssue[];
  onOpen: (agent: Agent) => void;
}) {
  const [floorIdx, setFloorIdx]     = useState(0);
  const [highlightId, setHighlight] = useState<string | null>(null);

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
  useEffect(() => { setUserZoom(null); }, [floorIdx]);

  // Pixel-art character sprites, generated per agent via PixelLab. Loaded from a
  // static manifest; agents without a sprite fall back to the circular avatar.
  const [sprites, setSprites] = useState<Record<string, { south?: string }>>({});
  useEffect(() => {
    let alive = true;
    fetch("/assets/agent-sprites/manifest.json")
      .then(r => (r.ok ? r.json() : {}))
      .then(m => { if (alive) setSprites(m ?? {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const floor = FLOORS[floorIdx];
  const mapW  = floor.natW;
  const mapH  = floor.natH;

  const fitZoom = useMemo(() => {
    if (!viewport.w || !viewport.h) return 1;
    return clamp(Math.min(viewport.w / mapW, viewport.h / mapH), 0.3, 4);
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

  const agentFloor = useMemo(() => {
    const m = new Map<string, number>();
    for (const za of zoneAssignments) for (const a of za.members) m.set(a.id, za.floorIdx);
    return m;
  }, [zoneAssignments]);

  const floorZones = useMemo(
    () => zoneAssignments.filter(za => za.floorIdx === floorIdx),
    [zoneAssignments, floorIdx]
  );

  // Pin layout + DYNAMIC avatar size per room. Avatars shrink as a room fills so
  // crowded teams never overlap, and grow when a room is sparse.
  const { pins, labelSize } = useMemo(() => {
    const out: { agent: Agent; x: number; y: number; size: number }[] = [];
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
      const size = clamp(Math.min(cellW * 0.62, cellH * 0.5), 12, 40);
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
        });
      });
    }
    // Hide name labels only when avatars get very small (would collide).
    return { pins: out, labelSize: minSize };
  }, [floorZones, mapW, mapH]);

  // Roster: active → blocked → paused → idle
  const roster = useMemo(() =>
    agents
      .map(a => ({ agent: a, status: getStatus(a, workingIds.has(a.id)), teamName: agentTeams(a)[0] ?? "—" }))
      .sort((a, b) => ROSTER_ORDER[a.status] - ROSTER_ORDER[b.status]),
    [agents, workingIds]);

  const workingTotal = roster.filter(r => r.status === "working").length;
  const attnTotal    = roster.filter(r => r.status === "attention").length;

  function focusAgent(agentId: string) {
    const f = agentFloor.get(agentId);
    if (f != null && f !== floorIdx) setFloorIdx(f);
  }

  const scaledW = mapW * zoom;
  const scaledH = mapH * zoom;
  const offsetX = Math.max(0, (viewport.w - scaledW) / 2);
  const offsetY = Math.max(0, (viewport.h - scaledH) / 2);

  return (
    <div style={{
      borderRadius: 14, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)",
      background: "#0a0d14", boxShadow: "0 8px 40px rgba(0,0,0,.35)",
    }}>
      {/* ── Top bar ──────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "9px 14px", background: "linear-gradient(180deg,#141925,#0d1117)",
        borderBottom: "1px solid rgba(255,255,255,0.07)", flexWrap: "wrap", gap: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", letterSpacing: "0.02em" }}>
            Virtual Office
          </span>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 800,
            letterSpacing: "0.08em", color: "#4ade80", background: "rgba(34,197,94,.12)",
            border: "1px solid rgba(34,197,94,.35)", borderRadius: 5, padding: "2px 7px",
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%", background: "#22c55e",
              boxShadow: "0 0 6px rgba(34,197,94,.9)",
              animation: "office-agent-ring-pulse 1.8s ease-in-out infinite",
            }} />
            LIVE
          </span>
          <div style={{ display: "flex", gap: 4, marginLeft: 6 }}>
            {FLOORS.map((f, i) => (
              <button key={f.id} type="button" onClick={() => setFloorIdx(i)} style={{
                padding: "3px 11px", fontSize: 10.5, fontWeight: 700, borderRadius: 7,
                border: "1px solid", cursor: "pointer", transition: "all .15s", outline: "none",
                borderColor: i === floorIdx ? "#6366f1" : "rgba(255,255,255,0.1)",
                background: i === floorIdx ? "rgba(99,102,241,0.18)" : "rgba(255,255,255,0.03)",
                color: i === floorIdx ? "#a5b4fc" : "#8290a8",
              }}>{f.label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 11, color: "#7b8aa3" }}>
            <b style={{ color: "#4ade80" }}>{workingTotal}</b> active
            {attnTotal > 0 && <> · <b style={{ color: "#f87171" }}>{attnTotal}</b> blocked</>}
            {" · "}<b style={{ color: "#cbd5e1" }}>{agents.length}</b> total
          </span>
          <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <button type="button" onClick={() => setUserZoom(z => clamp((z ?? fitZoom) - 0.2, 0.3, 4))} style={zoomBtnStyle} title="Zoom out">−</button>
            <button type="button" onClick={() => setUserZoom(null)} style={{ ...zoomBtnStyle, width: "auto", padding: "0 8px", fontSize: 10, fontWeight: 700 }} title="Fit to screen">FIT</button>
            <button type="button" onClick={() => setUserZoom(z => clamp((z ?? fitZoom) + 0.2, 0.3, 4))} style={zoomBtnStyle} title="Zoom in">+</button>
          </div>
        </div>
      </div>

      {/* ── Body: map + roster ──────────────────────────────────────── */}
      <div style={{ display: "flex", height: "min(76vh, 860px)", minHeight: 520 }}>
        {/* Map viewport */}
        <div ref={viewportRef} style={{
          flex: 1, minWidth: 0, overflow: "auto", position: "relative",
          background: "radial-gradient(circle at 50% 40%, #11151f, #090b10)",
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
                boxShadow: "0 0 60px rgba(0,0,0,.5)",
              }} />
              {floorZones.map(za => (
                <ZoneOverlay key={za.zone.id} zone={za.zone} teamName={za.teamName}
                  count={za.members.length}
                  workingCount={za.members.filter(a => workingIds.has(a.id)).length} />
              ))}
              {pins.map((pin, idx) => (
                <AgentPin key={pin.agent.id} agent={pin.agent} x={pin.x} y={pin.y} size={pin.size}
                  status={getStatus(pin.agent, workingIds.has(pin.agent.id))}
                  bubble={bubbles.get(pin.agent.id) ?? null}
                  highlight={highlightId === pin.agent.id}
                  showLabel={labelSize >= 17}
                  spriteUrl={sprites[pin.agent.id]?.south ?? null}
                  delayMs={idx * 120} onOpen={() => onOpen(pin.agent)} />
              ))}
            </div>
          </div>
        </div>

        {/* Roster panel */}
        <div style={{
          width: 256, flexShrink: 0, borderLeft: "1px solid rgba(255,255,255,0.07)",
          display: "flex", flexDirection: "column", background: "#0b0e16",
        }}>
          <div style={{
            padding: "10px 12px 8px", borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", color: "#94a3b8", textTransform: "uppercase" }}>
              Team Presence
            </span>
            <span style={{ fontSize: 10, color: "#5f6b80" }}>{agents.length}</span>
          </div>
          <div style={{ overflow: "auto", flex: 1, padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
            {roster.length === 0 && (
              <div style={{ padding: 16, textAlign: "center", fontSize: 11, color: "#5f6b80" }}>No agents in view.</div>
            )}
            {roster.map(({ agent, status, teamName }) => (
              <RosterRow key={agent.id} agent={agent} status={status} teamName={teamName}
                onOpen={() => onOpen(agent)}
                onHover={() => { focusAgent(agent.id); setHighlight(agent.id); }}
                onLeave={() => setHighlight(h => (h === agent.id ? null : h))} />
            ))}
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
