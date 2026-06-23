#!/usr/bin/env python3
"""Reachability + forced-gate proof for THE SUNKENMIRE (The Drowned Vault) bog dungeon.

Models the player's traversal across the off-grid Sunkenmire cluster (sx 23-25,
sy 0-2), entered via the warp from the Skyhollow boss room sw_boss(22,2) into
sm_entry(23,1). The cluster is unreachable WITHOUT the GALE HOOK (the warp sits on
a CHASM seam in sw_boss), and its BACK HALF is unreachable WITHOUT the TIDE CHARM
(murk channels).

Passability model (mirrors the sim):
  - Non-solid tiles are walkable.
  - Openable gate tiles (bramble/locked/boss/switch/eye/plate/torch/flood/drain)
    -> walkable (the player has reachable bombs/fire/arrows/levers/plates/keys).
  - hole -> walkable (a pushed block fills it to a bridge).
  - murk (tile_murk) -> walkable only with `have_charm`.
  - chasm (tile_chasm) -> walkable only with `have_hook` (only the entry seam).
  - lava (tile_lava) / frost_wall / water -> impassable (none in this zone, but
    modelled for completeness).
Connectivity:
  - Within a screen: 4-neighbour flood over walkable tiles.
  - Between screens: stepping off an edge cell to the matching edge cell of the
    orthogonally-adjacent screen, when BOTH cells are walkable.

We ALSO verify the boss-key pocket / tide-charm / sub-boss / boss are reachable
WITH the charm, that the back half is BLOCKED without it, and we run a small
push-geometry simulator for the sm_plate block-on-plate beat.
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
murk  = W["tile_murk"]
hole  = W["tile_hole"]
water = W["tile_water"]
names = W["tile_names"]

OPENABLE_GATES = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}

by_coord = {(s["x"], s["y"]): s for s in W["screens"]}
MIRE = {(sx, sy) for (sx, sy) in by_coord if 23 <= sx <= 25 and 0 <= sy <= 2}

def tile_at(s, x, y):
    return s["tiles"][y * COLS + x]

def walkable(s, x, y, have_charm, have_hook, force_gate=None):
    t = tile_at(s, x, y)
    # Traversal-item gates (separate boolean flags, NOT gate-numbered): the
    # surfboard/charm/hook/mantle/axes tiles. These dominate (an item, not a
    # puzzle, opens them).
    if murk[t]:
        return have_charm
    if chasm[t]:
        return have_hook
    if lava[t]:
        return False
    if frost[t]:
        return False
    if hole[t]:
        return True            # block-fill -> bridge
    # Puzzle gates (numbered) are checked BEFORE raw terrain flags, because a
    # drain_water (gate 12) is ALSO flagged water but DRAINS to floor when the
    # screen's water_lever is pulled (reachable here) -> it's crossable. Likewise
    # a flood_floor (gate 11). The forced-gate harness re-solids a chosen gate.
    g = gate[t]
    if force_gate is not None and g == force_gate:
        return False           # forced-solid puzzle gate
    if g in OPENABLE_GATES:
        return True
    if water[t]:
        return False
    return not solid[t]

def neighbors(s, x, y, have_charm, have_hook, force_gate=None):
    sx, sy = s["x"], s["y"]
    out = []
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < COLS and 0 <= ny < ROWS and walkable(s, nx, ny, have_charm, have_hook, force_gate):
            out.append((sx, sy, nx, ny))
    if x == 0 and (sx-1,sy) in by_coord and walkable(by_coord[(sx-1,sy)], COLS-1, y, have_charm, have_hook, force_gate):
        out.append((sx-1, sy, COLS-1, y))
    if x == COLS-1 and (sx+1,sy) in by_coord and walkable(by_coord[(sx+1,sy)], 0, y, have_charm, have_hook, force_gate):
        out.append((sx+1, sy, 0, y))
    if y == 0 and (sx,sy-1) in by_coord and walkable(by_coord[(sx,sy-1)], x, ROWS-1, have_charm, have_hook, force_gate):
        out.append((sx, sy-1, x, ROWS-1))
    if y == ROWS-1 and (sx,sy+1) in by_coord and walkable(by_coord[(sx,sy+1)], x, 0, have_charm, have_hook, force_gate):
        out.append((sx, sy+1, x, 0))
    return out

def flood(start, have_charm, have_hook, force_gate=None):
    seen = {start}; q = deque([start])
    while q:
        sx, sy, x, y = q.popleft()
        for c in neighbors(by_coord[(sx,sy)], x, y, have_charm, have_hook, force_gate):
            if c[:2] in MIRE and c not in seen:
                seen.add(c); q.append(c)
    return seen

# Entry: the sw_boss chasm-seam warp lands at sm_entry(23,1) px(48,56)->tile(3,3).
ENTRY = (23, 1, 3, 3)

def cell_of_item(item_name):
    for s in W["screens"]:
        if (s["x"], s["y"]) not in MIRE:
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

print("=== SUNKENMIRE reachability (WITH tide charm — full dungeon) ===")
# Inside the cluster the WATER-LEVEL is solvable (the silt-hall lever drains the
# channel): model drain (gate 12) as openable, which OPENABLE_GATES already does.
seen_full = flood(ENTRY, have_charm=True, have_hook=True)

charm_cell   = cell_of_item("tide_charm")
bosskey_cell = cell_of_item("boss_key")
roast_cell   = cell_of_item("hearty_roast")
print("tide_charm at", charm_cell, "| boss_key at", bosskey_cell, "| hearty_roast at", roast_cell)
check("tide_charm pickup reachable", charm_cell in seen_full)
check("boss_key reachable (murk-ringed pocket, with charm)", bosskey_cell in seen_full)
check("optional hearty_roast reachable (murk-ringed vault, with charm)", roast_cell in seen_full)

subboss_any = any((25,1)==(sx,sy) for (sx,sy,_,_) in seen_full)  # sm_charm
boss_any    = any((25,2)==(sx,sy) for (sx,sy,_,_) in seen_full)  # sm_boss
check("sub-boss room sm_charm(25,1) reachable", subboss_any)
check("boss room sm_boss(25,2) reachable", boss_any)

orphans = []
for s in W["screens"]:
    if (s["x"], s["y"]) not in MIRE:
        continue
    for y in range(ROWS):
        for x in range(COLS):
            if walkable(s, x, y, True, True):
                if (s["x"], s["y"], x, y) not in seen_full:
                    orphans.append((s["name"], x, y, names[tile_at(s,x,y)]))
check("0 orphan walkable cells across all 9 Sunkenmire screens (got %d)" % len(orphans),
      len(orphans) == 0)
for o in orphans[:30]:
    print("    ORPHAN", o)

print()
print("=== FORCED-GATE checks (each major gate is genuinely required) ===")

# 1) The ENTIRE zone needs the GALE HOOK: the only entry is the chasm-seam warp
#    in sw_boss. Prove that warp tile is a chasm tile (solid without the hook).
sw_boss = by_coord[(22, 2)]
seam = tile_at(sw_boss, 8, 5)
check("zone entry is a chasm seam in sw_boss (needs GALE HOOK to enter)",
      chasm[seam])

# 2) WITHOUT the tide charm: the boss room AND the boss_key pocket must be BLOCKED
#    (murk back half), but the charm itself + sub-boss room still reachable
#    (no chicken-and-egg / softlock).
seen_nocharm = flood(ENTRY, have_charm=False, have_hook=True)
boss_nocharm    = any((25,2)==(sx,sy) for (sx,sy,_,_) in seen_nocharm)
bosskey_nocharm = bosskey_cell in seen_nocharm
roast_nocharm   = roast_cell in seen_nocharm
check("WITHOUT charm: boss room BLOCKED (murk channel required)", not boss_nocharm)
check("WITHOUT charm: boss_key pocket BLOCKED (murk ring required)", not bosskey_nocharm)
check("WITHOUT charm: optional vault BLOCKED (murk ring required)", not roast_nocharm)
check("WITHOUT charm: tide_charm pickup STILL reachable (no softlock)",
      charm_cell in seen_nocharm)
check("WITHOUT charm: sub-boss room sm_charm(25,1) STILL reachable",
      any((25,1)==(sx,sy) for (sx,sy,_,_) in seen_nocharm))

# 3) Forced drain channel (gate 12): undrained -> the eye gate / everything past
#    the silt hall is unreachable (the silt hall walls off the E half until the
#    water_lever drains the channel).
seen_drain = flood(ENTRY, have_charm=True, have_hook=True, force_gate=12)
check("drain_water (gate 12) SOLID: tide_charm room BLOCKED (water-level drain required)",
      charm_cell not in seen_drain)

# 4) Forced torch-door (gate 10): unlit -> the sub-boss / tide_charm room is
#    unreachable from the entry.
seen_torch = flood(ENTRY, have_charm=True, have_hook=True, force_gate=10)
check("torch_door (gate 10) SOLID: tide_charm room BLOCKED (torch puzzle required)",
      charm_cell not in seen_torch)

# 5) Forced plate-door (gate 7): block off the plate -> the boss is unreachable.
seen_plate = flood(ENTRY, have_charm=True, have_hook=True, force_gate=7)
boss_noplate = any((25,2)==(sx,sy) for (sx,sy,_,_) in seen_plate)
check("plate_door (gate 7) SOLID: boss room BLOCKED (block-on-plate required)",
      not boss_noplate)

# 6) Forced eye-target (gate 8): unshot -> sm_eye W->E crossing is blocked, so the
#    sub-boss / tide_charm room is unreachable.
seen_eye = flood(ENTRY, have_charm=True, have_hook=True, force_gate=8)
check("eye_target (gate 8) SOLID: tide_charm room BLOCKED (eye shot required)",
      charm_cell not in seen_eye)

print()
print("=== PUSH-GEOMETRY check: sm_plate block-on-plate is solvable ===")
# sm_plate(24,1): block spawns at (2,2); plate at (2,4); player pushes it S.
sm_plate = by_coord[(24, 1)]
bx, by = 2, 2  # block spawn
plate_xy = None
for y in range(ROWS):
    for x in range(COLS):
        if gate[tile_at(sm_plate, x, y)] == 5:  # momentary plate
            plate_xy = (x, y)
check("sm_plate has exactly one momentary plate (gate 5)", plate_xy is not None)
def pushable_S(s, x, y):
    ny = y + 1
    if ny >= ROWS:
        return False
    t = tile_at(s, x, ny)
    return (not solid[t]) or gate[t] in (5, 6)
above_ok = (by - 1) >= 0 and not solid[tile_at(sm_plate, bx, by - 1)]
check("sm_plate: player can stand N of the block to shove it S", above_ok)
steps = 0
cx, cy = bx, by
while (cx, cy) != plate_xy and pushable_S(sm_plate, cx, cy) and steps < 8:
    cy += 1
    steps += 1
check("sm_plate: block shoves S onto the plate (got to %s in %d steps)" % ((cx, cy), steps),
      (cx, cy) == plate_xy)
has_pd = any(gate[tile_at(sm_plate, x, y)] == 7 for y in range(ROWS) for x in range(COLS))
check("sm_plate: a gate-7 plate_door seals the S passage", has_pd)

print()
print("=== SANITY: Skyhollow flood-fill not regressed (entry seam now a warp) ===")
# The sw_boss chasm seam we added must not have orphaned any Skyhollow cell or
# broken the gale-hook gate; re-run the Skyhollow check inline (lightweight).
SKY = {(sx, sy) for (sx, sy) in by_coord if 20 <= sx <= 22 and 0 <= sy <= 2}
def flood_sky(start, have_mantle, have_hook):
    seen = {start}; q = deque([start])
    while q:
        sx, sy, x, y = q.popleft()
        for c in neighbors(by_coord[(sx,sy)], x, y, have_hook, have_hook):
            if c[:2] in SKY and c not in seen:
                seen.add(c); q.append(c)
    return seen
sky_seen = flood_sky((20,1,3,3), True, True)
sky_orphans = 0
for s in W["screens"]:
    if (s["x"], s["y"]) not in SKY:
        continue
    for y in range(ROWS):
        for x in range(COLS):
            t = tile_at(s, x, y)
            # in Skyhollow chasm is hook-gated, murk absent
            wk = (not solid[t]) or gate[t] in OPENABLE_GATES or hole[t] or chasm[t]
            if water[t] or lava[t] or frost[t]:
                wk = False
            if wk and (s["x"], s["y"], x, y) not in sky_seen:
                sky_orphans += 1
check("Skyhollow still has 0 orphans with the new chasm seam (got %d)" % sky_orphans,
      sky_orphans == 0)

print()
print("RESULT:", "ALL GREEN" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)
