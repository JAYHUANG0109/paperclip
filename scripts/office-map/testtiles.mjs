import { decode, make, blit, scale, encode, grid } from "./pnglib.mjs";
const PACK = "/Users/jayhuang/dev/paperclip/paperclip/Office Tileset";
const A5 = decode(PACK + "/Office VX Ace/A5 Office Floors & Walls.png");
const M = decode(PACK + "/Office Tileset All 16x16.png");
const T = 16;
const tile = (img, c, r) => ({ img, sx: c*T, sy: r*T });
// Contact sheet: floor palette rows 16-20 (A5) and some furniture (master).
const cols = 16, rowsA = [16,17,18,19,20];
const out = make(cols*T, (rowsA.length + 12)*T);
// floors
rowsA.forEach((r, ri) => { for (let c=0;c<cols;c++) blit(out, A5, c*T, r*T, T, T, c*T, ri*T); });
// furniture candidate rows from master: rows 0-1 (desks), 16 (chairs), 22-23 (computers), 28 (plants)
const mrows = [0,1,2,16,17,22,23,28,29];
mrows.forEach((r, ri) => { for (let c=0;c<cols;c++) blit(out, M, c*T, r*T, T, T, c*T, (rowsA.length+ri)*T); });
const big = scale(out, 8); grid(big, T*8, [255,0,80]);
encode(big, "preview/contact.png");
console.log("rows: floors A5=16,17,18,19,20 ; then master=0,1,2,16,17,22,23,28,29");
