// Compose the Virtual Office from the Donarg Office Tileset as a wide 3x3 九宮格.
// Transparent bg; big furniture (desks 1.6x, chairs 2x). Team rooms are WIDE and
// fill their cell with desks distributed across the room; decorative + single-agent
// rooms are drawn small so the team rooms get the space. Tight 1-tile gaps.
import { decode, make, blit, blitScaled, fillRect, encode } from "./pnglib.mjs";

const PACK = "/Users/jayhuang/dev/paperclip/paperclip/Office Tileset";
const A5 = decode(PACK + "/Office VX Ace/A5 Office Floors & Walls.png");
// Furniture is blitted from the 48×48 sheet (3× res of the 16×16) and scaled
// DOWN to the map — crisp, not the blurry upscaled 16×16.
const M = decode(PACK + "/Office Tileset All 48x48.png");
const T = 16;      // map/floor tile size
const TS = 48;     // furniture source tile size
const DESK_F = 1.76, CHAIR_F = 2.2, DEC_F = 1.87;  // 1.1× larger furniture (agents scaled to match)

const ROOM_FLOOR = { c: 8, r: 18 };
let map;
const tileAt = (t, tx, ty) => blit(map, A5, t.c*T, t.r*T, T, T, tx*T, ty*T);
// Furniture: source region is in 48×48 px; scale by f*T/TS so the on-map size is
// still f× a 16px tile (same footprint as before, but sourced from the crisp sheet).
const objS = (mc, mr, wc, hc, tx, ty, f = DEC_F) => blitScaled(map, M, mc*TS, mr*TS, wc*TS, hc*TS, tx*T, ty*T, f*T/TS);
// Blit an arbitrary 48×48-px region of the sheet (sub-tile items like the keyboard).
const objPx = (sx, sy, sw, sh, tx, ty, f) => blitScaled(map, M, sx, sy, sw, sh, Math.round(tx*T), Math.round(ty*T), f*T/TS);

const DESK   = { c: 1,  r: 0,  w: 3, h: 2 };
const CHAIR  = { c: 5,  r: 16, w: 1, h: 1 };  // office chair from behind (agent faces the desk)
const ARMCH  = { c: 0,  r: 16, w: 1, h: 1 };
const SOFA   = { c: 4,  r: 2,  w: 4, h: 2 };
const PLANT  = { c: 4,  r: 28, w: 1, h: 2 };  // tall fern
const POT    = { c: 2,  r: 28, w: 1, h: 2 };  // small potted plant (盆栽), brown pot
const COOLER = { c: 5,  r: 16, w: 1, h: 2 };
const FRIDGE = { c: 12, r: 16, w: 2, h: 2 };
const TABLE  = { c: 4,  r: 1,  w: 4, h: 2 };
const COUNTER= { c: 8,  r: 0,  w: 4, h: 2 };
// Keyboard = ONLY the keys. The full tile (c12,r23) bundles the monitor stand,
// so we blit just the keys pixel-strip (y 376..383 of the sheet) via objPx.
// Keyboard = just the keys strip, in 48×48-sheet px (3× the 16×16 coords).
const KEYBOARD_PX = { sx: 12*TS, sy: 376*3, sw: TS, sh: 21 };
const KB_F = 2.42;                              // keyboard scale (1.1×)
const GREY_DESK  = { c: 1,  r: 2,  w: 3 };  // Jay's grey desk
const WHITE_DESK = { c: 5,  r: 2,  w: 3 };  // founder's white table
// Decoration tiles (verified against the sheet).
const CLOCK      = { c: 0,  r: 22, w: 1, h: 1 };
const WATER      = { c: 9,  r: 16, w: 1, h: 2 };  // water cooler
const CUP        = { c: 8,  r: 17, w: 1, h: 1 };  // paper cup
const VENDING    = { c: 14, r: 16, w: 2, h: 3 };  // vending machine
const BOOKSH_W   = { c: 8,  r: 9,  w: 1, h: 2 };  // wood bookshelf w/ books
const BOOKSH_G   = { c: 13, r: 9,  w: 2, h: 2 };  // grey bookshelf w/ books
const CHALK      = { c: 0,  r: 26, w: 2, h: 2 };  // green chalkboard
const PRES_BAR   = { c: 2,  r: 26, w: 2, h: 2 };  // presentation (bar chart)
const PRES_PIE   = { c: 4,  r: 26, w: 2, h: 2 };  // presentation (pie chart)
const PAINT_BIG  = { c: 0,  r: 24, w: 2, h: 2 };  // big landscape painting
const PAINT_MED  = { c: 2,  r: 24, w: 2, h: 2 };  // lighthouse painting
const PAINT_SM   = { c: 4,  r: 24, w: 1, h: 2 };  // small painting
const PRINTER    = { c: 8,  r: 27, w: 2, h: 2 };  // printer
const BOXES      = { c: 8,  r: 28, w: 2, h: 2 };  // stacked boxes
const GREY_BENCH = { c: 0,  r: 20, w: 2, h: 2 };  // grey bench/table (meeting)

// wide grid, tight 1-tile gaps. Center column is wide for the big team rooms.
const COLX = [1, 22, 67], COLW = [20, 44, 16];
const ROWY = [1, 22, 43], ROWH = [20, 20, 12];
const MW = 84, MH = 56;   // 1344x896

const ROOMS = [
  { id:"meeting",  team:null,         name:"會議室",    cell:[0,0], dw:14, dh:14, kind:"meeting" },
  { id:"teaching", team:"教學組",     name:"教學組",    cell:[1,0], cap:8 },
  { id:"talent",   team:"人才發展",   name:"人才發展",  cell:[2,0], dw:13, dh:13, cap:1 },
  { id:"lead",     team:"領導團隊",   name:"領導團隊",  cell:[0,1], cap:4, deskCols:2 },
  { id:"it",       team:"資訊部",     name:"資訊部",    cell:[1,1], cap:7 },
  { id:"lounge",   team:null,         name:"休息室",    cell:[2,1], dw:13, dh:12, kind:"lounge" },
  { id:"pantry",   team:null,         name:"茶水間",    cell:[0,2], dw:14, dh:10, kind:"pantry" },
  { id:"founder",  team:null,         name:"創辦人辦公室", cell:[1,2], dw:26, dh:11, kind:"founder", soloAgent:"創辦人" },
  { id:"auto",     team:"系統自動化", name:"系統自動化",cell:[2,2], dw:12, dh:10, cap:1 },
];
for (const rm of ROOMS) {
  const [c, r] = rm.cell; const cw = COLW[c], ch = ROWH[r], cx = COLX[c], cy = ROWY[r];
  rm.w = rm.dw ?? cw; rm.h = rm.dh ?? ch;
  rm.x = cx + Math.floor((cw - rm.w) / 2); rm.y = cy + Math.floor((ch - rm.h) / 2);
}

map = make(MW*T, MH*T);
const seats = {};

function drawRoom(rm) {
  const { x, y, w, h } = rm;
  for (let ty = y+1; ty < y+h-1; ty++) for (let tx = x+1; tx < x+w-1; tx++) tileAt(ROOM_FLOOR, tx, ty);
  const W=[224,218,202,255], E=[56,52,46,255];
  fillRect(map, x*T, y*T, w*T, T, W); fillRect(map, x*T, (y+h-1)*T, w*T, T, W);
  fillRect(map, x*T, y*T, T, h*T, W); fillRect(map, (x+w-1)*T, y*T, T, h*T, W);
  fillRect(map, x*T, y*T, w*T, 2, E); fillRect(map, x*T, (y+h)*T-2, w*T, 2, E);
  fillRect(map, x*T, y*T, 2, h*T, E); fillRect(map, (x+w)*T-2, y*T, 2, h*T, E);
  fillRect(map, x*T, (y+1)*T-1, w*T, 1, E);
  const dX = x + Math.floor(w/2) - 1; tileAt(ROOM_FLOOR, dX, y+h-1); tileAt(ROOM_FLOOR, dX+1, y+h-1);
}

const seatPct = (tx, ty) => ({ x: +((tx)/MW*100).toFixed(2), y: +((ty)/MH*100).toFixed(2) });

function furnishTeam(rm) {
  const { x, y, w, h, cap, id } = rm;
  const dW = DESK.w*DESK_F, dH = DESK.h*DESK_F, cW = CHAIR.w*CHAIR_F, cH = CHAIR.h*CHAIR_F;
  const cols = rm.deskCols ?? Math.max(1, Math.min(cap, 4));
  const rows = Math.ceil(cap / cols);
  const usableW = w - 3, usableH = h - 3.5;
  const cellW = usableW / cols, cellH = usableH / rows;
  const list = []; let n = 0;
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, cap - r * cols);
    const off = (cols - inRow) / 2;             // center a short last row
    for (let c = 0; c < inRow; c++, n++) {
      const centerX = x + 1.5 + (c + off + 0.5) * cellW;
      const rowTop = y + 2 + r * cellH;
      const desk = (id === "it" && n === 0) ? GREY_DESK : DESK;   // Jay's grey desk
      objS(desk.c, desk.r, desk.w, DESK.h, centerX - dW/2, rowTop, DESK_F);
      // Keyboard on the desk surface, directly under the (DOM) monitor, set very
      // slightly in from the front edge (north).
      const kW = (KEYBOARD_PX.sw/TS)*KB_F;
      objPx(KEYBOARD_PX.sx, KEYBOARD_PX.sy, KEYBOARD_PX.sw, KEYBOARD_PX.sh, centerX - kW/2, rowTop + 0.45, KB_F);
      const chairX = centerX - cW/2, chairY = rowTop + dH;
      objS(CHAIR.c, CHAIR.r, CHAIR.w, CHAIR.h, chairX, chairY, CHAIR_F);
      list.push(seatPct(chairX + cW/2, chairY + cH/2));
    }
  }
  seats[id] = list;
  // ── Room decorations (kept in the wall margins so they don't hit the desks) ──
  objS(CLOCK.c, CLOCK.r, 1, 1, x + w - 2.4, y + 0.5, 1.3);                       // clock, top-right
  const big = w > 30;                                                            // 教學組 / 資訊部
  const pt = big ? PAINT_BIG : PAINT_SM; const pf = 0.9, pw = pt.w*pf;
  objS(pt.c, pt.r, pt.w, 2, x + w/2 - pw/2, y + 0.25, pf);                        // painting on the top wall
  objS(BOOKSH_W.c, BOOKSH_W.r, BOOKSH_W.w, BOOKSH_W.h, x + 1.3, y + h - 3.1, DEC_F); // bookshelf, bottom-left
  if (big) objS(BOXES.c, BOXES.r, BOXES.w, BOXES.h, x + w - 5, y + h - 3.3, DEC_F);  // boxes (教學組/資訊部)
  if (id === "teaching") objS(PRINTER.c, PRINTER.r, PRINTER.w, PRINTER.h, x + w - 9, y + h - 3.3, DEC_F); // printer
}
function furnishMeeting(rm) {
  const { x, y, w, h } = rm; const cx = x + w/2;
  // Chalkboard + presentation boards on the back wall, plus a clock.
  objS(CHALK.c, CHALK.r, CHALK.w, CHALK.h, x + 1.3, y + 0.4, 1.4);
  objS(PRES_BAR.c, PRES_BAR.r, PRES_BAR.w, PRES_BAR.h, x + w - 5.2, y + 0.5, 1.2);
  objS(CLOCK.c, CLOCK.r, 1, 1, x + w/2 - 0.5, y + 0.5, 1.3);
  // Grey conference bench with mauve armchairs around it (replaces old table/chairs).
  const tw = GREY_BENCH.w*DEC_F, tx = cx - tw/2, ty = y + h/2;
  objS(GREY_BENCH.c, GREY_BENCH.r, GREY_BENCH.w, GREY_BENCH.h, tx, ty);
  for (let i = 0; i < 2; i++) {
    objS(ARMCH.c, ARMCH.r, 1, 1, tx + 0.4 + i*2.4, ty - 2.4, CHAIR_F);
    objS(ARMCH.c, ARMCH.r, 1, 1, tx + 0.4 + i*2.4, ty + GREY_BENCH.h*DEC_F + 0.3, CHAIR_F);
  }
}
function furnishLounge(rm) {
  const { x, y, w, h } = rm; const cx = x + w/2;
  objS(SOFA.c, SOFA.r, SOFA.w, SOFA.h, cx - SOFA.w*DEC_F/2, y+2);
  objS(TABLE.c, TABLE.r, 2, 2, cx - 1.7, y+6);
  objS(CLOCK.c, CLOCK.r, 1, 1, x + w - 2.4, y + 0.5, 1.3);
}
function furnishPantry(rm) {
  const { x, y, w, h } = rm;
  objS(COUNTER.c, COUNTER.r, COUNTER.w, COUNTER.h, x+1.5, y+2);
  // Fridge pulled fully inside the wall (was clipping the right wall).
  objS(FRIDGE.c, FRIDGE.r, FRIDGE.w, FRIDGE.h, x+w-FRIDGE.w*DEC_F-1.2, y+2);
  // Water cooler (+cup) and vending machine along the bottom.
  objS(WATER.c, WATER.r, WATER.w, WATER.h, x+2, y+h-4.5, DEC_F);
  objS(CUP.c, CUP.r, 1, 1, x+2+WATER.w*DEC_F+0.1, y+h-3, 1.3);
  objS(VENDING.c, VENDING.r, VENDING.w, VENDING.h, x+w-VENDING.w*1.5-1.2, y+h-VENDING.h*1.5-0.8, 1.5);
  objS(CLOCK.c, CLOCK.r, 1, 1, x + w/2 - 0.5, y + 0.5, 1.3);
}
function furnishFounder(rm) {
  const { x, y, w, h, id } = rm;
  const cx = x + w/2;
  const df = DEC_F;
  const dW = WHITE_DESK.w*df, dH = 2*df, cW = CHAIR.w*CHAIR_F, cH = CHAIR.h*CHAIR_F;
  // The chair/seat (and thus the DOM monitor, at seat − 0.9*AGENT_SIZE) stay put.
  // The white desk + keyboard + plants sit just under the monitor.
  const seatRow = y + Math.max(2, h*0.30);
  const deskTop = seatRow - 1.2;
  objS(WHITE_DESK.c, WHITE_DESK.r, WHITE_DESK.w, 2, cx - dW/2, deskTop, df);   // white table
  const kW = (KEYBOARD_PX.sw/TS)*KB_F;
  objPx(KEYBOARD_PX.sx, KEYBOARD_PX.sy, KEYBOARD_PX.sw, KEYBOARD_PX.sh, cx - kW/2, deskTop + 1.55, KB_F);
  objS(POT.c, POT.r, 1, 2, cx + dW/2 + 0.5, deskTop + 0.9, 1.8);      // 盆栽 to the right
  objS(PLANT.c, PLANT.r, 1, 2, cx - dW/2 - 2.1, deskTop + 0.7, 1.6);  // fern to the left
  const chairX = cx - cW/2, chairY = seatRow + dH - 0.8;             // chair a touch north
  objS(CHAIR.c, CHAIR.r, 1, 1, chairX, chairY, CHAIR_F);
  seats[id] = [seatPct(chairX + cW/2, chairY + cH/2)];
  // Landscape paintings across the back wall + a clock.
  objS(PAINT_BIG.c, PAINT_BIG.r, PAINT_BIG.w, PAINT_BIG.h, cx - PAINT_BIG.w*0.75/2, y + 0.2, 0.75);
  objS(PAINT_MED.c, PAINT_MED.r, PAINT_MED.w, PAINT_MED.h, x + 3, y + 0.25, 0.7);
  objS(PAINT_SM.c, PAINT_SM.r, PAINT_SM.w, PAINT_SM.h, x + w - 4.5, y + 0.25, 0.8);
  objS(CLOCK.c, CLOCK.r, 1, 1, x + 1.4, y + 0.5, 1.3);
}

for (const rm of ROOMS) drawRoom(rm);
for (const rm of ROOMS) {
  if (rm.kind === "meeting") furnishMeeting(rm);
  else if (rm.kind === "lounge") furnishLounge(rm);
  else if (rm.kind === "pantry") furnishPantry(rm);
  else if (rm.kind === "founder") furnishFounder(rm);
  else furnishTeam(rm);
}

encode(map, "preview/office-square.png");

const COLORS = { meeting:"#10B981", lounge:"#EC4899", pantry:"#14B8A6", founder:"#A855F7", auto:"#F97316", teaching:"#8B5CF6", lead:"#F59E0B", talent:"#6366F1", it:"#3B82F6" };
const pct = (v, tot) => +(v / tot * 100).toFixed(1);
console.log(`Map ${MW*T}x${MH*T}. Zones:\n`);
for (const rm of ROOMS) {
  const team = rm.team ? `"${rm.team}"` : "null";
  const s = seats[rm.id] ? JSON.stringify(seats[rm.id]) : "undefined";
  const solo = rm.soloAgent ? `, soloAgent: "${rm.soloAgent}"` : "";
  console.log(`      { id: "${rm.id}", name: "${rm.name}", team: ${team}, x: ${pct(rm.x,MW)}, y: ${pct(rm.y,MH)}, w: ${pct(rm.w,MW)}, h: ${pct(rm.h,MH)}, color: "${COLORS[rm.id]}"${solo}, seats: ${s} },`);
}
