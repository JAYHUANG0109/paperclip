// Compose the Virtual Office from the Donarg Office Tileset as a wide 3x3 九宮格.
// Transparent background; big furniture (desks 1.6x, chairs 2x); team rooms fill
// their cells, decorative rooms nearly fill theirs → little wasted space.
import { decode, make, blit, blitScaled, fillRect, encode } from "./pnglib.mjs";

const PACK = "/Users/jayhuang/dev/paperclip/paperclip/Office Tileset";
const A5 = decode(PACK + "/Office VX Ace/A5 Office Floors & Walls.png");
const M = decode(PACK + "/Office Tileset All 16x16.png");
const T = 16;
const DESK_F = 1.6, CHAIR_F = 2.0, DEC_F = 1.7;   // furniture scales

const ROOM_FLOOR = { c: 8, r: 18 };
let map;
const tileAt = (t, tx, ty) => blit(map, A5, t.c*T, t.r*T, T, T, tx*T, ty*T);
const objS = (mc, mr, wc, hc, tx, ty, f = DEC_F) => blitScaled(map, M, mc*T, mr*T, wc*T, hc*T, tx*T, ty*T, f);

const DESK   = { c: 1,  r: 0,  w: 3, h: 2 };
const CHAIR  = { c: 4,  r: 16, w: 1, h: 1 };
const ARMCH  = { c: 0,  r: 16, w: 1, h: 1 };
const SOFA   = { c: 4,  r: 2,  w: 4, h: 2 };
const PLANT  = { c: 4,  r: 28, w: 1, h: 2 };
const COOLER = { c: 5,  r: 16, w: 1, h: 2 };
const FRIDGE = { c: 12, r: 16, w: 2, h: 2 };
const TABLE  = { c: 4,  r: 1,  w: 4, h: 2 };
const COUNTER= { c: 8,  r: 0,  w: 4, h: 2 };

// wide grid (fills a wide viewport). center column widest (big team rooms).
const COLX = [1, 22, 57], COLW = [20, 34, 20];
const ROWY = [1, 21, 41], ROWH = [19, 19, 13];
const MW = 78, MH = 55;   // 1248x880 (~1.42:1)

const ROOMS = [
  { id:"meeting",  team:null,         name:"會議室",    cell:[0,0], dw:19, dh:17, kind:"meeting" },
  { id:"teaching", team:"教學組",     name:"教學組",    cell:[1,0], cap:8 },
  { id:"talent",   team:"人才發展",   name:"人才發展",  cell:[2,0], dw:16, dh:16, cap:1 },
  { id:"lead",     team:"領導團隊",   name:"領導團隊",  cell:[0,1], cap:4 },
  { id:"it",       team:"資訊部",     name:"資訊部",    cell:[1,1], cap:7 },
  { id:"lounge",   team:null,         name:"休息室",    cell:[2,1], dw:16, dh:16, kind:"lounge" },
  { id:"pantry",   team:null,         name:"茶水間",    cell:[0,2], dw:17, dh:12, kind:"pantry" },
  { id:"reception",team:null,         name:"接待處",    cell:[1,2], dw:28, dh:12, kind:"reception" },
  { id:"auto",     team:"系統自動化", name:"系統自動化",cell:[2,2], dw:15, dh:12, cap:1 },
];
for (const rm of ROOMS) {
  const [c, r] = rm.cell; const cw = COLW[c], ch = ROWH[r], cx = COLX[c], cy = ROWY[r];
  rm.w = rm.dw ?? cw; rm.h = rm.dh ?? ch;
  rm.x = cx + Math.floor((cw - rm.w) / 2); rm.y = cy + Math.floor((ch - rm.h) / 2);
}

map = make(MW*T, MH*T);   // transparent
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
  const PX = dW + 1.3, PY = dH + cH + 1;
  const cols = Math.max(1, Math.min(cap, Math.floor((w - 2) / PX), 4));
  const rows = Math.ceil(cap / cols);
  const gridW = cols * PX - 1.3, gridH = rows * PY - 1;
  const sx = x + Math.max(1.5, (w - gridW) / 2);
  const sy = y + Math.max(2, (h - gridH) / 2);
  const list = []; let n = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols && n < cap; c++, n++) {
    const dx = sx + c * PX, dy = sy + r * PY;
    objS(DESK.c, DESK.r, DESK.w, DESK.h, dx, dy, DESK_F);
    const chairX = dx + dW/2 - cW/2, chairY = dy + dH;
    objS(CHAIR.c, CHAIR.r, CHAIR.w, CHAIR.h, chairX, chairY, CHAIR_F);
    list.push(seatPct(chairX + cW/2, chairY + cH/2));
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
function furnishReception(rm) {
  const { x, y, w, h } = rm; const cx = x + w/2;
  objS(COUNTER.c, COUNTER.r, COUNTER.w, COUNTER.h, cx - COUNTER.w*DEC_F/2, y+2);
  objS(PLANT.c, PLANT.r, 1, 2, x+2, y+h-4); objS(PLANT.c, PLANT.r, 1, 2, x+w-4, y+h-4);
  objS(ARMCH.c, ARMCH.r, 1, 1, cx-3, y+h-4, CHAIR_F); objS(ARMCH.c, ARMCH.r, 1, 1, cx+1, y+h-4, CHAIR_F);
}

for (const rm of ROOMS) drawRoom(rm);
for (const rm of ROOMS) {
  if (rm.kind === "meeting") furnishMeeting(rm);
  else if (rm.kind === "lounge") furnishLounge(rm);
  else if (rm.kind === "pantry") furnishPantry(rm);
  else if (rm.kind === "reception") furnishReception(rm);
  else furnishTeam(rm);
}

encode(map, "preview/office-square.png");

const COLORS = { meeting:"#10B981", lounge:"#EC4899", pantry:"#14B8A6", reception:"#A855F7", auto:"#F97316", teaching:"#8B5CF6", lead:"#F59E0B", talent:"#6366F1", it:"#3B82F6" };
const pct = (v, tot) => +(v / tot * 100).toFixed(1);
console.log(`Map ${MW*T}x${MH*T}. Zones:\n`);
for (const rm of ROOMS) {
  const team = rm.team ? `"${rm.team}"` : "null";
  const s = seats[rm.id] ? JSON.stringify(seats[rm.id]) : "undefined";
  console.log(`      { id: "${rm.id}", name: "${rm.name}", team: ${team}, x: ${pct(rm.x,MW)}, y: ${pct(rm.y,MH)}, w: ${pct(rm.w,MW)}, h: ${pct(rm.h,MH)}, color: "${COLORS[rm.id]}", seats: ${s} },`);
}
