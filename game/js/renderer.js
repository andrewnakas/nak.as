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
const FLAG_FLIP_X = 1;
const FLAG_FLIP_Y = 2;

// Default GBC-style 4-shade ramp; real per-layer palettes arrive with the
// sprite pipeline in Phase 1.
const SHADES = ['#0f380f', '#306230', '#8bac0f', '#9bbc0e'];

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
    const scale = Math.max(
      1,
      Math.min(
        Math.floor(window.innerWidth / LOGICAL_W),
        Math.floor((window.innerHeight - 60) / LOGICAL_H),
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

      if (kind === KIND_RECT || kind === KIND_GLYPH) {
        // Rects and glyphs escape the playfield clip (the HUD uses them).
        ctx.restore();
        if (kind === KIND_RECT) {
          ctx.fillStyle = SHADES[a & 3];
          ctx.fillRect(x, y, d, e);
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
