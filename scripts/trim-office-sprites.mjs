// Trim the transparent padding around Virtual Office character sprites so the
// character fills its frame (they're generated with ~80% empty margin, which made
// them render tiny). Re-saves each PNG as a square canvas with the character
// centered horizontally and bottom-aligned (feet near the bottom), so the floor
// placement + ground shadow still line up.
//
// Pure Node (zlib) — no deps. Operates in place on every PNG under
// ui/public/assets/office-characters/<id>/*.png. Re-runnable (idempotent-ish:
// re-trimming an already-tight sprite just keeps it tight).
//
// Usage: node scripts/trim-office-sprites.mjs [--pad 6]
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "ui/public/assets/office-characters");
const PAD = parseInt((process.argv.includes("--pad") ? process.argv[process.argv.indexOf("--pad") + 1] : "6"), 10);

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decode(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const colorType = buf[25];
  if (colorType !== 6) throw new Error("expected RGBA (colorType 6), got " + colorType);
  let off = 8; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    for (let x = 0; x < stride; x++) {
      const v = raw[p++]; const ib = y * stride + x;
      const a = x >= bpp ? out[ib - bpp] : 0;
      const b = y > 0 ? out[ib - stride] : 0;
      const c = x >= bpp && y > 0 ? out[ib - stride - bpp] : 0;
      let val;
      switch (f) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; val = v + pr; break; }
        default: val = v;
      }
      out[ib] = val & 255;
    }
  }
  return { w, h, px: out };
}

function crc32(buf) { return zlib.crc32 ? zlib.crc32(buf) >>> 0 : fallbackCrc(buf); }
function fallbackCrc(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encode(w, h, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4; const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function bbox(w, h, px) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function trimFile(file) {
  const { w, h, px } = decode(readFileSync(file));
  const bb = bbox(w, h, px);
  if (!bb) { console.log(`  · ${path.basename(file)} empty, skip`); return; }
  const cw = bb.maxX - bb.minX + 1, ch = bb.maxY - bb.minY + 1;
  // Square canvas sized to the taller dimension + padding; character centered
  // horizontally, bottom-aligned (feet near bottom) with PAD bottom margin.
  const side = Math.max(cw, ch) + PAD * 2;
  const out = Buffer.alloc(side * side * 4);
  const dx = Math.round((side - cw) / 2);
  const dy = side - PAD - ch; // bottom aligned
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = ((bb.minY + y) * w + (bb.minX + x)) * 4;
    const d = ((dy + y) * side + (dx + x)) * 4;
    out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
  }
  writeFileSync(file, encode(side, side, out));
  console.log(`  · ${path.basename(path.dirname(file))}/${path.basename(file)}  ${w}x${h} → ${side}x${side} (char ${cw}x${ch})`);
}

let count = 0;
for (const id of readdirSync(DIR)) {
  const sub = path.join(DIR, id);
  if (!statSync(sub).isDirectory()) continue;
  for (const f of readdirSync(sub)) if (f.endsWith(".png")) { trimFile(path.join(sub, f)); count++; }
}
console.log(`\nTrimmed ${count} sprites. Next: bump ART_VERSION + pnpm deploy:live`);
