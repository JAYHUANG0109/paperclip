// Compose the Virtual Office from the Donarg Office Tileset as a wide 3x3 九宮格.
// Transparent bg; big furniture (desks 1.6x, chairs 2x). Team rooms are WIDE and
// fill their cell with desks distributed across the room; decorative + single-agent
// rooms are drawn small so the team rooms get the space. Tight 1-tile gaps.
import { decode, make, blit, blitScaled, fillRect, encode } from "./pnglib.mjs";

const PACK = "/Users/jayhuang/dev/paperclip/paperclip/Office Tileset";
const A5 = decode(PACK + "/Office VX Ace/A5 Office Floors & Walls.png");
const M = decode(PACK + "/Office Tileset All 16x16.png");
const T = 16;
const DESK_F = 1.6, CHAIR_F = 2.0, DEC_F = 1.7;

const ROOM_FLOOR = { c: 8, r: 18 };
let map;
const tileAt = (t, tx, ty) => blit(map, A5, t.c*T, t.r*T, T, T, tx*T, ty*T);
const objS = (mc, mr, wc, hc, tx, ty, f = DEC_F) => blitScaled(map, M, mc*T, mr*T, wc*T, hc*T, tx*T, ty*T, f);
// Blit an arbitrary pixel region of the sheet (for sub-tile items like the keyboard).
const objPx = (sx, sy, sw, sh, tx, ty, f) => blitScaled(map, M, sx, sy, sw, sh, Math.round(tx*T), Math.round(ty*T), f);

const DESK   = { c: 1,  r: 0,  w: 3, h: 2 };
const CHAIR  = { c: 4,  r: 16, w: 1, h: 1 };
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
const KEYBOARD_PX = { sx: 12*T, sy: 376, sw: T, sh: 7 };
const KB_F = 2.2;                               // keyboard scale
// Preview WHITE desk (same shape/size as DESK). Applied to ONE agent's desk for
// review before rolling the white look out to everyone.
const WHITE_DESK = { c: 5, r: 2, w: 3 };

// wide grid, tight 1-tile gaps. Center column is wide for the big team rooms.
const COLX = [1, 22, 67], COLW = [20, 44, 16];
const ROWY = [1, 22, 43], ROWH = [20, 20, 12];
const MW = 84, MH = 56;   // 1344x896 — wider left column, middle shifted right

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
      objS(DESK.c, DESK.r, DESK.w, DESK.h, centerX - dW/2, rowTop, DESK_F);
      // Keyboard on the desk surface, directly under the (DOM) monitor, set very
      // slightly in from the front edge (north).
      const kW = (KEYBOARD_PX.sw/T)*KB_F;
      objPx(KEYBOARD_PX.sx, KEYBOARD_PX.sy, KEYBOARD_PX.sw, KEYBOARD_PX.sh, centerX - kW/2, rowTop + 0.55, KB_F);
      const chairX = centerX - cW/2, chairY = rowTop + dH;
      objS(CHAIR.c, CHAIR.r, CHAIR.w, CHAIR.h, chairX, chairY, CHAIR_F);
      list.push(seatPct(chairX + cW/2, chairY + cH/2));
    }
  }
  seats[id] = list;
}
function furnishMeeting(rm) {
  const { x, y, w, h } = rm;
  const tw = TABLE.w, tx = x + (w - tw*DEC_F)/2, ty = y + h/2 - 1.5;
  objS(TABLE.c, TABLE.r, tw, TABLE.h, tx, ty);
  for (let i = 0; i < 3; i++) { objS(CHAIR.c, CHAIR.r, 1, 1, tx + i*2.2, ty - 2, CHAIR_F); objS(CHAIR.c, CHAIR.r, 1, 1, tx + i*2.2, ty + TABLE.h*DEC_F + 0.3, CHAIR_F); }
}
function furnishLounge(rm) {
  const { x, y, w, h } = rm; const cx = x + w/2;
  objS(SOFA.c, SOFA.r, SOFA.w, SOFA.h, cx - SOFA.w*DEC_F/2, y+2);
  objS(TABLE.c, TABLE.r, 2, 2, cx - 1.7, y+6);
}
function furnishPantry(rm) {
  const { x, y, w, h } = rm;
  objS(COUNTER.c, COUNTER.r, COUNTER.w, COUNTER.h, x+2, y+2);
  objS(FRIDGE.c, FRIDGE.r, FRIDGE.w, FRIDGE.h, x+w-5, y+2);
  objS(COOLER.c, COOLER.r, 1, 2, x+2, y+h-5);
}
function furnishFounder(rm) {
  const { x, y, w, h, id } = rm;
  // Founder desk = the wooden 茶水間 counter, same size (COUNTER @ DEC_F).
  // Centred and toward the top (north) of the room; the status monitor is a DOM
  // overlay drawn on top by the app, with the keyboard on the desk below it.
  const cx = x + w/2;
  const df = DEC_F;                              // matches the 茶水間 table scale
  const dW = COUNTER.w*df, dH = COUNTER.h*df, cW = CHAIR.w*CHAIR_F, cH = CHAIR.h*CHAIR_F;
  // The chair/seat (and thus the DOM monitor, at seat − 0.9*AGENT_SIZE) stay put —
  // that monitor height looks good. The desk + keyboard + plants are raised toward
  // the monitor so the workstation reads as one unit under the screen.
  const seatRow = y + Math.max(2, h*0.30);
  const deskTop = seatRow - 1.6;
  objS(COUNTER.c, COUNTER.r, COUNTER.w, COUNTER.h, cx - dW/2, deskTop, df);
  const kW = (KEYBOARD_PX.sw/T)*KB_F;
  objPx(KEYBOARD_PX.sx, KEYBOARD_PX.sy, KEYBOARD_PX.sw, KEYBOARD_PX.sh, cx - kW/2, deskTop + 1.9, KB_F);
  objS(POT.c, POT.r, 1, 2, cx + dW/2 + 0.5, deskTop + 0.9, 1.6);      // 盆栽 to the right
  objS(PLANT.c, PLANT.r, 1, 2, cx - dW/2 - 1.9, deskTop + 0.7, 1.4);  // fern to the left
  const chairX = cx - cW/2, chairY = seatRow + dH;
  objS(CHAIR.c, CHAIR.r, 1, 1, chairX, chairY, CHAIR_F);
  seats[id] = [seatPct(chairX + cW/2, chairY + cH/2)];
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
