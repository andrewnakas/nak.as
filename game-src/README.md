# Nak's Awakening

A Game Boy Color–style co-op action RPG that lives at [nak.as/game](https://nak.as/game/).
Original IP; "in the style of" classic 2D Zelda, with MMO-ish trimmings:
parties, quests, leveling skills, item fusion, durability, and cloud saves.

## Architecture

- **`game-src/`** — Rust workspace. `sim` is the entire deterministic game
  (fixed-point math, seeded PCG32, no wall clock); `protocol` holds postcard
  wire/save types; `wasm` is a thin wasm-bindgen shell. One peer (the party
  leader) runs the authoritative sim; everyone else sends inputs and renders
  interpolated 20 Hz snapshots. Solo play is a party of one on the same code
  path.
- **`game/`** — what Cloudflare Pages serves: ES-module JS shell (Canvas 2D
  renderer, WebRTC star topology, Web Audio chiptune synth) plus committed
  build artifacts (`pkg/` wasm, generated spritesheets, compiled world).
- **`content/`** — authoring sources: ASCII screen maps, text pixel-grid
  sprites, palettes. Edit these, run the tools, commit the outputs.
- **`tools/`** — zero-dependency build scripts (`node`/`bash` only).
- **`worker/`** — Cloudflare Worker (auth, character saves with validation,
  friends, WebRTC signaling via a Durable Object). No game logic server-side.

## Dev loop

```sh
# terminal 1: static site
python3 -m http.server 8000           # repo root -> http://localhost:8000/game/

# terminal 2: api (auth/saves/signaling)
cd worker
wrangler d1 migrations apply naks-awakening --local   # once
wrangler dev --port 8787

# after changing Rust:
tools/build-wasm.sh

# after changing sprites/maps/content:
node tools/gen-sprites.mjs && node tools/build-maps.mjs

# sim tests (determinism, combat, fusion, saves, quests):
cd game-src && cargo test -p sim
```

Debug helpers: `?debug` shows tick/hash overlay; `?at=sx,sy,px,py` spawns
anywhere (solo only). Multiplayer locally: open two tabs, HOST A PARTY in
one, JOIN with the code in the other.

## Deploy

- **Site**: `git push` — Cloudflare Pages serves the repo as-is.
- **Worker**: once per machine `wrangler login`, then
  `wrangler d1 create naks-awakening` (paste the id into `wrangler.toml`),
  `wrangler d1 migrations apply naks-awakening --remote`, and
  `wrangler deploy`. The custom domain `api.nak.as` is configured in
  `wrangler.toml`.

## Content cheatsheet

- New item: `game/assets/content/items.json` (+ sprite in
  `content/sprites/sprites.mjs`, regenerate).
- New enemy: `enemies.json` (brain: thornling/crab/gel/wasp/snatcher/
  critter/boss) + drop table in `drops.json` + `E name tx ty` in the map.
- New screen: `SCREEN col row name` + 8 rows of 10 legend chars in
  `content/maps/overworld.txt`. `N npc`, `I item`, `W warp` lines for
  placements; screens connect by adjacency.
- Quests: `quests.json` (kill/collect/cook/fuse/fish objectives, rewards,
  `requires` chaining); givers are NPCs from `npcs.json`.
