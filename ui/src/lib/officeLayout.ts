// Procedural per-agent workstation layout for the Virtual Office.
//
// Historically the desks/keyboards/chairs were baked into a static PNG with a
// fixed seat count per room, so adding agents left them standing with no desk.
// Now the background is a BARE room shell ("Office Square Bare.png") and every
// agent gets a computed workstation here — one desk+computer+keyboard+chair per
// agent — laid out in a grid that fills the room and shrinks as the headcount
// grows, so furniture always matches the number of agents.
//
// All furniture is sized in NATIVE MAP PIXELS (same units as AGENT_SIZE), so it
// scales with the office zoom exactly like the avatars. Positions are returned
// as percentages of the map so they slot into the existing `left: x%` / `top: y%`
// rendering used for monitors + avatars.

export interface OfficeZoneRect {
  x: number; y: number; w: number; h: number; // percentages of the map
}

export interface Workstation {
  x: number;      // seat centre X, % of map width
  y: number;      // seat centre Y, % of map height
  scale: number;  // furniture/avatar scale for this room (1 = nominal)
}

// Nominal furniture footprints in native map px (mirrors generate-office.mjs:
// desk 3×2 tiles ×1.76, chair 1×1.2 tiles ×2.2, keyboard 78×14 px ×1.6·16/48).
export const FURN = {
  deskW: 84.5, deskH: 56.3,
  chairW: 35.2, chairH: 42.2,
  kbW: 41.6, kbH: 7.5,
};

// A workstation's footprint (desk stacked above chair) used to size grid cells.
const WS_W = FURN.deskW + 8;              // desk + a little side breathing room
const WS_H = FURN.deskH + FURN.chairH * 0.7 + 20; // desk + chair + avatar headroom

/**
 * Lay out `count` workstations inside `zone`. Returns one seat (with a shared
 * per-room `scale`) per agent, in map %. The grid fills the room; when agents
 * exceed the comfortable capacity the cells (and thus furniture) shrink so
 * everyone still gets a desk.
 */
export function computeWorkstations(
  zone: OfficeZoneRect,
  count: number,
  mapW: number,
  mapH: number,
): Workstation[] {
  if (count <= 0) return [];

  // Zone → native px.
  const zx = (zone.x / 100) * mapW, zy = (zone.y / 100) * mapH;
  const zw = (zone.w / 100) * mapW, zh = (zone.h / 100) * mapH;

  // Usable interior: inset from walls; leave extra headroom at the top for the
  // wall clock/painting and a little at the bottom for the door gap.
  const padX = 14, padTop = 40, padBottom = 16;
  const ux = zx + padX, uy = zy + padTop;
  const uw = Math.max(WS_W, zw - padX * 2), uh = Math.max(WS_H, zh - padTop - padBottom);

  // Pick a column count whose grid aspect ≈ the room's, so cells stay desk-shaped.
  const roomAspect = uw / uh;
  const wsAspect = WS_W / WS_H;
  let cols = Math.round(Math.sqrt((count * roomAspect) / wsAspect));
  cols = Math.max(1, Math.min(count, cols));
  let rows = Math.ceil(count / cols);
  // Guard: if the last row would be wildly short, prefer fewer columns.
  while (cols > 1 && Math.ceil(count / (cols - 1)) === rows) cols--;
  rows = Math.ceil(count / cols);

  const cellW = uw / cols, cellH = uh / rows;
  // Scale furniture to the cell (never upscale past ~1.1 so sparse rooms don't get
  // cartoonishly huge desks; shrink freely so crowded rooms fit).
  const scale = Math.min(1.1, (cellW * 0.94) / WS_W, (cellH * 0.94) / WS_H);

  const deskH = FURN.deskH * scale, chairH = FURN.chairH * scale;
  const out: Workstation[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const inRow = Math.min(cols, count - r * cols);
    const off = (cols - inRow) / 2;           // centre a short last row
    const c = i - r * cols;
    const cellCx = ux + (c + off + 0.5) * cellW;
    const cellTop = uy + r * cellH;
    // Vertically centre the desk+chair stack in its cell, then the seat sits at
    // the chair centre (below the desk).
    const stackH = deskH + chairH;
    const deskTop = cellTop + Math.max(0, (cellH - stackH) / 2);
    const seatY = deskTop + deskH + chairH * 0.35;
    out.push({
      x: +((cellCx / mapW) * 100).toFixed(3),
      y: +((seatY / mapH) * 100).toFixed(3),
      scale: +scale.toFixed(3),
    });
  }
  return out;
}
