# Virtual Office — character art brief

Spec for the cute-animal avatar set used in the Virtual Office. Written so it can
be (a) generated with an AI image tool now, and (b) handed to a commissioned
illustrator later for a polished pass. The catalog this fills is defined in
`ui/src/lib/office-characters.ts`.

## Art direction

- **Vibe:** cute but not childish; calm, friendly, "cozy minimalist office".
- **Style:** soft flat illustration with gentle shading — clean rounded shapes,
  minimal linework, no harsh outlines. Reads clearly at **28px** (desk size) and
  up to 96px (profile). Think simple, modern sticker mascots.
- **Palette restraint:** the office room is white/near-white, so characters carry
  the color. Keep each character to a few muted, harmonious tones — **no neon**.
- **Background:** fully **transparent** PNG. No shadows baked in (the app adds a
  soft contact shadow under the feet).
- **Framing:** full body, head-to-feet, centered, facing 3/4 front-left. Consistent
  proportions and "camera" across every species so they sit together in one room.

## Roster — 10 species × 5 palettes

Species (match the ids in `office-characters.ts`): `cat, fox, dog, bunny, bear,
panda, hamster, penguin, frog, owl`.

Palettes (per species): `classic, snow, charcoal, ginger, mocha`. A palette is a
recolor of the same character (fur/skin tone), not a different animal.

> Start small: generate **all 10 species in `classic` first** (10 images × 3 states
> = the minimum viable set), then add palettes for the favorites. 50 looks total
> at full coverage, before any cosmetics.

## Required states (per species + palette)

Three poses, same character, same scale/registration so they swap cleanly:

| State | File | Use |
|---|---|---|
| `idle` | `idle.png` | standing, relaxed — used while wandering / at rest |
| `walk` | `walk.png` | mid-step (one foot forward) — used while moving |
| `sit`  | `sit.png`  | seated, facing a desk, "typing" — used while the agent is working |

Keep the head and body center-aligned across all three so the app can cross-fade
without the character jumping.

## File output

- Format: **PNG, transparent**, square canvas, **512×512**, character centered with
  ~8% padding. (App downscales; 512 keeps profile views crisp.)
- Cosmetics (later): separate transparent overlays aligned to the same 512 canvas
  (e.g. a hat positioned over the head), so they layer on any species.
- Naming / location (drop-in, no code change needed):
  ```
  ui/public/office-characters/<species>/<palette>/idle.png
  ui/public/office-characters/<species>/<palette>/walk.png
  ui/public/office-characters/<species>/<palette>/sit.png
  ```
  Example: `ui/public/office-characters/fox/classic/sit.png`

## AI prompt template

Generate one species at a time, three states, on a transparent background:

> "A cute minimalist flat-illustration **{animal}** office mascot, soft rounded
> shapes, gentle shading, muted {palette} color tones, no harsh outlines, full
> body facing 3/4 front-left, centered, **transparent background**, sticker style,
> clean and modern. Three versions of the SAME character, identical proportions
> and scale: (1) standing relaxed, (2) mid-step walking, (3) sitting at a desk
> typing on a laptop. Reads clearly when small."

Tips for consistency: lock a seed/style reference from the first good `cat`, then
reuse it as a style anchor for the other nine so the cast feels like one set.

## Acceptance checklist

- [ ] All 10 species render legibly at 28px and 96px.
- [ ] `idle` / `walk` / `sit` of the same character are registration-aligned.
- [ ] Transparent background, no baked shadow, square 512×512.
- [ ] Palette is muted and harmonious with a white room.
- [ ] Files named/placed per the convention above.
