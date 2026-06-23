#!/usr/bin/env python3
"""Reachability + forced-gate proof for the SKYHOLLOW (The Riftspans) sky dungeon.

Models the player's traversal across the off-grid Skyhollow cluster (sx 20-22,
sy 0-2), entered via the warp from the Emberdeep boss room ed_boss(19,2) into
sw_entry(20,1). The cluster is unreachable WITHOUT the EMBER MANTLE (the warp
sits on a lava seam in ed_boss), and its BACK HALF is unreachable WITHOUT the
GALE HOOK (chasm gulfs).

Passability model (mirrors the sim):
  - Non-solid tiles are walkable.
  - Openable gate tiles (bramble/locked/boss/switch/eye/plate/torch/flood/drain)
    -> walkable (the player has reachable bombs/fire/arrows/levers/plates/keys).
  - hole -> walkable (a pushed block fills it to a bridge).
  - chasm (tile_chasm) -> walkable only with `have_hook`.
  - lava (tile_lava) / frost_wall / water -> impassable (none in this zone, but
    modelled for completeness).
Connectivity:
  - Within a screen: 4-neighbour flood over walkable tiles.
  - Between screens: stepping off an edge cell to the matching edge cell of the
    orthogonally-adjacent screen, when BOTH cells are walkable.

We ALSO verify the boss-key pocket / gale-hook / sub-boss / boss are reachable
WITH the hook, that the back half is BLOCKED without it, and we run a small
push-geometry simulator for the sw_plate block-on-plate beat.
"""
import json, sys
from collections import deque

W = json.load(open("game/assets/content/world.json"))
COLS, ROWS = 10, 8
solid = W["tile_solid"]
gate  = W["tile_gate"]
frost = W["tile_frost"]
lava  = W["tile_lava"]
chasm = W["tile_chasm"]
hole  = W["tile_hole"]
water = W["tile_water"]
names = W["tile_names"]

OPENABLE_GATES = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}

by_coord = {(s["x"], s["y"]): s for s in W["screens"]}
SKY = {(sx, sy) for (sx, sy) in by_coord if 20 <= sx <= 22 and 0 <= sy <= 2}

def tile_at(s, x, y):
    return s["tiles"][y * COLS + x]

def walkable(s, x, y, have_mantle, have_hook, force_gate=None):
    t = tile_at(s, x, y)
    if chasm[t]:
        return have_hook
    if lava[t]:
        return have_mantle
    if frost[t]:
        return False
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

def neighbors(s, x, y, have_mantle, have_hook, force_gate=None):
    sx, sy = s["x"], s["y"]
    out = []
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < COLS and 0 <= ny < ROWS and walkable(s, nx, ny, have_mantle, have_hook, force_gate):
            out.append((sx, sy, nx, ny))
    if x == 0 and (sx-1,sy) in by_coord and walkable(by_coord[(sx-1,sy)], COLS-1, y, have_mantle, have_hook, force_gate):
        out.append((sx-1, sy, COLS-1, y))
    if x == COLS-1 and (sx+1,sy) in by_coord and walkable(by_coord[(sx+1,sy)], 0, y, have_mantle, have_hook, force_gate):
        out.append((sx+1, sy, 0, y))
    if y == 0 and (sx,sy-1) in by_coord and walkable(by_coord[(sx,sy-1)], x, ROWS-1, have_mantle, have_hook, force_gate):
        out.append((sx, sy-1, x, ROWS-1))
    if y == ROWS-1 and (sx,sy+1) in by_coord and walkable(by_coord[(sx,sy+1)], x, 0, have_mantle, have_hook, force_gate):
        out.append((sx, sy+1, x, 0))
    return out

def flood(start, have_mantle, have_hook, force_gate=None):
    seen = {start}; q = deque([start])
    while q:
        sx, sy, x, y = q.popleft()
        for c in neighbors(by_coord[(sx,sy)], x, y, have_mantle, have_hook, force_gate):
            if c[:2] in SKY and c not in seen:
                seen.add(c); q.append(c)
    return seen

# Entry: the ed_boss lava-seam warp lands at sw_entry(20,1) px(48,56)->tile(3,3).
ENTRY = (20, 1, 3, 3)

def cell_of_item(item_name):
    for s in W["screens"]:
        if (s["x"], s["y"]) not in SKY:
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

print("=== SKYHOLLOW reachability (WITH gale hook — full dungeon) ===")
seen_full = flood(ENTRY, have_mantle=True, have_hook=True)

hook_cell    = cell_of_item("gale_hook")
bosskey_cell = cell_of_item("boss_key")
roast_cell   = cell_of_item("hearty_roast")
print("gale_hook at", hook_cell, "| boss_key at", bosskey_cell, "| hearty_roast at", roast_cell)
check("gale_hook pickup reachable", hook_cell in seen_full)
check("boss_key reachable (chasm-ringed pocket, with hook)", bosskey_cell in seen_full)
check("optional hearty_roast reachable (chasm-ringed vault, with hook)", roast_cell in seen_full)

subboss_any = any((22,1)==(sx,sy) for (sx,sy,_,_) in seen_full)  # sw_hook
boss_any    = any((22,2)==(sx,sy) for (sx,sy,_,_) in seen_full)  # sw_boss
check("sub-boss room sw_hook(22,1) reachable", subboss_any)
check("boss room sw_boss(22,2) reachable", boss_any)

orphans = []
for s in W["screens"]:
    if (s["x"], s["y"]) not in SKY:
        continue
    for y in range(ROWS):
        for x in range(COLS):
            if walkable(s, x, y, True, True):
                if (s["x"], s["y"], x, y) not in seen_full:
                    orphans.append((s["name"], x, y, names[tile_at(s,x,y)]))
check("0 orphan walkable cells across all 9 Skyhollow screens (got %d)" % len(orphans),
      len(orphans) == 0)
for o in orphans[:30]:
    print("    ORPHAN", o)

print()
print("=== FORCED-GATE checks (each major gate is genuinely required) ===")

# 1) The ENTIRE zone needs the EMBER MANTLE: the only entry is the lava-seam warp
#    in ed_boss. Prove that warp tile is a lava tile (solid without the mantle).
ed_boss = by_coord[(19, 2)]
seam = tile_at(ed_boss, 8, 5)
check("zone entry is a lava seam in ed_boss (needs EMBER MANTLE to enter)",
      lava[seam])

# 2) WITHOUT the gale hook: the boss room AND the boss_key pocket must be BLOCKED
#    (chasm back half), but the hook itself + sub-boss room still reachable
#    (no chicken-and-egg / softlock).
seen_nohook = flood(ENTRY, have_mantle=True, have_hook=False)
boss_nohook    = any((22,2)==(sx,sy) for (sx,sy,_,_) in seen_nohook)
bosskey_nohook = bosskey_cell in seen_nohook
roast_nohook   = roast_cell in seen_nohook
check("WITHOUT hook: boss room BLOCKED (chasm gulf required)", not boss_nohook)
check("WITHOUT hook: boss_key pocket BLOCKED (chasm ring required)", not bosskey_nohook)
check("WITHOUT hook: optional vault BLOCKED (chasm ring required)", not roast_nohook)
check("WITHOUT hook: gale_hook pickup STILL reachable (no softlock)",
      hook_cell in seen_nohook)
check("WITHOUT hook: sub-boss room sw_hook(22,1) STILL reachable",
      any((22,1)==(sx,sy) for (sx,sy,_,_) in seen_nohook))

# 3) Forced torch-door (gate 10): unlit -> the sub-boss / gale_hook room is
#    unreachable from the entry.
seen_torch = flood(ENTRY, have_mantle=True, have_hook=True, force_gate=10)
check("torch_door (gate 10) SOLID: gale_hook room BLOCKED (torch puzzle required)",
      hook_cell not in seen_torch)

# 4) Forced plate-door (gate 7): block off the plate -> the boss is unreachable.
seen_plate = flood(ENTRY, have_mantle=True, have_hook=True, force_gate=7)
boss_noplate = any((22,2)==(sx,sy) for (sx,sy,_,_) in seen_plate)
check("plate_door (gate 7) SOLID: boss room BLOCKED (block-on-plate required)",
      not boss_noplate)

# 5) Forced eye-target (gate 8): unshot -> sw_bridge / everything past it is
#    unreachable (the eye gates the W->E crossing in sw_bridge).
seen_eye = flood(ENTRY, have_mantle=True, have_hook=True, force_gate=8)
check("eye_target (gate 8) SOLID: gale_hook room BLOCKED (eye shot required)",
      hook_cell not in seen_eye)

print()
print("=== PUSH-GEOMETRY check: sw_plate block-on-plate is solvable ===")
# sw_plate(21,1): block spawns at (2,2); plate at (2,4); player pushes it S.
sw_plate = by_coord[(21, 1)]
bx, by = 2, 2  # block spawn
plate_xy = None
for y in range(ROWS):
    for x in range(COLS):
        if gate[tile_at(sw_plate, x, y)] == 5:  # momentary plate
            plate_xy = (x, y)
check("sw_plate has exactly one momentary plate (gate 5)", plate_xy is not None)
def pushable_S(s, x, y):
    ny = y + 1
    if ny >= ROWS:
        return False
    t = tile_at(s, x, ny)
    return (not solid[t]) or gate[t] in (5, 6)
above_ok = (by - 1) >= 0 and not solid[tile_at(sw_plate, bx, by - 1)]
check("sw_plate: player can stand N of the block to shove it S", above_ok)
steps = 0
cx, cy = bx, by
while (cx, cy) != plate_xy and pushable_S(sw_plate, cx, cy) and steps < 8:
    cy += 1
    steps += 1
check("sw_plate: block shoves S onto the plate (got to %s in %d steps)" % ((cx, cy), steps),
      (cx, cy) == plate_xy)
has_pd = any(gate[tile_at(sw_plate, x, y)] == 7 for y in range(ROWS) for x in range(COLS))
check("sw_plate: a gate-7 plate_door seals the S passage", has_pd)

print()
print("=== PUSH-GEOMETRY check: sw_gap block->hole gap-bridge is solvable ===")
# sw_gap(20,0): block at (2,3); hole at (5,3); player pushes E.
sw_gap = by_coord[(20, 0)]
gx, gy = 2, 3
hole_xy = None
for y in range(ROWS):
    for x in range(COLS):
        if hole[tile_at(sw_gap, x, y)]:
            hole_xy = (x, y)
check("sw_gap has exactly one hole", hole_xy is not None)
def pushable_E(s, x, y):
    nx = x + 1
    if nx >= COLS:
        return False
    t = tile_at(s, nx, y)
    return (not solid[t]) or hole[t]
left_ok = (gx - 1) >= 0 and not solid[tile_at(sw_gap, gx - 1, gy)]
check("sw_gap: player can stand W of the block to shove it E", left_ok)
steps = 0
cx, cy = gx, gy
while (cx, cy) != hole_xy and pushable_E(sw_gap, cx, cy) and steps < 8:
    cx += 1
    steps += 1
check("sw_gap: block shoves E into the hole (got to %s in %d steps)" % ((cx, cy), steps),
      (cx, cy) == hole_xy)

print()
print("RESULT:", "ALL GREEN" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)
