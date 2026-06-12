#!/usr/bin/env node
// Composes committed PNG spritesheets from the text pixel grids in
// content/sprites/. Zero npm dependencies: minimal PNG encoder over
// node:zlib deflate. Run: node tools/gen-sprites.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PALETTES } from '../content/sprites/palettes.mjs';
import { TILES } from '../content/sprites/tiles.mjs';
import { SPRITES } from '../content/sprites/sprites.mjs';
import { CHARSET, glyphRows } from '../content/sprites/font.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'game', 'assets', 'sprites');
const SHEET_COLS = 16;

// ---- minimal PNG encoder (8-bit RGBA, no filtering) ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- sheet composition ----

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function buildSheet(defs, { allowTransparent }) {
  const rows = Math.ceil(defs.length / SHEET_COLS);
  const w = SHEET_COLS * 16;
  const h = rows * 16;
  const rgba = Buffer.alloc(w * h * 4);

  defs.forEach((def, index) => {
    const pal = PALETTES[def.palette];
    if (!pal) throw new Error(`${def.name}: unknown palette '${def.palette}'`);
    if (def.grid.length !== 16) throw new Error(`${def.name}: grid must have 16 rows`);
    const ox = (index % SHEET_COLS) * 16;
    const oy = Math.floor(index / SHEET_COLS) * 16;
    def.grid.forEach((row, y) => {
      if (row.length !== 16) {
        throw new Error(`${def.name} row ${y}: expected 16 chars, got ${row.length}`);
      }
      for (let x = 0; x < 16; x++) {
        const ch = row[x];
        const off = ((oy + y) * w + ox + x) * 4;
        if (ch === '.') {
          if (!allowTransparent) {
            throw new Error(`${def.name}: background tiles cannot be transparent`);
          }
          continue; // leave rgba 0,0,0,0
        }
        const shade = Number(ch);
        if (!(shade >= 0 && shade <= 3)) {
          throw new Error(`${def.name} row ${y} col ${x}: bad char '${ch}'`);
        }
        const [r, g, b] = hexToRgb(pal[shade]);
        rgba[off] = r;
        rgba[off + 1] = g;
        rgba[off + 2] = b;
        rgba[off + 3] = 255;
      }
    });
  });

  return encodePng(w, h, rgba);
}

// Font sheet: 8x8 glyphs, 16 per row, two stacked color blocks
// (block 0 = dark for light backgrounds, block 1 = light for dark ones).
function buildFontSheet() {
  const GLYPH_COLS = 16;
  const rows = Math.ceil(CHARSET.length / GLYPH_COLS);
  const w = GLYPH_COLS * 8;
  const blockH = rows * 8;
  const rgba = Buffer.alloc(w * blockH * 2 * 4);
  const colors = [hexToRgb('#0f380f'), hexToRgb('#e8f0d8')];

  colors.forEach(([r, g, b], block) => {
    [...CHARSET].forEach((c, index) => {
      const ox = (index % GLYPH_COLS) * 8;
      const oy = block * blockH + Math.floor(index / GLYPH_COLS) * 8;
      glyphRows(c).forEach((row, y) => {
        for (let x = 0; x < 8; x++) {
          if (row[x] !== 'X') continue;
          const off = ((oy + y) * w + ox + x) * 4;
          rgba[off] = r;
          rgba[off + 1] = g;
          rgba[off + 2] = b;
          rgba[off + 3] = 255;
        }
      });
    });
  });
  return encodePng(w, blockH * 2, rgba);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'tiles0.png'), buildSheet(TILES, { allowTransparent: false }));
writeFileSync(join(OUT, 'sprites0.png'), buildSheet(SPRITES, { allowTransparent: true }));
writeFileSync(join(OUT, 'font0.png'), buildFontSheet());
console.log(
  `tiles0.png: ${TILES.length} tiles; sprites0.png: ${SPRITES.length} sprites; font0.png: ${CHARSET.length} glyphs`,
);
