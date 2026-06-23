// Sprite sheet definitions: 16x16 grids, chars 0-3 = palette ramp index,
// '.' = transparent. Order defines the sprite id; append only.
// Side-facing sprites face LEFT; the sim sets flip-x for right.

function grid(fn) {
  return Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => String(fn(x, y))).join(''),
  );
}

// Small blob helper: ellipse with outline, light from upper-left.
function blob(cx, cy, rx, ry, { hi = 3, mid = 2 } = {}) {
  return (x, y) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1) return '.';
    if (d > 0.82) return 0;
    return dx + dy < -0.5 ? hi : mid;
  };
}

export const SPRITES = [
  // The hero: a hooded adventurer in a teal cloak.
  // palette hero = [0 charcoal, 1 teal cloak, 2 skin, 3 bone highlight]
  {
    name: 'player_down_0',
    palette: 'hero',
    grid: [
      '.....00000......',
      '....0111110.....',
      '...011333110....',
      '...013333310....',
      '..0113333110....',
      '..0122222210....',
      '..0120220210....',
      '..0122222210....',
      '..0011222100....',
      '.011112221110...',
      '.011311113110...',
      '.011111111110...',
      '..0111111110....',
      '...0110.0110....',
      '...022..022.....',
      '...000..000.....',
    ],
  },
  {
    name: 'player_down_1',
    palette: 'hero',
    grid: [
      '.....00000......',
      '....0111110.....',
      '...011333110....',
      '...013333310....',
      '..0113333110....',
      '..0122222210....',
      '..0120220210....',
      '..0122222210....',
      '..0011222100....',
      '.011112221110...',
      '.011311113110...',
      '.011111111110...',
      '..0111111110....',
      '..0110...0110...',
      '..022.....022...',
      '..000.....000...',
    ],
  },
  {
    name: 'player_up_0',
    palette: 'hero',
    grid: [
      '.....00000......',
      '....0111110.....',
      '...011111110....',
      '...013333310....',
      '..0113333110....',
      '..0113333110....',
      '..0111111110....',
      '..0111111110....',
      '..0011111100....',
      '.011133311110...',
      '.011311113110...',
      '.011111111110...',
      '..0111111110....',
      '...0110.0110....',
      '...022..022.....',
      '...000..000.....',
    ],
  },
  {
    name: 'player_up_1',
    palette: 'hero',
    grid: [
      '.....00000......',
      '....0111110.....',
      '...011111110....',
      '...013333310....',
      '..0113333110....',
      '..0113333110....',
      '..0111111110....',
      '..0111111110....',
      '..0011111100....',
      '.011133311110...',
      '.011311113110...',
      '.011111111110...',
      '..0111111110....',
      '..0110...0110...',
      '..022.....022...',
      '..000.....000...',
    ],
  },
  {
    name: 'player_side_0',
    palette: 'hero',
    grid: [
      '....00000.......',
      '...0111110......',
      '..01133110......',
      '..01333310......',
      '..0133331100....',
      '..0122221100....',
      '..0120222100....',
      '..0112222100....',
      '...011221100....',
      '..01133331100...',
      '..01113111100...',
      '..01111111100...',
      '...011111100....',
      '...011.0110.....',
      '...022.022......',
      '...00..000......',
    ],
  },
  {
    name: 'player_side_1',
    palette: 'hero',
    grid: [
      '....00000.......',
      '...0111110......',
      '..01133110......',
      '..01333310......',
      '..0133331100....',
      '..0122221100....',
      '..0120222100....',
      '..0112222100....',
      '...011221100....',
      '..01133331100...',
      '..01113111100...',
      '..01111111100...',
      '...011111100....',
      '....011110......',
      '...022.022......',
      '...000.000......',
    ],
  },

  // ---- weapons ----
  {
    name: 'sword_down',
    palette: 'stone',
    grid: [
      '......0110......',
      '......0220......',
      '......0220......',
      '......0220......',
      '......0220......',
      '......0330......',
      '......0330......',
      '......0330......',
      '....00033000....',
      '....01133110....',
      '....00033000....',
      '......0110......',
      '......0110......',
      '......0000......',
      '................',
      '................',
    ],
  },
  {
    name: 'sword_up',
    palette: 'stone',
    grid: [
      '................',
      '................',
      '......0000......',
      '......0110......',
      '......0110......',
      '....00033000....',
      '....01133110....',
      '....00033000....',
      '......0330......',
      '......0330......',
      '......0330......',
      '......0220......',
      '......0220......',
      '......0220......',
      '......0220......',
      '......0110......',
    ],
  },
  {
    name: 'sword_side',
    palette: 'stone',
    grid: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '......00........',
      '......010.......',
      '.000003110......',
      '0122333333000...',
      '.000003110......',
      '......010.......',
      '......00........',
      '................',
      '................',
      '................',
      '................',
    ],
  },

  // ---- enemies (2 frames each) ----
  {
    name: 'thornling_0',
    palette: 'grass',
    grid: grid((x, y) => {
      const spikes = [[7, 1], [2, 5], [13, 5], [3, 12], [12, 12]];
      for (const [sx, sy] of spikes) {
        if (Math.abs(x - sx) <= 0 && Math.abs(y - sy) <= 1) return 0;
      }
      const b = blob(7.5, 8, 5.5, 5)(x, y);
      if (b === '.') return '.';
      // face
      if (y === 7 && (x === 5 || x === 10)) return 0;
      if (y === 10 && x >= 6 && x <= 9) return 0;
      return b;
    }),
  },
  {
    name: 'thornling_1',
    palette: 'grass',
    grid: grid((x, y) => {
      const spikes = [[4, 1], [11, 1], [1, 8], [14, 8], [7, 13]];
      for (const [sx, sy] of spikes) {
        if (Math.abs(x - sx) <= 0 && Math.abs(y - sy) <= 1) return 0;
      }
      const b = blob(7.5, 8, 5.5, 5)(x, y);
      if (b === '.') return '.';
      if (y === 8 && (x === 5 || x === 10)) return 0;
      if (y === 11 && x >= 6 && x <= 9) return 0;
      return b;
    }),
  },
  {
    name: 'snapcrab_0',
    palette: 'sand',
    grid: grid((x, y) => {
      // claws
      if ((y === 4 || y === 5) && (x <= 2 || x >= 13)) return 1;
      // legs
      if (y >= 12 && y <= 13 && (x === 2 || x === 5 || x === 10 || x === 13)) return 0;
      const b = blob(7.5, 8.5, 5.5, 4)(x, y);
      if (b === '.') return '.';
      if (y === 7 && (x === 5 || x === 10)) return 0; // eyes
      return b;
    }),
  },
  {
    name: 'snapcrab_1',
    palette: 'sand',
    grid: grid((x, y) => {
      if ((y === 3 || y === 4) && (x <= 2 || x >= 13)) return 1;
      if (y >= 12 && y <= 13 && (x === 3 || x === 6 || x === 9 || x === 12)) return 0;
      const b = blob(7.5, 8.5, 5.5, 4)(x, y);
      if (b === '.') return '.';
      if (y === 7 && (x === 5 || x === 10)) return 0;
      return b;
    }),
  },
  {
    name: 'gel_0',
    palette: 'water',
    grid: grid((x, y) => {
      const b = blob(7.5, 9.5, 5, 4.2)(x, y);
      if (b === '.') return '.';
      if (y === 9 && (x === 5 || x === 10)) return 0;
      return b;
    }),
  },
  {
    name: 'gel_1',
    palette: 'water',
    grid: grid((x, y) => {
      const b = blob(7.5, 8, 4.2, 5.2)(x, y);
      if (b === '.') return '.';
      if (y === 8 && (x === 5 || x === 10)) return 0;
      return b;
    }),
  },
  {
    name: 'wasp_0',
    palette: 'sand',
    grid: grid((x, y) => {
      // wings up
      if ((y === 2 || y === 3) && (x >= 3 && x <= 5)) return 3;
      if ((y === 2 || y === 3) && (x >= 10 && x <= 12)) return 3;
      // stripes on body
      const b = blob(7.5, 8.5, 4, 4.5)(x, y);
      if (b === '.') {
        // stinger
        if (y >= 13 && y <= 14 && x === 7) return 0;
        return '.';
      }
      if (y === 7 && (x === 5 || x === 10)) return 0;
      if (b !== 0 && (y === 9 || y === 11)) return 1;
      return b;
    }),
  },
  {
    name: 'wasp_1',
    palette: 'sand',
    grid: grid((x, y) => {
      if (y === 5 && (x === 2 || x === 13)) return 3;
      if (y === 6 && (x >= 1 && x <= 3)) return 3;
      if (y === 6 && (x >= 12 && x <= 14)) return 3;
      const b = blob(7.5, 8.5, 4, 4.5)(x, y);
      if (b === '.') {
        if (y >= 13 && y <= 14 && x === 7) return 0;
        return '.';
      }
      if (y === 7 && (x === 5 || x === 10)) return 0;
      if (b !== 0 && (y === 9 || y === 11)) return 1;
      return b;
    }),
  },
  {
    name: 'snatcher_0',
    palette: 'wood',
    grid: grid((x, y) => {
      // ears
      if (y >= 2 && y <= 4 && (x === 4 || x === 10)) return 1;
      // tail
      if (y === 10 && x >= 13) return 1;
      const b = blob(7, 9, 4.5, 4)(x, y);
      if (b === '.') {
        if (y >= 13 && (x === 4 || x === 9)) return 0; // feet
        return '.';
      }
      if (y === 8 && (x === 5 || x === 9)) return 0;
      if (y === 10 && x === 7) return 0; // snout
      return b;
    }),
  },
  {
    name: 'snatcher_1',
    palette: 'wood',
    grid: grid((x, y) => {
      if (y >= 2 && y <= 4 && (x === 5 || x === 11)) return 1;
      if (y === 9 && x >= 13) return 1;
      const b = blob(7, 9, 4.5, 4)(x, y);
      if (b === '.') {
        if (y >= 13 && (x === 5 || x === 10)) return 0;
        return '.';
      }
      if (y === 8 && (x === 5 || x === 9)) return 0;
      if (y === 10 && x === 7) return 0;
      return b;
    }),
  },

  // ---- projectiles & pickups ----
  {
    name: 'seed',
    palette: 'grass',
    grid: grid((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 3) return '.';
      if (d > 2.2) return 0;
      return x + y < 14 ? 3 : 2;
    }),
  },
  {
    name: 'heart_drop',
    palette: 'hero',
    grid: [
      '................',
      '................',
      '................',
      '....00...00.....',
      '...0220.0220....',
      '..022220222200..',
      '..022222222220..',
      '..023222222220..',
      '..023222222220..',
      '...0222222220...',
      '....02222220....',
      '.....022220.....',
      '......0220......',
      '.......00.......',
      '................',
      '................',
    ],
  },
  {
    name: 'shell_drop',
    palette: 'sand',
    grid: [
      '................',
      '................',
      '................',
      '......0000......',
      '....00333300....',
      '...0332233230...',
      '..033223322330..',
      '..032233223230..',
      '..033223322330..',
      '...0332233230...',
      '....00333300....',
      '......0000......',
      '................',
      '................',
      '................',
      '................',
    ],
  },

  // ---- player gear ----
  {
    name: 'itm_stick',
    palette: 'wood',
    grid: grid((x, y) => {
      // a gnarled branch, diagonal, with a couple of nubs
      if (x - y >= -1 && x - y <= 1 && x >= 2 && x <= 13) {
        return x < 6 ? 1 : 2;
      }
      if (x === 4 && y === 6) return 1; // nub
      if (x === 10 && y === 8) return 1; // nub
      return '.';
    }),
  },
  {
    name: 'itm_bow',
    palette: 'wood',
    grid: grid((x, y) => {
      // curved bow facing left, string on the right
      const d = Math.hypot(x - 11, y - 7.5);
      if (d > 5.2 && d < 7 && x < 11) return d > 6.2 ? 0 : 2;
      if (x === 11 && y >= 2 && y <= 13) return 3; // string
      return '.';
    }),
  },
  {
    name: 'itm_shield',
    palette: 'wood',
    grid: grid((x, y) => {
      const w = y < 9 ? 5 : Math.max(1, 5 - (y - 9));
      const dx = Math.abs(x - 7.5);
      if (y >= 2 && y <= 13 && dx < w) {
        if (dx > w - 1.2 || y === 2) return 0;
        if (dx < 1 && y >= 4 && y <= 9) return 3; // boss stripe
        return y % 2 ? 2 : 1;
      }
      return '.';
    }),
  },
  {
    // Iron shield: a sturdier kite shield in cold steel with corner rivets and
    // a raised central boss. Sturdier than the wooden shield (durability 40).
    name: 'itm_ironshield',
    palette: 'stone',
    grid: grid((x, y) => {
      const w = y < 9 ? 5 : Math.max(1, 5 - (y - 9));
      const dx = Math.abs(x - 7.5);
      if (y >= 2 && y <= 13 && dx < w) {
        if (dx > w - 1.2 || y === 2) return 0; // dark rim
        // central round boss
        if (Math.hypot(x - 7.5, y - 7) < 1.6) return 3;
        // rivet studs near the corners
        if ((y === 4 || y === 11) && dx > w - 2.4 && dx < w - 0.8) return 3;
        return (x + y) % 2 ? 2 : 1; // brushed-metal sheen
      }
      return '.';
    }),
  },
  {
    name: 'itm_bomb',
    palette: 'stone',
    grid: grid((x, y) => {
      // fuse
      if (y <= 3 && x === 9 - y) return y === 0 ? 3 : 1;
      const d = Math.hypot(x - 7.5, y - 9.5);
      if (d > 4.8) return '.';
      if (d > 3.9) return 0;
      return x + y < 15 ? 2 : 1;
    }),
  },
  {
    name: 'arrow_h',
    palette: 'wood',
    grid: grid((x, y) => {
      // points LEFT
      if (y === 7 && x >= 2 && x <= 13) return x < 5 ? 3 : 2;
      if ((y === 6 || y === 8) && x >= 2 && x <= 4) return 3;
      if ((y === 6 || y === 8) && x >= 12) return 1; // fletching
      if ((y === 5 || y === 9) && x >= 13) return 1;
      return '.';
    }),
  },
  {
    name: 'arrow_v',
    palette: 'wood',
    grid: grid((x, y) => {
      // points UP
      if (x === 7 && y >= 2 && y <= 13) return y < 5 ? 3 : 2;
      if ((x === 6 || x === 8) && y >= 2 && y <= 4) return 3;
      if ((x === 6 || x === 8) && y >= 12) return 1;
      if ((x === 5 || x === 9) && y >= 13) return 1;
      return '.';
    }),
  },
  {
    name: 'blast_0',
    palette: 'sand',
    grid: grid((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 6) return '.';
      if (d > 4.5) return (x + y) % 2 ? 3 : '.';
      return d < 2.5 ? 3 : 2;
    }),
  },
  {
    name: 'blast_1',
    palette: 'sand',
    grid: grid((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 7.4) return '.';
      if (d > 5.5) return (x * 3 + y) % 3 ? '.' : 3;
      if (d > 3) return (x + y) % 2 ? 2 : 1;
      return '.'; // hollow center as it dissipates
    }),
  },

  // ---- skills: fishing/cooking/hunting ----
  {
    name: 'itm_rod',
    palette: 'wood',
    grid: grid((x, y) => {
      // diagonal rod with a line and hook
      if (x - y === -1 || x - y === 0) {
        if (x >= 2 && x <= 10) return x < 5 ? 1 : 2;
      }
      if (x === 11 && y >= 11 && y <= 13) return 3; // line
      if (y === 13 && x >= 10 && x <= 11) return 3;
      if (y === 12 && x === 10) return 3;
      return '.';
    }),
  },
  {
    name: 'bobber',
    palette: 'hero',
    grid: grid((x, y) => {
      const d = Math.hypot(x - 7.5, y - 8);
      if (d > 3) return '.';
      if (d > 2.2) return 0;
      return y < 8 ? 3 : 2;
    }),
  },
  {
    name: 'itm_fish',
    palette: 'water',
    grid: grid((x, y) => {
      const dx = (x - 6.5) / 1.6;
      const dy = (y - 8) / 1.05;
      if (Math.sqrt(dx * dx + dy * dy) < 3) {
        if (y === 7 && x === 4) return 0; // eye
        return Math.sqrt(dx * dx + dy * dy) > 2.5 ? 0 : x % 3 === 0 ? 3 : 2;
      }
      // tail
      if (x >= 11 && x <= 13 && Math.abs(y - 8) <= x - 11) return 2;
      return '.';
    }),
  },
  {
    name: 'itm_herb',
    palette: 'grass',
    grid: grid((x, y) => {
      // three sprigs
      if (x === 7 && y >= 5 && y <= 12) return 1;
      if (x - y === -1 && y >= 6 && y <= 9) return 2;
      if (x + y === 16 && y >= 6 && y <= 9) return 2;
      if ((y === 5 && (x === 5 || x === 9)) || (y === 4 && x === 7)) return 3;
      return '.';
    }),
  },
  {
    name: 'itm_mushroom',
    palette: 'sand',
    grid: grid((x, y) => {
      // cap
      const d = Math.hypot(x - 7.5, (y - 7) * 1.4);
      if (y <= 7 && d < 5) return d > 4 ? 0 : (x + y) % 4 === 0 ? 3 : 2;
      // stem
      if (y > 7 && y <= 12 && x >= 6 && x <= 9) return y === 12 ? 0 : 1;
      return '.';
    }),
  },
  {
    name: 'itm_meat',
    palette: 'wood',
    grid: grid((x, y) => {
      const d = Math.hypot((x - 8) * 1.1, y - 7);
      if (d < 4.5) return d > 3.6 ? 0 : x < 8 ? 3 : 2;
      // bone
      if (y >= 10 && y <= 11 && x >= 9 && x <= 13) return 3;
      return '.';
    }),
  },
  {
    name: 'itm_food',
    palette: 'sand',
    grid: grid((x, y) => {
      // steaming bowl
      if (y >= 8 && y <= 12) {
        const w = y <= 10 ? 6 : 8 - y + 4;
        if (Math.abs(x - 7.5) < w) return y === 8 ? 3 : Math.abs(x - 7.5) > w - 1.3 ? 0 : 2;
      }
      if ((x === 6 || x === 9) && (y === 4 || y === 6)) return 1; // steam
      if ((x === 7 || x === 8) && y === 5) return 1;
      return '.';
    }),
  },
  {
    name: 'hare_0',
    palette: 'sand',
    grid: grid((x, y) => {
      // ears
      if ((x === 5 || x === 8) && y >= 2 && y <= 5) return 2;
      const b = blob(7, 10, 4, 3.4)(x, y);
      if (b === '.') {
        if (y === 14 && (x === 5 || x === 9)) return 0;
        return '.';
      }
      if (y === 9 && (x === 5 || x === 8)) return 0;
      return b === 2 ? 3 : b;
    }),
  },
  {
    name: 'hare_1',
    palette: 'sand',
    grid: grid((x, y) => {
      if ((x === 5 || x === 8) && y >= 3 && y <= 6) return 2;
      const b = blob(7, 10.5, 4, 3)(x, y);
      if (b === '.') {
        if (y === 14 && (x === 4 || x === 10)) return 0;
        return '.';
      }
      if (y === 9 && (x === 5 || x === 8)) return 0;
      return b === 2 ? 3 : b;
    }),
  },
  {
    name: 'stag_0',
    palette: 'wood',
    grid: grid((x, y) => {
      // antlers
      if (y <= 3 && (x === 3 || x === 6 || x === 9 || x === 12) && y >= 1) return 3;
      if (y === 4 && (x === 4 || x === 5 || x === 10 || x === 11)) return 3;
      // head + body
      const b = blob(7.5, 9, 4.6, 4)(x, y);
      if (b === '.') {
        if (y >= 13 && (x === 5 || x === 10)) return 0; // legs
        return '.';
      }
      if (y === 8 && (x === 6 || x === 9)) return 0;
      return b;
    }),
  },
  {
    name: 'stag_1',
    palette: 'wood',
    grid: grid((x, y) => {
      if (y <= 3 && (x === 3 || x === 6 || x === 9 || x === 12) && y >= 1) return 3;
      if (y === 4 && (x === 4 || x === 5 || x === 10 || x === 11)) return 3;
      const b = blob(7.5, 9.5, 4.6, 3.6)(x, y);
      if (b === '.') {
        if (y >= 13 && (x === 4 || x === 11)) return 0;
        return '.';
      }
      if (y === 8 && (x === 6 || x === 9)) return 0;
      return b;
    }),
  },

  // ---- NPCs ----
  {
    name: 'npc_elder',
    palette: 'wood',
    grid: [
      '................',
      '....00000000....',
      '...0333333330...',
      '..033333333330..',
      '..033222222330..',
      '..032022220230..',
      '..032222222230..',
      '...0222112220...',
      '...0221111220...',
      '..011111111110..',
      '.01111111111110.',
      '.01111111111110.',
      '..011111111110..',
      '...0110..0110...',
      '...0000..0000...',
      '................',
    ],
  },
  {
    name: 'npc_a',
    palette: 'water',
    grid: [
      '................',
      '....00000000....',
      '...0111111110...',
      '..011111111110..',
      '..011222222110..',
      '..022022220220..',
      '..022222222220..',
      '...0222222220...',
      '..033333333330..',
      '.03333333333330.',
      '.02233333333220.',
      '..033333333330..',
      '..033333333330..',
      '...0110..0110...',
      '...0000..0000...',
      '................',
    ],
  },
  {
    name: 'npc_b',
    palette: 'sand',
    grid: [
      '................',
      '....00000000....',
      '...0222222220...',
      '..022222222220..',
      '..022333333220..',
      '..023023320320..',
      '..023333333320..',
      '...0333333330...',
      '..011111111110..',
      '.01111111111110.',
      '.03311111111330.',
      '..011111111110..',
      '..011111111110..',
      '...0110..0110...',
      '...0000..0000...',
      '................',
    ],
  },

  // ---- dungeon enemies & boss ----
  {
    name: 'pip_0',
    palette: 'stone',
    grid: grid((x, y) => {
      // bat: wings spread
      if (y >= 5 && y <= 8 && (x <= 4 || x >= 11)) {
        const wx = x <= 4 ? x : 15 - x;
        return y - 5 <= wx ? 2 : '.';
      }
      const b = blob(7.5, 7, 2.6, 3)(x, y);
      if (b === '.') return '.';
      if (y === 6 && (x === 6 || x === 9)) return 3;
      return b === 3 ? 2 : b;
    }),
  },
  {
    name: 'pip_1',
    palette: 'stone',
    grid: grid((x, y) => {
      // wings up
      if (y >= 2 && y <= 6 && (x <= 4 || x >= 11)) {
        const wx = x <= 4 ? x : 15 - x;
        return 6 - y <= wx ? 2 : '.';
      }
      const b = blob(7.5, 8, 2.6, 3)(x, y);
      if (b === '.') return '.';
      if (y === 7 && (x === 6 || x === 9)) return 3;
      return b === 3 ? 2 : b;
    }),
  },
  {
    name: 'sentry_0',
    palette: 'grass',
    grid: grid((x, y) => {
      // rooted knot of wood with one eye
      if (y >= 12 && (x === 4 || x === 8 || x === 11)) return 0; // roots
      const b = blob(7.5, 8, 5, 4.6)(x, y);
      if (b === '.') return '.';
      if (Math.hypot(x - 7.5, y - 7) < 1.8) return 3; // eye
      return (x * 2 + y) % 5 === 0 ? 0 : b === 3 ? 2 : b;
    }),
  },
  {
    name: 'sentry_1',
    palette: 'grass',
    grid: grid((x, y) => {
      if (y >= 12 && (x === 5 || x === 9 || x === 12)) return 0;
      const b = blob(7.5, 8.5, 5, 4.2)(x, y);
      if (b === '.') return '.';
      if (Math.hypot(x - 7.5, y - 7.5) < 1.4) return 3;
      return (x * 2 + y) % 5 === 0 ? 0 : b === 3 ? 2 : b;
    }),
  },
  {
    // Top-left quadrant of the 32x32 boss; mirrored x/y at render time.
    name: 'moldra_0',
    palette: 'grass',
    grid: grid((x, y) => {
      // gnarled root mass radiating from the bottom-right corner
      const d = Math.hypot(15 - x, 15 - y);
      if (d > 14) return '.';
      if (d > 12.5) return 0;
      const vein = (Math.atan2(15 - y, 15 - x) * 8) | 0;
      if (vein % 2 === 0 && d > 5) return 1;
      if (d < 4.5) return 0; // dark core
      return (x + y) % 7 === 0 ? 3 : 2;
    }),
  },
  {
    name: 'moldra_1',
    palette: 'grass',
    grid: grid((x, y) => {
      const d = Math.hypot(15 - x, 15 - y);
      if (d > 14.5) return '.';
      if (d > 13) return 0;
      const vein = (Math.atan2(15 - y, 15 - x) * 8 + 1) | 0;
      if (vein % 2 === 0 && d > 5.5) return 1;
      if (d < 4) return 0;
      return (x + y) % 7 === 3 ? 3 : 2;
    }),
  },

  // ---- keys ----
  {
    name: 'itm_key',
    palette: 'sand',
    grid: grid((x, y) => {
      const d = Math.hypot(x - 5, y - 5);
      if (d < 3.2 && d > 1.6) return 3; // bow ring
      if (x - y === 0 && x >= 6 && x <= 11) return 3; // shaft
      if (y === 11 && x >= 10 && x <= 11) return 3; // teeth
      if (y === 12 && x === 10) return 3;
      return '.';
    }),
  },
  {
    name: 'itm_bosskey',
    palette: 'hero',
    grid: grid((x, y) => {
      const d = Math.hypot(x - 5, y - 5);
      if (d < 3.8 && d > 1.4) return y < 5 ? 3 : 2;
      if (x - y === 0 && x >= 6 && x <= 12) return 2;
      if (y === 11 && x >= 10 && x <= 12) return 2;
      if (y === 13 && x === 11) return 2;
      return '.';
    }),
  },

  // ---- materials (drops; inventory icons in Phase 4) ----
  {
    name: 'mat_claw',
    palette: 'sand',
    grid: grid((x, y) => {
      // curved pincer shape
      const d = Math.hypot(x - 8, y - 9);
      if (d < 5 && d > 2.5 && x <= 9 && y <= 12) return d > 4.2 ? 0 : 3;
      if (y >= 9 && y <= 11 && x >= 8 && x <= 12) return y === 10 ? 2 : 0;
      return '.';
    }),
  },
  {
    name: 'mat_stinger',
    palette: 'stone',
    grid: grid((x, y) => {
      if (x >= 6 && x <= 9 && y >= 3 && y <= 6 && Math.abs(x - 7.5) < (y - 2) / 1.5) {
        return 1;
      }
      if (y > 6 && y <= 13 && Math.abs(x - 7.5) < (14 - y) / 2) return y < 10 ? 3 : 2;
      return '.';
    }),
  },
  {
    name: 'mat_gelcore',
    palette: 'water',
    grid: grid((x, y) => {
      const d = Math.hypot(x - 7.5, y - 8);
      if (d > 4.5) return '.';
      if (d > 3.6) return 0;
      if (d < 1.8) return 3;
      return 2;
    }),
  },
  {
    name: 'mat_wood',
    palette: 'wood',
    grid: grid((x, y) => {
      if (y < 5 || y > 11) return '.';
      if (x < 2 || x > 13) return '.';
      if (y === 5 || y === 11) return 0;
      if (x === 2 || x === 13) return 0;
      return (x + y) % 5 === 0 ? 1 : 2;
    }),
  },
  {
    name: 'mat_pelt',
    palette: 'wood',
    grid: grid((x, y) => {
      const b = blob(7.5, 8, 5, 4.5)(x, y);
      if (b === '.') return '.';
      if (b === 0) return 0;
      return (x * 3 + y) % 4 === 0 ? 3 : 2;
    }),
  },

  // ---- body parts (swappable attachments; from bracklings & critters) ----
  {
    // Curved ridged horn — defense.
    name: 'part_horn',
    palette: 'sand',
    grid: grid((x, y) => {
      // sweeping crescent from lower-left to upper-right
      const t = (15 - y) / 15;
      const cx = 4 + t * 8;
      const w = 3.2 - t * 2.4;
      const d = Math.abs(x - cx);
      if (d < w && y >= 1 && y <= 14) {
        if (d > w - 1) return 0;
        // ridges across the horn
        return y % 3 === 0 ? 3 : x < cx ? 1 : 2;
      }
      return '.';
    }),
  },
  {
    // Feathered wing — speed.
    name: 'part_wing',
    palette: 'stone',
    grid: grid((x, y) => {
      // fan of feathers sweeping down-left from a top-right shoulder
      const sx = 12, sy = 3;
      const dx = x - sx, dy = y - sy;
      if (dx > 1 || dy < 0) return '.';
      const r = Math.hypot(dx, dy);
      if (r > 11 || r < 2) return '.';
      // feather banding by angle
      const ang = Math.atan2(dy, -dx); // 0..pi/2 ish
      if (ang < 0.15 || ang > 1.45) return '.';
      const band = Math.floor(r) % 3;
      if (r > 9.5) return 0;
      return band === 0 ? 0 : band === 1 ? 3 : 2;
    }),
  },
  {
    // Hooked claw — damage. Beefier than the crab pincer mat_claw.
    name: 'part_claw',
    palette: 'wood',
    grid: grid((x, y) => {
      // talon arc with a sharp tip
      const d = Math.hypot((x - 5) / 1.1, (y - 8) / 1.4);
      if (d > 3.2 && d < 6 && x <= 11) {
        if (d > 5.2) return 0;
        return x < 5 ? 3 : 2;
      }
      // sharp tip pointing up-right
      if (x >= 9 && x <= 13 && y >= 2 && y <= 7 && x - 8 >= y - 1) {
        return x - 8 === y - 1 ? 0 : 3;
      }
      return '.';
    }),
  },
  {
    // Pointed fang — damage.
    name: 'part_fang',
    palette: 'stone',
    grid: grid((x, y) => {
      // tapering tooth, wide at top, point at bottom
      const w = (14 - y) / 2.2;
      if (y >= 2 && y <= 14 && Math.abs(x - 7.5) < w) {
        if (Math.abs(x - 7.5) > w - 1) return 0;
        return y < 6 ? 3 : x < 7.5 ? 2 : 1;
      }
      return '.';
    }),
  },

  // ---- climbing claws (cliff-traversal key item) ----
  {
    // Inventory icon: a pair of clawed climbing gauntlets, hooks splayed.
    name: 'itm_claws',
    palette: 'stone',
    grid: grid((x, y) => {
      // two gauntlet cuffs at the bottom, three hooked talons rising from each
      // toward the top (mirrored left/right).
      const hand = (cx) => {
        // wrist cuff
        if (y >= 11 && y <= 13 && Math.abs(x - cx) <= 2) return y === 13 ? 0 : 2;
        // three talons curving up from the cuff
        for (const k of [-2, 0, 2]) {
          const tx = cx + k + (y < 6 ? Math.sign(k) : 0); // hook the tips inward
          if (y >= 2 && y <= 10 && x === tx) return y <= 4 ? 3 : 1;
          if (y >= 2 && y <= 4 && x === tx + Math.sign(k || 1)) return 0; // tip
        }
        return null;
      };
      const l = hand(4);
      if (l !== null) return l;
      const r = hand(11);
      if (r !== null) return r;
      return '.';
    }),
  },
  {
    // Inventory icon: a crossed pair of ice axes (curved picks, wood hafts).
    name: 'itm_iceaxes',
    palette: 'stone',
    grid: grid((x, y) => {
      // two hafts crossing through the center, a hooked pick head at each top.
      // left haft runs top-left -> bottom-right; right haft mirrors it.
      const onHaft = (down) => {
        // diagonal line: down=true goes \, down=false goes /
        const on = down ? Math.abs(x - y) <= 0 : Math.abs(x + y - 15) <= 0;
        return on && y >= 3 && y <= 13;
      };
      if (onHaft(true) || onHaft(false)) return 1; // wood-dark hafts (stone pal)
      // pick heads (bright) hooking off the tops
      if (y >= 1 && y <= 4) {
        if (x >= 2 && x <= 5 && (x + y) % 2 === 0) return 3; // left head
        if (x >= 10 && x <= 13 && (x + y) % 2 === 0) return 3; // right head
      }
      // metal cuff where they cross
      if (Math.hypot(x - 7.5, y - 7.5) < 2) return 2;
      return '.';
    }),
  },
  {
    // Inventory icon: the EMBER MANTLE — a hooded cloak that glows with banked
    // embers, letting the wearer walk across lava. Drawn with the magma ramp:
    // dark cloth folds with a few bright ember flecks along the hem and clasp.
    name: 'itm_mantle',
    palette: 'magma',
    grid: grid((x, y) => {
      // hood + shoulders: a rounded yoke up top
      const hd = Math.hypot(x - 7.5, y - 4);
      if (hd < 3.2) {
        if (hd > 2.5) return 0; // hood rim
        return 1; // shadowed hood interior
      }
      // cloak body: a wide trapezoid falling from the shoulders to a flared hem
      const halfW = 2.5 + (y - 5) * 0.55;
      if (y >= 5 && y <= 14 && Math.abs(x - 7.5) <= halfW) {
        if (Math.abs(x - 7.5) > halfW - 1) return 0; // dark edge fold
        // central clasp + a vertical seam
        if (Math.abs(x - 7.5) < 0.8) return 1;
        // banked embers: scattered bright flecks, denser toward the hem
        const fleck = y >= 12 ? (x + y) % 3 === 0 : (x * 3 + y) % 7 === 0;
        if (fleck) return 3;
        return 2; // ember-glow cloth
      }
      return '.';
    }),
  },

  // ---- surfboard + waves ----
  {
    // Inventory icon: a longboard seen from above.
    name: 'itm_surfboard',
    palette: 'wood',
    grid: grid((x, y) => {
      const dx = (x - 7.5) / 2.4;
      const dy = (y - 7.5) / 6.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) return '.';
      if (d > 0.82) return 0;
      // center stripe + tint
      if (Math.abs(x - 7.5) < 0.7) return 3;
      return x < 7.5 ? 2 : 1;
    }),
  },
  {
    // Under-player overlay while surfing: a short board with a wake.
    name: 'surf_board',
    palette: 'wood',
    grid: grid((x, y) => {
      // board sits low under the feet
      if (y >= 11 && y <= 14) {
        const dx = (x - 7.5) / 6.5;
        const dy = (y - 12.5) / 2;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 1) return '.';
        if (d > 0.8) return 0;
        return Math.abs(x - 7.5) < 1 ? 3 : 2;
      }
      return '.';
    }),
  },
  {
    // Pushable block: a chunky stone crate that reads as shoveable (beveled
    // edges, a carved arrow-cross hint so players know it slides).
    name: 'block',
    palette: 'stone',
    grid: grid((x, y) => {
      if (x < 1 || x > 14 || y < 1 || y > 14) return '.'; // transparent surround
      if (x === 1 || x === 14 || y === 1 || y === 14) return 0; // dark outer edge
      if (x === 2 || y === 2) return 3; // top/left highlight bevel
      if (x === 13 || y === 13) return 0; // bottom/right shadow bevel
      // carved push-cross in the middle
      if (Math.abs(x - 7.5) < 1 && y >= 5 && y <= 10) return 0;
      if (Math.abs(y - 7.5) < 1 && x >= 5 && x <= 10) return 0;
      return (x + y) % 2 === 0 ? 2 : 1; // stone face
    }),
  },
  {
    name: 'wave_0',
    palette: 'water',
    grid: grid((x, y) => {
      // a horizontal crest with foam flecks
      if (y === 7 || y === 8) return 3;
      if (y === 6 && (x + 0) % 3 === 0) return 2;
      if (y === 9 && (x + 1) % 3 === 0) return 2;
      return '.';
    }),
  },
  {
    name: 'wave_1',
    palette: 'water',
    grid: grid((x, y) => {
      if (y === 7 || y === 8) return 3;
      if (y === 6 && (x + 1) % 3 === 0) return 2;
      if (y === 9 && (x + 2) % 3 === 0) return 2;
      return '.';
    }),
  },

  // ---- bracklings (original-IP goblin fodder; chase & swing / archer) ----
  // A squat goblin: pointed ears, big head, stubby body. `bob` shifts the
  // body 1px for the walk frame; `arms` flags a raised-club / drawn-bow pose.
  ...bracklingFrames('brackling', 'grass'),
  ...bracklingFrames('brackling_blue', 'water'),
  ...bracklingFrames('brackling_archer', 'sand', { archer: true }),

  // ---- frost foes (combat-depth pass; seeded near the foothills, later the
  // Mountain). Cold "stone" palette = icy slate. ----
  // FROST CHARGER: a hunched, broad-horned beast that lowers its head and
  // rushes in a straight line. Two frames bob the body for the run.
  ...frostChargerFrames('frost_charger', 'stone'),
  // RIME WARDEN: an armoured sentinel hauling a heavy slab-shield on its left
  // side. Frontal hits ring off the shield; flank or backstab it.
  ...rimeWardenFrames('rime_warden', 'stone'),

  // GLACE, the RIMEWYRM: the Frostspire boss. Like moldra, only the top-left
  // quadrant of the 32x32 body is drawn here and mirrored x/y at render time —
  // a coiled, crystalline mass of ice radiating from the bottom-right corner.
  ...glaceFrames('glace', 'water'),

  // ---- ember foes (Emberdeep depths; molten contrast to the frost) ----
  // CINDER HOUND: a lean, burning beast that telegraphs then rushes (charger
  // brain). It guards the EMBER MANTLE mid-dungeon. Magma palette = glowing coal.
  ...cinderHoundFrames('cinder_hound', 'magma'),
  // MAGMA SENTINEL: a slag-armoured warden carrying its shield-plate on its
  // (screen-)left; flank or backstab it (ward brain). Seeded into the depths.
  ...rimeWardenFrames('magma_sentinel', 'magma'),
  // PYRA, the MAGMAHEART: the Emberdeep boss. A 32x32 quadrant (mirrored x/y) —
  // a roiling core of molten rock with a blazing crack down its centre.
  ...pyraFrames('pyra', 'magma'),
];

// Two frames for the cinder hound: a low burning quadruped that rushes.
function cinderHoundFrames(name, palette) {
  const body = (bob) =>
    grid((x, y) => {
      const yy = y - bob; // bob on the run frame
      // a low, lean head + shoulders (smaller/leaner than the frost charger)
      const hd = Math.hypot((x - 7.5) / 1.35, (yy - 8) / 0.95);
      if (hd < 4.4) {
        if (hd > 3.6) return 0; // charred outline
        // blazing eyes
        if (yy === 7 && (x === 6 || x === 9)) return 3;
        // open, glowing maw
        if (yy >= 9 && yy <= 10 && x >= 6 && x <= 9) return 3;
        // ember-mottled coat
        return (x * 2 + yy) % 5 === 0 ? 3 : (x + yy) % 2 === 0 ? 2 : 1;
      }
      // a crest of flame flickers along the back
      if (yy >= 3 && yy <= 5 && (x === 5 || x === 8 || x === 11)) return 3;
      // stubby legs
      if (yy >= 13 && (x === 4 || x === 5 || x === 10 || x === 11)) return 0;
      return '.';
    });
  return [
    { name: `${name}_0`, palette, grid: body(0) },
    { name: `${name}_1`, palette, grid: body(1) },
  ];
}

// Two frames for PYRA: a molten boss quadrant (mirrored x/y to a 32x32 body),
// modelled on glaceFrames but with a blazing core crack instead of ice facets.
function pyraFrames(name, palette) {
  const body = (phase) =>
    grid((x, y) => {
      const d = Math.hypot(15 - x, 15 - y);
      if (d > 14.5) return '.';
      if (d > 13) return 0; // charred basalt outline
      // a molten core radiating cracks; bright veins fan out from the centre
      const ang = Math.atan2(15 - y, 15 - x);
      const vein = (((ang * 5) | 0) + phase) % 2 === 0;
      if (d < 4) return 3; // white-hot core
      if (vein && d > 6) return (x + y) % 3 !== 0 ? 3 : 2; // ember veins
      // a glaring eye set into the upper body
      if (x === 9 && y === 9) return 3;
      return (x + y) % 4 === 0 ? 0 : (x + y) % 3 === 0 ? 1 : 2; // crusted slag
    });
  return [
    { name: `${name}_0`, palette, grid: body(0) },
    { name: `${name}_1`, palette, grid: body(1) },
  ];
}

// Two frames for the Rimewyrm boss quadrant (mirrored x/y to a 32x32 body).
function glaceFrames(name, palette) {
  const body = (phase) =>
    grid((x, y) => {
      // crystalline mass radiating from the bottom-right (the body centre)
      const d = Math.hypot(15 - x, 15 - y);
      if (d > 14.5) return '.';
      if (d > 13) return 0; // dark rime outline
      // faceted ice shards: angular bright veins fanning from the core
      const ang = Math.atan2(15 - y, 15 - x);
      const facet = (((ang * 6) | 0) + phase) % 2 === 0;
      if (d < 4.5) return 0; // frozen core
      if (facet && d > 6) return 3; // bright ice glint
      // a cold eye glint set into the upper body
      if (x === 9 && y === 9) return 3;
      return (x + y) % 5 === 0 ? 1 : 2;
    });
  return [
    { name: `${name}_0`, palette, grid: body(0) },
    { name: `${name}_1`, palette, grid: body(1) },
  ];
}

// Two frames for the frost charger: a low, horned quadruped-ish brute.
function frostChargerFrames(name, palette) {
  const body = (bob) =>
    grid((x, y) => {
      const yy = y - bob; // subtle vertical bob on the run frame
      // sweeping horns up top
      if (yy === 3 && (x === 3 || x === 12)) return 3;
      if (yy === 4 && (x === 4 || x === 11)) return 3;
      // low, heavy head + shoulders
      const hd = Math.hypot((x - 7.5) / 1.25, (yy - 8) / 1.05);
      if (hd < 4.6) {
        if (hd > 3.7) return 0;
        // glowing eyes
        if (yy === 7 && (x === 6 || x === 9)) return 3;
        // tusked snout
        if (yy === 10 && x >= 6 && x <= 9) return 3;
        return (x + yy) % 3 === 0 ? 1 : 2;
      }
      // stubby legs
      if (yy >= 13 && (x === 4 || x === 5 || x === 10 || x === 11)) return 0;
      return '.';
    });
  return [
    { name: `${name}_0`, palette, grid: body(0) },
    { name: `${name}_1`, palette, grid: body(1) },
  ];
}

// Two frames for the rime warden: an upright sentinel with a big slab-shield on
// its (screen-)left. `step` shifts the legs for the walk frame.
function rimeWardenFrames(name, palette) {
  const body = (step) =>
    grid((x, y) => {
      // slab shield down the left edge
      if (x >= 1 && x <= 3 && y >= 4 && y <= 13) {
        if (x === 1 || y === 4 || y === 13) return 0; // dark rim
        if (x === 2 && y === 8) return 3; // central boss
        return (x + y) % 2 ? 2 : 1;
      }
      // helmeted head
      const hd = Math.hypot(x - 9, y - 5);
      if (hd < 3.4) {
        if (hd > 2.6) return 0;
        if (y === 5 && (x === 8 || x === 10)) return 0; // visor slit eyes
        return 2;
      }
      // armoured torso
      if (y >= 8 && y <= 13 && x >= 7 && x <= 12) {
        if (y === 13 || x === 7 || x === 12) return 0;
        return (x + y) % 2 ? 1 : 2;
      }
      // legs (alternate for the walk frame)
      if (y >= 14 && y <= 15) {
        const l = step ? [7, 11] : [8, 10];
        if (l.includes(x)) return 0;
      }
      return '.';
    });
  return [
    { name: `${name}_0`, palette, grid: body(0) },
    { name: `${name}_1`, palette, grid: body(1) },
  ];
}

// Two animation frames for a brackling in a given palette.
function bracklingFrames(name, palette, { archer = false } = {}) {
  const body = (bob, raise) =>
    grid((x, y) => {
      const yy = y + bob;
      // pointed ears
      if (yy === 4 && (x === 2 || x === 13)) return 0;
      if (yy === 5 && (x === 3 || x === 12)) return 2;
      // head
      const hd = Math.hypot(x - 7.5, yy - 6);
      if (hd < 4.2) {
        if (hd > 3.3) return 0;
        // eyes + snout
        if (yy === 6 && (x === 6 || x === 9)) return 0;
        if (yy === 8 && x >= 6 && x <= 9) return 3;
        return 2;
      }
      // body
      if (yy >= 9 && yy <= 13 && x >= 5 && x <= 10) {
        if (yy === 13 || x === 5 || x === 10) return 0;
        return 1;
      }
      // legs
      if (yy >= 14 && (x === 5 || x === 6 || x === 9 || x === 10)) return 0;
      // weapon arm: club (melee) or bow (archer), raised on the action frame
      if (raise) {
        if (archer) {
          // simple bow arc on the right side
          if (x >= 11 && x <= 13 && yy >= 6 && yy <= 12 && Math.abs(yy - 9) <= (13 - x) + 2)
            return 3;
        } else {
          // club held up
          if (x >= 11 && x <= 12 && yy >= 3 && yy <= 9) return 3;
          if (yy >= 3 && yy <= 4 && x >= 10 && x <= 13) return 0;
        }
      }
      return '.';
    });
  return [
    { name: `${name}_0`, palette, grid: body(0, false) },
    { name: `${name}_1`, palette, grid: body(1, true) },
  ];
}
