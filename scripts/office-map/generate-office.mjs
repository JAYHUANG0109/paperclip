// Compose the Virtual Office from the Donarg Office Tileset as a 3x3 九宮格.
// 9 rooms on a shared hallway floor. Team rooms fill their grid cell; decorative
// rooms (會議室/休息室/茶水間/接待處) are drawn smaller, centered in their cell.
// Team rooms get exactly `cap` desks (= headcount). Monitors are rendered by the app.
import { decode, make, blit, fillRect, encode } from "./pnglib.mjs";

const PACK = "/Users/jayhuang/dev/paperclip/paperclip/Office Tileset";
const A5 = decode(PACK + "/Office VX Ace/A5 Office Floors & Walls.png");
const M = decode(PACK + "/Office Tileset All 16x16.png");
const T = 16;

const ROOM_FLOOR = { c: 8, r: 18 };
const HALL_FLOOR = { c: 2, r: 16 };
const tileAt = (d, t, tx, ty) => blit(d, A5, t.c*T, t.r*T, T, T, tx*T, ty*T);
const obj = (d, mc, mr, wc, hc, tx, ty) => blit(d, M, mc*T, mr*T, wc*T, hc*T, tx*T, ty*T);

const DESK   = { c: 1,  r: 0,  w: 3, h: 2 };
const CHAIR  = { c: 4,  r: 16, w: 1, h: 1 };
const ARMCH  = { c: 0,  r: 16, w: 1, h: 1 };
const SOFA   = { c: 4,  r: 2,  w: 4, h: 2 };
const PLANT  = { c: 4,  r: 28, w: 1, h: 2 };
const COOLER = { c: 5,  r: 16, w: 1, h: 2 };
const FRIDGE = { c: 12, r: 16, w: 2, h: 2 };
const TABLE  = { c: 4,  r: 1,  w: 4, h: 2 };
const COUNTER= { c: 8,  r: 0,  w: 4, h: 2 };

// ── 3x3 grid geometry (tiles) ────────────────────────────────────────────────
const COLX = [1, 15, 34], COLW = [13, 18, 13];
const ROWY = [1, 18, 31], ROWH = [16, 12, 10];
const MW = 48, MH = 42;                       // 768x672 → scales up big

// cell:[col,row]; dw/dh = drawn size (default: fill the cell)
const ROOMS = [
  { id:"meeting",  team:null,         name:"會議室",    cell:[0,0], dw:12, dh:13, kind:"meeting" },
  { id:"teaching", team:"教學組",     name:"教學組",    cell:[1,0], cap:9 },
  { id:"talent",   team:"人才發展",   name:"人才發展",  cell:[2,0], dw:10, dh:11, cap:1 },
  { id:"lead",     team:"領導團隊",   name:"領導團隊",  cell:[0,1], dw:13, dh:10, cap:3 },
  { id:"it",       team:"資訊部",     name:"資訊部",    cell:[1,1], cap:7 },
  { id:"lounge",   team:null,         name:"休息室",    cell:[2,1], dw:11, dh:9, kind:"lounge" },
  { id:"pantry",   team:null,         name:"茶水間",    cell:[0,2], dw:11, dh:9, kind:"pantry" },
  { id:"reception",team:null,         name:"接待處",    cell:[1,2], dw:14, dh:9, kind:"reception" },
  { id:"auto",     team:"系統自動化", name:"系統自動化",cell:[2,2], dw:9,  dh:9, cap:1 },
];
for (const rm of ROOMS) {
  const [c, r] = rm.cell;
  const cw = COLW[c], ch = ROWH[r], cx = COLX[c], cy = ROWY[r];
  rm.w = rm.dw ?? cw; rm.h = rm.dh ?? ch;
  rm.x = cx + Math.floor((cw - rm.w) / 2);
  rm.y = cy + Math.floor((ch - rm.h) / 2);
}

const map = make(MW*T, MH*T);
for (let ty = 0; ty < MH; ty++) for (let tx = 0; tx < MW; tx++) tileAt(map, HALL_FLOOR, tx, ty);
const seats = {};

function drawRoom(rm) {
  const { x, y, w, h } = rm;
  for (let ty = y+1; ty < y+h-1; ty++) for (let tx = x+1; tx < x+w-1; tx++) tileAt(map, ROOM_FLOOR, tx, ty);
  fillRect(map, x*T, y*T, w*T, T, [224,218,202,255]); fillRect(map, x*T, (y+h-1)*T, w*T, T, [224,218,202,255]);
  fillRect(map, x*T, y*T, T, h*T, [224,218,202,255]); fillRect(map, (x+w-1)*T, y*T, T, h*T, [224,218,202,255]);
  const E=[56,52,46,255];
  fillRect(map, x*T, y*T, w*T, 2, E); fillRect(map, x*T, (y+h)*T-2, w*T, 2, E);
  fillRect(map, x*T, y*T, 2, h*T, E); fillRect(map, (x+w)*T-2, y*T, 2, h*T, E);
  fillRect(map, x*T, (y+1)*T-1, w*T, 1, E);
  const dX = x + Math.floor(w/2) - 1; tileAt(map, ROOM_FLOOR, dX, y+h-1); tileAt(map, ROOM_FLOOR, dX+1, y+h-1);
}

const seatPct = (tx, ty) => ({ x: +((tx+0.5)/MW*100).toFixed(2), y: +((ty+0.5)/MH*100).toFixed(2) });

function furnishTeam(rm) {
  const { x, y, w, h, cap, id } = rm;
  const PX = 4, PY = 5;
  const cols = Math.max(1, Math.min(cap, Math.floor((w - 2) / PX)));
  const rows = Math.ceil(cap / cols);
  const gridW = cols * PX - 1, gridH = rows * PY - 1;
  const sx = x + Math.max(1, Math.round((w - gridW) / 2));
  const sy = y + Math.max(1, Math.round((h - gridH) / 2));
  const list = []; let n = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols && n < cap; c++, n++) {
    const dx = sx + c * PX, dy = sy + r * PY;
    obj(map, DESK.c, DESK.r, DESK.w, DESK.h, dx, dy);
    obj(map, CHAIR.c, CHAIR.r, 1, 1, dx+1, dy+2);
    list.push(seatPct(dx+1, dy+2));
  }
  seats[id] = list;
}
function furnishMeeting(rm) {
  const { x, y, w, h } = rm;
  const tw = Math.min(TABLE.w, w-4), tx = x + Math.floor((w-tw)/2), ty = y + Math.floor(h/2)-1;
  obj(map, TABLE.c, TABLE.r, tw, TABLE.h, tx, ty);
  for (let i = 0; i < tw; i++) { obj(map, CHAIR.c, CHAIR.r, 1, 1, tx+i, ty-1); obj(map, CHAIR.c, CHAIR.r, 1, 1, tx+i, ty+2); }
}
function furnishLounge(rm) {
  const { x, y, w, h } = rm; const cx = x + Math.floor(w/2);
  obj(map, SOFA.c, SOFA.r, SOFA.w, SOFA.h, cx-2, y+2);
  obj(map, TABLE.c, TABLE.r, 2, 2, cx-1, y+5);
}
function furnishPantry(rm) {
  const { x, y, w, h } = rm;
  obj(map, COUNTER.c, COUNTER.r, Math.min(COUNTER.w, w-3), COUNTER.h, x+2, y+2);
  obj(map, FRIDGE.c, FRIDGE.r, FRIDGE.w, FRIDGE.h, x+w-4, y+2);
  obj(map, COOLER.c, COOLER.r, 1, 2, x+2, y+h-4);
}
function furnishReception(rm) {
  const { x, y, w, h } = rm;
  obj(map, COUNTER.c, COUNTER.r, Math.min(COUNTER.w, w-4), COUNTER.h, x + Math.floor((w-4)/2), y+2);
  obj(map, PLANT.c, PLANT.r, 1, 2, x+2, y+h-4); obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+h-4);
  obj(map, ARMCH.c, ARMCH.r, 1, 1, x+Math.floor(w/2)-1, y+h-3); obj(map, ARMCH.c, ARMCH.r, 1, 1, x+Math.floor(w/2)+1, y+h-3);
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
