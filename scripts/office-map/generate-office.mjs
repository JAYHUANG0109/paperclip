// Compose a square, multi-room Virtual Office map from the Donarg Office Tileset.
// Rooms are sized to team headcount (教學組 biggest, 系統自動化 smallest) plus
// meeting / lounge / 茶水間. Outputs a map PNG + prints room rects (as % of the
// map) to paste into LivingOfficeFloor's zone table.
import { decode, make, blit, fillRect, encode } from "./pnglib.mjs";

const PACK = "/Users/jayhuang/dev/paperclip/paperclip/Office Tileset";
const A5 = decode(PACK + "/Office VX Ace/A5 Office Floors & Walls.png");
const M = decode(PACK + "/Office Tileset All 16x16.png");
const T = 16;

// ── tile helpers ─────────────────────────────────────────────────────────────
const FLOOR = { c: 8, r: 18 };                 // teal diamond (matches old office)
function floorAt(dst, tx, ty) { blit(dst, A5, FLOOR.c*T, FLOOR.r*T, T, T, tx*T, ty*T); }
// paste a WxH-tile object from the master sheet at tile (tx,ty)
function obj(dst, mc, mr, wc, hc, tx, ty) { blit(dst, M, mc*T, mr*T, wc*T, hc*T, tx*T, ty*T); }

// Furniture (master-sheet tile coords, size in tiles)
const DESK   = { c: 1, r: 0, w: 3, h: 2 };     // wooden desk
const DESK2  = { c: 8, r: 0, w: 3, h: 2 };     // desk variant
const CHAIR  = { c: 4, r: 16, w: 1, h: 1 };    // office chair (front)
const ARMCH  = { c: 0, r: 16, w: 1, h: 1 };    // pink armchair
const PLANT  = { c: 4, r: 28, w: 1, h: 2 };    // tall plant
const COOLER = { c: 5, r: 16, w: 1, h: 2 };    // water cooler
const FRIDGE = { c: 12, r: 16, w: 2, h: 2 };   // fridge
const TABLE  = { c: 4, r: 1, w: 4, h: 2 };     // long meeting table

// ── layout (tiles). Building 50w x 40t (landscape, fills wide screens). ───────
const MW = 50, MH = 40;
const WALL = [222, 216, 200, 255];   // beige wall
const WALL_EDGE = [58, 54, 48, 255]; // dark trim

// rooms: x,y,w,h in tiles (outer incl. wall), team key, label, door side
const ROOMS = [
  { id:"teaching",  team:"教學組",     x:1,  y:1,  w:22, h:22, cap:10 },
  { id:"it",        team:"資訊部",     x:1,  y:24, w:22, h:15, cap:8  },
  { id:"meeting",   team:"__meeting",  x:24, y:1,  w:13, h:13, cap:8, kind:"meeting" },
  { id:"lead",      team:"領導團隊",   x:24, y:15, w:13, h:10, cap:5  },
  { id:"lounge",    team:"__lounge",   x:24, y:26, w:13, h:13, cap:0, kind:"lounge" },
  { id:"talent",    team:"人才發展",   x:38, y:1,  w:11, h:11, cap:3  },
  { id:"pantry",    team:"__pantry",   x:38, y:13, w:11, h:11, cap:0, kind:"pantry" },
  { id:"auto",      team:"系統自動化", x:38, y:26, w:7,  h:8,  cap:2  }, // smallest
];

const map = make(MW*T, MH*T);
// dark building backdrop
fillRect(map, 0, 0, MW*T, MH*T, [12, 15, 22, 255]);

function drawRoom(rm) {
  const { x, y, w, h } = rm;
  // floor
  for (let ty = y+1; ty < y+h-1; ty++) for (let tx = x+1; tx < x+w-1; tx++) floorAt(map, tx, ty);
  // walls (1 tile) beige with dark inner+outer edge
  fillRect(map, x*T, y*T, w*T, T, WALL);            // top
  fillRect(map, x*T, (y+h-1)*T, w*T, T, WALL);      // bottom
  fillRect(map, x*T, y*T, T, h*T, WALL);            // left
  fillRect(map, (x+w-1)*T, y*T, T, h*T, WALL);      // right
  // dark trims
  fillRect(map, x*T, y*T, w*T, 2, WALL_EDGE);
  fillRect(map, x*T, (y+h)*T-2, w*T, 2, WALL_EDGE);
  fillRect(map, x*T, y*T, 2, h*T, WALL_EDGE);
  fillRect(map, (x+w)*T-2, y*T, 2, h*T, WALL_EDGE);
  fillRect(map, x*T, (y+1)*T-1, w*T, 1, WALL_EDGE); // wall/floor seam
  // door: gap on bottom wall, centered
  const doorX = x + Math.floor(w/2) - 1;
  for (let dx = 0; dx < 2; dx++) { floorAt(map, doorX+dx, y+h-1); }
}

function furnish(rm) {
  const { x, y, w, h, kind, cap } = rm;
  const ix = x+2, iy = y+2, iw = w-4, ih = h-4; // interior working area
  if (kind === "meeting") {
    obj(map, TABLE.c, TABLE.r, TABLE.w, TABLE.h, x + Math.floor((w-TABLE.w)/2), y + Math.floor(h/2)-1);
    obj(map, PLANT.c, PLANT.r, PLANT.w, PLANT.h, x+1, y+h-3);
    return;
  }
  if (kind === "lounge") {
    obj(map, ARMCH.c, ARMCH.r, 1, 1, x+2, y+2); obj(map, ARMCH.c, ARMCH.r, 1, 1, x+4, y+2);
    obj(map, ARMCH.c, ARMCH.r, 1, 1, x+2, y+4); obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+2);
    return;
  }
  if (kind === "pantry") {
    obj(map, FRIDGE.c, FRIDGE.r, FRIDGE.w, FRIDGE.h, x+2, y+2);
    obj(map, COOLER.c, COOLER.r, 1, 2, x+5, y+2);
    obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+h-3);
    return;
  }
  // team rooms: rows of desks sized to capacity
  const perRow = Math.max(2, Math.floor(iw / 4));
  const nDesks = Math.max(2, cap);
  let placed = 0;
  for (let row = 0; placed < nDesks; row++) {
    const ry = iy + row * 3;
    if (ry + 2 > y + h - 2) break;
    for (let col = 0; col < perRow && placed < nDesks; col++) {
      const rx = ix + col * 4;
      if (rx + DESK.w > x + w - 1) break;
      obj(map, DESK.c, DESK.r, DESK.w, DESK.h, rx, ry);
      placed++;
    }
  }
  obj(map, PLANT.c, PLANT.r, 1, 2, x+w-3, y+1);
}

for (const rm of ROOMS) drawRoom(rm);
for (const rm of ROOMS) furnish(rm);

encode(map, "preview/office-square.png");

// Emit ready-to-paste zone objects. Agents sit in the interior (over the desks).
const LABELS = { __meeting: "會議室", __lounge: "休息室", __pantry: "茶水間" };
const COLORS = ["#8B5CF6","#3B82F6","#10B981","#F59E0B","#EC4899","#6366F1","#14B8A6","#F97316"];
const pct = (v, tot) => +(v / tot * 100).toFixed(1);
console.log(`Map ${MW*T}x${MH*T}. Paste zones:\n`);
ROOMS.forEach((rm, i) => {
  const decorative = rm.team.startsWith("__");
  const name = decorative ? LABELS[rm.team] : rm.team;
  const team = decorative ? "null" : `"${rm.team}"`;
  const x = pct(rm.x, MW), y = pct(rm.y, MH), w = pct(rm.w, MW), h = pct(rm.h, MH);
  // floor: interior working area (over desks)
  const fx = pct(rm.x + 1.5, MW), fy = pct(rm.y + 1.5, MH), fw = pct(rm.w - 3, MW), fh = pct(rm.h - 3, MH);
  console.log(`      { id: "${rm.id}", name: "${name}", team: ${team}, x: ${x}, y: ${y}, w: ${w}, h: ${h}, fx: ${fx}, fy: ${fy}, fw: ${fw}, fh: ${fh}, color: "${COLORS[i]}" },`);
});
