import type { Agent } from "@paperclipai/shared";
import { officeTeamKey } from "./agent-teams";

// Room model shared by the Virtual Office layouts. The desktop pixel floor
// (LivingOfficeFloor) positions these same rooms on a baked background image;
// this metadata mirrors that floor's zone→team mapping (kept in sync by hand —
// the room set is stable). The mobile layout reuses it to render a stacked list
// of room cards instead of shrinking the whole floor image.
export interface OfficeRoom {
  id: string;
  name: string;
  /** Team whose agents sit here (must match agentTeams()); null = decorative. */
  team: string | null;
  /** A named agent (name substring) reserved to this room regardless of team. */
  soloAgent?: string;
}

// Mirrors the zones in LivingOfficeFloor's FLOORS[0]. Decorative rooms
// (meeting/lounge/pantry) have no team and are dropped from the mobile list.
export const OFFICE_ROOMS: OfficeRoom[] = [
  { id: "founder", name: "創辦人辦公室", team: null, soloAgent: "創辦人" },
  { id: "teaching", name: "教學組", team: "教學組" },
  { id: "it", name: "數位資訊部", team: "數位資訊部" },
  { id: "esl", name: "ESL教學組", team: "ESL教學組" },
  { id: "lead", name: "領導團隊", team: "領導團隊" },
  { id: "talent", name: "人才發展部", team: "人才發展部" },
  { id: "ga", name: "總務管理組", team: "總務管理組" },
  { id: "brand", name: "品牌發展部", team: "品牌發展部" },
  { id: "auto", name: "系統自動化", team: "系統自動化" },
];

export interface RoomWithMembers {
  room: OfficeRoom;
  members: Agent[];
}

/**
 * Group agents into office rooms for the mobile card list, applying the same
 * rules as the desktop floor: a solo-reserved agent (the founder) claims her own
 * room first; each team room gets its team's remaining agents; any agent whose
 * team has no room falls into the largest team room. Ordering for mobile:
 * founder room ALWAYS first, then rooms sorted by member count (desc). Empty
 * rooms are dropped so the list prioritises rooms that actually have agents.
 */
export function groupAgentsByRoom(agents: Agent[]): RoomWithMembers[] {
  const byTeam = new Map<string, Agent[]>();
  for (const a of agents) {
    const key = officeTeamKey(a); // department-based (campus ignored), mapped to a room
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key)!.push(a);
  }

  const assignments: RoomWithMembers[] = OFFICE_ROOMS.map((room) => ({ room, members: [] }));

  // 1) Solo rooms (founder) — claim a specific named agent, remove from her team.
  const soloClaimed = new Set<string>();
  for (const a of assignments) {
    if (!a.room.soloAgent) continue;
    const match = agents.find((ag) => (ag.name ?? "").includes(a.room.soloAgent!));
    if (match) {
      a.members = [match];
      soloClaimed.add(match.id);
    }
  }

  // 2) Team rooms — their team's agents, minus anyone reserved to a solo room.
  const claimed = new Set<string>();
  for (const a of assignments) {
    if (a.room.team && byTeam.has(a.room.team)) {
      a.members = byTeam.get(a.room.team)!.filter((m) => !soloClaimed.has(m.id));
      claimed.add(a.room.team);
    }
  }

  // 3) Teams without a room → drop into the largest team room (by current count).
  const spare = assignments
    .filter((a) => a.room.team)
    .sort((x, y) => y.members.length - x.members.length)[0];
  for (const [team, members] of byTeam) {
    if (!claimed.has(team) && spare) {
      spare.members = [...spare.members, ...members.filter((m) => !soloClaimed.has(m.id))];
    }
  }

  // Founder first, then by headcount desc; empty rooms dropped.
  return assignments
    .filter((a) => a.members.length > 0)
    .sort((x, y) => {
      if (x.room.id === "founder") return -1;
      if (y.room.id === "founder") return 1;
      return y.members.length - x.members.length;
    });
}
