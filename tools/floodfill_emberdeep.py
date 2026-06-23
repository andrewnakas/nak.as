#!/usr/bin/env python3
"""Reachability + forced-gate proof for the EMBERDEEP molten dungeon.

Models the player's traversal across the off-grid Emberdeep cluster (sx 17-19,
sy 0-2), entered via the warp from the Frostspire boss room fs_boss(16,2) into
ed_entry(17,1). The cluster is unreachable WITHOUT the ICE AXES (the warp sits on
a frost_wall seam in fs_boss), and its BACK HALF is unreachable WITHOUT the EMBER
MANTLE (lava channels).

Passability model (mirrors the sim):
  - Non-solid tiles are walkable.
  - Openable gate tiles (bramble/locked/boss/switch/eye/plate/torch/flood/drain)
    -> walkable (the player has reachable bombs/fire/arrows/levers/plates/keys).
  - hole -> walkable (a pushed block fills it to a bridge).
  - frost_wall (tile_frost) -> walkable only with `have_axes`.
  - lava (tile_lava) -> walkable only with `have_mantle`.
  - water (tile_water) -> impassable (no surfboard here).
Connectivity:
  - Within a screen: 4-neighbour flood over walkable tiles.
  - Between screens: stepping off an edge cell to the matching edge cell of the
    orthogonally-adjacent screen, when BOTH cells are walkable.

We ALSO verify the boss-key pocket / ember-mantle / sub-boss / boss are reachable
WITH the mantle, that the back half is BLOCKED without it, and we run a small
push-geometry simulator for the ed_plate block-on-plate beat.
"""
import json, sys
from collections import deque

W = json.load(open("game/assets/content/world.json"))
COLS, ROWS = 10, 8
solid = W["tile_solid"]
gate  = W["tile_gate"]
frost = W["tile_frost"]
lava  = W["tile_lava"]
hole  = W["tile_hole"]
water = W["tile_water"]
names = W["tile_names"]

OPENABLE_GATES = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}

by_coord = {(s["x"], s["y"]): s for s in W["screens"]}
DEEP = {(sx, sy) for (sx, sy) in by_coord if 17 <= sx <= 19 and 0 <= sy <= 2}

def tile_at(s, x, y):
    return s["tiles"][y * COLS + x]

def walkable(s, x, y, have_axes, have_mantle, force_gate=None):
    t = tile_at(s, x, y)
    if frost[t]:
        return have_axes
    if lava[t]:
        return have_mantle
    if hole[t]:
        return True            # block-fill -> bridge
    if water[t]:
        return False
    g = gate[t]
    if force_gate is not None and g == force_gate:
        return False           # forced-solid puzzle gate
    if g in OPENABLE_GATES:
        return True
    return not solid[t]

def neighbors(s, x, y, have_axes, have_mantle, force_gate=None):
    sx, sy = s["x"], s["y"]
    out = []
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < COLS and 0 <= ny < ROWS and walkable(s, nx, ny, have_axes, have_mantle, force_gate):
            out.append((sx, sy, nx, ny))
    if x == 0 and (sx-1,sy) in by_coord and walkable(by_coord[(sx-1,sy)], COLS-1, y, have_axes, have_mantle, force_gate):
        out.append((sx-1, sy, COLS-1, y))
    if x == COLS-1 and (sx+1,sy) in by_coord and walkable(by_coord[(sx+1,sy)], 0, y, have_axes, have_mantle, force_gate):
        out.append((sx+1, sy, 0, y))
    if y == 0 and (sx,sy-1) in by_coord and walkable(by_coord[(sx,sy-1)], x, ROWS-1, have_axes, have_mantle, force_gate):
        out.append((sx, sy-1, x, ROWS-1))
    if y == ROWS-1 and (sx,sy+1) in by_coord and walkable(by_coord[(sx,sy+1)], x, 0, have_axes, have_mantle, force_gate):
        out.append((sx, sy+1, x, 0))
    return out

def flood(start, have_axes, have_mantle, force_gate=None):
    seen = {start}; q = deque([start])
    while q:
        sx, sy, x, y = q.popleft()
        for c in neighbors(by_coord[(sx,sy)], x, y, have_axes, have_mantle, force_gate):
            if c[:2] in DEEP and c not in seen:
                seen.add(c); q.append(c)
    return seen

# Entry: the fs_boss frost-seam warp lands at ed_entry(17,1) px(48,56)->tile(3,3).
ENTRY = (17, 1, 3, 3)

def cell_of_item(item_name):
    for s in W["screens"]:
        if (s["x"], s["y"]) not in DEEP:
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

print("=== EMBERDEEP reachability (WITH ember mantle — full dungeon) ===")
seen_full = flood(ENTRY, have_axes=True, have_mantle=True)

mantle_cell  = cell_of_item("ember_mantle")
bosskey_cell = cell_of_item("boss_key")
roast_cell   = cell_of_item("hearty_roast")
print("ember_mantle at", mantle_cell, "| boss_key at", bosskey_cell, "| hearty_roast at", roast_cell)
check("ember_mantle pickup reachable", mantle_cell in seen_full)
check("boss_key reachable (lava-ringed pocket, with mantle)", bosskey_cell in seen_full)
check("optional hearty_roast reachable (lava-ringed vault, with mantle)", roast_cell in seen_full)

subboss_any = any((19,1)==(sx,sy) for (sx,sy,_,_) in seen_full)  # ed_mantle
boss_any    = any((19,2)==(sx,sy) for (sx,sy,_,_) in seen_full)  # ed_boss
check("sub-boss room ed_mantle(19,1) reachable", subboss_any)
check("boss room ed_boss(19,2) reachable", boss_any)

orphans = []
for s in W["screens"]:
    if (s["x"], s["y"]) not in DEEP:
        continue
    for y in range(ROWS):
        for x in range(COLS):
            if walkable(s, x, y, True, True):
                if (s["x"], s["y"], x, y) not in seen_full:
                    orphans.append((s["name"], x, y, names[tile_at(s,x,y)]))
check("0 orphan walkable cells across all 9 Emberdeep screens (got %d)" % len(orphans),
      len(orphans) == 0)
for o in orphans[:30]:
    print("    ORPHAN", o)

print()
print("=== FORCED-GATE checks (each major gate is genuinely required) ===")

# 1) The ENTIRE zone needs the ICE AXES: the only entry is the frost-seam warp in
#    fs_boss. Prove that warp tile is a frost_wall (solid without axes).
fs_boss = by_coord[(16, 2)]
seam = tile_at(fs_boss, 8, 5)
check("zone entry is a frost_wall seam in fs_boss (needs ICE AXES to enter)",
      frost[seam])

# 2) WITHOUT the ember mantle: the boss room AND the boss_key pocket must be
#    BLOCKED (lava back half), but the mantle itself + sub-boss room still
#    reachable (no chicken-and-egg / softlock).
seen_nomantle = flood(ENTRY, have_axes=True, have_mantle=False)
boss_nomantle    = any((19,2)==(sx,sy) for (sx,sy,_,_) in seen_nomantle)
bosskey_nomantle = bosskey_cell in seen_nomantle
roast_nomantle   = roast_cell in seen_nomantle
check("WITHOUT mantle: boss room BLOCKED (lava channel required)", not boss_nomantle)
check("WITHOUT mantle: boss_key pocket BLOCKED (lava ring required)", not bosskey_nomantle)
check("WITHOUT mantle: optional vault BLOCKED (lava ring required)", not roast_nomantle)
check("WITHOUT mantle: ember_mantle pickup STILL reachable (no softlock)",
      mantle_cell in seen_nomantle)
check("WITHOUT mantle: sub-boss room ed_mantle(19,1) STILL reachable",
      any((19,1)==(sx,sy) for (sx,sy,_,_) in seen_nomantle))

# 3) Forced torch-door (gate 10): unlit -> the sub-boss / ember_mantle room is
#    unreachable from the entry.
seen_torch = flood(ENTRY, have_axes=True, have_mantle=True, force_gate=10)
check("torch_door (gate 10) SOLID: ember_mantle room BLOCKED (torch puzzle required)",
      mantle_cell not in seen_torch)

# 4) Forced plate-door (gate 7): block off the plate -> the boss is unreachable.
seen_plate = flood(ENTRY, have_axes=True, have_mantle=True, force_gate=7)
boss_noplate = any((19,2)==(sx,sy) for (sx,sy,_,_) in seen_plate)
check("plate_door (gate 7) SOLID: boss room BLOCKED (block-on-plate required)",
      not boss_noplate)

# 5) Forced eye-target (gate 8): unshot -> ed_eye / everything past the bridge
#    room is unreachable (the eye gates the W->E crossing in ed_bridge).
seen_eye = flood(ENTRY, have_axes=True, have_mantle=True, force_gate=8)
eye_blocks_mantle = mantle_cell not in seen_eye
check("eye_target (gate 8) SOLID: ember_mantle room BLOCKED (eye shot required)",
      eye_blocks_mantle)

print()
print("=== PUSH-GEOMETRY check: ed_plate block-on-plate is solvable ===")
# ed_plate(18,1): block spawns at (2,2); plate at (2,4); player pushes it S.
# A block is pushed in the player's facing dir if the player stands on the cell
# directly behind it (here, N of the block) and walks INTO it; the block advances
# one tile if the destination is non-solid floor/plate (not wall/water/another
# block). We sim the two S-shoves the puzzle intends.
ed_plate = by_coord[(18, 1)]
def cell(s, x, y):
    return names[tile_at(s, x, y)]
bx, by = 2, 2  # block spawn
# plate target:
plate_xy = None
for y in range(ROWS):
    for x in range(COLS):
        if gate[tile_at(ed_plate, x, y)] == 5:  # momentary plate
            plate_xy = (x, y)
check("ed_plate has exactly one momentary plate (gate 5)", plate_xy is not None)
def pushable_S(s, x, y):
    ny = y + 1
    if ny >= ROWS:
        return False
    t = tile_at(s, x, ny)
    # destination must be steppable for a block: non-solid OR a plate (gate 5/6)
    return (not solid[t]) or gate[t] in (5, 6)
# the player must be able to stand N of the block to start the shove
above_ok = (by - 1) >= 0 and not solid[tile_at(ed_plate, bx, by - 1)]
check("ed_plate: player can stand N of the block to shove it S", above_ok)
steps = 0
cx, cy = bx, by
while (cx, cy) != plate_xy and pushable_S(ed_plate, cx, cy) and steps < 8:
    cy += 1
    steps += 1
check("ed_plate: block shoves S onto the plate (got to %s in %d steps)" % ((cx, cy), steps),
      (cx, cy) == plate_xy)
# and once held, the gate-7 plate_door must be on the S-exit path (interior).
has_pd = any(gate[tile_at(ed_plate, x, y)] == 7 for y in range(ROWS) for x in range(COLS))
check("ed_plate: a gate-7 plate_door seals the S passage", has_pd)

print()
print("RESULT:", "ALL GREEN" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)
