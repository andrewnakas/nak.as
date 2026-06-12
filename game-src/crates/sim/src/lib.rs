//! Deterministic game simulation core for Nak's Awakening.
//!
//! Determinism rules (enforced by convention + tests):
//! - integer fixed-point only (see `fixed`); no f32/f64
//! - all randomness via the seeded `rng::Pcg32`
//! - no wall-clock time; the tick counter is the only clock
//! - no iteration over HashMap/HashSet in sim logic

#![forbid(unsafe_code)]

pub mod draw;
pub mod fixed;
pub mod input;
pub mod rng;
pub mod world;

use draw::{DrawList, FLAG_FLIP_X, HUD_H, SCREEN_H, SCREEN_W};
use fixed::{fx, to_px, Fx};
use input::*;
use rng::Pcg32;
use world::World;

pub const TICKS_PER_SEC: u32 = 60;
pub const MAX_PLAYERS: usize = 4;
pub const TRANSITION_TICKS: u32 = 40;

/// Player walk speed: 1.25 px/tick = 75 px/s, close to LA's feel.
const WALK_SPEED: Fx = fx(1) + fx(1) / 4;

/// Sprite is 16x16; movement collides on a feet box near the bottom.
const FEET_X0: i32 = 3;
const FEET_X1: i32 = 12;
const FEET_Y0: i32 = 10;
const FEET_Y1: i32 = 15;

/// Valid sprite-position ranges in screen space (playfield is y 16..144).
const MIN_X: Fx = fx(0);
const MAX_X: Fx = fx(SCREEN_W - 16);
const MIN_Y: Fx = fx(HUD_H);
const MAX_Y: Fx = fx(SCREEN_H - 16);

#[derive(Clone, Copy)]
pub struct Transition {
    /// Travel direction: 0 down, 1 up, 2 left, 3 right.
    pub dir: u8,
    pub t: u32,
}

#[derive(Clone)]
pub struct Player {
    pub sx: i32,
    pub sy: i32,
    pub x: Fx,
    pub y: Fx,
    pub facing: u8, // 0 down, 1 up, 2 left, 3 right
    pub walking: bool,
    pub anim: u32,
    pub buttons: u16,
    pub transition: Option<Transition>,
}

pub struct Sim {
    pub tick: u32,
    pub seed: u64,
    rng: Pcg32,
    pub world: World,
    pub players: [Option<Player>; 4],
}

impl Sim {
    pub fn new(content_json: &str, seed: u64) -> Result<Self, String> {
        Ok(Sim {
            tick: 0,
            seed,
            rng: Pcg32::new(seed, 1),
            world: World::from_json(content_json)?,
            players: [None, None, None, None],
        })
    }

    pub fn add_player(&mut self, slot: usize) {
        if slot >= MAX_PLAYERS || self.players[slot].is_some() {
            return;
        }
        let sp = self.world.spawn;
        self.players[slot] = Some(Player {
            sx: sp.sx,
            sy: sp.sy,
            x: fx(sp.x + slot as i32 * 12).clamp(MIN_X, MAX_X),
            y: fx(sp.y).clamp(MIN_Y, MAX_Y),
            facing: 0,
            walking: false,
            anim: 0,
            buttons: 0,
            transition: None,
        });
    }

    pub fn set_input(&mut self, slot: usize, buttons: u16) {
        if let Some(Some(p)) = self.players.get_mut(slot) {
            p.buttons = buttons;
        }
    }

    pub fn step(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        for slot in 0..MAX_PLAYERS {
            self.step_player(slot);
        }
    }

    fn step_player(&mut self, slot: usize) {
        // Work on a copy to keep borrows of self.world simple; write back at end.
        let Some(mut pl) = self.players[slot].clone() else {
            return;
        };

        if let Some(tr) = &mut pl.transition {
            tr.t += 1;
            if tr.t >= TRANSITION_TICKS {
                pl.transition = None;
            }
            self.players[slot] = Some(pl);
            return;
        }

        let mut dx: Fx = 0;
        let mut dy: Fx = 0;
        if pl.buttons & BTN_LEFT != 0 {
            dx -= WALK_SPEED;
        }
        if pl.buttons & BTN_RIGHT != 0 {
            dx += WALK_SPEED;
        }
        if pl.buttons & BTN_UP != 0 {
            dy -= WALK_SPEED;
        }
        if pl.buttons & BTN_DOWN != 0 {
            dy += WALK_SPEED;
        }
        // Facing: vertical wins on diagonals (matches LA feel).
        if dy < 0 {
            pl.facing = 1;
        } else if dy > 0 {
            pl.facing = 0;
        } else if dx < 0 {
            pl.facing = 2;
        } else if dx > 0 {
            pl.facing = 3;
        }
        pl.walking = dx != 0 || dy != 0;
        if pl.walking {
            pl.anim = pl.anim.wrapping_add(1);
        }

        let screen = match self.world.screen_at(pl.sx, pl.sy) {
            Some(s) => s,
            None => {
                self.players[slot] = Some(pl);
                return;
            }
        };

        // Axis-separated movement against the feet box for wall sliding.
        if dx != 0 {
            let nx = pl.x + dx;
            if self.feet_clear(screen, nx, pl.y) {
                pl.x = nx;
            }
        }
        if dy != 0 {
            let ny = pl.y + dy;
            if self.feet_clear(screen, pl.x, ny) {
                pl.y = ny;
            }
        }

        // Edge crossing -> screen transition (or clamp at world border).
        let (mut tdir, mut nsx, mut nsy) = (None, pl.sx, pl.sy);
        if pl.x < MIN_X {
            tdir = Some(2u8);
            nsx -= 1;
        } else if pl.x > MAX_X {
            tdir = Some(3);
            nsx += 1;
        } else if pl.y < MIN_Y {
            tdir = Some(1);
            nsy -= 1;
        } else if pl.y > MAX_Y {
            tdir = Some(0);
            nsy += 1;
        }

        if let Some(dir) = tdir {
            if self.world.screen_at(nsx, nsy).is_some() {
                pl.sx = nsx;
                pl.sy = nsy;
                match dir {
                    2 => pl.x = MAX_X,
                    3 => pl.x = MIN_X,
                    1 => pl.y = MAX_Y,
                    _ => pl.y = MIN_Y,
                }
                pl.transition = Some(Transition { dir, t: 0 });
            } else {
                pl.x = pl.x.clamp(MIN_X, MAX_X);
                pl.y = pl.y.clamp(MIN_Y, MAX_Y);
            }
        }

        self.players[slot] = Some(pl);
    }

    fn feet_clear(&self, screen: &world::Screen, x: Fx, y: Fx) -> bool {
        let px = to_px(x);
        let py = to_px(y);
        !(self.world.is_solid(screen, px + FEET_X0, py + FEET_Y0)
            || self.world.is_solid(screen, px + FEET_X1, py + FEET_Y0)
            || self.world.is_solid(screen, px + FEET_X0, py + FEET_Y1)
            || self.world.is_solid(screen, px + FEET_X1, py + FEET_Y1))
    }

    // ---- rendering ----

    /// Emit the draw list as seen by `viewpoint`'s player (each client renders
    /// its own player's screen). Paint order: tiles, sprites, HUD.
    pub fn render(&self, viewpoint: usize, out: &mut DrawList) {
        let Some(Some(vp)) = self.players.get(viewpoint) else {
            out.rect(0, 0, 0, SCREEN_W as u16, SCREEN_H as u16);
            return;
        };

        match vp.transition {
            None => {
                self.draw_screen(vp.sx, vp.sy, 0, 0, out);
                self.draw_players_on(vp.sx, vp.sy, 0, 0, out);
            }
            Some(tr) => {
                // vp is already on the NEW screen; the old screen is behind it.
                let (dx, dy) = match tr.dir {
                    0 => (0, 1),
                    1 => (0, -1),
                    2 => (-1, 0),
                    _ => (1, 0),
                };
                let (osx, osy) = (vp.sx - dx, vp.sy - dy);
                let shift_x = (tr.t as i32 * SCREEN_W) / TRANSITION_TICKS as i32;
                let shift_y = (tr.t as i32 * (SCREEN_H - HUD_H)) / TRANSITION_TICKS as i32;
                let (new_ox, new_oy) = (
                    dx * (SCREEN_W - shift_x),
                    dy * ((SCREEN_H - HUD_H) - shift_y),
                );
                let (old_ox, old_oy) = (-dx * shift_x, -dy * shift_y);
                self.draw_screen(osx, osy, old_ox, old_oy, out);
                self.draw_screen(vp.sx, vp.sy, new_ox, new_oy, out);
                self.draw_players_on(osx, osy, old_ox, old_oy, out);
                self.draw_players_on(vp.sx, vp.sy, new_ox, new_oy, out);
            }
        }

        // HUD bar (hearts etc. come with combat).
        out.rect(0, 0, 0, SCREEN_W as u16, HUD_H as u16);
    }

    fn draw_screen(&self, sx: i32, sy: i32, ox: i32, oy: i32, out: &mut DrawList) {
        let Some(screen) = self.world.screen_at(sx, sy) else {
            return;
        };
        for ty in 0..world::SCREEN_ROWS {
            for tx in 0..world::SCREEN_COLS {
                let tile = screen.tiles[(ty * world::SCREEN_COLS + tx) as usize];
                out.tile(tile, tx * 16 + ox, HUD_H + ty * 16 + oy, 0);
            }
        }
    }

    fn draw_players_on(&self, sx: i32, sy: i32, ox: i32, oy: i32, out: &mut DrawList) {
        // Draw in y order so southern players overlap northern ones.
        let mut order: Vec<usize> = (0..MAX_PLAYERS)
            .filter(|&i| {
                self.players[i]
                    .as_ref()
                    .is_some_and(|p| p.sx == sx && p.sy == sy)
            })
            .collect();
        order.sort_by_key(|&i| self.players[i].as_ref().unwrap().y);

        for i in order {
            let p = self.players[i].as_ref().unwrap();
            let frame = if p.walking { (p.anim >> 3) & 1 } else { 0 } as u16;
            let (base, flags) = match p.facing {
                1 => (self.world.sprites.player_up, 0),
                2 => (self.world.sprites.player_side, 0),
                3 => (self.world.sprites.player_side, FLAG_FLIP_X),
                _ => (self.world.sprites.player_down, 0),
            };
            out.sprite(base + frame, to_px(p.x) + ox, to_px(p.y) + oy, 0, flags);
        }
    }

    /// FNV-1a over the canonical state; used by determinism tests and the
    /// debug overlay. Any sim-visible state must feed in here.
    pub fn state_hash(&self) -> u64 {
        let mut h = Fnv::new();
        h.u32(self.tick);
        h.u64(self.rng.state_bits());
        for p in self.players.iter() {
            match p {
                None => h.u32(0xDEAD),
                Some(p) => {
                    h.u32(1);
                    h.i32(p.sx);
                    h.i32(p.sy);
                    h.i32(p.x);
                    h.i32(p.y);
                    h.u32(p.facing as u32);
                    h.u32(p.anim);
                    match p.transition {
                        None => h.u32(0),
                        Some(tr) => {
                            h.u32(tr.dir as u32 + 1);
                            h.u32(tr.t);
                        }
                    }
                }
            }
        }
        h.finish()
    }
}

pub struct Fnv(u64);

impl Fnv {
    pub fn new() -> Self {
        Fnv(0xcbf29ce484222325)
    }
    pub fn byte(&mut self, b: u8) {
        self.0 ^= b as u64;
        self.0 = self.0.wrapping_mul(0x100000001b3);
    }
    pub fn u32(&mut self, v: u32) {
        for b in v.to_le_bytes() {
            self.byte(b);
        }
    }
    pub fn i32(&mut self, v: i32) {
        self.u32(v as u32);
    }
    pub fn u64(&mut self, v: u64) {
        for b in v.to_le_bytes() {
            self.byte(b);
        }
    }
    pub fn finish(&self) -> u64 {
        self.0
    }
}

impl Default for Fnv {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2x1-screen test world: borders solid, interiors open, gap on the
    /// shared edge so players can cross between screens.
    fn test_world() -> String {
        let mut screens = Vec::new();
        for sx in 0..2 {
            let mut tiles = vec![0u16; 80];
            for tx in 0..10 {
                tiles[tx] = 1;
                tiles[70 + tx] = 1;
            }
            for ty in 0..8 {
                if ty != 3 && ty != 4 {
                    tiles[ty * 10] = 1;
                    tiles[ty * 10 + 9] = 1;
                }
            }
            screens.push(format!(
                r#"{{"x":{sx},"y":0,"name":"t{sx}","tiles":{tiles:?}}}"#
            ));
        }
        format!(
            r#"{{"tile_names":["floor","wall"],"tile_solid":[false,true],
"sprite_names":["player_down_0","player_up_0","player_side_0"],
"screens":[{}],"spawn":{{"sx":0,"sy":0,"x":72,"y":64}}}}"#,
            screens.join(",")
        )
    }

    fn scripted_run(ticks: u32) -> u64 {
        let world = test_world();
        let mut sim = Sim::new(&world, 0xA11CE).unwrap();
        sim.add_player(0);
        sim.add_player(1);
        let mut script = Pcg32::new(42, 7);
        for t in 0..ticks {
            if t % 13 == 0 {
                sim.set_input(0, (script.next_u32() & 0xf) as u16);
            }
            if t % 7 == 0 {
                sim.set_input(1, (script.next_u32() & 0xf) as u16);
            }
            sim.step();
        }
        sim.state_hash()
    }

    #[test]
    fn determinism_same_inputs_same_hash() {
        assert_eq!(scripted_run(10_000), scripted_run(10_000));
    }

    #[test]
    fn players_move_and_collide() {
        let world = test_world();
        let mut sim = Sim::new(&world, 1).unwrap();
        sim.add_player(0);
        let x0 = sim.players[0].as_ref().unwrap().x;
        sim.set_input(0, BTN_RIGHT);
        for _ in 0..10 {
            sim.step();
        }
        assert!(sim.players[0].as_ref().unwrap().x > x0);
        // Hold up: should stop at the wall row, not pass through.
        sim.set_input(0, BTN_UP);
        for _ in 0..600 {
            sim.step();
        }
        let p = sim.players[0].as_ref().unwrap();
        assert_eq!(p.sy, 0);
        assert!(to_px(p.y) >= HUD_H + 16 - FEET_Y0);
    }

    #[test]
    fn screen_transition_through_gap() {
        let world = test_world();
        let mut sim = Sim::new(&world, 1).unwrap();
        sim.add_player(0);
        // Spawn (y=64) is aligned with the edge gap (rows 3-4); walk right through it.
        sim.set_input(0, BTN_RIGHT);
        for _ in 0..400 {
            sim.step();
        }
        let p = sim.players[0].as_ref().unwrap();
        assert_eq!(p.sx, 1, "player should have crossed to screen 1");
    }
}
