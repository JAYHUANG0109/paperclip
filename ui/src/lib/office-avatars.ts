// Virtual Office avatar resolution. Maps each agent to a custom image (if one
// was dropped into /public/office-avatars) or a generic gender image, falling
// back to a DiceBear cartoon when no file exists. Editable config — no schema.

import { agentTeams } from "./agent-teams";

export type Gender = "male" | "female";

// Per-agent custom avatars, keyed by a lowercased substring of the agent's
// urlKey or name. First match wins. Put the most specific entries first.
const CUSTOM_AVATARS: { match: string; src: string }[] = [
  { match: "jay_jay20020109", src: "/office-avatars/jay.png" },
  { match: "jay20020109", src: "/office-avatars/jay.png" },
];

const GENDER_IMAGE: Record<Gender, string> = {
  male: "/office-avatars/male.png",
  female: "/office-avatars/female.png",
};

function haystack(agent: { name?: string | null; urlKey?: string | null }): string {
  return `${agent.name ?? ""} ${agent.urlKey ?? ""}`.toLowerCase();
}

// Gender rule (per 四季 setup): everyone in the 資訊部 (IT) team is MALE, EXCEPT
// Jessica; every other agent is FEMALE. Keyed off team membership so it stays
// correct as people are renamed.
export function resolveGender(agent: {
  name?: string | null;
  urlKey?: string | null;
  metadata?: Record<string, unknown> | null;
}): Gender {
  if (haystack(agent).includes("jessica")) return "female"; // explicit exception
  const inItDept = agentTeams({ metadata: agent.metadata ?? null }).some((t) =>
    t.replace(/\s/g, "").includes("資訊"),
  );
  return inItDept ? "male" : "female";
}

// Returns the ordered list of image srcs to try before falling back to DiceBear.
// The component tries each in order, advancing on load error.
export function resolveAvatarSources(agent: { name?: string | null; urlKey?: string | null; metadata?: Record<string, unknown> | null }): string[] {
  const h = haystack(agent);
  const custom = CUSTOM_AVATARS.find((c) => h.includes(c.match.toLowerCase()));
  const sources: string[] = [];
  // Uploaded avatar (per-agent, set in Settings / office) wins over everything.
  const uploaded = agent.metadata && typeof agent.metadata.officeAvatarUrl === "string" ? agent.metadata.officeAvatarUrl : null;
  if (uploaded) sources.push(uploaded);
  if (custom) sources.push(custom.src);
  sources.push(GENDER_IMAGE[resolveGender(agent)]);
  return sources;
}
