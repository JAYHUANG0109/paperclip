import { useState, useMemo } from "react";
import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { OfficeAvatar } from "./OfficeAvatar";
import { agentTeams } from "../lib/agent-teams";

// ── Floor / zone definitions ───────────────────────────────────────────────
interface Zone {
  id: string;
  name: string;
  x: number; // % of map width
  y: number; // % of map height
  w: number;
  h: number;
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

const FLOORS: FloorDef[] = [
  {
    id: "floor1",
    label: "Floor 1",
    image: "/assets/pixelart/Office%20Level%204.png",
    natW: 640,
    natH: 800,
    zones: [
      { id: "planning", name: "Planning Studio", x: 25, y: 3,  w: 50, h: 27, color: "#8B5CF6" },
      { id: "shipyard", name: "Shipyard",        x: 2,  y: 33, w: 58, h: 30, color: "#3B82F6" },
      { id: "systems",  name: "Systems Bay",     x: 62, y: 33, w: 36, h: 22, color: "#10B981" },
      { id: "commons",  name: "Commons",         x: 2,  y: 68, w: 58, h: 30, color: "#F59E0B" },
      { id: "signal",   name: "Signal Room",     x: 62, y: 60, w: 36, h: 38, color: "#EC4899" },
    ],
  },
  {
    id: "floor2",
    label: "Floor 2",
    image: "/assets/pixelart/Office%20Level%203.jpeg",
    natW: 768,
    natH: 672,
    zones: [
      { id: "lab",      name: "Lab",        x: 2,  y: 3,  w: 30, h: 20, color: "#14B8A6" },
      { id: "main",     name: "Main Floor", x: 2,  y: 26, w: 50, h: 50, color: "#3B82F6" },
      { id: "westWing", name: "West Wing",  x: 57, y: 3,  w: 40, h: 36, color: "#8B5CF6" },
      { id: "eastWing", name: "East Wing",  x: 57, y: 43, w: 40, h: 35, color: "#F97316" },
      { id: "lobby",    name: "Lobby",      x: 2,  y: 80, w: 48, h: 17, color: "#EC4899" },
    ],
  },
];

const ALL_ZONES = FLOORS.flatMap((f, fi) => f.zones.map(z => ({ ...z, floorIdx: fi })));

// ── Status ─────────────────────────────────────────────────────────────────
type Status = "working" | "attention" | "paused" | "idle";

function getStatus(agent: Agent, working: boolean): Status {
  if (agent.errorReason) return "attention";
  if (agent.pauseReason) return "paused";
  if (working)           return "working";
  return "idle";
}

const STATUS_COLOR: Record<Status, string> = {
  working:   "#22c55e",
  attention: "#ef4444",
  paused:    "#f59e0b",
  idle:      "#6b7280",
};
const STATUS_GLOW: Record<Status, string> = {
  working:   "rgba(34,197,94,0.65)",
  attention: "rgba(239,68,68,0.55)",
  paused:    "rgba(245,158,11,0.4)",
  idle:      "transparent",
};
const STATUS_LABEL: Record<Status, string> = {
  working:   "ACTIVE",
  attention: "BLOCKED",
  paused:    "PAUSED",
  idle:      "IDLE",
};

const AV_D = 38;
const AV_R = AV_D / 2;

// ── Speech bubble ──────────────────────────────────────────────────────────
function SpeechBubble({ text, color }: { text: string; color: string }) {
  const short = text.length > 42 ? text.slice(0, 41) + "…" : text;
  return (
    <div className="office-speech-bubble" style={{
      position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
      transform: "translateX(-50%)", zIndex: 30, pointerEvents: "none", whiteSpace: "nowrap",
    }}>
      <div style={{
        background: "rgba(6,9,18,0.95)", border: `1px solid ${color}60`, borderRadius: 7,
        padding: "3px 8px", fontSize: 9, fontWeight: 600, color: "#cdd7ed",
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

// ── Agent pin on map ───────────────────────────────────────────────────────
function AgentPin({ agent, x, y, status, bubble, highlight, delayMs, onOpen }: {
  agent: Agent; x: number; y: number; status: Status;
  bubble: string | null; highlight: boolean; delayMs: number; onOpen: () => void;
}) {
  const color    = STATUS_COLOR[status];
  const glow      = STATUS_GLOW[status];
  const isActive  = status === "working";
  const isAlert   = status === "attention";
  const ring      = isActive || isAlert;

  return (
    <div style={{
      position: "absolute", left: `${x}%`, top: `${y}%`, width: AV_D, height: AV_D,
      marginLeft: -AV_R, marginTop: -AV_R, zIndex: highlight ? 25 : 10, overflow: "visible",
    }}>
      {ring && (
        <div className="office-agent-ring" style={{
          position: "absolute", left: -7, top: -7, width: AV_D + 14, height: AV_D + 14,
          borderRadius: "50%", border: `2px solid ${color}`, boxShadow: `0 0 10px ${glow}`,
          animationDelay: `${delayMs}ms`, pointerEvents: "none",
        }} />
      )}
      {highlight && (
        <div style={{
          position: "absolute", left: -11, top: -11, width: AV_D + 22, height: AV_D + 22,
          borderRadius: "50%", border: "2px solid #e2e8f0", boxShadow: "0 0 16px rgba(255,255,255,.5)",
          pointerEvents: "none",
        }} />
      )}
      {bubble && isActive && <SpeechBubble text={bubble} color={color} />}

      <button type="button" onClick={onOpen} title={agent.name ?? undefined}
        className={isActive ? "office-agent-working" : undefined}
        style={{
          position: "absolute", inset: 0, padding: 0, background: "none", border: "none",
          cursor: "pointer", borderRadius: "50%", outline: "none", animationDelay: `${delayMs * 0.6}ms`,
        }}>
        <OfficeAvatar agent={agent} size={AV_D} animated={isActive} style={{
          borderRadius: "50%", border: `2px solid ${color}90`,
          boxShadow: ring ? `0 0 14px ${glow}, 0 2px 7px rgba(0,0,0,.65)` : "0 1px 5px rgba(0,0,0,.55)",
        }} />
      </button>

      <div style={{
        position: "absolute", top: AV_D + 3, left: "50%", transform: "translateX(-50%)",
        maxWidth: 84, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontSize: 8.5, fontWeight: 700, color: "#c6d2e8", background: "rgba(6,9,18,0.90)",
        borderRadius: 5, padding: "1px 5px", pointerEvents: "none", lineHeight: "14px", zIndex: 3,
      }}>
        <span style={{
          display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: color,
          marginRight: 3, marginBottom: 1, verticalAlign: "middle",
          boxShadow: status !== "idle" ? `0 0 5px ${color}` : undefined,
        }} />
        {agent.name}
      </div>
    </div>
  );
}

// ── Zone overlay ───────────────────────────────────────────────────────────
function ZoneOverlay({ zone, teamName, workingCount }: { zone: Zone; teamName: string; workingCount: number }) {
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
        position: "absolute", top: 4, left: 5, fontSize: 7.5, fontWeight: 800, color: zone.color,
        background: "rgba(6,9,18,0.82)", borderRadius: 4, padding: "1px 5px", letterSpacing: "0.05em",
        opacity: hovered ? 1 : 0.72, transition: "opacity .2s", pointerEvents: "none",
        whiteSpace: "nowrap", textTransform: "uppercase", lineHeight: "14px",
      }}>{label}</div>
      {workingCount > 0 && (
        <div style={{
          position: "absolute", top: 4, right: 5, fontSize: 7.5, fontWeight: 700, color: "#22c55e",
          background: "rgba(34,197,94,.14)", border: "1px solid rgba(34,197,94,.38)", borderRadius: 4,
          padding: "1px 5px", pointerEvents: "none", whiteSpace: "nowrap", lineHeight: "14px",
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
          fontSize: 10, color: "#7b8aa3", overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap",
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
export function LivingOfficeFloor({ agents, workingIds, liveRuns, onOpen }: {
  agents: Agent[];
  workingIds: Set<string>;
  skillCounts?: Record<string, number>;
  liveRuns?: LiveRunForIssue[];
  onOpen: (agent: Agent) => void;
}) {
  const [floorIdx, setFloorIdx]     = useState(0);
  const [zoom, setZoom]             = useState(0.8);
  const [highlightId, setHighlight] = useState<string | null>(null);

  const floor = FLOORS[floorIdx];
  const mapW  = floor.natW;
  const mapH  = floor.natH;

  const bubbles = useMemo(() => new Map<string, string>(
    (liveRuns ?? []).filter(r => r.currentStatusMessage).map(r => [r.agentId, r.currentStatusMessage!])
  ), [liveRuns]);

  // Teams sorted by size (largest first)
  const teamList = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const a of agents) {
      const teams = agentTeams(a);
      const key   = teams.length > 0 ? teams[0] : "__ungrouped__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [agents]);

  // Assign teams → zones across both floors
  const zoneAssignments = useMemo(() => {
    const assignments = ALL_ZONES.map(z => ({
      zone: { id: z.id, name: z.name, x: z.x, y: z.y, w: z.w, h: z.h, color: z.color } as Zone,
      floorIdx: z.floorIdx, teamName: "", members: [] as Agent[],
    }));
    teamList.forEach(([name, members], i) => {
      if (i < assignments.length) {
        assignments[i].teamName = name;
        assignments[i].members  = members;
      } else {
        const zi = i % assignments.length;
        assignments[zi].members = [...assignments[zi].members, ...members];
      }
    });
    return assignments;
  }, [teamList]);

  // Map agentId → which floor they live on (for roster floor-jump)
  const agentFloor = useMemo(() => {
    const m = new Map<string, number>();
    for (const za of zoneAssignments) for (const a of za.members) m.set(a.id, za.floorIdx);
    return m;
  }, [zoneAssignments]);

  const floorZones = useMemo(
    () => zoneAssignments.filter(za => za.floorIdx === floorIdx),
    [zoneAssignments, floorIdx]
  );

  // Pin positions (auto-grid within each zone)
  const agentPins = useMemo(() => {
    const pins: { agent: Agent; x: number; y: number }[] = [];
    for (const za of floorZones) {
      const { zone, members } = za;
      if (members.length === 0) continue;
      const padX = 12, padY = 22;
      const usableW = zone.w * (1 - (padX * 2) / 100);
      const usableH = zone.h * (1 - (padY * 2) / 100);
      const startX  = zone.x + zone.w * (padX / 100);
      const startY  = zone.y + zone.h * (padY / 100);
      const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
      const rows = Math.ceil(members.length / cols);
      members.forEach((agent, idx) => {
        const col = idx % cols, row = Math.floor(idx / cols);
        pins.push({
          agent,
          x: startX + (col + 0.5) * (usableW / cols),
          y: startY + (row + 0.5) * (usableH / rows),
        });
      });
    }
    return pins;
  }, [floorZones]);

  // Roster: sorted working → attention → paused → idle
  const ROSTER_ORDER: Record<Status, number> = { working: 0, attention: 1, paused: 2, idle: 3 };
  const roster = useMemo(() => {
    return agents
      .map(a => ({ agent: a, status: getStatus(a, workingIds.has(a.id)),
        teamName: (agentTeams(a)[0] ?? "—") }))
      .sort((a, b) => ROSTER_ORDER[a.status] - ROSTER_ORDER[b.status]);
  }, [agents, workingIds]);

  const workingTotal = roster.filter(r => r.status === "working").length;
  const attnTotal    = roster.filter(r => r.status === "attention").length;

  function focusAgent(agentId: string) {
    const f = agentFloor.get(agentId);
    if (f != null && f !== floorIdx) setFloorIdx(f);
  }

  return (
    <div style={{
      borderRadius: 14, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)",
      background: "#0a0d14", boxShadow: "0 8px 40px rgba(0,0,0,.35)",
    }}>
      {/* ── Top bar ──────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "9px 14px", background: "linear-gradient(180deg,#141925,#0d1117)",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
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
          {/* Floor tabs */}
          <div style={{ display: "flex", gap: 4, marginLeft: 6 }}>
            {FLOORS.map((f, i) => (
              <button key={f.id} type="button"
                onClick={() => { setFloorIdx(i); setZoom(0.8); }}
                style={{
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
            <button type="button" onClick={() => setZoom(z => Math.max(0.45, +(z - 0.15).toFixed(2)))} style={zoomBtnStyle} title="Zoom out">−</button>
            <span style={{ fontSize: 10, color: "#6b7280", minWidth: 30, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom(z => Math.min(2.5, +(z + 0.15).toFixed(2)))} style={zoomBtnStyle} title="Zoom in">+</button>
          </div>
        </div>
      </div>

      {/* ── Body: map + roster ──────────────────────────────────────── */}
      <div style={{ display: "flex", height: 560 }}>
        {/* Map viewport */}
        <div style={{ flex: 1, minWidth: 0, overflow: "auto", position: "relative", background: "#0d1117" }}>
          <div style={{ width: mapW * zoom, height: mapH * zoom, minWidth: "100%" }} />
          <div style={{
            position: "absolute", top: 0, left: 0, width: mapW, height: mapH,
            transform: `scale(${zoom})`, transformOrigin: "top left",
          }}>
            <img src={floor.image} alt={floor.label} draggable={false} style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              imageRendering: "pixelated", display: "block", userSelect: "none", pointerEvents: "none",
            }} />
            {floorZones.map(za => (
              <ZoneOverlay key={za.zone.id} zone={za.zone} teamName={za.teamName}
                workingCount={za.members.filter(a => workingIds.has(a.id)).length} />
            ))}
            {agentPins.map((pin, idx) => (
              <AgentPin key={pin.agent.id} agent={pin.agent} x={pin.x} y={pin.y}
                status={getStatus(pin.agent, workingIds.has(pin.agent.id))}
                bubble={bubbles.get(pin.agent.id) ?? null}
                highlight={highlightId === pin.agent.id}
                delayMs={idx * 140} onOpen={() => onOpen(pin.agent)} />
            ))}
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
              <div style={{ padding: 16, textAlign: "center", fontSize: 11, color: "#5f6b80" }}>
                No agents in view.
              </div>
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
