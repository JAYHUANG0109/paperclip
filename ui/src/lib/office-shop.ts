// Virtual Office shop — what the coins you earn can buy.
//
// Coins are minted 1:1 with XP (see server/src/services/office-progression.ts) and
// SPENT here; spending never changes XP/level/rank. Every item has a RARITY, a
// minimum LEVEL to unlock, and a coin PRICE — so rare/mythical characters are
// things you grow into and save up for, not pay-to-win.
//
// `kind: "species"` items are full character skins (incl. mythical creatures);
// `kind: "cosmetic"` items are accessories layered on top of any character.
// Emoji are placeholders until the illustrated art lands (same drop-in pipeline
// as the everyday critters).

export type Rarity = "common" | "rare" | "epic" | "legendary" | "mythic";

export const RARITY_META: Record<Rarity, { zh: string; en: string; color: string; order: number }> = {
  common: { zh: "一般", en: "Common", color: "#8A8C92", order: 0 },
  rare: { zh: "稀有", en: "Rare", color: "#3E7CC2", order: 1 },
  epic: { zh: "史詩", en: "Epic", color: "#8A5CD0", order: 2 },
  legendary: { zh: "傳說", en: "Legendary", color: "#D98A2B", order: 3 },
  mythic: { zh: "神話", en: "Mythic", color: "#C0405E", order: 4 },
};

export type ShopKind = "species" | "cosmetic";

export interface ShopItem {
  id: string;
  kind: ShopKind;
  emoji: string; // placeholder art until illustrated assets land
  zh: string;
  en: string;
  rarity: Rarity;
  /** Minimum level required to unlock for purchase. */
  unlockLevel: number;
  /** Coin price. 0 = free / default starter. */
  price: number;
}

export const SHOP_ITEMS: ShopItem[] = [
  // ── Everyday species — free, available from the start (Common) ──
  { id: "sp_cat", kind: "species", emoji: "🐱", zh: "貓", en: "Cat", rarity: "common", unlockLevel: 1, price: 0 },
  { id: "sp_dog", kind: "species", emoji: "🐶", zh: "狗", en: "Dog", rarity: "common", unlockLevel: 1, price: 0 },
  { id: "sp_bunny", kind: "species", emoji: "🐰", zh: "兔子", en: "Bunny", rarity: "common", unlockLevel: 1, price: 0 },
  { id: "sp_bear", kind: "species", emoji: "🐻", zh: "熊", en: "Bear", rarity: "common", unlockLevel: 1, price: 0 },
  { id: "sp_hamster", kind: "species", emoji: "🐹", zh: "倉鼠", en: "Hamster", rarity: "common", unlockLevel: 1, price: 0 },
  { id: "sp_fox", kind: "species", emoji: "🦊", zh: "狐狸", en: "Fox", rarity: "common", unlockLevel: 1, price: 0 },

  // ── Rare species — a small level + coin gate ──
  { id: "sp_panda", kind: "species", emoji: "🐼", zh: "貓熊", en: "Panda", rarity: "rare", unlockLevel: 2, price: 300 },
  { id: "sp_penguin", kind: "species", emoji: "🐧", zh: "企鵝", en: "Penguin", rarity: "rare", unlockLevel: 2, price: 300 },
  { id: "sp_frog", kind: "species", emoji: "🐸", zh: "青蛙", en: "Frog", rarity: "rare", unlockLevel: 3, price: 400 },
  { id: "sp_owl", kind: "species", emoji: "🦉", zh: "貓頭鷹", en: "Owl", rarity: "rare", unlockLevel: 3, price: 400 },

  // ── Epic species ──
  { id: "sp_redpanda", kind: "species", emoji: "🦝", zh: "小熊貓", en: "Red Panda", rarity: "epic", unlockLevel: 4, price: 900 },
  { id: "sp_ninetail", kind: "species", emoji: "🦊", zh: "九尾狐", en: "Nine-Tailed Fox", rarity: "epic", unlockLevel: 5, price: 1400 },

  // ── Legendary species ──
  { id: "sp_unicorn", kind: "species", emoji: "🦄", zh: "獨角獸", en: "Unicorn", rarity: "legendary", unlockLevel: 6, price: 2500 },
  { id: "sp_pegasus", kind: "species", emoji: "🐴", zh: "天馬", en: "Pegasus", rarity: "legendary", unlockLevel: 6, price: 2500 },
  { id: "sp_griffin", kind: "species", emoji: "🦅", zh: "獅鷲", en: "Griffin", rarity: "legendary", unlockLevel: 7, price: 3200 },

  // ── Mythic species — the top of the ladder ──
  { id: "sp_dragon_winged", kind: "species", emoji: "🐉", zh: "西方飛龍", en: "Winged Dragon", rarity: "mythic", unlockLevel: 8, price: 5000 },
  { id: "sp_loong", kind: "species", emoji: "🐲", zh: "中華神龍", en: "Loong (Chinese Dragon)", rarity: "mythic", unlockLevel: 9, price: 7000 },
  { id: "sp_phoenix", kind: "species", emoji: "🔥", zh: "鳳凰", en: "Phoenix", rarity: "mythic", unlockLevel: 10, price: 8000 },
  { id: "sp_qilin", kind: "species", emoji: "🦌", zh: "麒麟", en: "Qilin", rarity: "mythic", unlockLevel: 10, price: 8000 },

  // ── Cosmetics — layer on any character ──
  { id: "co_gradcap", kind: "cosmetic", emoji: "🎓", zh: "學士帽", en: "Grad Cap", rarity: "common", unlockLevel: 1, price: 100 },
  { id: "co_party", kind: "cosmetic", emoji: "🥳", zh: "派對帽", en: "Party Hat", rarity: "common", unlockLevel: 1, price: 120 },
  { id: "co_sunglasses", kind: "cosmetic", emoji: "🕶️", zh: "墨鏡", en: "Sunglasses", rarity: "common", unlockLevel: 1, price: 150 },
  { id: "co_bowtie", kind: "cosmetic", emoji: "🎀", zh: "領結", en: "Bow Tie", rarity: "rare", unlockLevel: 2, price: 200 },
  { id: "co_headphones", kind: "cosmetic", emoji: "🎧", zh: "耳機", en: "Headphones", rarity: "rare", unlockLevel: 2, price: 250 },
  { id: "co_halo", kind: "cosmetic", emoji: "😇", zh: "光環", en: "Halo", rarity: "epic", unlockLevel: 5, price: 1200 },
  { id: "co_crown", kind: "cosmetic", emoji: "👑", zh: "皇冠", en: "Crown", rarity: "legendary", unlockLevel: 6, price: 2000 },
  { id: "co_angelwings", kind: "cosmetic", emoji: "🪽", zh: "天使翼", en: "Angel Wings", rarity: "legendary", unlockLevel: 7, price: 2600 },
];

export type PurchaseCheck = { ok: true } | { ok: false; reason: "owned" | "level" | "coins"; need?: number };

/** Whether a user can buy an item right now, given their level, coins, and what they own. */
export function checkPurchase(
  item: ShopItem,
  ctx: { level: number; coins: number; owned: string[] },
): PurchaseCheck {
  if (ctx.owned.includes(item.id)) return { ok: false, reason: "owned" };
  if (item.price === 0) return { ok: true }; // free starter — always usable
  if (ctx.level < item.unlockLevel) return { ok: false, reason: "level", need: item.unlockLevel };
  if (ctx.coins < item.price) return { ok: false, reason: "coins", need: item.price - ctx.coins };
  return { ok: true };
}

export function itemsByRarity(): Record<Rarity, ShopItem[]> {
  const out = { common: [], rare: [], epic: [], legendary: [], mythic: [] } as Record<Rarity, ShopItem[]>;
  for (const it of SHOP_ITEMS) out[it.rarity].push(it);
  return out;
}
