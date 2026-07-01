// Compose a square, multi-room Virtual Office from the Donarg Office Tileset.
// Rooms are sized to team headcount (教學組 biggest, 系統自動化 smallest) + 會議室/
// 休息室/茶水間. Team rooms get realistic WORKSTATION ROWS (desk + chair) and the
// generator EXPORTS the exact seat coordinates so agents sit at their desks.
import { decode, make, blit, fillRect, encode } from "./pnglib.mjs";

const PACK = "/Users/jayhuang/dev/paperclip/paperclip/Office Tileset";
const A5 = decode(PACK + "/Office VX Ace/A5 Office Floors & Walls.png");
const M = decode(PACK + "/Office Tileset All 16x16.png");
const T = 16;

const FLOOR = { c: 8, r: 18 };
const floorAt = (d, tx, ty) => blit(d, A5, FLOOR.c*T, FLOOR.r*T, T, T, tx*T, ty*T);
const obj = (d, mc, mr, wc, hc, tx, ty) => blit(d, M, mc*T, mr*T, wc*T, hc*T, tx*T, ty*T);

// furniture (master tile coords)
const DESK   = { c: 1,  r: 0,  w: 3, h: 2 };
const MON    = { c: 11, r: 22, w: 2, h: 2 };   // monitor+tower (on desk)
const CHAIR  = { c: 4,  r: 16, w: 1, h: 1 };   // office chair (front)
const ARMCH  = { c: 0,  r: 16, w: 1, h: 1 };
const SOFA   = { c: 4,  r: 2,  w: 4, h: 2 };   // long couch
const PLANT  = { c: 4,  r: 28, w: 1, h: 2 };
const COOLER = { c: 5,  r: 16, w: 1, h: 2 };
const FRIDGE = { c: 12, r: 16, w: 2, h: 2 };
const TABLE  = { c: 4,  r: 1,  w: 4, h: 2 };   // long table (meeting/pantry)
const COUNTER= { c: 8,  r: 0,  w: 4, h: 2 };

const MW = 60, MH = 46;                          // bigger (960x736)
const WALL = [224, 218, 202, 255], EDGE = [56, 52, 46, 255];

// rooms (x,y,w,h in tiles). team null = decorative.
const ROOMS = [
  { id:"teaching", team:"教學組",     name:"教學組",   x:1,  y:1,  w:30, h:26, cap:12 },
  { id:"it",       team:"資訊部",     name:"資訊部",   x:1,  y:28, w:30, h:17, cap:8  },
  { id:"meeting",  team:null,         name:"會議室",   x:32, y:1,  w:16, h:17, kind:"meeting" },
  { id:"lead",     team:"領導團隊",   name:"領導團隊", x:32, y:19, w:16, h:12, cap:6 },
  { id:"lounge",   team:null,         name:"休息室",   x:32, y:32, w:16, h:13, kind:"lounge" },
  { id:"talent",   team:"人才發展",   name:"人才發展", x:49, y:1,  w:10, h:13, cap:4 },
  { id:"pantry",   team:null,         name:"茶水間",   x:49, y:15, w:10, h:14, kind:"pantry" },
  { id:"auto",     team:"系統自動化", name:"系統自動化",x:49, y:30, w:8,  h:9,  cap:2 }, // smallest
];

const map = make(MW*T, MH*T);
fillRect(map, 0, 0, MW*T, MH*T, [12, 15, 22, 255]);
const seats = {}; // id -> [{x%,y%}]

function drawRoom(rm) {
  const { x, y, w, h } = rm;
  for (let ty = y+1; ty < y+h-1; ty++) for (let tx = x+1; tx < x+w-1; tx++) floorAt(map, tx, ty);
  fillRect(map, x*T, y*T, w*T, T, WALL); fillRect(map, x*T, (y+h-1)*T, w*T, T, WALL);
  fillRect(map, x*T, y*T, T, h*T, WALL); fillRect(map, (x+w-1)*T, y*T, T, h*T, WALL);
  fillRect(map, x*T, y*T, w*T, 2, EDGE); fillRect(map, x*T, (y+h)*T-2, w*T, 2, EDGE);
  fillRect(map, x*T, y*T, 2, h*T, EDGE); fillRect(map, (x+w)*T-2, y*T, 2, h*T, EDGE);
  fillRect(map, x*T, (y+1)*T-1, w*T, 1, EDGE);
  const dX = x + Math.floor(w/2) - 1; floorAt(map, dX, y+h-1); floorAt(map, dX+1, y+h-1); // door
}

const seatPct = (tx, ty) => ({ x: +((tx+0.5)/MW*100).toFixed(2), y: +((ty+0.6)/MH*100).toFixed(2) });

function furnishTeam(rm) {
  const { x, y, w, h, cap, id } = rm;
  // Workstation rows: desk (3w x 2h) with a chair + seat below, facing the desk.
  const PITCH_X = 4, PITCH_Y = 5;
  const startX = x + 2, startY = y + 2;
  const cols = Math.max(1, Math.floor((w - 3) / PITCH_X));
  const list = [];
  let n = 0;
  for (let row = 0; ; row++) {
    const dy = startY + row * PITCH_Y;
    if (dy + 4 > y + h - 1) break;           // keep inside room (desk+chair+margin)
    for (let col = 0; col < cols; col++) {
      const dx = startX + col * PITCH_X;
      obj(map, DESK.c, DESK.r, DESK.w, DESK.h, dx, dy);
      obj(map, MON.c, MON.r, MON.w, MON.h, dx, dy);          // monitor on desk
      obj(map, CHAIR.c, CHAIR.r, 1, 1, dx+1, dy+2);          // chair in front
      list.push(seatPct(dx+1, dy+2));
      n++;
    }
    if (n >= cap + cols) break;              // enough seats (a little slack)
  }
  seats[id] = list;
  obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+h-3);
}

function furnishMeeting(rm) {
  const { x, y, w, h } = rm;
  const tw = Math.min(TABLE.w, w-6), tx = x + Math.floor((w-tw)/2), ty = y + Math.floor(h/2) - 1;
  obj(map, TABLE.c, TABLE.r, tw, TABLE.h, tx, ty);
  for (let i = 0; i < tw; i++) { obj(map, CHAIR.c, CHAIR.r, 1, 1, tx+i, ty-1); obj(map, CHAIR.c, CHAIR.r, 1, 1, tx+i, ty+2); }
  obj(map, PLANT.c, PLANT.r, 1, 2, x+2, y+h-3); obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+h-3);
}
function furnishLounge(rm) {
  const { x, y, w, h } = rm;
  obj(map, SOFA.c, SOFA.r, SOFA.w, SOFA.h, x+2, y+2);
  obj(map, ARMCH.c, ARMCH.r, 1, 1, x+2, y+5); obj(map, ARMCH.c, ARMCH.r, 1, 1, x+4, y+5);
  obj(map, TABLE.c, TABLE.r, 2, 2, x+3, y+7);
  obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+2);
}
function furnishPantry(rm) {
  const { x, y, w, h } = rm;
  obj(map, COUNTER.c, COUNTER.r, Math.min(COUNTER.w, w-3), COUNTER.h, x+2, y+2);
  obj(map, FRIDGE.c, FRIDGE.r, FRIDGE.w, FRIDGE.h, x+2, y+5);
  obj(map, COOLER.c, COOLER.r, 1, 2, x+5, y+5);
  obj(map, TABLE.c, TABLE.r, 2, 2, x+w-4, y+h-4);
  obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+2);
}

for (const rm of ROOMS) drawRoom(rm);
for (const rm of ROOMS) {
  if (rm.kind === "meeting") furnishMeeting(rm);
  else if (rm.kind === "lounge") furnishLounge(rm);
  else if (rm.kind === "pantry") furnishPantry(rm);
  else furnishTeam(rm);
}

encode(map, "preview/office-square.png");

const COLORS = ["#8B5CF6","#3B82F6","#10B981","#F59E0B","#EC4899","#6366F1","#14B8A6","#F97316"];
const pct = (v, tot) => +(v / tot * 100).toFixed(1);
console.log(`Map ${MW*T}x${MH*T}. Zones:\n`);
ROOMS.forEach((rm, i) => {
  const team = rm.team ? `"${rm.team}"` : "null";
  const s = seats[rm.id] ? JSON.stringify(seats[rm.id]) : "undefined";
  console.log(`      { id: "${rm.id}", name: "${rm.name}", team: ${team}, x: ${pct(rm.x,MW)}, y: ${pct(rm.y,MH)}, w: ${pct(rm.w,MW)}, h: ${pct(rm.h,MH)}, color: "${COLORS[i]}", seats: ${s} },`);
});
