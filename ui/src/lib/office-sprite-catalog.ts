// Virtual Office CHARACTER CATALOG — the shared roster a user can pick from for
// their agent's on-floor look.
//
// Unlike the per-agent PixelLab sprites (/assets/agent-sprites/<agentId>/…, one
// bespoke set per agent), the catalog is a FIXED library of reusable characters:
// two default people (male / female) plus animals and style variants. A user
// picks one; their choice is stored on the agent as `metadata.officeCharacterId`.
//
// Art: each entry maps to /assets/office-characters/<id>/<direction>.png (8-way
// directional sprites, same shape as the agent-sprite manifest, so the office can
// make the character WALK). Generate them with scripts/generate-office-characters.mjs
// (PixelLab) or drop your own PNGs in. Until an entry's art exists, the picker and
// the floor fall back to the entry's `emoji`, so the whole flow works before any
// art is generated.

export type CharacterGroup = "people" | "animals";

export interface CatalogCharacter {
  /** slug — folder name under /assets/office-characters/<id>/ and the stored id */
  id: string;
  zh: string;
  en: string;
  group: CharacterGroup;
  /** Preview + on-floor fallback until the directional PNGs are generated. */
  emoji: string;
  /** For the two defaults, which gender they stand in for (auto-assigned). */
  gender?: "male" | "female";
  /** The prompt used to generate this character (kept here so art + catalog never drift). */
  prompt: string;
}

// Base pixel-art prompt suffix shared by every entry — matches the PixelLab v3
// "Low Top-Down" office look. Keep in sync with generate-office-characters.mjs.
export const PROMPT_SUFFIX =
  "full body, standing, facing forward, cute chibi proportions, clean simple flat colors, soft shading, single black outline, retro game sprite, transparent background";

/**
 * Starter catalog: 2 people (defaults) + 12 animals = 14 looks. Expandable — add
 * a row here + generate/drop its art folder, and the picker, floor, and storage
 * all pick it up automatically. Aim for 30-50 by adding palette/style variants
 * (e.g. "cat-ginger", "cat-tuxedo") as separate rows.
 */
export const CATALOG: CatalogCharacter[] = [
  // ── Default people (matched pair: both white button-down + grey trousers) ──
  { id: "male", gender: "male", group: "people", emoji: "👨‍💼", zh: "男生（預設）", en: "Male (default)",
    prompt: "a man office worker with short dark hair, wearing a white button-down shirt with a tie and grey trousers, full body, head to toe, standing," },
  { id: "female", gender: "female", group: "people", emoji: "👩‍💼", zh: "女生（預設）", en: "Female (default)",
    prompt: "a woman office worker with long dark hair, wearing a white button-down shirt and grey trousers, full body, head to toe, standing," },

  // ── Animals (anthropomorphic office workers, suit-and-tie chibi) ───────────
  { id: "cat", group: "animals", emoji: "🐱", zh: "貓", en: "Cat",
    prompt: "an anthropomorphic orange tabby cat office worker, wearing a grey business suit, standing on two legs," },
  { id: "fox", group: "animals", emoji: "🦊", zh: "狐狸", en: "Fox",
    prompt: "an anthropomorphic orange fox office worker, wearing a brown blazer, standing on two legs," },
  { id: "dog", group: "animals", emoji: "🐶", zh: "狗", en: "Dog",
    prompt: "an anthropomorphic golden dog office worker, wearing a blue shirt and tie, standing on two legs," },
  { id: "bunny", group: "animals", emoji: "🐰", zh: "兔子", en: "Bunny",
    prompt: "an anthropomorphic white bunny office worker, wearing a pink cardigan, standing on two legs," },
  { id: "bear", group: "animals", emoji: "🐻", zh: "熊", en: "Bear",
    prompt: "an anthropomorphic brown bear office worker, wearing a dark suit, standing on two legs," },
  { id: "panda", group: "animals", emoji: "🐼", zh: "貓熊", en: "Panda",
    prompt: "an anthropomorphic panda office worker, wearing a green vest, standing on two legs," },
  { id: "hamster", group: "animals", emoji: "🐹", zh: "倉鼠", en: "Hamster",
    prompt: "an anthropomorphic tan hamster office worker, wearing a yellow sweater, standing on two legs," },
  { id: "penguin", group: "animals", emoji: "🐧", zh: "企鵝", en: "Penguin",
    prompt: "an anthropomorphic penguin office worker, wearing a red bow tie, standing on two legs," },
  { id: "frog", group: "animals", emoji: "🐸", zh: "青蛙", en: "Frog",
    prompt: "an anthropomorphic green frog office worker, wearing a purple shirt, standing on two legs," },
  { id: "owl", group: "animals", emoji: "🦉", zh: "貓頭鷹", en: "Owl",
    prompt: "an anthropomorphic brown owl office worker, wearing round glasses and a teal vest, standing on two legs," },
  { id: "penguin-chef", group: "animals", emoji: "🐧", zh: "企鵝主廚", en: "Penguin Chef",
    prompt: "an anthropomorphic penguin wearing a white chef hat and apron, standing on two legs," },
  { id: "shiba", group: "animals", emoji: "🐕", zh: "柴犬", en: "Shiba",
    prompt: "an anthropomorphic shiba inu dog office worker, wearing a beige coat, standing on two legs," },
];

export const CATALOG_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

/** Directional sprite set for a catalog id, loaded from the catalog manifest. */
export type SpriteSet = Partial<Record<
  "south" | "south-east" | "east" | "north-east" | "north" | "north-west" | "west" | "south-west",
  string
>>;
// Each catalog entry has the 8 static rotations plus an optional `walk` set of
// per-direction animated GIFs, played while the agent is moving.
// walkScale (= walk-gif canvas / static-png canvas) tells the app how much bigger
// to render the walk GIF so the moving character matches the static sprite size.
export type CatalogManifest = Record<string, SpriteSet & { name?: string; walk?: SpriteSet; walkScale?: number }>;

/** Public URL of the catalog manifest the office fetches at runtime. */
export const CATALOG_MANIFEST_URL = "/assets/office-characters/manifest.json";

// Bump when the sprite PNGs are regenerated — the filenames stay the same, so
// without this the browser serves stale cached images. Appended as ?v= to every
// sprite URL so a redeploy always shows the latest art.
export const ART_VERSION = "12";

/** Append the art-version cache-buster to a sprite URL. */
export function bustCache(url: string): string {
  if (!url) return url;
  return url.includes("?") ? url : `${url}?v=${ART_VERSION}`;
}

/**
 * The catalog character id to show for an agent: their explicit choice if set,
 * otherwise the gender-default ("male"/"female") so seeded agents get sensible
 * art without anyone picking. Returns null only if the agent opted out.
 */
export function resolveAgentCharacterId(
  agent: { name?: string | null; urlKey?: string | null; metadata?: Record<string, unknown> | null },
  fallbackGender: "male" | "female",
): string {
  const chosen = agent.metadata?.officeCharacterId;
  if (typeof chosen === "string" && CATALOG_BY_ID.has(chosen)) return chosen;
  return fallbackGender;
}
