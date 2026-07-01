// Minimal dependency-free PNG (RGBA, 8-bit) decode/encode + blit/crop/scale/grid
// helpers, for composing Virtual Office maps from the Donarg Office Tileset.
import zlib from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decode(pathOrBuf) {
  const buf = Buffer.isBuffer(pathOrBuf) ? pathOrBuf : readFileSync(pathOrBuf);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const colorType = buf[25];
  let off = 8; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
  const stride = w * channels, un = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    for (let x = 0; x < stride; x++) {
      const v = raw[p++]; const ib = y * stride + x;
      const a = x >= channels ? un[ib - channels] : 0;
      const b = y > 0 ? un[ib - stride] : 0;
      const c = x >= channels && y > 0 ? un[ib - stride - channels] : 0;
      let val;
      switch (f) {
        case 0: val = v; break; case 1: val = v + a; break; case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; val = v + pr; break; }
        default: val = v;
      }
      un[ib] = val & 255;
    }
  }
  // normalize to RGBA
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (channels === 4) { px[i*4]=un[i*4]; px[i*4+1]=un[i*4+1]; px[i*4+2]=un[i*4+2]; px[i*4+3]=un[i*4+3]; }
    else if (channels === 3) { px[i*4]=un[i*3]; px[i*4+1]=un[i*3+1]; px[i*4+2]=un[i*3+2]; px[i*4+3]=255; }
    else { px[i*4]=un[i]; px[i*4+1]=un[i]; px[i*4+2]=un[i]; px[i*4+3]=255; }
  }
  return { w, h, px };
}

function crc32(b) { return (zlib.crc32 ? zlib.crc32(b) : slowCrc(b)) >>> 0; }
function slowCrc(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c;}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
export function encode({ w, h, px }, outPath) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y*(stride+1)] = 0; px.copy(raw, y*(stride+1)+1, y*stride, y*stride+stride); }
  const out = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  if (outPath) writeFileSync(outPath, out);
  return out;
}

export function make(w, h) { return { w, h, px: Buffer.alloc(w * h * 4) }; }

// Alpha-composite src region onto dst at (dx,dy).
export function blit(dst, src, sx, sy, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const ax = sx + x, ay = sy + y; if (ax < 0 || ay < 0 || ax >= src.w || ay >= src.h) continue;
    const bx = dx + x, by = dy + y; if (bx < 0 || by < 0 || bx >= dst.w || by >= dst.h) continue;
    const s = (ay * src.w + ax) * 4, d = (by * dst.w + bx) * 4;
    const sa = src.px[s + 3]; if (sa === 0) continue;
    if (sa === 255) { dst.px[d]=src.px[s]; dst.px[d+1]=src.px[s+1]; dst.px[d+2]=src.px[s+2]; dst.px[d+3]=255; continue; }
    const da = dst.px[d + 3], a = sa / 255, ia = 1 - a;
    for (let k = 0; k < 3; k++) dst.px[d + k] = Math.round(src.px[s + k] * a + dst.px[d + k] * ia);
    dst.px[d + 3] = Math.max(da, sa);
  }
}

// Alpha-composite a src region onto dst, nearest-neighbour scaled by `f` (may be
// fractional). Destination top-left is (dx,dy) in px.
export function blitScaled(dst, src, sx, sy, sw, sh, dx, dy, f) {
  const ow = Math.round(sw * f), oh = Math.round(sh * f);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const ax = sx + Math.floor(x / f), ay = sy + Math.floor(y / f);
    if (ax < 0 || ay < 0 || ax >= src.w || ay >= src.h) continue;
    const bx = dx + x, by = dy + y; if (bx < 0 || by < 0 || bx >= dst.w || by >= dst.h) continue;
    const s = (ay * src.w + ax) * 4, d = (by * dst.w + bx) * 4;
    const sa = src.px[s + 3]; if (sa === 0) continue;
    if (sa === 255) { dst.px[d]=src.px[s]; dst.px[d+1]=src.px[s+1]; dst.px[d+2]=src.px[s+2]; dst.px[d+3]=255; continue; }
    const a = sa / 255, ia = 1 - a;
    for (let k = 0; k < 3; k++) dst.px[d + k] = Math.round(src.px[s + k] * a + dst.px[d + k] * ia);
    dst.px[d + 3] = Math.max(dst.px[d + 3], sa);
  }
}

export function fillRect(dst, x0, y0, rw, rh, [r,g,b,a=255]) {
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) {
    if (x<0||y<0||x>=dst.w||y>=dst.h) continue; const d=(y*dst.w+x)*4;
    dst.px[d]=r;dst.px[d+1]=g;dst.px[d+2]=b;dst.px[d+3]=a;
  }
}

// Nearest-neighbour scale (integer factor).
export function scale(img, f) {
  const o = make(img.w * f, img.h * f);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const s = (y*img.w+x)*4;
    for (let yy=0; yy<f; yy++) for (let xx=0; xx<f; xx++) {
      const d = ((y*f+yy)*o.w + (x*f+xx))*4;
      o.px[d]=img.px[s];o.px[d+1]=img.px[s+1];o.px[d+2]=img.px[s+2];o.px[d+3]=img.px[s+3];
    }
  }
  return o;
}

// Draw a grid every `step` px in the given color (for identifying tile coords).
export function grid(img, step, [r,g,b]=[255,0,0]) {
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (x % step === 0 || y % step === 0) { const d=(y*img.w+x)*4; img.px[d]=r;img.px[d+1]=g;img.px[d+2]=b;img.px[d+3]=255; }
  }
}
