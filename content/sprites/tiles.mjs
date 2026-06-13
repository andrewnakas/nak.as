// Background tile definitions. Each tile is a 16x16 grid of chars 0-3
// (indices into its 4-shade palette — background tiles have no transparency).
// Order here defines the tile id used in world.json; append only.
//
// Flat textures are generated with tiny deterministic helpers; detailed
// tiles (trees, rocks, buildings) are hand-drawn grids.

// Deterministic per-pixel hash for speck textures (must stay stable forever:
// committed PNGs are the source of truth, but rebuilds should be identical).
function hash(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + salt * 1274126177) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = (h * 1103515245) | 0;
  return ((h ^ (h >> 16)) >>> 0) % 1000;
}

function grid(fn) {
  return Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => String(fn(x, y))).join(''),
  );
}

const speckle = (base, speck, permille, salt) =>
  grid((x, y) => (hash(x, y, salt) < permille ? speck : base));

// Horizontal wave dashes for water.
const waves = (base, crest) =>
  grid((x, y) => {
    const row = y % 8;
    if (row === 1 && (x + Math.floor(y / 8) * 4) % 8 < 3) return crest;
    return base;
  });

export const TILES = [
  { name: 'grass', palette: 'grass', solid: false, grid: speckle(1, 2, 90, 1) },
  { name: 'grass_tuft', palette: 'grass', solid: false, grid: speckle(1, 2, 260, 2) },
  {
    name: 'flowers',
    palette: 'grass',
    solid: false,
    grid: grid((x, y) => {
      const spots = [[3, 4], [11, 3], [6, 11], [13, 12]];
      for (const [fx, fy] of spots) {
        if (Math.abs(x - fx) + Math.abs(y - fy) === 1) return 3;
        if (x === fx && y === fy) return 0;
      }
      return hash(x, y, 3) < 80 ? 2 : 1;
    }),
  },
  { name: 'path', palette: 'sand', solid: false, grid: speckle(2, 1, 110, 4) },
  { name: 'sand', palette: 'sand', solid: false, grid: speckle(2, 3, 160, 5) },
  { name: 'water', palette: 'water', solid: true, water: true, grid: waves(1, 2) },
  { name: 'deep_water', palette: 'water', solid: true, water: true, grid: waves(0, 1) },
  {
    name: 'tree',
    palette: 'grass',
    solid: true,
    tree: true,
    grid: grid((x, y) => {
      // round canopy, light from upper-left, trunk at bottom on grass
      const dx = x - 7.5, dy = y - 6;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 6.8) {
        if (d > 5.6) return 0;
        return dx + dy < -3 ? 3 : 2;
      }
      if (y >= 12 && x >= 6 && x <= 9) return y === 15 ? 1 : 0;
      return hash(x, y, 1) < 90 ? 2 : 1;
    }),
  },
  {
    name: 'pine',
    palette: 'grass',
    solid: true,
    tree: true,
    grid: grid((x, y) => {
      // triangular silhouette
      const half = Math.floor((y + 3) / 2.2);
      const dx = Math.abs(x - 7.5);
      if (y < 13 && dx < half) {
        if (dx > half - 1.2) return 0;
        return x - 7.5 < -(half / 2) ? 3 : 2;
      }
      if (y >= 13 && x >= 6 && x <= 9) return y === 15 ? 1 : 0;
      return hash(x, y, 1) < 90 ? 2 : 1;
    }),
  },
  {
    name: 'bush',
    palette: 'grass',
    solid: true,
    tree: true,
    grid: grid((x, y) => {
      const dx = (x - 7.5) / 1.3, dy = y - 9;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 5.4) {
        if (d > 4.4) return 0;
        return (x + y) % 3 === 0 ? 3 : 2;
      }
      return hash(x, y, 1) < 90 ? 2 : 1;
    }),
  },
  {
    name: 'rock',
    palette: 'stone',
    solid: true,
    grid: grid((x, y) => {
      const dx = (x - 7.5) / 1.4, dy = (y - 9) / 1.1;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 5.2) {
        if (d > 4.2) return 0;
        return dx + dy < -2 ? 3 : x % 5 === 0 ? 1 : 2;
      }
      // grass shows around the rock: reuse grass shades 1/2 is wrong palette;
      // stone palette ground reads as dirt — keep darkest ring
      return hash(x, y, 6) < 100 ? 1 : 0;
    }),
  },
  {
    name: 'cliff',
    palette: 'stone',
    solid: true,
    grid: grid((x, y) => {
      if (y === 0) return 3;
      if (y === 1) return 2;
      if (y >= 14) return 0;
      const crack = hash(0, y, 7) % 14;
      return x === crack ? 0 : 1;
    }),
  },
  {
    name: 'fence',
    palette: 'wood',
    solid: true,
    grid: grid((x, y) => {
      const post = x % 8 < 2;
      if (post && y >= 3 && y <= 13) return x % 8 === 0 ? 2 : 1;
      if ((y === 5 || y === 9) && !post) return 2;
      if ((y === 6 || y === 10) && !post) return 1;
      return hash(x, y, 8) < 90 ? 2 : 1; // grass-ish backdrop in wood ramp
    }),
  },
  {
    name: 'house_wall',
    palette: 'wood',
    solid: true,
    grid: grid((x, y) => {
      if (y % 5 === 0) return 0;
      if (x % 8 === (Math.floor(y / 5) % 2) * 4) return 1;
      return 2;
    }),
  },
  {
    name: 'house_roof',
    palette: 'wood',
    solid: true,
    grid: grid((x, y) => {
      if ((x + y * 2) % 6 < 1) return 1;
      return y % 4 === 0 ? 3 : 2;
    }),
  },
  {
    name: 'house_door',
    palette: 'wood',
    solid: true,
    grid: grid((x, y) => {
      if (x < 2 || x > 13 || y < 1) return 2; // wall surround
      if (x < 4 || x > 11 || y < 3) return 0; // frame
      if (x === 10 && y >= 8 && y <= 9) return 3; // handle
      return 1;
    }),
  },
  {
    name: 'window',
    palette: 'wood',
    solid: true,
    grid: grid((x, y) => {
      if (y % 5 === 0) return 0;
      if (x >= 4 && x <= 11 && y >= 4 && y <= 11) {
        if (x === 4 || x === 11 || y === 4 || y === 11 || x === 7 || x === 8) return 0;
        return 3;
      }
      return 2;
    }),
  },
  {
    name: 'sign',
    palette: 'wood',
    solid: true,
    grid: grid((x, y) => {
      if (y >= 3 && y <= 9 && x >= 2 && x <= 13) {
        if (y === 3 || y === 9 || x === 2 || x === 13) return 0;
        return (y === 5 || y === 7) && x >= 4 && x <= 11 && x % 3 !== 0 ? 1 : 2;
      }
      if (y > 9 && y < 15 && x >= 7 && x <= 8) return 1;
      return hash(x, y, 9) < 90 ? 2 : 1;
    }),
  },
  {
    name: 'dock',
    palette: 'wood',
    solid: false,
    grid: grid((x, y) => {
      if (y % 4 === 0) return 0;
      if (x === 0 || x === 15) return 1;
      return hash(0, y, 10) % 5 === 0 && x % 7 === 3 ? 1 : 2;
    }),
  },
  {
    name: 'tall_grass',
    palette: 'grass',
    solid: false,
    grid: grid((x, y) => {
      if (y % 4 === 3 && hash(x, Math.floor(y / 4), 11) < 500) return 0;
      return (x + y) % 2 === 0 ? 2 : 1;
    }),
  },
  {
    name: 'dungeon_floor',
    palette: 'stone',
    solid: false,
    grid: grid((x, y) => {
      if (x % 8 === 0 || y % 8 === 0) return 0;
      return hash(x, y, 20) < 80 ? 0 : 1;
    }),
  },
  {
    name: 'dungeon_wall',
    palette: 'stone',
    solid: true,
    grid: grid((x, y) => {
      const row = Math.floor(y / 4);
      const off = (row % 2) * 4;
      if (y % 4 === 0) return 0;
      if ((x + off) % 8 === 0) return 0;
      return y % 4 === 1 ? 3 : 2;
    }),
  },
  {
    name: 'bramble',
    palette: 'grass',
    solid: true,
    gate: 3,
    cleared: 'dungeon_floor',
    grid: grid((x, y) => {
      // tangled thorns
      const h = hash(x, y, 21);
      if ((x * 2 + y) % 5 === 0 || (y * 3 - x) % 7 === 0) return 0;
      if (h < 120) return 3;
      return h < 500 ? 1 : 2;
    }),
  },
  {
    name: 'locked_door',
    palette: 'stone',
    solid: true,
    gate: 1,
    cleared: 'dungeon_floor',
    grid: grid((x, y) => {
      if (x < 2 || x > 13 || y < 1 || y > 14) return 1;
      if (x < 4 || x > 11 || y < 3) return 0;
      // keyhole
      if (x >= 7 && x <= 8 && y >= 6 && y <= 7) return 3;
      if (x >= 7 && x <= 8 && y >= 8 && y <= 10) return 3;
      return 2;
    }),
  },
  {
    name: 'boss_door',
    palette: 'wood',
    solid: true,
    gate: 2,
    cleared: 'dungeon_floor',
    grid: grid((x, y) => {
      if (x < 1 || x > 14 || y < 1 || y > 14) return 0;
      if (x < 3 || x > 12 || y < 3) return 1;
      // skull-ish mark
      const d = Math.hypot(x - 7.5, y - 8);
      if (d < 3.4) return d < 2 && y > 8 ? 0 : 3;
      return 2;
    }),
  },
  {
    name: 'stairs_down',
    palette: 'stone',
    solid: false,
    grid: grid((x, y) => {
      const step = Math.floor(y / 4);
      const inset = step * 2;
      if (x < inset || x > 15 - inset) return 0;
      return y % 4 === 0 ? 0 : 3 - Math.min(step, 2);
    }),
  },
  {
    name: 'stairs_up',
    palette: 'stone',
    solid: false,
    grid: grid((x, y) => {
      const step = 3 - Math.floor(y / 4);
      const inset = step * 2;
      if (x < inset || x > 15 - inset) return 0;
      return y % 4 === 0 ? 0 : 3 - Math.min(step, 2);
    }),
  },
  {
    name: 'campfire',
    palette: 'sand',
    solid: true,
    fire: true,
    grid: grid((x, y) => {
      // stone ring
      const d = Math.hypot(x - 7.5, y - 9);
      if (d > 5.2 && d < 6.8) return 1;
      if (d > 6.8) return hash(x, y, 12) < 90 ? 2 : 1;
      // flames (background tile: no transparency, dark ground instead)
      const fd = Math.hypot((x - 7.5) * 1.4, y - 9);
      if (fd < 4.4 && y >= 5) {
        const flick = hash(x, y, 13) % 3;
        return flick === 0 ? 3 : flick === 1 ? 2 : 0;
      }
      return 0;
    }),
  },
];
