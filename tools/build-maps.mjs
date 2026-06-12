#!/usr/bin/env node
// Compiles content/maps/*.txt ASCII screens into game/assets/content/world.json.
// Validates: legend chars exist as tiles, screen dimensions, spawn screen exists.
// Run: node tools/build-maps.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILES } from '../content/sprites/tiles.mjs';
import { SPRITES } from '../content/sprites/sprites.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'content', 'maps', 'overworld.txt');
const OUT_DIR = join(REPO, 'game', 'assets', 'content');

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
  if (line === '' || line.startsWith('#')) continue;

  if (line === 'LEGEND') {
    mode = 'legend';
    continue;
  }
  if (line.startsWith('SCREEN ')) {
    const [, col, row, name] = line.split(/\s+/);
    screen = { x: Number(col), y: Number(row), name, rows: [], line: i };
    screens.push(screen);
    mode = 'screen';
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
}

if (!spawn) throw new Error('no SPAWN directive');
if (!byCoord.has(`${spawn.sx},${spawn.sy}`)) {
  throw new Error(`SPAWN references missing screen ${spawn.sx},${spawn.sy}`);
}

const world = {
  tile_names: TILES.map((t) => t.name),
  tile_solid: TILES.map((t) => t.solid),
  sprite_names: SPRITES.map((s) => s.name),
  screens: screens.map((s) => ({ x: s.x, y: s.y, name: s.name, tiles: s.tiles })),
  spawn,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'world.json'), JSON.stringify(world));
console.log(`world.json: ${screens.length} screens, ${TILES.length} tile defs, spawn at ${spawn.sx},${spawn.sy}`);
