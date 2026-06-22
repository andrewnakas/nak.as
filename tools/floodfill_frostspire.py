#!/usr/bin/env python3
"""Reachability + forced-gate proof for the FROSTSPIRE mountain dungeon.

Models the player's traversal across the off-grid Frostspire cluster (sx 14-16,
sy 0-2), entered via the warp from wind_terrace(4,-1) into fs_entry(14,1).

Passability model (mirrors the sim):
  - Non-solid tiles are walkable.
  - Gate tiles that the player can OPEN with an obtainable resource are treated
    as walkable when that resource is available:
      * bramble/locked_door/boss_door/switch_door/eye_target/plate_door/
        torch_unlit/torch_door/flood_floor/drain_water -> openable (we have
        bombs/fire/levers/plates/keys reachable) so walkable.
      * hole -> walkable (a pushed block fills it to a bridge).
      * frost_wall (tile_frost) -> walkable ONLY when `have_axes` is True.
  - water (tile_water) is impassable here (no surfboard in this dungeon).
Connectivity:
  - Within a screen: 4-neighbour flood over walkable tiles.
  - Between screens: stepping off an edge cell to the matching edge cell of the
    orthogonally-adjacent screen, when BOTH cells are walkable.
"""
import json, sys
from collections import deque

W = json.load(open("game/assets/content/world.json"))
COLS, ROWS = 10, 8
solid = W["tile_solid"]
gate  = W["tile_gate"]
frost = W["tile_frost"]
hole  = W["tile_hole"]
water = W["tile_water"]
names = W["tile_names"]

# Gate numbers whose tiles the player can clear with reachable tools/levers/keys.
OPENABLE_GATES = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}

by_coord = {(s["x"], s["y"]): s for s in W["screens"]}
MOUNT = {(sx, sy) for (sx, sy) in by_coord if 14 <= sx <= 16 and 0 <= sy <= 2}

def tile_at(s, x, y):
    return s["tiles"][y * COLS + x]

def walkable(s, x, y, have_axes):
    t = tile_at(s, x, y)
    if frost[t]:
        return have_axes
    if hole[t]:
        return True            # block-fill -> bridge
    if water[t]:
        return False
    g = gate[t]
    if g in OPENABLE_GATES:
        return True            # openable door/plate/torch/bramble/eye
    return not solid[t]

def neighbors(s, x, y, have_axes):
    sx, sy = s["x"], s["y"]
    out = []
    # in-screen
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < COLS and 0 <= ny < ROWS and walkable(s, nx, ny, have_axes):
            out.append((sx, sy, nx, ny))
    # cross-screen edge steps
    if x == 0:  # step W
        ns = by_coord.get((sx-1, sy))
        if ns and walkable(ns, COLS-1, y, have_axes):
            out.append((sx-1, sy, COLS-1, y))
    if x == COLS-1:  # step E
        ns = by_coord.get((sx+1, sy))
        if ns and walkable(ns, 0, y, have_axes):
            out.append((sx+1, sy, 0, y))
    if y == 0:  # step N
        ns = by_coord.get((sx, sy-1))
        if ns and walkable(ns, x, ROWS-1, have_axes):
            out.append((sx, sy-1, x, ROWS-1))
    if y == ROWS-1:  # step S
        ns = by_coord.get((sx, sy+1))
        if ns and walkable(ns, x, 0, have_axes):
            out.append((sx, sy+1, x, 0))
    return out

def flood(start, have_axes, restrict_to_mount=True):
    seen = set()
    q = deque([start])
    seen.add(start)
    while q:
        sx, sy, x, y = q.popleft()
        s = by_coord[(sx, sy)]
        for (nsx, nsy, nx, ny) in neighbors(s, x, y, have_axes):
            if restrict_to_mount and (nsx, nsy) not in MOUNT:
                continue
            cell = (nsx, nsy, nx, ny)
            if cell not in seen:
                seen.add(cell)
                q.append(cell)
    return seen

# Entry: the wind_terrace warp lands at fs_entry(14,1) px(64,56) -> tile (4,3).
ENTRY = (14, 1, 4, 3)

def cell_of_item(item_name):
    for s in W["screens"]:
        if (s["x"], s["y"]) not in MOUNT:
            continue
        for it in s.get("items", []):
            if it["t"] == item_name:
                return (s["x"], s["y"], it["tx"], it["ty"])
    return None

def reachable(seen, cell):
    return cell in seen

ok = True
def check(label, cond):
    global ok
    print(("  PASS " if cond else "  FAIL ") + label)
    if not cond:
        ok = False

print("=== FROSTSPIRE reachability (WITH ice axes — full dungeon) ===")
seen_full = flood(ENTRY, have_axes=True)

axes_cell = cell_of_item("ice_axes")
bosskey_cell = cell_of_item("boss_key")
print("ice_axes at", axes_cell, "| boss_key at", bosskey_cell)
check("ice_axes pickup reachable", reachable(seen_full, axes_cell))
check("boss_key reachable (behind the frost-wall alcove, with axes)",
      reachable(seen_full, bosskey_cell))

# sub-boss room = fs_axes(16,1); boss room = fs_boss(16,2)
subboss_any = any((16,1)==(sx,sy) for (sx,sy,_,_) in seen_full)
boss_any    = any((16,2)==(sx,sy) for (sx,sy,_,_) in seen_full)
check("sub-boss room fs_axes(16,1) reachable", subboss_any)
check("boss room fs_boss(16,2) reachable", boss_any)

# every open floor cell in every mountain screen must be reachable (with axes).
orphans = []
for s in W["screens"]:
    if (s["x"], s["y"]) not in MOUNT:
        continue
    for y in range(ROWS):
        for x in range(COLS):
            if walkable(s, x, y, True):
                if (s["x"], s["y"], x, y) not in seen_full:
                    orphans.append((s["name"], x, y, names[tile_at(s,x,y)]))
check("0 orphan walkable cells across all 9 mountain screens (got %d)" % len(orphans),
      len(orphans) == 0)
if orphans:
    for o in orphans[:30]:
        print("    ORPHAN", o)

print()
print("=== FORCED-GATE checks (each major gate is genuinely required) ===")

# 1) Without ice axes, the boss room must be UNREACHABLE (frost-wall back half
#    in fs_flood + the fs_stand plate-door is fine, but fs_flood frost seam gates
#    the only path E to the boss).
seen_noaxes = flood(ENTRY, have_axes=False)
boss_noaxes = any((16,2)==(sx,sy) for (sx,sy,_,_) in seen_noaxes)
check("WITHOUT ice axes: boss room is BLOCKED (frost-wall gate required)",
      not boss_noaxes)
# boss_key alcove must also be blocked without axes.
bosskey_noaxes = reachable(seen_noaxes, bosskey_cell)
check("WITHOUT ice axes: boss_key alcove is BLOCKED (frost-wall gate required)",
      not bosskey_noaxes)
# but ice_axes itself must be reachable without axes (no chicken-and-egg).
check("WITHOUT ice axes: the ice_axes pickup is STILL reachable (no softlock)",
      reachable(seen_noaxes, axes_cell))

# 2) Forced plate-door: if fs_stand's gate-7 plate_door is treated as SOLID
#    (puzzle unsolved), the S passage to fs_flood/boss must be cut.
def flood_forced_solid(start, have_axes, force_solid_gate=None, force_solid_frost=False):
    def walk2(s, x, y):
        t = tile_at(s, x, y)
        if frost[t]:
            return have_axes and not force_solid_frost
        if hole[t]:
            return True
        if water[t]:
            return False
        g = gate[t]
        if force_solid_gate is not None and g == force_solid_gate:
            return False
        if g in OPENABLE_GATES:
            return True
        return not solid[t]
    def nbrs(s, x, y):
        sx, sy = s["x"], s["y"]
        out = []
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < COLS and 0 <= ny < ROWS and walk2(s, nx, ny):
                out.append((sx, sy, nx, ny))
        if x == 0 and (sx-1,sy) in by_coord and walk2(by_coord[(sx-1,sy)], COLS-1, y):
            out.append((sx-1, sy, COLS-1, y))
        if x == COLS-1 and (sx+1,sy) in by_coord and walk2(by_coord[(sx+1,sy)], 0, y):
            out.append((sx+1, sy, 0, y))
        if y == 0 and (sx,sy-1) in by_coord and walk2(by_coord[(sx,sy-1)], x, ROWS-1):
            out.append((sx, sy-1, x, ROWS-1))
        if y == ROWS-1 and (sx,sy+1) in by_coord and walk2(by_coord[(sx,sy+1)], x, 0):
            out.append((sx, sy+1, x, 0))
        return out
    seen = {start}; q = deque([start])
    while q:
        sx, sy, x, y = q.popleft()
        for c in nbrs(by_coord[(sx,sy)], x, y):
            if c[:2] in MOUNT and c not in seen:
                seen.add(c); q.append(c)
    return seen

seen_plate_solid = flood_forced_solid(ENTRY, have_axes=True, force_solid_gate=7)
boss_no_plate = any((16,2)==(sx,sy) for (sx,sy,_,_) in seen_plate_solid)
check("plate_door (gate 7) SOLID: boss room BLOCKED (two-plate puzzle required)",
      not boss_no_plate)

# 3) Forced torch-door: if the gate-10 torch_door is solid (torches unlit), the
#    sub-boss / ice_axes room must be unreachable from the entry.
seen_torch_solid = flood_forced_solid(ENTRY, have_axes=True, force_solid_gate=10)
axes_no_torch = reachable(seen_torch_solid, axes_cell)
check("torch_door (gate 10) SOLID: ice_axes room BLOCKED (torch puzzle required)",
      not axes_no_torch)

print()
print("RESULT:", "ALL GREEN" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)
