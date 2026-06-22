#!/usr/bin/env python3
"""Reachability + forced-gate + push-geometry proofs for the RETROFITTED
Rootcellar and Tidecrag dungeons (Phase-3 puzzle retrofit).

Both dungeons gained a new puzzle BEAT:
  * ROOTCELLAR d_sentry(12,11): a pushable BLOCK shoved south onto a momentary
    PLATE holds the gate-7 PLATE_DOOR open over the S passage to the boss-key
    vault (no item required).
  * TIDECRAG  tc_pool(8,10): a WATER_LEVER drains a drain_water channel so the
    block can be shoved E across it onto a PLATE that holds the gate-7 plate_door
    over the E exit to the boss-key vault (water-level + block-on-plate).

Passability model (mirrors the sim):
  - Non-solid tiles are walkable.
  - Openable gate tiles (door/plate/torch/bramble/eye/lever-gate/water-flip) are
    walkable when the gating tool/lever/key/plate is available (we verify the
    plate is actually weightable below via the push-geometry check).
  - hole -> walkable (block-fill -> bridge).
  - water (tile_water) -> walkable ONLY with the surfboard (have_board).
  - drain_water (gate 12) is water by default but becomes floor when the screen's
    water level is RAISED; we model it as walkable if (have_board) OR (raised).
Connectivity: 4-neighbour within a screen + edge-steps between adjacent screens.

The push-geometry check is SEPARATE from BFS: a block in a corner can't be
pushed every direction, so we explicitly simulate the intended shove sequence
and assert the block lands on the plate and the door then opens.
"""
import json, sys
from collections import deque

W = json.load(open("game/assets/content/world.json"))
COLS, ROWS = 10, 8
solid = W["tile_solid"]
gate  = W["tile_gate"]
water = W["tile_water"]
slip  = W["tile_slip"]
hole  = W["tile_hole"]
names = W["tile_names"]
NAME2ID = {n: i for i, n in enumerate(names)}

by_coord = {(s["x"], s["y"]): s for s in W["screens"]}

# Gate numbers a player can clear with reachable tools/levers/keys (NOT counting
# the plate-door which we treat specially per-test).
OPENABLE = {1, 2, 3, 4, 5, 6, 8, 9, 10, 11}  # 7 (plate_door) & 12 (drain) special

def tile_at(s, x, y):
    return s["tiles"][y * COLS + x]

def block_cells(cluster):
    """All (sx,sy,tx,ty) of pushable blocks in the cluster."""
    out = []
    for s in W["screens"]:
        if (s["x"], s["y"]) not in cluster:
            continue
        for b in s.get("blocks", []):
            out.append((s["x"], s["y"], b["tx"], b["ty"]))
    return out

def walkable(s, x, y, have_board, raised_screens, plate_open_screens):
    t = tile_at(s, x, y)
    g = gate[t]
    if hole[t]:
        return True
    if g == 12:  # drain_water: water unless this screen's level is raised
        return ((s["x"], s["y"]) in raised_screens) or have_board
    if water[t]:
        return have_board
    if g == 7:  # plate_door: only when this screen's plate is held
        return (s["x"], s["y"]) in plate_open_screens
    if g in OPENABLE:
        return True
    return not solid[t]

def neighbors(s, x, y, have_board, raised, plate_open):
    sx, sy = s["x"], s["y"]
    out = []
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < COLS and 0 <= ny < ROWS and walkable(s, nx, ny, have_board, raised, plate_open):
            out.append((sx, sy, nx, ny))
    if x == 0 and (sx-1,sy) in by_coord and walkable(by_coord[(sx-1,sy)], COLS-1, y, have_board, raised, plate_open):
        out.append((sx-1, sy, COLS-1, y))
    if x == COLS-1 and (sx+1,sy) in by_coord and walkable(by_coord[(sx+1,sy)], 0, y, have_board, raised, plate_open):
        out.append((sx+1, sy, 0, y))
    if y == 0 and (sx,sy-1) in by_coord and walkable(by_coord[(sx,sy-1)], x, ROWS-1, have_board, raised, plate_open):
        out.append((sx, sy-1, x, ROWS-1))
    if y == ROWS-1 and (sx,sy+1) in by_coord and walkable(by_coord[(sx,sy+1)], x, 0, have_board, raised, plate_open):
        out.append((sx, sy+1, x, 0))
    return out

def flood(start, cluster, have_board=False, raised=frozenset(), plate_open=frozenset()):
    seen = {start}; q = deque([start])
    while q:
        sx, sy, x, y = q.popleft()
        for c in neighbors(by_coord[(sx,sy)], x, y, have_board, raised, plate_open):
            if c[:2] in cluster and c not in seen:
                seen.add(c); q.append(c)
    return seen

def item_cell(cluster, item_name):
    for s in W["screens"]:
        if (s["x"], s["y"]) not in cluster:
            continue
        for it in s.get("items", []):
            if it["t"] == item_name:
                return (s["x"], s["y"], it["tx"], it["ty"])
    return None

ok = True
def check(label, cond):
    global ok
    print(("  PASS " if cond else "  FAIL ") + label)
    if not cond:
        ok = False

# ---- Generic push-geometry simulator ---------------------------------------
def can_push(s_xy, block_xy, dir, count, raised=frozenset()):
    """Simulate shoving the block `count` tiles in dir over the screen.
    dir: (dx,dy). Refuses solid/water/another-block/edge (drain_water counts as
    open when `raised`). Slides further on ice. Returns the final (tx,ty) or None."""
    s = by_coord[s_xy]
    dx, dy = dir
    tx, ty = block_xy
    other_blocks = {(b["tx"], b["ty"]) for b in s.get("blocks", []) if (b["tx"],b["ty"]) != block_xy}
    def cell_open(cx, cy):
        if not (0 <= cx < COLS and 0 <= cy < ROWS):
            return False
        if (cx, cy) in other_blocks:
            return False
        t = tile_at(s, cx, cy)
        g = gate[t]
        if hole[t]:
            return True
        if g == 12:  # drain_water open only when raised
            return s_xy in raised
        if water[t]:
            return False
        return not solid[t]
    pushes = 0
    while pushes < count:
        ncx, ncy = tx+dx, ty+dy
        if not cell_open(ncx, ncy):
            return None
        tx, ty = ncx, ncy
        pushes += 1
        # ice slide: keep going while on a slip tile and the next cell is open
        while slip[tile_at(s, tx, ty)] and cell_open(tx+dx, ty+dy):
            tx, ty = tx+dx, ty+dy
    return (tx, ty)

# ===========================================================================
print("=== ROOTCELLAR (sx10-13, sy10-12) ===")
ROOT = {(sx,sy) for (sx,sy) in by_coord if 10 <= sx <= 13 and 10 <= sy <= 12}
# Warp lands at d_entry(10,10) tile (3,0) per W 2 5 3 0 64 40 (px64,py40 -> tx4,ty1?).
# Use the < stairs cell as a robust interior start: d_entry has '<' at (2,5).
R_ENTRY = (10, 10, 2, 5)

# Push geometry: d_sentry(12,11) block at (4,2), plate at (4,4); shove S 2 tiles.
R_PLATE = (12, 11, 4, 4)
land = can_push((12,11), (4,2), (0,1), 2)
check("d_sentry: block(4,2) shoves S onto plate(4,4) [push geometry OK] got %s" % (land,),
      land == (4, 4))
# The plate is held by the block -> plate_open for d_sentry. Flood WITH that.
seen_root = flood(R_ENTRY, ROOT, have_board=False, plate_open={(12,11)})
bosskey = item_cell(ROOT, "boss_key")
ironsword = item_cell(ROOT, "iron_sword")
smallkey = item_cell(ROOT, "small_key")
print("  boss_key", bosskey, "| iron_sword", ironsword, "| small_key", smallkey)
check("boss_key vault reachable (block-on-plate door open)", bosskey in seen_root)
check("d_boss room (13,12) reachable", any((13,12)==(sx,sy) for (sx,sy,_,_) in seen_root))
check("root_warden room d_sentry(12,11) reachable", any((12,11)==(sx,sy) for (sx,sy,_,_) in seen_root))
check("small_key (optional, behind bramble) reachable", smallkey in seen_root)
check("iron_sword (optional, behind small-key door) reachable", ironsword in seen_root)
# Orphans: every walkable cell reachable (with the plate held).
orph = []
for s in W["screens"]:
    if (s["x"],s["y"]) not in ROOT: continue
    for y in range(ROWS):
        for x in range(COLS):
            if walkable(s, x, y, False, frozenset(), {(12,11)}):
                if (s["x"],s["y"],x,y) not in seen_root:
                    orph.append((s["name"], x, y, names[tile_at(s,x,y)]))
check("0 orphan walkable cells across all Rootcellar rooms (got %d)" % len(orph), len(orph)==0)
for o in orph[:20]: print("    ORPHAN", o)
# Forced-gate: plate_door SOLID (block NOT on plate) -> boss-key vault BLOCKED.
seen_noplate = flood(R_ENTRY, ROOT, have_board=False, plate_open=frozenset())
check("FORCED: plate_door SOLID -> boss_key vault BLOCKED (puzzle required)",
      bosskey not in seen_noplate)
# And the block itself must be reachable (so the puzzle is solvable).
check("FORCED-ok: the d_sentry block is reachable to push (no chicken-and-egg)",
      (12,11,4,2) in seen_noplate or any((12,11)==(sx,sy) for (sx,sy,_,_) in seen_noplate))

print()
print("=== TIDECRAG (sx7-9, sy10-12) ===")
TIDE = {(sx,sy) for (sx,sy) in by_coord if 7 <= sx <= 9 and 10 <= sy <= 12}
# Warp lands at tc_entry(7,12); use its '<' stair cells (2,2)/(3,2) as start.
T_ENTRY = (7, 12, 2, 2)

# The puzzle: water_lever RAISES -> drain_water(3,3)(4,3) becomes floor; then the
# block(2,3) shoves E 3 tiles onto plate(5,3); plate holds plate_door(7,3).
T_RAISED = {(8,10)}
# (a) WITHOUT draining, the block CANNOT cross the drain_water channel:
land_dry = can_push((8,10), (2,3), (1,0), 3, raised=frozenset())
check("tc_pool: WITHOUT draining, block(2,3) CANNOT be pushed E across drain_water (got %s)" % (land_dry,),
      land_dry is None)
# (b) WITH the level raised, the block slides E onto the plate(5,3):
land_wet = can_push((8,10), (2,3), (1,0), 3, raised=T_RAISED)
check("tc_pool: WITH drain raised, block(2,3) shoves E onto plate(5,3) [push geometry OK] got %s" % (land_wet,),
      land_wet == (5, 3))
# Player has the surfboard by tc_pool (grabbed in tc_surf before it). Flood with
# board + raised water + plate held.
seen_tide = flood(T_ENTRY, TIDE, have_board=True, raised=T_RAISED, plate_open={(8,10)})
t_bosskey = item_cell(TIDE, "boss_key")
t_surf = item_cell(TIDE, "surfboard")
t_iron = item_cell(TIDE, "iron_sword")
t_small = item_cell(TIDE, "small_key")
print("  boss_key", t_bosskey, "| surfboard", t_surf, "| iron_sword", t_iron, "| small_key", t_small)
check("surfboard reachable (sub-boss chamber, behind hall+surf levers)", t_surf in seen_tide)
check("boss_key vault reachable (past the pool puzzle, surfing)", t_bosskey in seen_tide)
check("tide_sentinel room tc_surf(8,11) reachable", any((8,11)==(sx,sy) for (sx,sy,_,_) in seen_tide))
check("boss room tc_boss(9,12) reachable", any((9,12)==(sx,sy) for (sx,sy,_,_) in seen_tide))
check("small_key (optional) reachable", t_small in seen_tide)
check("iron_sword (optional, behind small-key door) reachable", t_iron in seen_tide)
# Orphans across Tidecrag (with board + raised + plate held).
orphT = []
for s in W["screens"]:
    if (s["x"],s["y"]) not in TIDE: continue
    for y in range(ROWS):
        for x in range(COLS):
            if walkable(s, x, y, True, T_RAISED, {(8,10)}):
                if (s["x"],s["y"],x,y) not in seen_tide:
                    orphT.append((s["name"], x, y, names[tile_at(s,x,y)]))
check("0 orphan walkable cells across all Tidecrag rooms (got %d)" % len(orphT), len(orphT)==0)
for o in orphT[:20]: print("    ORPHAN", o)
# Forced-gate 1: plate_door SOLID (plate not held) -> boss-key vault BLOCKED.
seen_t_noplate = flood(T_ENTRY, TIDE, have_board=True, raised=T_RAISED, plate_open=frozenset())
check("FORCED: tc_pool plate_door SOLID -> boss_key vault BLOCKED (block-on-plate required)",
      t_bosskey not in seen_t_noplate)
# Forced-gate 2: even WITH the board, the player cannot hold the momentary plate
# AND pass the door -- proven structurally: with plate_open empty (player off the
# plate) the SE exit chamber is unreachable, confirming the BLOCK is the only way
# to keep the door open while walking through (no bypass route exists).
se_chamber = any((8,10)==(sx,sy) and x >= 8 for (sx,sy,x,y) in seen_t_noplate)
check("FORCED: with plate unheld, the SE exit chamber (cols8-9) is unreachable (no bypass)",
      not se_chamber)
# The water-level is genuinely required: the block can't cross undrained, so the
# plate can't be block-held, so the door can't stay open while you walk through.
check("FORCED: water-level drain is required for the block to reach the plate",
      land_dry is None and land_wet == (5,3))

print()
print("RESULT:", "ALL GREEN" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)
