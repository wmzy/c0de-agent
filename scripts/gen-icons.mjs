#!/usr/bin/env node
/**
 * Generate PNG icons from SVG specs — zero dependencies.
 * Pure PNG encoder: rounded-rect + "</>" monospace text.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

// ── Color palette ──────────────────────────────────────
const BG = [0x0a, 0x0a, 0x0f];       // #0a0a0f
const FG = [0x58, 0xa6, 0xff];       // #58a6ff

// ── Glyph bitmap data (5 cols each) ────────────────────
// Each glyph is 5 pixels wide; height varies.
const GLYPHS = {
  '<': [
    [0,1,0,0,0],
    [1,0,1,0,0],
    [1,1,0,0,0],
    [1,0,1,0,0],
    [0,1,0,0,0],
  ],
  '/': [
    [0,0,0,0,1],
    [0,0,0,1,0],
    [0,0,1,0,0],
    [0,1,0,0,0],
    [1,0,0,0,0],
  ],
  '>': [
    [0,0,0,1,0],
    [0,0,1,0,1],
    [0,1,0,0,0],
    [0,0,1,0,1],
    [0,0,0,1,0],
  ],
};

function drawGlyph(buf, gw, ox, oy, glyph, pxScale, fg) {
  const gd = GLYPHS[glyph];
  if (!gd) return;
  const h = gd.length;
  const w = gd[0].length;
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      if (gd[gy][gx]) {
        for (let py = 0; py < pxScale; py++) {
          for (let px = 0; px < pxScale; px++) {
            const x = ox + gx * pxScale + px;
            const y = oy + gy * pxScale + py;
            if (x >= 0 && x < gw && y >= 0) {
              const off = (y * gw + x) * 4;
              buf[off]     = fg[0];
              buf[off + 1] = fg[1];
              buf[off + 2] = fg[2];
              buf[off + 3] = 255;
            }
          }
        }
      }
    }
  }
}

// ── PNG encoder (RGBA) ─────────────────────────────────
function makePNG(width, height, rgba) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const crcVal = crc32(body);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcVal >>> 0);
    return Buffer.concat([len, body, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // raw = filter(0) + RGBA for each row
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + width * 4);
    raw[rowOff] = 0; // filter: none
    rgba.copy(raw, rowOff + 1, y * width * 4, (y + 1) * width * 4);
  }

  const comp = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', comp),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CRC32
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Rounded rect mask ──────────────────────────────────
function roundedRectMask(w, h, r) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = true;
      // Each pixel belongs to exactly one corner region or none.
      // Corner regions: [0,r)×[0,r), [w-r,w)×[0,r), [0,r)×[h-r,h), [w-r,w)×[h-r,h)
      if (x < r && y < r) {
        // top-left corner
        const dx = x - r, dy = y - r;
        if (dx * dx + dy * dy > r * r) inside = false;
      } else if (x >= w - r && y < r) {
        // top-right corner
        const dx = x - (w - 1 - r), dy = y - r;
        if (dx * dx + dy * dy > r * r) inside = false;
      } else if (x < r && y >= h - r) {
        // bottom-left corner
        const dx = x - r, dy = y - (h - 1 - r);
        if (dx * dx + dy * dy > r * r) inside = false;
      } else if (x >= w - r && y >= h - r) {
        // bottom-right corner
        const dx = x - (w - 1 - r), dy = y - (h - 1 - r);
        if (dx * dx + dy * dy > r * r) inside = false;
      }
      if (inside) mask[y * w + x] = 1;
    }
  }
  return mask;
}

// ── Generate one icon ──────────────────────────────────
function generatePNG(size) {
  const r = Math.round(size * 0.165); // corner radius ~16.5%
  const mask = roundedRectMask(size, size, r);

  const buf = Buffer.alloc(size * size * 4);

  // Fill background inside mask, transparent outside
  for (let i = 0; i < size * size; i++) {
    const off = i * 4;
    if (mask[i]) {
      buf[off] = BG[0]; buf[off+1] = BG[1]; buf[off+2] = BG[2]; buf[off+3] = 255;
    } else {
      buf[off+3] = 0;
    }
  }

  // Draw "</>" centered
  const pxScale = Math.round(size / 28); // pixel scale factor
  const glyphW = 5; // each glyph is 5 px wide
  const gap = 1;    // gap between glyphs in px
  const textW = glyphW * 3 + gap * 2; // 17 px total
  const textH = 5; // glyph height in px
  const textPxW = textW * pxScale;
  const textPxH = textH * pxScale;
  const ox = Math.round((size - textPxW) / 2);
  const oy = Math.round((size - textPxH) / 2);

  const chars = ['<', '/', '>'];
  let curX = ox;
  for (const ch of chars) {
    drawGlyph(buf, size, curX, oy, ch, pxScale, FG);
    curX += glyphW * pxScale;
    if (ch !== '>') curX += gap * pxScale;
  }

  return makePNG(size, size, buf);
}

// ── Main ───────────────────────────────────────────────
const dir = join(import.meta.dirname, '..', 'public', 'icons');

for (const [name, size] of [['icon-192', 192], ['icon-512', 512]]) {
  const png = generatePNG(size);
  const outPath = join(dir, `${name}.png`);
  writeFileSync(outPath, png);
  console.log(`✓ ${name}.png (${(png.length / 1024).toFixed(1)} KB)`);
}
