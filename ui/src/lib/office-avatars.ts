// Virtual Office avatar resolution. Maps each agent to a custom image (if one
// was dropped into /public/office-avatars) or a generic gender image, falling
// back to a DiceBear cartoon when no file exists. Editable config — no schema.

export type Gender = "male" | "female";

// Per-agent custom avatars, keyed by a lowercased substring of the agent's
// urlKey or name. First match wins. Put the most specific entries first.
const CUSTOM_AVATARS: { match: string; src: string }[] = [
  { match: "jay_jay20020109", src: "/office-avatars/jay.png" },
  { match: "jay20020109", src: "/office-avatars/jay.png" },
];

// Agents whose name/urlKey contains one of these is MALE; everyone else FEMALE.
// (Per 四季 setup: Frank, 育銘, 坤源, 智偉, 忠泰 are male.)
const MALE_HINTS = ["frank", "育銘", "坤源", "智偉", "忠泰"];

const GENDER_IMAGE: Record<Gender, string> = {
  male: "/office-avatars/male.png",
  female: "/office-avatars/female.png",
};

function haystack(agent: { name?: string | null; urlKey?: string | null }): string {
  return `${agent.name ?? ""} ${agent.urlKey ?? ""}`.toLowerCase();
}

export function resolveGender(agent: { name?: string | null; urlKey?: string | null }): Gender {
  const h = haystack(agent);
  return MALE_HINTS.some((hint) => h.includes(hint.toLowerCase())) ? "male" : "female";
}

// Returns the ordered list of image srcs to try before falling back to DiceBear.
// The component tries each in order, advancing on load error.
export function resolveAvatarSources(agent: { name?: string | null; urlKey?: string | null }): string[] {
  const h = haystack(agent);
  const custom = CUSTOM_AVATARS.find((c) => h.includes(c.match.toLowerCase()));
  const sources: string[] = [];
  if (custom) sources.push(custom.src);
  sources.push(GENDER_IMAGE[resolveGender(agent)]);
  return sources;
}
