import type { Agent } from "@paperclipai/shared";
import { OfficeAvatar } from "./OfficeAvatar";
import { agentTeams } from "../lib/agent-teams";

// ── Layout constants (px) ──────────────────────────────────────────────────
const SLOT_W  = 110;   // horizontal space per agent slot
const PAD     = 16;    // left/right padding inside pod
const DESK_Y  = 100;   // desk centre Y from pod top
const DESK_H  = 22;    // desk thickness
const AV_R    = 29;    // avatar radius  (58 px diameter)
const TOP_Y   = 65;    // avatar centre Y — top row
const BOT_Y   = 135;   // avatar centre Y — bottom row
const POD_H   = 190;   // total pod height
const MON_W   = 22;    // monitor width
const MON_H   = 14;    // monitor height

// ── Team colour palette ────────────────────────────────────────────────────
const PALETTE = [
  { bg: "rgba(62,124,194,0.07)",  border: "#3E7CC2", text: "#3E7CC2" },
  { bg: "rgba(79,94,140,0.07)",   border: "#4F5E8C", text: "#4F5E8C" },
  { bg: "rgba(138,92,208,0.07)",  border: "#8A5CD0", text: "#8A5CD0" },
  { bg: "rgba(78,140,106,0.07)",  border: "#4E8C6A", text: "#4E8C6A" },
  { bg: "rgba(201,138,43,0.07)",  border: "#C98A2B", text: "#C98A2B" },
  { bg: "rgba(176,86,127,0.07)",  border: "#B0567F", text: "#B0567F" },
  { bg: "rgba(180,74,74,0.07)",   border: "#B44A4A", text: "#B44A4A" },
  { bg: "rgba(60,130,130,0.07)",  border: "#3C8282", text: "#3C8282" },
];
function teamColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xfffffff;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// ── Agent status ───────────────────────────────────────────────────────────
type Status = "working" | "attention" | "paused" | "idle";
function statusOf(agent: Agent, working: boolean): Status {
  if (agent.pauseReason) return "paused";
  if (agent.errorReason) return "attention";
  if (working) return "working";
  return "idle";
}
const STATUS_DOT: Record<Status, string> = {
  working:   "#22c55e",
  attention: "#ef4444",
  paused:    "#f59e0b",
  idle:      "#a8a8ae",
};

// ── Monitor style per status ───────────────────────────────────────────────
function monitorStyle(status: Status): React.CSSProperties {
  if (status === "working")   return { background: "linear-gradient(135deg,#34d399,#22c55e)", border: "1px solid #15803d", boxShadow: "0 0 7px rgba(34,197,94,.6)" };
  if (status === "attention") return { background: "linear-gradient(135deg,#f87171,#ef4444)", border: "1px solid #b91c1c", boxShadow: "0 0 6px rgba(239,68,68,.55)" };
  if (status === "paused")    return { background: "rgba(251,191,36,.2)", border: "1px solid rgba(251,191,36,.5)" };
  return { background: "#21242b", border: "1px solid #14161a" };
}

// ── Public component ───────────────────────────────────────────────────────
export function LivingOfficeFloor({
  agents,
  workingIds,
  onOpen,
}: {
  agents: Agent[];
  workingIds: Set<string>;
  skillCounts?: Record<string, number>;
  onOpen: (agent: Agent) => void;
}) {
  // Group by primary team (first entry in metadata.teams / metadata.team)
  const podMap = new Map<string, Agent[]>();
  const ungrouped: Agent[] = [];
  for (const a of agents) {
    const teams = agentTeams(a);
    if (teams.length > 0) {
      const key = teams[0];
      if (!podMap.has(key)) podMap.set(key, []);
      podMap.get(key)!.push(a);
    } else {
      ungrouped.push(a);
    }
  }
  if (ungrouped.length > 0) podMap.set("其他", ungrouped);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, overflowX: "auto" }}>
      {Array.from(podMap.entries()).map(([team, members]) => (
        <TeamPod
          key={team}
          team={team}
          agents={members}
          workingIds={workingIds}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

// ── Team bench pod ─────────────────────────────────────────────────────────
function TeamPod({
  team, agents, workingIds, onOpen,
}: {
  team: string;
  agents: Agent[];
  workingIds: Set<string>;
  onOpen: (agent: Agent) => void;
}) {
  const color  = teamColor(team);
  const half   = Math.ceil(agents.length / 2);
  const topRow = agents.slice(0, half);
  const botRow = agents.slice(half);
  const cols   = Math.max(topRow.length, 1);
  const podW   = cols * SLOT_W + PAD * 2;

  function slotX(idx: number, total: number) {
    const usable = podW - PAD * 2;
    return PAD + (idx + 0.5) * (usable / total);
  }

  return (
    <div style={{ position: "relative", width: podW, height: POD_H, flexShrink: 0 }}>

      {/* Zone background + dashed outline */}
      <div style={{
        position: "absolute", top: 22, left: 0, right: 0, bottom: 0,
        borderRadius: 14,
        border: `1.5px dashed ${color.border}33`,
        background: color.bg,
      }} />

      {/* Team label chip */}
      <div style={{
        position: "absolute", top: 14, left: 10, zIndex: 9,
        fontSize: 10.5, fontWeight: 700, color: color.text,
        background: "rgba(255,255,255,0.92)",
        border: `1px solid ${color.border}44`,
        borderRadius: 7, padding: "2px 8px",
        letterSpacing: "0.03em",
        boxShadow: "0 1px 3px rgba(0,0,0,.07)",
        pointerEvents: "none",
      }}>
        {team}
      </div>

      {/* Top-row agents */}
      {topRow.map((a, i) => (
        <AgentPin
          key={a.id}
          agent={a}
          cx={slotX(i, topRow.length)}
          cy={TOP_Y}
          row="top"
          status={statusOf(a, workingIds.has(a.id))}
          onOpen={() => onOpen(a)}
        />
      ))}

      {/* Bench desk */}
      <div style={{
        position: "absolute",
        left: PAD, right: PAD,
        top: DESK_Y - DESK_H / 2,
        height: DESK_H,
        zIndex: 5,
        borderRadius: 8,
        background: "linear-gradient(180deg,#CDA471,#B68A50)",
        border: "1px solid #956d36",
        boxShadow: "0 4px 10px rgba(60,40,15,.18),inset 0 1px 0 rgba(255,255,255,.3)",
      }} />

      {/* Bottom-row agents */}
      {botRow.map((a, i) => (
        <AgentPin
          key={a.id}
          agent={a}
          cx={slotX(i, botRow.length)}
          cy={BOT_Y}
          row="bottom"
          status={statusOf(a, workingIds.has(a.id))}
          onOpen={() => onOpen(a)}
        />
      ))}
    </div>
  );
}

// ── Single agent seat ──────────────────────────────────────────────────────
function AgentPin({
  agent, cx, cy, row, status, onOpen,
}: {
  agent: Agent;
  cx: number;
  cy: number;
  row: "top" | "bottom";
  status: Status;
  onOpen: () => void;
}) {
  const isTop = row === "top";

  // Monitor sits at the desk edge — in front of avatar for top row (screen at
  // agent's bottom is harder to see), behind for bottom row (screen at top is
  // clearly readable already).
  const monZ = isTop ? 8 : 6;
  const monCy = isTop
    ? cy + AV_R + 3    // below avatar → desk-top edge
    : cy - AV_R - 3;   // above avatar → desk-bottom edge

  const nmY = isTop
    ? cy - AV_R - 18   // label above avatar for top row
    : cy + AV_R + 5;   // label below avatar for bottom row

  return (
    <>
      {/* Monitor */}
      <div style={{
        position: "absolute",
        left: cx - MON_W / 2,
        top:  monCy - MON_H / 2,
        width: MON_W, height: MON_H,
        zIndex: monZ,
        borderRadius: 3,
        transition: "background .2s,border-color .2s,box-shadow .2s",
        ...monitorStyle(status),
      }} />

      {/* Avatar button */}
      <button
        type="button"
        onClick={onOpen}
        title={agent.name}
        style={{
          position: "absolute",
          left: cx - AV_R,
          top:  cy - AV_R,
          width: AV_R * 2, height: AV_R * 2,
          zIndex: 7,
          padding: 0, background: "none", border: "none",
          cursor: "pointer", borderRadius: "50%",
        }}
      >
        <OfficeAvatar agent={agent} size={AV_R * 2} animated={false} className="drop-shadow-sm" />
      </button>

      {/* Name label */}
      <div style={{
        position: "absolute",
        left: cx,
        top: nmY,
        zIndex: 8,
        transform: "translateX(-50%)",
        maxWidth: 108,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontSize: 9.5, fontWeight: 600, color: "#33363d",
        background: "rgba(255,255,255,.9)",
        borderRadius: 6, padding: "2px 6px",
        boxShadow: "0 1px 3px rgba(0,0,0,.1)",
        pointerEvents: "none",
      }}>
        <span style={{
          display: "inline-block",
          width: 5, height: 5, borderRadius: "50%",
          background: STATUS_DOT[status],
          marginRight: 3, verticalAlign: "middle",
        }} />
        {agent.name}
      </div>
    </>
  );
}
