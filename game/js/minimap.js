// Zelda-style discovered-screens minimap.
//
// The overworld is a grid of screens. As the player walks into a screen it's
// "discovered" and added to a persisted set; the minimap draws the discovered
// region as a grid of cells, with the current screen highlighted and party
// members / other nearby players as dots. Discovery persists per character in
// localStorage so the map fills in across sessions.

const CELL = 7; // px per screen cell on the minimap
const GAP = 1;
const PAD = 3;

// Muted GBC-ish palette to match the HUD.
const COL = {
  frame: 'rgba(22,24,29,0.82)',
  border: '#6f8a5b',
  undiscovered: 'rgba(47,91,74,0.18)',
  discovered: '#2f5b4a',
  current: '#efe6d2',
  self: '#efe6d2',
  party: '#c99a46',
  other: '#6f8a5b',
};

export class Minimap {
  /// worldJson: the parsed world bundle (for screen bounds).
  /// charKey: a stable per-character key for persistence.
  constructor(worldJson, charKey) {
    // The bundle nests the map under `world`; accept either shape.
    const screens = worldJson.world?.screens ?? worldJson.screens ?? [];
    this.minX = Math.min(...screens.map((s) => s.x));
    this.maxX = Math.max(...screens.map((s) => s.x));
    this.minY = Math.min(...screens.map((s) => s.y));
    this.maxY = Math.max(...screens.map((s) => s.y));
    this.cols = this.maxX - this.minX + 1;
    this.rows = this.maxY - this.minY + 1;
    // Which grid cells are real screens (so we never light up the void).
    this.real = new Set(screens.map((s) => `${s.x},${s.y}`));
    this.key = `naks_map_${charKey || 'guest'}`;
    this.visited = new Set(this._load());
    this.expanded = false; // tap to toggle a larger view (mobile)

    this.canvas = document.getElementById('minimap');
    this.ctx = this.canvas?.getContext('2d');
    if (this.canvas) {
      this.canvas.addEventListener('click', () => {
        this.expanded = !this.expanded;
        this._resize();
      });
      this._resize();
    }
  }

  _load() {
    try {
      return JSON.parse(localStorage.getItem(this.key) || '[]');
    } catch {
      return [];
    }
  }

  _save() {
    try {
      localStorage.setItem(this.key, JSON.stringify([...this.visited]));
    } catch {
      // storage full / private mode — fine, map just won't persist
    }
  }

  /// Mark the player's current screen discovered. Returns true if it was new.
  visit(sx, sy) {
    const k = `${sx},${sy}`;
    if (!this.real.has(k) || this.visited.has(k)) return false;
    this.visited.add(k);
    this._save();
    this._resize();
    return true;
  }

  _scale() {
    return this.expanded ? 2 : 1;
  }

  _resize() {
    if (!this.canvas) return;
    const s = this._scale();
    const w = PAD * 2 + this.cols * (CELL * s + GAP) - GAP;
    const h = PAD * 2 + this.rows * (CELL * s + GAP) - GAP;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /// Draw the map. `self` = {sx,sy}; `others` = [{sx,sy,party}] for live dots.
  render(self, others = []) {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this._scale();
    const cell = CELL * s;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Frame.
    ctx.fillStyle = COL.frame;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = COL.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, this.canvas.width - 1, this.canvas.height - 1);

    const cx = (gx) => PAD + (gx - this.minX) * (cell + GAP);
    const cy = (gy) => PAD + (gy - this.minY) * (cell + GAP);

    // Cells.
    for (let gy = this.minY; gy <= this.maxY; gy++) {
      for (let gx = this.minX; gx <= this.maxX; gx++) {
        const k = `${gx},${gy}`;
        if (!this.real.has(k)) continue;
        const isCur = self && gx === self.sx && gy === self.sy;
        ctx.fillStyle = isCur
          ? COL.current
          : this.visited.has(k)
            ? COL.discovered
            : COL.undiscovered;
        ctx.fillRect(cx(gx), cy(gy), cell, cell);
      }
    }

    // Player dots (only on discovered screens so the map isn't a radar).
    const dot = (gx, gy, color) => {
      ctx.fillStyle = color;
      const r = Math.max(1.5, s);
      ctx.beginPath();
      ctx.arc(cx(gx) + cell / 2, cy(gy) + cell / 2, r, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const o of others) {
      if (!this.visited.has(`${o.sx},${o.sy}`)) continue;
      dot(o.sx, o.sy, o.party ? COL.party : COL.other);
    }
    if (self) dot(self.sx, self.sy, COL.self);
  }
}
