// Display-only helper: agent names are stored as `name_role_id` (e.g.
// "陳怡伶_教學主管_22980502", "Frank_資訊副理_a0000960", "Jay_jay20020109",
// "Jessica_資訊顧問_it-jessica"). The trailing id/code segment is for the system
// (URLs, search, backend) — it should NOT be shown in the UI. This strips a
// trailing id-like segment for DISPLAY only; the stored agent.name is untouched.
export function displayAgentName(name?: string | null): string {
  if (!name) return name ?? "";
  const parts = name.split("_");
  if (parts.length < 2) return name; // no separator → nothing to strip
  const last = parts[parts.length - 1];
  // An id/code segment has a digit or a hyphen (22980502, a0000960, 51A20901,
  // it-jessica, "Agent 12", jay20020109). Role/name segments are plain words.
  if (/[\d-]/.test(last)) return parts.slice(0, -1).join("_");
  return name;
}
