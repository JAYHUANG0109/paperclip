// Compose the Virtual Office from the Donarg Office Tileset.
// - Rooms sit on a shared HALLWAY floor so the office reads as one connected space
//   (decorative rooms 會議室/休息室/茶水間 in the corners, teams clustered in the middle).
// - Team rooms get exactly `cap` desks (= headcount), centered, each with a chair.
//   Monitors are NOT baked — the app renders a status-coloured monitor per agent.
// - Exports seat coords (where each agent stands, in front of its desk).
import { decode, make, blit, fillRect, encode } from "./pnglib.mjs";

const PACK = "/Users/jayhuang/dev/paperclip/paperclip/Office Tileset";
const A5 = decode(PACK + "/Office VX Ace/A5 Office Floors & Walls.png");
const M = decode(PACK + "/Office Tileset All 16x16.png");
const T = 16;

const ROOM_FLOOR = { c: 8, r: 18 };   // teal diamond (inside rooms)
const HALL_FLOOR = { c: 2, r: 16 };   // grey (hallway between rooms)
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

const MW = 60, MH = 46;
const WALL = [224, 218, 202, 255], EDGE = [56, 52, 46, 255];

// Decorative rooms in the 4 corners; teams clustered in the middle band.
const ROOMS = [
  { id:"meeting",  team:null,         name:"會議室",    x:1,  y:1,  w:17, h:16, kind:"meeting" }, // TL
  { id:"lounge",   team:null,         name:"休息室",    x:42, y:1,  w:17, h:16, kind:"lounge"  }, // TR
  { id:"pantry",   team:null,         name:"茶水間",    x:1,  y:30, w:17, h:15, kind:"pantry"  }, // BL
  { id:"auto",     team:"系統自動化", name:"系統自動化",x:50, y:34, w:9,  h:11, cap:1 },          // BR (smallest)
  { id:"teaching", team:"教學組",     name:"教學組",    x:20, y:1,  w:20, h:20, cap:9 },
  { id:"lead",     team:"領導團隊",   name:"領導團隊",  x:1,  y:18, w:17, h:11, cap:3 },
  { id:"talent",   team:"人才發展",   name:"人才發展",  x:42, y:18, w:17, h:14, cap:1 },
  { id:"it",       team:"資訊部",     name:"資訊部",    x:20, y:22, w:28, h:23, cap:7 },
];

const map = make(MW*T, MH*T);
// Hallway floor everywhere first → rooms sit on it → gaps become corridors.
for (let ty = 0; ty < MH; ty++) for (let tx = 0; tx < MW; tx++) tileAt(map, HALL_FLOOR, tx, ty);
const seats = {};

function drawRoom(rm) {
  const { x, y, w, h } = rm;
  for (let ty = y+1; ty < y+h-1; ty++) for (let tx = x+1; tx < x+w-1; tx++) tileAt(map, ROOM_FLOOR, tx, ty);
  fillRect(map, x*T, y*T, w*T, T, WALL); fillRect(map, x*T, (y+h-1)*T, w*T, T, WALL);
  fillRect(map, x*T, y*T, T, h*T, WALL); fillRect(map, (x+w-1)*T, y*T, T, h*T, WALL);
  fillRect(map, x*T, y*T, w*T, 2, EDGE); fillRect(map, x*T, (y+h)*T-2, w*T, 2, EDGE);
  fillRect(map, x*T, y*T, 2, h*T, EDGE); fillRect(map, (x+w)*T-2, y*T, 2, h*T, EDGE);
  fillRect(map, x*T, (y+1)*T-1, w*T, 1, EDGE);
  const dX = x + Math.floor(w/2) - 1; tileAt(map, ROOM_FLOOR, dX, y+h-1); tileAt(map, ROOM_FLOOR, dX+1, y+h-1);
}

const seatPct = (tx, ty) => ({ x: +((tx+0.5)/MW*100).toFixed(2), y: +((ty+0.6)/MH*100).toFixed(2) });

function furnishTeam(rm) {
  const { x, y, w, h, cap, id } = rm;
  const PX = 5, PY = 5;                                   // desk pitch
  const cols = Math.max(1, Math.min(cap, Math.floor((w - 2) / PX)));
  const rows = Math.ceil(cap / cols);
  const gridW = cols * PX - 2, gridH = rows * PY - 1;     // (last cell no trailing gap)
  const sx = x + Math.max(1, Math.round((w - gridW) / 2));
  const sy = y + Math.max(1, Math.round((h - gridH) / 2));
  const list = [];
  let n = 0;
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
  const tw = Math.min(TABLE.w, w-6), tx = x + Math.floor((w-tw)/2), ty = y + Math.floor(h/2)-1;
  obj(map, TABLE.c, TABLE.r, tw, TABLE.h, tx, ty);
  for (let i = 0; i < tw; i++) { obj(map, CHAIR.c, CHAIR.r, 1, 1, tx+i, ty-1); obj(map, CHAIR.c, CHAIR.r, 1, 1, tx+i, ty+2); }
  obj(map, PLANT.c, PLANT.r, 1, 2, x+2, y+2); obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+2);
}
function furnishLounge(rm) {
  const { x, y, w, h } = rm;
  const cx = x + Math.floor(w/2);
  obj(map, SOFA.c, SOFA.r, SOFA.w, SOFA.h, cx-2, y+2);
  obj(map, TABLE.c, TABLE.r, 2, 2, cx-1, y+5);
  obj(map, ARMCH.c, ARMCH.r, 1, 1, cx-2, y+8); obj(map, ARMCH.c, ARMCH.r, 1, 1, cx+1, y+8);
  obj(map, PLANT.c, PLANT.r, 1, 2, x+2, y+h-3); obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+h-3);
}
function furnishPantry(rm) {
  const { x, y, w, h } = rm;
  obj(map, COUNTER.c, COUNTER.r, Math.min(COUNTER.w, w-4), COUNTER.h, x+2, y+2);
  obj(map, FRIDGE.c, FRIDGE.r, FRIDGE.w, FRIDGE.h, x+w-4, y+2);
  const cx = x + Math.floor(w/2);
  obj(map, TABLE.c, TABLE.r, 2, 2, cx-1, y+Math.floor(h/2));
  obj(map, COOLER.c, COOLER.r, 1, 2, x+2, y+h-4);
  obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+h-4);
}

for (const rm of ROOMS) drawRoom(rm);
for (const rm of ROOMS) {
  if (rm.kind === "meeting") furnishMeeting(rm);
  else if (rm.kind === "lounge") furnishLounge(rm);
  else if (rm.kind === "pantry") furnishPantry(rm);
  else furnishTeam(rm);
}

encode(map, "preview/office-square.png");

const COLORS = { meeting:"#10B981", lounge:"#EC4899", pantry:"#14B8A6", auto:"#F97316", teaching:"#8B5CF6", lead:"#F59E0B", talent:"#6366F1", it:"#3B82F6" };
const pct = (v, tot) => +(v / tot * 100).toFixed(1);
console.log(`Map ${MW*T}x${MH*T}. Zones:\n`);
for (const rm of ROOMS) {
  const team = rm.team ? `"${rm.team}"` : "null";
  const s = seats[rm.id] ? JSON.stringify(seats[rm.id]) : "undefined";
  console.log(`      { id: "${rm.id}", name: "${rm.name}", team: ${team}, x: ${pct(rm.x,MW)}, y: ${pct(rm.y,MH)}, w: ${pct(rm.w,MW)}, h: ${pct(rm.h,MH)}, color: "${COLORS[rm.id]}", seats: ${s} },`);
}
