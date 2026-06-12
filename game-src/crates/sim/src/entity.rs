//! Dynamic entities: enemies (with per-type brains), projectiles, pickups.

use crate::defs::{Brain, Defs};
use crate::fixed::{fx, to_px, Fx};
use crate::rng::Pcg32;
use crate::world::{Screen, World};
use crate::Player;

pub const ET_ENEMY: u8 = 0;
pub const ET_PROJECTILE: u8 = 1;
pub const ET_PICKUP: u8 = 2;
pub const ET_BOMB: u8 = 3;
pub const ET_BLAST: u8 = 4;

/// Projectile kinds (EntitySnap.def for ET_PROJECTILE).
pub const PJ_SEED: u8 = 0;
pub const PJ_ARROW: u8 = 1;

pub const BOMB_FUSE: u32 = 90;
pub const BLAST_TTL: u32 = 14;
pub const BLAST_RADIUS: i32 = 26;

/// Pickup kinds (EntitySnap.def for ET_PICKUP; item index in data).
pub const PK_HEART: u8 = 0;
pub const PK_SHELLS: u8 = 1;
pub const PK_ITEM: u8 = 2;

pub const PICKUP_TTL: u32 = 600; // 10s before fading away

#[derive(Clone)]
pub struct Entity {
    pub id: u32,
    pub etype: u8,
    pub def: u8,
    /// Per-kind extra: gel split level / shell amount / item index / damage.
    pub data: i32,
    pub sx: i32,
    pub sy: i32,
    pub x: Fx,
    pub y: Fx,
    pub vx: Fx,
    pub vy: Fx,
    pub hp: i16,
    pub facing: u8,
    pub state: u8,
    pub state_t: u32,
    pub anim: u32,
    pub iframes: u8,
    pub home: (i32, i32), // spawn screen, for respawn bookkeeping
    pub alive: bool,
    /// Player slot that owns this projectile/bomb, or -1 for enemies.
    pub owner: i8,
    /// Poison ticks remaining (enemies; damages every 60 ticks).
    pub poison_t: u32,
}

impl Entity {
    pub fn enemy(id: u32, def: u8, hp: i16, sx: i32, sy: i32, x: i32, y: i32) -> Entity {
        Entity {
            id,
            etype: ET_ENEMY,
            def,
            data: 0,
            sx,
            sy,
            x: fx(x),
            y: fx(y),
            vx: 0,
            vy: 0,
            hp,
            facing: 0,
            state: 0,
            state_t: 0,
            anim: 0,
            iframes: 0,
            home: (sx, sy),
            alive: true,
            owner: -1,
            poison_t: 0,
        }
    }

    pub fn feet_box(&self) -> (i32, i32, i32, i32) {
        let px = to_px(self.x);
        let py = to_px(self.y);
        (px + 2, py + 2, px + 13, py + 13)
    }
}

/// Enemy brain states (meaning varies per brain).
const ST_IDLE: u8 = 0;
const ST_MOVE: u8 = 1;
const ST_ATTACK: u8 = 2;
const ST_FLEE: u8 = 3;

pub struct StepCtx<'a> {
    pub world: &'a World,
    pub defs: &'a Defs,
    pub tick: u32,
}

/// Advance one enemy by one tick. Returns an optional projectile to spawn
/// (id is assigned by the caller).
pub fn step_enemy(
    e: &mut Entity,
    ctx: &StepCtx,
    players: &[Option<Player>; 4],
    rng: &mut Pcg32,
) -> Option<Entity> {
    e.anim = e.anim.wrapping_add(1);
    e.state_t = e.state_t.wrapping_add(1);
    if e.iframes > 0 {
        e.iframes -= 1;
    }

    // Knockback overrides the brain while active.
    if e.vx != 0 || e.vy != 0 {
        try_move(e, ctx.world, e.vx, e.vy);
        e.vx = decay(e.vx);
        e.vy = decay(e.vy);
        return None;
    }

    let def = &ctx.defs.enemies[e.def as usize];
    let target = nearest_player_on(players, e.sx, e.sy, e.x, e.y);

    match def.brain {
        Brain::Thornling => {
            // Rooted; spits a seed at the nearest player every few seconds.
            if let Some((px, py, _)) = target {
                if e.state_t > 150 + (rng.below(60)) {
                    e.state_t = 0;
                    return Some(spawn_seed(e, ctx, px, py));
                }
            }
            None
        }
        Brain::Crab => {
            match e.state {
                ST_ATTACK => {
                    // Sideways charge until a wall or 40 ticks.
                    let dx = if e.facing == 2 { -def.speed * 3 } else { def.speed * 3 };
                    if !try_move(e, ctx.world, dx, 0) || e.state_t > 40 {
                        e.state = ST_IDLE;
                        e.state_t = 0;
                    }
                }
                _ => {
                    wander(e, ctx.world, def.speed, rng, 60);
                    // Charge when roughly row-aligned with a player.
                    if let Some((px, py, _)) = target {
                        if (to_px(e.y) - to_px(py)).abs() < 10 && e.state_t > 30 {
                            e.facing = if px < e.x { 2 } else { 3 };
                            e.state = ST_ATTACK;
                            e.state_t = 0;
                        }
                    }
                }
            }
            None
        }
        Brain::Gel => {
            // Hop toward the player in bursts.
            if e.state == ST_MOVE {
                if e.state_t > 14 {
                    e.state = ST_IDLE;
                    e.state_t = 0;
                } else if let Some((px, py, _)) = target {
                    let (dx, dy) = step_toward(e.x, e.y, px, py, def.speed * 2);
                    try_move(e, ctx.world, dx, dy);
                }
            } else if e.state_t > 30 + rng.below(30) {
                e.state = ST_MOVE;
                e.state_t = 0;
            }
            None
        }
        Brain::Wasp => {
            // Weave toward the player, ignoring terrain (flies).
            if let Some((px, py, _)) = target {
                let (dx, dy) = step_toward(e.x, e.y, px, py, def.speed);
                let weave = ((ctx.tick / 8 + e.id) % 2) as i32 * 2 - 1;
                e.x += dx + weave * (fx(1) / 2);
                e.y += dy;
                e.facing = if dx < 0 { 2 } else { 3 };
            } else {
                wander_fly(e, rng);
            }
            clamp_to_playfield(e);
            None
        }
        Brain::Snatcher => {
            if e.state == ST_FLEE {
                // Run from the nearest player after stealing.
                if let Some((px, py, _)) = target {
                    let (dx, dy) = step_toward(e.x, e.y, px, py, def.speed * 2);
                    try_move(e, ctx.world, -dx, -dy);
                }
                if e.state_t > 120 {
                    e.state = ST_IDLE;
                    e.state_t = 0;
                }
            } else if let Some((px, py, d2)) = target {
                if d2 < 60 * 60 {
                    let (dx, dy) = step_toward(e.x, e.y, px, py, def.speed);
                    try_move(e, ctx.world, dx, dy);
                    e.facing = if dx < 0 { 2 } else { 3 };
                } else {
                    wander(e, ctx.world, def.speed, rng, 45);
                }
            }
            None
        }
    }
}

/// Bare entity with everything zeroed; callers set what they need.
pub fn blank(etype: u8, sx: i32, sy: i32, x: Fx, y: Fx) -> Entity {
    Entity {
        id: 0, // assigned by caller
        etype,
        def: 0,
        data: 0,
        sx,
        sy,
        x,
        y,
        vx: 0,
        vy: 0,
        hp: 1,
        facing: 0,
        state: 0,
        state_t: 0,
        anim: 0,
        iframes: 0,
        home: (sx, sy),
        alive: true,
        owner: -1,
        poison_t: 0,
    }
}

fn spawn_seed(e: &Entity, ctx: &StepCtx, px: Fx, py: Fx) -> Entity {
    let def = &ctx.defs.enemies[e.def as usize];
    let (vx, vy) = step_toward(e.x, e.y, px, py, fx(1) + fx(1) / 2);
    let mut p = blank(ET_PROJECTILE, e.sx, e.sy, e.x, e.y);
    p.def = PJ_SEED;
    p.data = def.damage as i32;
    p.vx = vx;
    p.vy = vy;
    p.facing = e.facing;
    p.home = e.home;
    p
}

/// Arrow fired by a player.
pub fn spawn_arrow(slot: u8, sx: i32, sy: i32, x: Fx, y: Fx, facing: u8, damage: i32) -> Entity {
    let speed = fx(3);
    let (vx, vy) = match facing {
        1 => (0, -speed),
        2 => (-speed, 0),
        3 => (speed, 0),
        _ => (0, speed),
    };
    let mut p = blank(ET_PROJECTILE, sx, sy, x, y);
    p.def = PJ_ARROW;
    p.data = damage;
    p.vx = vx;
    p.vy = vy;
    p.facing = facing;
    p.owner = slot as i8;
    p
}

/// Bomb placed by a player; explodes into a blast after BOMB_FUSE ticks.
pub fn spawn_bomb(slot: u8, sx: i32, sy: i32, x: Fx, y: Fx) -> Entity {
    let mut b = blank(ET_BOMB, sx, sy, x, y);
    b.owner = slot as i8;
    b
}

pub fn step_bomb(e: &mut Entity) -> bool {
    e.anim = e.anim.wrapping_add(1);
    e.state_t = e.state_t.wrapping_add(1);
    e.state_t >= BOMB_FUSE
}

pub fn step_blast(e: &mut Entity) {
    e.anim = e.anim.wrapping_add(1);
    e.state_t = e.state_t.wrapping_add(1);
    if e.state_t > BLAST_TTL {
        e.alive = false;
    }
}

pub fn step_projectile(e: &mut Entity, world: &World) {
    e.anim = e.anim.wrapping_add(1);
    e.state_t = e.state_t.wrapping_add(1);
    e.x += e.vx;
    e.y += e.vy;
    let px = to_px(e.x) + 8;
    let py = to_px(e.y) + 8;
    let screen = world.screen_at(e.sx, e.sy);
    let out = px < -8 || px > 168 || py < 8 || py > 152;
    let hit_wall = screen.is_some_and(|s| world.is_solid(s, px, py));
    if out || hit_wall || e.state_t > 240 {
        e.alive = false;
    }
}

pub fn step_pickup(e: &mut Entity) {
    e.anim = e.anim.wrapping_add(1);
    e.state_t = e.state_t.wrapping_add(1);
    if e.state_t > PICKUP_TTL {
        e.alive = false;
    }
}

// ---- movement helpers ----

fn decay(v: Fx) -> Fx {
    v - v / 4 - v.signum()
}

/// Move with wall collision on the entity's box; returns false if fully blocked.
fn try_move(e: &mut Entity, world: &World, dx: Fx, dy: Fx) -> bool {
    let Some(screen) = world.screen_at(e.sx, e.sy) else {
        return false;
    };
    let mut moved = false;
    if dx != 0 && box_clear(world, screen, e.x + dx, e.y) {
        e.x += dx;
        moved = true;
    }
    if dy != 0 && box_clear(world, screen, e.x, e.y + dy) {
        e.y += dy;
        moved = true;
    }
    // Entities never leave their screen (players are the only travelers).
    let clamped = clamp_to_playfield(e);
    moved && !clamped
}

fn box_clear(world: &World, screen: &Screen, x: Fx, y: Fx) -> bool {
    let px = to_px(x);
    let py = to_px(y);
    !(world.is_solid(screen, px + 2, py + 2)
        || world.is_solid(screen, px + 13, py + 2)
        || world.is_solid(screen, px + 2, py + 13)
        || world.is_solid(screen, px + 13, py + 13))
}

fn clamp_to_playfield(e: &mut Entity) -> bool {
    let cx = e.x.clamp(fx(0), fx(144));
    let cy = e.y.clamp(fx(16), fx(128));
    let clamped = cx != e.x || cy != e.y;
    e.x = cx;
    e.y = cy;
    clamped
}

fn wander(e: &mut Entity, world: &World, speed: Fx, rng: &mut Pcg32, period: u32) {
    if e.state_t > period {
        e.state_t = 0;
        e.facing = rng.below(5) as u8; // 4 = stand still
    }
    let (dx, dy) = match e.facing {
        0 => (0, speed),
        1 => (0, -speed),
        2 => (-speed, 0),
        3 => (speed, 0),
        _ => (0, 0),
    };
    if (dx != 0 || dy != 0) && !try_move(e, world, dx, dy) {
        e.state_t = period; // turn next tick
    }
}

fn wander_fly(e: &mut Entity, rng: &mut Pcg32) {
    if e.state_t > 40 {
        e.state_t = 0;
        e.facing = rng.below(4) as u8;
    }
    let s = fx(1) / 2;
    let (dx, dy) = match e.facing {
        0 => (0, s),
        1 => (0, -s),
        2 => (-s, 0),
        _ => (s, 0),
    };
    e.x += dx;
    e.y += dy;
}

fn step_toward(x: Fx, y: Fx, tx: Fx, ty: Fx, speed: Fx) -> (Fx, Fx) {
    // 8-way normalization without sqrt: full speed on the dominant axis,
    // half on the other when both are active (close enough for GBC feel).
    let dx = tx - x;
    let dy = ty - y;
    let ax = dx.abs();
    let ay = dy.abs();
    if ax > ay * 2 {
        (speed * dx.signum(), 0)
    } else if ay > ax * 2 {
        (0, speed * dy.signum())
    } else {
        (
            (speed * 3 / 4) * dx.signum(),
            (speed * 3 / 4) * dy.signum(),
        )
    }
}

fn nearest_player_on(
    players: &[Option<Player>; 4],
    sx: i32,
    sy: i32,
    x: Fx,
    y: Fx,
) -> Option<(Fx, Fx, i64)> {
    let mut best: Option<(Fx, Fx, i64)> = None;
    for p in players.iter().flatten() {
        if p.sx != sx || p.sy != sy || p.dead_t > 0 {
            continue;
        }
        let dx = to_px(p.x - x) as i64;
        let dy = to_px(p.y - y) as i64;
        let d2 = dx * dx + dy * dy;
        if best.is_none_or(|(_, _, b)| d2 < b) {
            best = Some((p.x, p.y, d2));
        }
    }
    best
}
