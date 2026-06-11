// One-off icon generator. Produces three PNGs in client/public/icons/:
//   icon-192.png, icon-512.png, icon-maskable-512.png
//
// Pure Node — no image libraries. Renders a flat indigo-gradient background
// with a centered "$" mark, scaled from a 16×24 bitmap. Output is a valid
// PNG (8-bit RGBA) constructed via the pako-free zlib + manual chunks pattern.
//
// Run: node scripts/generate-icons.mjs
// Re-run only when you want different colors/glyph.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// CRC-32 (PNG uses the standard polynomial 0xEDB88320). Pure JS table-based
// implementation — Node 22+ has zlib.crc32 but we still support 18.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'client', 'public', 'icons');
mkdirSync(OUT_DIR, { recursive: true });

// 16-wide × 24-tall "$" bitmap (1 = glyph, 0 = transparent).
// Designed by hand — Inter-ish weight 700 dollar sign.
const GLYPH = `
.....111........
....11111.......
...11.1.11......
..1...1...1.....
..1...1.........
...1..1.........
....1.1.........
.....11.........
......111.......
.......111......
........111.....
........1.1.....
........1.1.....
........1.1.....
....1...1.1.....
....11..1.11....
.....1..1.1.....
.....1..1.......
.....1..1.......
......111.......
......1.........
.....11.........
....1...........
...1............
`.trim().split('\n');

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildPNG(size, opts) {
  const { bgFn, glyphColor, padPct } = opts;
  const pixels = Buffer.alloc(size * size * 4);

  // Background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b, a] = bgFn(x, y, size);
      pixels[i]     = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }

  // Glyph: scale from 16×24 grid into a centered region of `size`. We use
  // (1 - padPct*2) of the canvas width for the glyph box, then fit the 16×24
  // grid into it with letterboxing on the wider axis.
  const gridW = 16;
  const gridH = 24;
  const pad = Math.round(size * padPct);
  const boxW = size - pad * 2;
  const boxH = size - pad * 2;
  const cellSize = Math.floor(Math.min(boxW / gridW, boxH / gridH));
  const glyphW = cellSize * gridW;
  const glyphH = cellSize * gridH;
  const offX = Math.floor((size - glyphW) / 2);
  const offY = Math.floor((size - glyphH) / 2);

  for (let gy = 0; gy < gridH; gy++) {
    const row = GLYPH[gy] || '';
    for (let gx = 0; gx < gridW; gx++) {
      if (row[gx] === '1') {
        const px = offX + gx * cellSize;
        const py = offY + gy * cellSize;
        for (let dy = 0; dy < cellSize; dy++) {
          for (let dx = 0; dx < cellSize; dx++) {
            const x = px + dx;
            const y = py + dy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const i = (y * size + x) * 4;
            pixels[i]     = glyphColor[0];
            pixels[i + 1] = glyphColor[1];
            pixels[i + 2] = glyphColor[2];
            pixels[i + 3] = 255;
          }
        }
      }
    }
  }

  // Convert raw RGBA into PNG IDAT (filter byte 0 per scanline).
  const stride = size * 4;
  const filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[(stride + 1) * y] = 0; // None filter
    pixels.copy(filtered, (stride + 1) * y + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(filtered);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // color type RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Slate-900 → indigo-700-ish radial-ish gradient, computed in code.
function gradientBg(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const dx = (x - cx) / cx;
  const dy = (y - cy) / cy;
  const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
  const lerp = (a, b) => Math.round(a + (b - a) * r);
  // center: indigo-600 (#4f46e5)  → corner: slate-900 (#0f172a)
  return [lerp(79, 15), lerp(70, 23), lerp(229, 42), 255];
}

const GLYPH_WHITE = [255, 255, 255];

writeFileSync(join(OUT_DIR, 'icon-192.png'),
  buildPNG(192, { bgFn: gradientBg, glyphColor: GLYPH_WHITE, padPct: 0.18 }));
writeFileSync(join(OUT_DIR, 'icon-512.png'),
  buildPNG(512, { bgFn: gradientBg, glyphColor: GLYPH_WHITE, padPct: 0.18 }));
// Maskable: leave wider safe-zone padding (icon visible inside a circle/round-square).
writeFileSync(join(OUT_DIR, 'icon-maskable-512.png'),
  buildPNG(512, { bgFn: gradientBg, glyphColor: GLYPH_WHITE, padPct: 0.28 }));

// Favicon (32×32) for the browser tab.
writeFileSync(join(__dirname, '..', 'client', 'public', 'favicon.png'),
  buildPNG(32, { bgFn: gradientBg, glyphColor: GLYPH_WHITE, padPct: 0.10 }));

console.log('Generated icons in', OUT_DIR);
