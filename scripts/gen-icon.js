"use strict";
// Generates assets/icon.png (1024x1024) with no external dependencies.
// A rounded-square coral gradient with a white diamond — the OmniWork mark.
// electron-builder derives .ico/.icns from this PNG at build time.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 1024;
const SS = 2; // supersampling factor for anti-aliasing

// colors
const top = [217, 119, 87]; // #d97757
const bot = [184, 88, 60]; // #b8583c
const white = [255, 255, 255];

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// rounded rect over an arbitrary [min,max] box with corner radius r
function inRoundedRect(x, y, min, max, r) {
  if (x < min || x > max || y < min || y > max) return false;
  if (x >= min + r && x <= max - r) return true;
  if (y >= min + r && y <= max - r) return true;
  const cx = x < min + r ? min + r : max - r;
  const cy = y < min + r ? min + r : max - r;
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

function inDiamond(x, y, cx, cy, rx, ry) {
  return Math.abs(x - cx) / rx + Math.abs(y - cy) / ry <= 1;
}

function render() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const pad = SIZE * 0.07;
  const r = SIZE * 0.2;
  const cx = SIZE / 2, cy = SIZE / 2;
  const rx = SIZE * 0.26, ry = SIZE * 0.32;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          let col = null, alpha = 0;
          if (inRoundedRect(fx, fy, pad, SIZE - pad, r)) {
            const grad = lerp(top, bot, (fy - pad) / (SIZE - 2 * pad));
            col = grad;
            alpha = 255;
            if (inDiamond(fx, fy, cx, cy, rx, ry)) col = white;
          }
          if (col) {
            rr += col[0]; gg += col[1]; bb += col[2]; aa += alpha;
          }
        }
      }
      const n = SS * SS;
      const i = (y * SIZE + x) * 4;
      buf[i] = Math.round(rr / n);
      buf[i + 1] = Math.round(gg / n);
      buf[i + 2] = Math.round(bb / n);
      buf[i + 3] = Math.round(aa / n);
    }
  }
  return buf;
}

// ---- minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });
const png = encodePng(render(), SIZE, SIZE);
fs.writeFileSync(path.join(outDir, "icon.png"), png);
console.log("wrote assets/icon.png", png.length, "bytes");
