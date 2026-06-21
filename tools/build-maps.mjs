#!/usr/bin/env node
// Compiles content/maps/*.txt ASCII screens into game/assets/content/world.json.
// Validates: legend chars exist as tiles, screen dimensions, spawn screen exists.
// Run: node tools/build-maps.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILES } from '../content/sprites/tiles.mjs';
import { SPRITES } from '../content/sprites/sprites.mjs';
import { CHARSET } from '../content/sprites/font.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'content', 'maps', 'overworld.txt');
const OUT_DIR = join(REPO, 'game', 'assets', 'content');

const ENEMY_NAMES = new Set(
  JSON.parse(readFileSync(join(OUT_DIR, 'enemies.json'), 'utf8')).map((e) => e.name),
);
const NPC_NAMES = new Set(
  JSON.parse(readFileSync(join(OUT_DIR, 'npcs.json'), 'utf8')).map((n) => n.name),
);
const ITEM_NAMES = new Set(
  JSON.parse(readFileSync(join(OUT_DIR, 'items.json'), 'utf8')).map((i) => i.name),
);
const TILE_INDEX = new Map(TILES.map((t, i) => [t.name, i]));

const COLS = 10;
const ROWS = 8;

const tileIndex = new Map(TILES.map((t, i) => [t.name, i]));

const lines = readFileSync(SRC, 'utf8').split('\n');
const legend = new Map();
const screens = [];
let spawn = null;

let mode = null; // 'legend' | 'screen'
let screen = null;

function fail(lineNo, msg) {
  throw new Error(`${SRC}:${lineNo + 1}: ${msg}`);
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trimEnd();
  // Comments are '# ...' (hash-space); bare '#'-runs are dungeon wall rows.
  if (line === '' || line.startsWith('# ')) continue;

  if (line === 'LEGEND') {
    mode = 'legend';
    continue;
  }
  if (line.startsWith('SCREEN ')) {
    const [, col, row, name] = line.split(/\s+/);
    screen = {
      x: Number(col),
      y: Number(row),
      name,
      rows: [],
      entities: [],
      npcs: [],
      items: [],
      warps: [],
      line: i,
    };
    screens.push(screen);
    mode = 'screen';
    continue;
  }
  if (mode === 'screen' && line.startsWith('E ')) {
    if (!screen) fail(i, 'E line outside a SCREEN');
    const [, type, tx, ty] = line.split(/\s+/);
    if (!ENEMY_NAMES.has(type)) fail(i, `unknown enemy '${type}'`);
    screen.entities.push({ t: type, tx: Number(tx), ty: Number(ty), line: i });
    continue;
  }
  if (mode === 'screen' && line.startsWith('N ')) {
    if (!screen) fail(i, 'N line outside a SCREEN');
    const [, type, tx, ty] = line.split(/\s+/);
    if (!NPC_NAMES.has(type)) fail(i, `unknown npc '${type}'`);
    screen.npcs.push({ t: type, tx: Number(tx), ty: Number(ty), line: i });
    continue;
  }
  if (mode === 'screen' && line.startsWith('I ')) {
    if (!screen) fail(i, 'I line outside a SCREEN');
    const [, type, tx, ty] = line.split(/\s+/);
    if (!ITEM_NAMES.has(type)) fail(i, `unknown item '${type}'`);
    screen.items.push({ t: type, tx: Number(tx), ty: Number(ty), line: i });
    continue;
  }
  if (mode === 'screen' && line.startsWith('W ')) {
    if (!screen) fail(i, 'W line outside a SCREEN');
    const [, tx, ty, sx, sy, px, py] = line.split(/\s+/).map(Number);
    screen.warps.push({ tx, ty, sx, sy, px, py, line: i });
    continue;
  }
  if (line.startsWith('SPAWN ')) {
    const [, col, row, px, py] = line.split(/\s+/).map(Number);
    spawn = { sx: col, sy: row, x: px, y: py };
    mode = null;
    continue;
  }

  if (mode === 'legend') {
    const ch = line[0];
    const name = line.slice(1).trim();
    if (!tileIndex.has(name)) fail(i, `legend '${ch}' -> unknown tile '${name}'`);
    legend.set(ch, tileIndex.get(name));
  } else if (mode === 'screen') {
    if (line.length !== COLS) fail(i, `screen row must be ${COLS} chars, got ${line.length}`);
    if (screen.rows.length >= ROWS) fail(i, `screen ${screen.name} has more than ${ROWS} rows`);
    screen.rows.push(line);
  } else {
    fail(i, `unexpected line outside any section: '${line}'`);
  }
}

const byCoord = new Map();
for (const s of screens) {
  if (s.rows.length !== ROWS) {
    fail(s.line, `screen ${s.name} has ${s.rows.length} rows, expected ${ROWS}`);
  }
  const key = `${s.x},${s.y}`;
  if (byCoord.has(key)) fail(s.line, `duplicate screen at ${key}`);
  byCoord.set(key, s);
  s.tiles = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const ch = s.rows[y][x];
      if (!legend.has(ch)) fail(s.line + 1 + y, `screen ${s.name}: char '${ch}' not in legend`);
      s.tiles.push(legend.get(ch));
    }
  }
  for (const e of [...s.entities, ...s.npcs, ...s.items]) {
    if (e.tx < 0 || e.tx >= COLS || e.ty < 0 || e.ty >= ROWS) {
      fail(e.line, `screen ${s.name}: '${e.t}' out of bounds`);
    }
    const tile = s.tiles[e.ty * COLS + e.tx];
    const flying = e.t === 'dune_wasp' || e.t === 'cave_pip';
    if (TILES[tile].solid && !flying) {
      fail(e.line, `screen ${s.name}: '${e.t}' on solid tile '${TILES[tile].name}'`);
    }
  }
  for (const w of s.warps) {
    if (w.tx < 0 || w.tx >= COLS || w.ty < 0 || w.ty >= ROWS) {
      fail(w.line, `screen ${s.name}: warp trigger out of bounds`);
    }
  }
}

// Warp destinations must exist (checked after all screens parse).
for (const s of screens) {
  for (const w of s.warps) {
    if (!byCoord.has(`${w.sx},${w.sy}`)) {
      fail(w.line, `screen ${s.name}: warp to missing screen ${w.sx},${w.sy}`);
    }
  }
}

if (!spawn) throw new Error('no SPAWN directive');
if (!byCoord.has(`${spawn.sx},${spawn.sy}`)) {
  throw new Error(`SPAWN references missing screen ${spawn.sx},${spawn.sy}`);
}

const world = {
  tile_names: TILES.map((t) => t.name),
  tile_solid: TILES.map((t) => t.solid),
  tile_water: TILES.map((t) => !!t.water),
  tile_fire: TILES.map((t) => !!t.fire),
  tile_tree: TILES.map((t) => !!t.tree),
  tile_heal: TILES.map((t) => !!t.heal),
  tile_lever: TILES.map((t) => !!t.lever),
  tile_cliff: TILES.map((t) => !!t.cliff),
  tile_slip: TILES.map((t) => !!t.slip),
  tile_gate: TILES.map((t) => t.gate ?? 0),
  tile_cleared: TILES.map((t) => {
    if (!t.cleared) return -1;
    const idx = TILE_INDEX.get(t.cleared);
    if (idx === undefined) throw new Error(`tile ${t.name}: unknown cleared target '${t.cleared}'`);
    return idx;
  }),
  sprite_names: SPRITES.map((s) => s.name),
  font_chars: CHARSET,
  screens: screens.map((s) => ({
    x: s.x,
    y: s.y,
    name: s.name,
    tiles: s.tiles,
    entities: s.entities.map(({ t, tx, ty }) => ({ t, tx, ty })),
    npcs: s.npcs.map(({ t, tx, ty }) => ({ t, tx, ty })),
    items: s.items.map(({ t, tx, ty }) => ({ t, tx, ty })),
    warps: s.warps.map(({ tx, ty, sx, sy, px, py }) => ({ tx, ty, sx, sy, px, py })),
  })),
  spawn,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'world.json'), JSON.stringify(world));
console.log(`world.json: ${screens.length} screens, ${TILES.length} tile defs, spawn at ${spawn.sx},${spawn.sy}`);
