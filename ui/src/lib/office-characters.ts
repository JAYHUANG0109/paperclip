// Virtual Office character catalog — the cute-animal roster a user can pick from.
//
// A character is layered: a base SPECIES + a PALETTE variant, with cosmetic
// overlays (hats/accessories from the shop) stacked on top. The user's choice is
// stored on their agent/user metadata as an {@link OfficeCharacter}.
//
// Art is added later without touching this file's consumers: each species will
// map to /office-characters/<species>/<palette>/{idle,walk,sit}.png once the
// illustrated sprites land. Until then the picker renders `emoji` as a stand-in,
// so the whole identity flow can be built and tested before art exists.

export type CharacterStateKey = "idle" | "walk" | "sit";

export interface CharacterSpecies {
  id: string;
  emoji: string; // placeholder until illustrated art lands
  zh: string;
  en: string;
}

export interface PaletteVariant {
  id: string;
  zh: string;
  en: string;
  /** Tint hint for the picker chip (= fur). */
  swatch: string;
  /** Recolor set the SVG critter uses: main fur, darker shade, light belly, outline. */
  fur: string;
  shade: string;
  belly: string;
  /** Unifying silhouette stroke — a deeper tone of the fur for an illustrated look. */
  outline: string;
}

/**
 * 10 starter species. Expandable — add a row here + an art folder, and the
 * picker, scene, and storage all pick it up automatically.
 */
export const CHARACTER_SPECIES: CharacterSpecies[] = [
  { id: "cat", emoji: "🐱", zh: "貓", en: "Cat" },
  { id: "fox", emoji: "🦊", zh: "狐狸", en: "Fox" },
  { id: "dog", emoji: "🐶", zh: "狗", en: "Dog" },
  { id: "bunny", emoji: "🐰", zh: "兔子", en: "Bunny" },
  { id: "bear", emoji: "🐻", zh: "熊", en: "Bear" },
  { id: "panda", emoji: "🐼", zh: "貓熊", en: "Panda" },
  { id: "hamster", emoji: "🐹", zh: "倉鼠", en: "Hamster" },
  { id: "penguin", emoji: "🐧", zh: "企鵝", en: "Penguin" },
  { id: "frog", emoji: "🐸", zh: "青蛙", en: "Frog" },
  { id: "owl", emoji: "🦉", zh: "貓頭鷹", en: "Owl" },
];

/** 5 palette variants per species → 50 base looks before any cosmetics. */
export const PALETTE_VARIANTS: PaletteVariant[] = [
  { id: "classic", zh: "原色", en: "Classic", swatch: "#D8B084", fur: "#D8B084", shade: "#B98E5E", belly: "#F6EAD8", outline: "#5E4630" },
  { id: "snow", zh: "雪白", en: "Snow", swatch: "#EFEBE2", fur: "#F1EDE5", shade: "#D6CFC1", belly: "#FFFFFF", outline: "#8B8275" },
  { id: "charcoal", zh: "墨灰", en: "Charcoal", swatch: "#7C818B", fur: "#838893", shade: "#5E636B", belly: "#DADDE2", outline: "#2C2E33" },
  { id: "ginger", zh: "薑橘", en: "Ginger", swatch: "#EC9F58", fur: "#EFA15A", shade: "#CE7836", belly: "#FBEAD2", outline: "#7A3F15" },
  { id: "mocha", zh: "摩卡", en: "Mocha", swatch: "#9C7A59", fur: "#9C7A59", shade: "#74583E", belly: "#D6B997", outline: "#38291B" },
];

export function paletteById(id: string | null | undefined): PaletteVariant {
  return PALETTE_VARIANTS.find((p) => p.id === id) ?? PALETTE_VARIANTS[0]!;
}

export interface OfficeCharacter {
  /** CharacterSpecies.id */
  species: string;
  /** PaletteVariant.id */
  palette: string;
  /** Equipped shop item ids, layered on top (empty until the shop ships). */
  cosmetics: string[];
}

export const DEFAULT_CHARACTER: OfficeCharacter = { species: "cat", palette: "classic", cosmetics: [] };

/** Total base looks (species × palettes), for display copy like "50 looks". */
export const BASE_LOOK_COUNT = CHARACTER_SPECIES.length * PALETTE_VARIANTS.length;

export function speciesById(id: string | null | undefined): CharacterSpecies | undefined {
  return CHARACTER_SPECIES.find((s) => s.id === id);
}

/** Resolve a stored character (or the default) to its sprite path for a state. */
export function characterSpritePath(character: OfficeCharacter, state: CharacterStateKey): string {
  return `/office-characters/${character.species}/${character.palette}/${state}.png`;
}

/** Species that have hand-drawn SVG art today (others fall back to emoji). */
export const DRAWN_SPECIES = ["cat", "fox", "dog", "bunny", "bear", "hamster"] as const;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The character to show for an agent: their saved choice if they've picked one
 * (metadata.officeCharacter), otherwise a stable, well-distributed default
 * derived from the agent id — so everyone has a distinct cute critter before the
 * picker ships, and it never changes underfoot.
 */
export function resolveAgentCharacter(agent: {
  id: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}): OfficeCharacter {
  const saved = agent.metadata?.officeCharacter as Partial<OfficeCharacter> | undefined;
  if (saved && typeof saved.species === "string" && typeof saved.palette === "string") {
    return { species: saved.species, palette: saved.palette, cosmetics: Array.isArray(saved.cosmetics) ? saved.cosmetics : [] };
  }
  const h = hashString(agent.id || agent.name || "critter");
  const species = DRAWN_SPECIES[h % DRAWN_SPECIES.length]!;
  const palette = PALETTE_VARIANTS[Math.floor(h / 7) % PALETTE_VARIANTS.length]!.id;
  return { species, palette, cosmetics: [] };
}
