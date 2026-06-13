// Canvas 2D renderer: consumes the packed u16 draw list from the sim and
// paints a 160x144 logical frame, integer-scaled to the page canvas.
// Record format documented in game-src/crates/sim/src/draw.rs.

import { LOGICAL_W, LOGICAL_H } from './config.js';

const RECORD_WORDS = 6;
const COORD_BIAS = 512;
const KIND_TILE = 1;
const KIND_SPRITE = 2;
const KIND_RECT = 3;
const KIND_GLYPH = 4;
const KIND_HPBAR = 5;
const FLAG_FLIP_X = 1;
const FLAG_FLIP_Y = 2;

// HUD/transition rects use this muted ramp (matches palettes.mjs direction):
// dark slate -> deep teal -> sage -> bone. Index 0 is the HUD bar & letterbox.
const SHADES = ['#16181d', '#2f5b4a', '#6f8a5b', '#efe6d2'];

// Health-bar gradient stops, muted to sit inside the GBC palette: a sage-green
// at full, amber midway, dusty red when low. Interpolated by HP ratio.
const HP_STOPS = [
  [0.0, [0xb4, 0x4a, 0x3a]], // low  — dusty red
  [0.5, [0xc9, 0x9a, 0x46]], // mid  — amber
  [1.0, [0x6f, 0x8a, 0x5b]], // full — sage green (matches SHADES[2])
];
function hpColor(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  for (let i = 1; i < HP_STOPS.length; i++) {
    if (r <= HP_STOPS[i][0]) {
      const [lo, c0] = HP_STOPS[i - 1];
      const [hi, c1] = HP_STOPS[i];
      const t = (r - lo) / (hi - lo || 1);
      const mix = (a, b) => Math.round(a + (b - a) * t);
      return `rgb(${mix(c0[0], c1[0])},${mix(c0[1], c1[1])},${mix(c0[2], c1[2])})`;
    }
  }
  const c = HP_STOPS[HP_STOPS.length - 1][1];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.off = document.createElement('canvas');
    this.off.width = LOGICAL_W;
    this.off.height = LOGICAL_H;
    this.ctx = this.off.getContext('2d');
    this.outCtx = canvas.getContext('2d');
    this.sheets = new Map();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /// Crop one 16x16 sprite from the sprite sheet into a small data URL, for
  /// use as an <img> icon in the DOM inventory. Cached by index.
  spriteIcon(index, scale = 2) {
    this._iconCache ??= new Map();
    const key = `${index}@${scale}`;
    if (this._iconCache.has(key)) return this._iconCache.get(key);
    const sheet = this.sheets.get('sprites0');
    if (!sheet) return '';
    const cols = sheet.width >> 4;
    const sx = (index % cols) * 16;
    const sy = Math.floor(index / cols) * 16;
    const c = document.createElement('canvas');
    c.width = 16 * scale;
    c.height = 16 * scale;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.drawImage(sheet, sx, sy, 16, 16, 0, 0, 16 * scale, 16 * scale);
    const url = c.toDataURL();
    this._iconCache.set(key, url);
    return url;
  }

  /// Load spritesheet PNGs; must resolve before the game loop starts.
  async loadSheets(names) {
    await Promise.all(
      names.map(
        (name) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              this.sheets.set(name, img);
              resolve();
            };
            img.onerror = () => reject(new Error(`failed to load sheet ${name}`));
            img.src = `assets/sprites/${name}.png`;
          }),
      ),
    );
  }

  resize() {
    // Reserve vertical space for on-screen controls when they're shown.
    const reserved = document.body.classList.contains('has-touch') ? 210 : 60;
    const scale = Math.max(
      1,
      Math.min(
        Math.floor(window.innerWidth / LOGICAL_W),
        Math.floor((window.innerHeight - reserved) / LOGICAL_H),
      ),
    );
    this.canvas.width = LOGICAL_W * scale;
    this.canvas.height = LOGICAL_H * scale;
    this.outCtx.imageSmoothingEnabled = false;
  }

  draw(list) {
    const ctx = this.ctx;
    ctx.fillStyle = SHADES[0];
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    // World (tiles + sprites) clips to the playfield below the 16px HUD bar,
    // so screen-scroll transitions never paint over the HUD.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 16, LOGICAL_W, LOGICAL_H - 16);
    ctx.clip();

    for (let i = 0; i + RECORD_WORDS <= list.length; i += RECORD_WORDS) {
      const kind = list[i];
      const a = list[i + 1];
      const x = list[i + 2] - COORD_BIAS;
      const y = list[i + 3] - COORD_BIAS;
      const d = list[i + 4];
      const e = list[i + 5];

      if (kind === KIND_RECT || kind === KIND_GLYPH || kind === KIND_HPBAR) {
        // Rects, glyphs and the HP bar escape the playfield clip (HUD layer).
        ctx.restore();
        if (kind === KIND_RECT) {
          ctx.fillStyle = SHADES[a & 3];
          ctx.fillRect(x, y, d, e);
        } else if (kind === KIND_HPBAR) {
          // a = fill permille (0..1000). Dark track, then a colored fill whose
          // hue tracks remaining health.
          const ratio = a / 1000;
          ctx.fillStyle = SHADES[0];
          ctx.fillRect(x, y, d, e);
          const fillW = Math.round(d * ratio);
          if (fillW > 0) {
            ctx.fillStyle = hpColor(ratio);
            ctx.fillRect(x, y, fillW, e);
          }
        } else {
          this.drawGlyph(a, x, y, d);
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 16, LOGICAL_W, LOGICAL_H - 16);
        ctx.clip();
      } else if (kind === KIND_TILE || kind === KIND_SPRITE) {
        this.drawSheetTile(kind, a, x, y, d, e);
      }
    }
    ctx.restore();

    this.outCtx.imageSmoothingEnabled = false;
    this.outCtx.drawImage(this.off, 0, 0, this.canvas.width, this.canvas.height);
  }

  /// 8x8 glyphs from font0; variant 0 = dark block (bottom half of the
  /// sheet is generated as a second color block), 1 = light.
  drawGlyph(index, x, y, variant) {
    const sheet = this.sheets.get('font0');
    if (!sheet) return;
    const cols = sheet.width >> 3;
    const blockH = sheet.height / 2;
    const sx = (index % cols) * 8;
    const sy = Math.floor(index / cols) * 8 + (variant === 1 ? blockH : 0);
    this.ctx.drawImage(sheet, sx, sy, 8, 8, x, y, 8, 8);
  }

  drawSheetTile(kind, index, x, y, palette, flags) {
    const sheet = this.sheets.get(kind === KIND_TILE ? `tiles${palette}` : `sprites${palette}`);
    if (!sheet) return;
    const cols = sheet.width >> 4;
    const sx = (index % cols) * 16;
    const sy = Math.floor(index / cols) * 16;
    const ctx = this.ctx;
    if (flags & (FLAG_FLIP_X | FLAG_FLIP_Y)) {
      ctx.save();
      ctx.translate(x + 8, y + 8);
      ctx.scale(flags & FLAG_FLIP_X ? -1 : 1, flags & FLAG_FLIP_Y ? -1 : 1);
      ctx.drawImage(sheet, sx, sy, 16, 16, -8, -8, 16, 16);
      ctx.restore();
    } else {
      ctx.drawImage(sheet, sx, sy, 16, 16, x, y, 16, 16);
    }
  }
}
