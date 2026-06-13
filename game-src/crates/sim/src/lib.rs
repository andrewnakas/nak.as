//! Deterministic game simulation core for Nak's Awakening.
//!
//! Determinism rules (enforced by convention + tests):
//! - integer fixed-point only (see `fixed`); no f32/f64
//! - all randomness via the seeded `rng::Pcg32`
//! - no wall-clock time; the tick counter is the only clock
//! - no iteration over HashMap/HashSet in sim logic (BTreeMap is fine)

#![forbid(unsafe_code)]

pub mod client;
pub mod defs;
pub mod draw;
pub mod entity;
pub mod fixed;
pub mod input;
pub mod rng;
pub mod save;
pub mod world;

use defs::{Brain, Defs, DropItem, FuseEffect, ItemKind};
use draw::{DrawList, FLAG_FLIP_X, HUD_H, SCREEN_H, SCREEN_W};
use entity::{
    Entity, StepCtx, BLAST_RADIUS, ET_BLAST, ET_BOMB, ET_ENEMY, ET_PICKUP, ET_PROJECTILE,
    PJ_ARROW, PK_HEART, PK_ITEM, PK_SHELLS,
};
use fixed::{fx, to_px, Fx};
use input::*;
use protocol::{EntitySnap, GameEvent, ItemSnap, PlayerSnap, SnapshotData};
use rng::Pcg32;
use serde::Deserialize;
use std::collections::BTreeMap;
use world::{World, WorldJson};

pub const TICKS_PER_SEC: u32 = 60;
/// Max players one host's sim tracks in a shared world. The lobby caps real
/// occupancy (CONNECT_CAP) below this; this is the array bound.
pub const MAX_PLAYERS: usize = 32;
pub const TRANSITION_TICKS: u32 = 40;
/// Screen columns >= this are the instanced tutorial beach (not the shared
/// mainland). Spawn point for the intro vs. town is chosen by the JS shell.
pub const TUTORIAL_COL: i32 = 5;
/// Where finished characters spawn (Driftwood Village).
pub const TOWN_SPAWN: (i32, i32, i32, i32) = (1, 1, 72, 80);

/// Sound cue ids (mirrored in game/js/audio.js).
pub mod cues {
    pub const SWING: u16 = 1;
    pub const HIT: u16 = 2;
    pub const ENEMY_DIE: u16 = 3;
    pub const HURT: u16 = 4;
    pub const HEART: u16 = 5;
    pub const SHELL: u16 = 6;
    pub const ITEM: u16 = 7;
    pub const DIE: u16 = 8;
    pub const SHOOT: u16 = 9;
    pub const BREAK: u16 = 10;
    pub const FUSE: u16 = 11;
    pub const BOOM: u16 = 12;
    pub const BLOCK: u16 = 13;
}

pub const INVENTORY_CAP: usize = 16;
pub const STACK_CAP: u16 = 99;

/// Player walk speed: 1.25 px/tick = 75 px/s, close to LA's feel.
const WALK_SPEED: Fx = fx(1) + fx(1) / 4;

const ATTACK_TICKS: u8 = 16;
/// Bare-handed punch/kick: faster but shorter reach and weaker.
const UNARMED_TICKS: u8 = 10;
/// Sword connects during this window of attack_t (counting down).
const HIT_WINDOW: std::ops::RangeInclusive<u8> = 4..=12;
const UNARMED_WINDOW: std::ops::RangeInclusive<u8> = 3..=8;
/// Bare-handed damage.
const UNARMED_DAMAGE: i16 = 1;
const PLAYER_IFRAMES: u8 = 60;
const ENEMY_IFRAMES: u8 = 10;
const RESPAWN_TICKS: u32 = 120;
const ENEMY_RESPAWN_TICKS: u32 = 1800; // screen empty 30s -> enemies return

/// Sprite is 16x16; movement collides on a small feet box near the bottom
/// (forgiving, LA-style: you slip past corners instead of snagging).
const FEET_X0: i32 = 5;
const FEET_X1: i32 = 10;
const FEET_Y0: i32 = 11;
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

/// One inventory slot: weapons are unstacked instances with durability;
/// bombs/arrows/materials stack in qty.
#[derive(Clone, Copy)]
pub struct ItemStack {
    pub def: u8,
    pub qty: u16,
    pub durability: u16,
    /// Material item def fused onto this weapon.
    pub fused: Option<u8>,
}

/// What a dialogue box is showing. The u8 is a quest index except for
/// Idle, where it picks one of the NPC's line sets.
#[derive(Clone, Copy, PartialEq)]
pub enum DialogueSource {
    Idle(u8),
    QuestOffer(u8),
    QuestIncomplete(u8),
    QuestComplete(u8),
}

#[derive(Clone, Copy)]
pub struct Dialogue {
    pub npc: u8,
    pub source: DialogueSource,
    pub page: u8,
}

#[derive(Clone, PartialEq)]
pub struct PlayerQuest {
    pub quest: u8,
    pub done: bool,
    /// One counter per objective (collect objectives stay 0; they are
    /// counted live from the inventory).
    pub progress: Vec<u32>,
}

/// Fishing mini-game phases.
#[derive(Clone, Copy, PartialEq)]
pub enum FishPhase {
    /// Waiting for a bite; t counts down.
    Cast { t: u32 },
    /// Bite window; press B within t ticks to land it.
    Bite { t: u32 },
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
    pub prev_buttons: u16,
    pub transition: Option<Transition>,
    pub hp: i16,
    pub max_hp: i16,
    pub shells: u32,
    pub inventory: Vec<ItemStack>,
    /// Indexes into inventory, or -1.
    pub equip_a: i8,
    pub equip_b: i8,
    pub attack_t: u8,
    /// The current attack is a bare-handed punch/kick (no weapon equipped).
    pub unarmed: bool,
    /// Cooldown ticks before bare hands can knock another stick off a tree.
    pub harvest_t: u32,
    pub shielding: bool,
    pub iframes: u8,
    pub kvx: Fx,
    pub kvy: Fx,
    pub dead_t: u32,
    /// XP per skill: [fishing, cooking, hunting].
    pub skills: [u32; 3],
    /// Character RPG progression (separate from the per-skill XP above):
    /// combat XP raises `level`, which raises max HP and base damage.
    pub level: u32,
    pub xp: u32,
    pub fishing: Option<FishPhase>,
    pub dialogue: Option<Dialogue>,
    pub quests: Vec<PlayerQuest>,
    /// Set once the player has completed the intro/tutorial. Persisted so
    /// returning characters spawn in town, not on the tutorial beach.
    pub intro_done: bool,
}

/// Total combat XP required to reach a level (level 1 = 0). Gentle quadratic.
pub fn xp_for_level(level: u32) -> u32 {
    let n = level.saturating_sub(1);
    60 * n + 20 * n * n
}

pub fn level_for_xp(xp: u32) -> u32 {
    let mut level = 1;
    while level < MAX_LEVEL && xp >= xp_for_level(level + 1) {
        level += 1;
    }
    level
}

pub const MAX_LEVEL: u32 = 30;
/// Hearts (2 HP each) gained: 3 hearts at L1, +1 heart every 2 levels.
pub fn max_hp_for_level(level: u32) -> i16 {
    (6 + (level.saturating_sub(1) / 2) as i16 * 2).min(40)
}
/// Flat bonus damage from character level (+1 per 5 levels).
pub fn level_damage_bonus(level: u32) -> i16 {
    (level.saturating_sub(1) / 5) as i16
}

impl Player {
    pub fn equipped(&self, slot: i8) -> Option<&ItemStack> {
        usize::try_from(slot).ok().and_then(|i| self.inventory.get(i))
    }
}

#[derive(Deserialize)]
struct Bundle {
    world: WorldJson,
    items: Vec<defs::ItemJson>,
    enemies: Vec<defs::EnemyJson>,
    drops: BTreeMap<String, Vec<defs::DropJson>>,
    skills: defs::SkillsJson,
    recipes: Vec<defs::RecipeJson>,
    npcs: Vec<defs::NpcJson>,
    quests: Vec<defs::QuestJson>,
}

pub struct Sim {
    pub tick: u32,
    pub seed: u64,
    rng: Pcg32,
    pub world: World,
    pub defs: Defs,
    pub players: [Option<Player>; MAX_PLAYERS],
    pub entities: Vec<Entity>,
    next_id: u32,
    last_spawn: BTreeMap<(i32, i32), u32>,
    /// Local sound cues (drained by the renderer side each frame).
    audio: Vec<(i32, i32, u16)>,
    /// Net events accumulated since the last drain (host broadcasts these).
    events: Vec<GameEvent>,
    /// UI toasts for local players (slot, message).
    toasts: Vec<(u8, String)>,
    /// Mutated tiles: (sx, sy, tile index) -> new tile id. Opened doors,
    /// cleared brambles. Broadcast in snapshots so clients render them.
    pub overrides: BTreeMap<(i32, i32, i32), u16>,
    pub content_hash: u64,
}

enum WearSlot {
    A,
    B,
}

#[derive(Clone, Copy)]
enum QuestEvent {
    Kill(u8),
    Cook,
    Fuse,
    Fish,
}

/// Add `qty` of `def` to the inventory; weapons get their full durability.
/// Returns false if there was no room.
pub fn give_item(p: &mut Player, defs: &Defs, def: u8, qty: u16) -> bool {
    let item = &defs.items[def as usize];
    if item.stackable() {
        if let Some(stack) = p.inventory.iter_mut().find(|s| s.def == def) {
            stack.qty = (stack.qty + qty).min(STACK_CAP);
            return true;
        }
    }
    if p.inventory.len() >= INVENTORY_CAP {
        return false;
    }
    p.inventory.push(ItemStack {
        def,
        qty: if item.stackable() { qty } else { 1 },
        durability: item.durability,
        fused: None,
    });
    true
}

fn consume_one(p: &mut Player, idx: usize) {
    if let Some(stack) = p.inventory.get_mut(idx) {
        stack.qty = stack.qty.saturating_sub(1);
        if stack.qty == 0 {
            p.inventory.remove(idx);
            fix_equips_after_remove(p, idx);
        }
    }
}

fn fix_equips_after_remove(p: &mut Player, removed: usize) {
    for e in [&mut p.equip_a, &mut p.equip_b] {
        if *e == removed as i8 {
            *e = -1;
        } else if *e > removed as i8 {
            *e -= 1;
        }
    }
}

impl Sim {
    pub fn new(content_json: &str, seed: u64) -> Result<Self, String> {
        let mut h = Fnv::new();
        for b in content_json.as_bytes() {
            h.byte(*b);
        }
        let bundle: Bundle = serde_json::from_str(content_json).map_err(|e| e.to_string())?;
        let sprite_names = bundle.world.sprite_names.clone();
        let defs = Defs::build(
            bundle.items,
            bundle.enemies,
            bundle.drops,
            bundle.skills,
            bundle.recipes,
            bundle.npcs,
            bundle.quests,
            &|name| world::sprite_index(&sprite_names, name),
        )?;
        let world = World::build(
            bundle.world,
            &|name| {
                defs.enemy_index(name)
                    .ok_or_else(|| format!("map references unknown enemy '{name}'"))
            },
            &|name| {
                defs.npc_def_index(name)
                    .ok_or_else(|| format!("map references unknown npc '{name}'"))
            },
            &|name| {
                defs.item_index(name)
                    .ok_or_else(|| format!("map references unknown item '{name}'"))
            },
        )?;

        let mut sim = Sim {
            tick: 0,
            seed,
            rng: Pcg32::new(seed, 1),
            world,
            defs,
            players: std::array::from_fn(|_| None),
            entities: Vec::new(),
            next_id: 1,
            last_spawn: BTreeMap::new(),
            audio: Vec::new(),
            events: Vec::new(),
            toasts: Vec::new(),
            overrides: BTreeMap::new(),
            content_hash: h.finish(),
        };
        for i in 0..sim.world.screens.len() {
            sim.spawn_screen(i);
        }
        // Ground items from the map: persistent pickups (state=1 -> no TTL).
        let mut ground = Vec::new();
        for screen in &sim.world.screens {
            for gi in &screen.items {
                let mut e = entity::blank(ET_PICKUP, screen.x, screen.y, fx(gi.x), fx(gi.y));
                e.def = PK_ITEM;
                e.data = gi.item as i32;
                e.state = 1;
                ground.push(e);
            }
        }
        for mut e in ground {
            e.id = sim.next_id;
            sim.next_id += 1;
            sim.entities.push(e);
        }
        Ok(sim)
    }

    fn spawn_screen(&mut self, screen_idx: usize) {
        let screen = &self.world.screens[screen_idx];
        let coords = (screen.x, screen.y);
        let mut spawned = Vec::new();
        for sp in &screen.spawns {
            let def = &self.defs.enemies[sp.enemy as usize];
            let mut e = Entity::enemy(
                self.next_id,
                sp.enemy,
                def.hp,
                screen.x,
                screen.y,
                sp.x,
                sp.y,
            );
            e.big = def.big;
            spawned.push(e);
            self.next_id += 1;
        }
        self.entities.extend(spawned);
        self.last_spawn.insert(coords, self.tick);
    }

    /// Tile solidity including door/bramble overrides (player path only;
    /// enemies keep using the pristine map).
    fn effective_solid(&self, screen: &world::Screen, px: i32, py: i32) -> bool {
        let tx = px.div_euclid(16);
        let ty = (py - HUD_H).div_euclid(16);
        if (0..world::SCREEN_COLS).contains(&tx) && (0..world::SCREEN_ROWS).contains(&ty) {
            if let Some(&t) = self
                .overrides
                .get(&(screen.x, screen.y, ty * world::SCREEN_COLS + tx))
            {
                return self.world.tile_solid.get(t as usize).copied().unwrap_or(true);
            }
        }
        self.world.is_solid(screen, px, py)
    }

    pub fn add_player(&mut self, slot: usize) {
        if slot >= MAX_PLAYERS || self.players[slot].is_some() {
            return;
        }
        let sp = self.world.spawn;
        let mut p = Player {
            sx: sp.sx,
            sy: sp.sy,
            x: fx(sp.x + slot as i32 * 12).clamp(MIN_X, MAX_X),
            y: fx(sp.y).clamp(MIN_Y, MAX_Y),
            facing: 0,
            walking: false,
            anim: 0,
            buttons: 0,
            prev_buttons: 0,
            transition: None,
            hp: 6,
            max_hp: 6,
            shells: 0,
            inventory: Vec::new(),
            equip_a: -1,
            equip_b: -1,
            attack_t: 0,
            unarmed: false,
            harvest_t: 0,
            shielding: false,
            iframes: 0,
            kvx: 0,
            kvy: 0,
            dead_t: 0,
            skills: [0, 0, 0],
            level: 1,
            xp: 0,
            fishing: None,
            dialogue: None,
            quests: Vec::new(),
            intro_done: false,
        };
        // No starting kit: you begin empty-handed. The first weapon is a
        // stick picked up off the ground in the intro; real gear is bought
        // from the town vendor with shells.
        self.players[slot] = Some(p);
    }

    /// Add a player and restore their character from a save (invalid or
    /// missing positions fall back to the spawn point; the screen must exist).
    pub fn add_player_with_save(&mut self, slot: usize, save_json: &str) {
        self.add_player(slot);
        let Some(mut p) = self.players.get(slot).cloned().flatten() else {
            return;
        };
        let positioned = save::apply(&self.defs, &mut p, save_json);
        if !positioned || self.world.screen_at(p.sx, p.sy).is_none() {
            let sp = self.world.spawn;
            p.sx = sp.sx;
            p.sy = sp.sy;
            p.x = fx(sp.x);
            p.y = fx(sp.y);
        }
        self.players[slot] = Some(p);
    }

    pub fn export_save(&self, slot: usize) -> String {
        match self.players.get(slot).and_then(|p| p.as_ref()) {
            Some(p) => save::export(&self.defs, p),
            None => "null".to_string(),
        }
    }

    pub fn remove_player(&mut self, slot: usize) {
        if slot < MAX_PLAYERS {
            self.players[slot] = None;
        }
    }

    pub fn set_input(&mut self, slot: usize, buttons: u16) {
        if let Some(Some(p)) = self.players.get_mut(slot) {
            p.buttons = buttons;
        }
    }

    fn emit_cue(&mut self, sx: i32, sy: i32, cue: u16) {
        self.audio.push((sx, sy, cue));
        self.events.push(GameEvent::Audio { sx, sy, cue });
    }

    fn emit_toast(&mut self, slot: usize, msg: &str) {
        self.toasts.push((slot as u8, msg.to_string()));
        self.events.push(GameEvent::Toast {
            slot: slot as u8,
            msg: msg.to_string(),
        });
    }

    /// Toasts for one player since the last call (host-side UI path).
    pub fn drain_toasts(&mut self, viewpoint: usize) -> Vec<String> {
        let out = self
            .toasts
            .iter()
            .filter(|(s, _)| *s as usize == viewpoint)
            .map(|(_, m)| m.clone())
            .collect();
        self.toasts.retain(|(s, _)| *s as usize != viewpoint);
        out
    }

    /// A bare-handed swing at a tree/bush knocks a stick loose. Rate-limited
    /// so you get one every ~1.5s, not a swarm. Returns true if it harvested.
    fn try_harvest_stick(&mut self, pl: &mut Player, slot: usize) -> bool {
        if pl.harvest_t > 0 {
            return false;
        }
        let (fx_, fy_) = facing_tile_center(pl);
        let near_tree = self
            .world
            .screen_at(pl.sx, pl.sy)
            .is_some_and(|s| self.world.is_tree(s, fx_, fy_));
        if !near_tree {
            return false;
        }
        let Some(stick) = self.defs.item_index("stick") else {
            return false;
        };
        if give_item(pl, &self.defs, stick, 1) {
            // Auto-equip if the sword hand is empty (you just disarmed).
            if pl.equip_a < 0 {
                if let Some(idx) = pl
                    .inventory
                    .iter()
                    .position(|s| s.def == stick)
                {
                    pl.equip_a = idx as i8;
                }
            }
            pl.harvest_t = 90;
            self.emit_toast(slot, "GOT A STICK");
            self.emit_cue(pl.sx, pl.sy, cues::ITEM);
            true
        } else {
            self.emit_toast(slot, "PACK IS FULL");
            false
        }
    }

    /// Roll the catch table at the player's fishing level.
    fn land_fish(&mut self, pl: &mut Player, slot: usize) {
        let level = self.defs.curve.level_for_xp(pl.skills[defs::SKILL_FISHING]);
        let eligible: Vec<defs::FishEntry> = self
            .defs
            .fishing
            .iter()
            .filter(|f| f.min_level <= level)
            .copied()
            .collect();
        let total: u32 = eligible.iter().map(|f| f.weight).sum();
        if total == 0 {
            return;
        }
        let mut roll = self.rng.below(total);
        let fish = eligible
            .iter()
            .find(|f| {
                if roll < f.weight {
                    true
                } else {
                    roll -= f.weight;
                    false
                }
            })
            .copied()
            .unwrap_or(eligible[0]);
        if give_item(pl, &self.defs, fish.item, 1) {
            let label = self.defs.items[fish.item as usize].label.clone();
            self.emit_toast(slot, &format!("CAUGHT A {label}!"));
            self.emit_cue(pl.sx, pl.sy, cues::ITEM);
            self.award_xp(pl, slot, defs::SKILL_FISHING, fish.xp);
            Self::quest_event(pl, &self.defs, QuestEvent::Fish);
            self.wear_weapon(pl, slot, WearSlot::B);
        } else {
            self.emit_toast(slot, "PACK IS FULL!");
        }
    }

    /// Add XP and toast on level-up.
    fn award_xp(&mut self, pl: &mut Player, slot: usize, skill: usize, amount: u32) {
        let before = self.defs.curve.level_for_xp(pl.skills[skill]);
        pl.skills[skill] = pl.skills[skill].saturating_add(amount);
        let after = self.defs.curve.level_for_xp(pl.skills[skill]);
        if after > before {
            self.emit_toast(slot, &format!("{} UP! LV {after}", defs::SKILL_NAMES[skill]));
            self.emit_cue(pl.sx, pl.sy, cues::FUSE);
        }
    }

    /// Character XP from a kill. Levels raise max HP and base damage.
    fn award_combat_xp(&mut self, pl: &mut Player, slot: usize, enemy_def: u8) {
        let amount = self.defs.enemies[enemy_def as usize].combat_xp;
        if amount == 0 {
            return;
        }
        let before = pl.level;
        pl.xp = pl.xp.saturating_add(amount);
        pl.level = level_for_xp(pl.xp);
        if pl.level > before {
            let new_max = max_hp_for_level(pl.level);
            let gained = new_max - pl.max_hp;
            pl.max_hp = new_max;
            pl.hp = (pl.hp + gained.max(0)).min(pl.max_hp); // heal the new hearts
            self.emit_toast(slot, &format!("LEVEL {}!", pl.level));
            self.emit_cue(pl.sx, pl.sy, cues::FUSE);
        }
    }

    fn weapon_damage(&self, stack: &ItemStack) -> i32 {
        let def = &self.defs.items[stack.def as usize];
        let fuse = stack
            .fused
            .map_or(0, |m| self.defs.items[m as usize].fuse_damage);
        (def.damage + fuse) as i32
    }

    fn weapon_poison(&self, stack: &ItemStack) -> bool {
        self.weapon_effect(stack) == Some(FuseEffect::Poison)
    }

    fn weapon_effect(&self, stack: &ItemStack) -> Option<FuseEffect> {
        stack.fused.map(|m| self.defs.items[m as usize].fuse_effect)
    }

    /// Clear bramble tiles (gate 3) intersecting a pixel box. Returns true
    /// if anything was cleared.
    fn clear_gates_in_box(&mut self, sx: i32, sy: i32, x0: i32, y0: i32, x1: i32, y1: i32) -> bool {
        let Some(screen) = self.world.screen_at(sx, sy) else {
            return false;
        };
        let mut cleared = Vec::new();
        let (ty0, ty1) = ((y0 - HUD_H).div_euclid(16), (y1 - 1 - HUD_H).div_euclid(16));
        let (tx0, tx1) = (x0.div_euclid(16), (x1 - 1).div_euclid(16));
        for ty in ty0..=ty1 {
            for tx in tx0..=tx1 {
                if !(0..world::SCREEN_COLS).contains(&tx)
                    || !(0..world::SCREEN_ROWS).contains(&ty)
                {
                    continue;
                }
                let idx = ty * world::SCREEN_COLS + tx;
                if self.overrides.contains_key(&(sx, sy, idx)) {
                    continue;
                }
                let tile = screen.tiles[idx as usize] as usize;
                if self.world.tile_gate.get(tile).copied().unwrap_or(0) == 3 {
                    if let Some(&target) = self.world.tile_cleared.get(tile) {
                        if target >= 0 {
                            cleared.push((idx, target as u16));
                        }
                    }
                }
            }
        }
        let any = !cleared.is_empty();
        for (idx, target) in cleared {
            self.overrides.insert((sx, sy, idx), target);
        }
        any
    }

    /// Durability loss on a connect; breaks the item at 0 (removed from
    /// inventory, equips fixed up, toast + cue emitted).
    fn wear_weapon(&mut self, pl: &mut Player, slot: usize, which: WearSlot) {
        let idx = match which {
            WearSlot::A => pl.equip_a,
            WearSlot::B => pl.equip_b,
        };
        let Ok(idx) = usize::try_from(idx) else {
            return;
        };
        let Some(stack) = pl.inventory.get_mut(idx) else {
            return;
        };
        stack.durability = stack.durability.saturating_sub(1);
        if stack.durability == 0 {
            let label = self.defs.items[stack.def as usize].label.clone();
            pl.inventory.remove(idx);
            fix_equips_after_remove(pl, idx);
            self.emit_toast(slot, &format!("THE {label} BROKE!"));
            self.emit_cue(pl.sx, pl.sy, cues::BREAK);
        }
    }

    /// Local sound cues on the viewpoint player's screen; clears the queue.
    pub fn drain_audio(&mut self, viewpoint: usize) -> Vec<u16> {
        let at = self.players[viewpoint.min(MAX_PLAYERS - 1)]
            .as_ref()
            .map(|p| (p.sx, p.sy));
        let out = match at {
            Some((sx, sy)) => self
                .audio
                .iter()
                .filter(|(ax, ay, _)| *ax == sx && *ay == sy)
                .map(|&(_, _, c)| c)
                .collect(),
            None => Vec::new(),
        };
        self.audio.clear();
        out
    }

    /// Net events since last call (encoded for the reliable channel).
    pub fn drain_events(&mut self) -> Vec<GameEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn step(&mut self) {
        self.tick = self.wrapping_tick();
        for slot in 0..MAX_PLAYERS {
            self.step_player(slot);
        }
        self.step_entities();
        self.resolve_combat();
        self.cleanup_and_drops();
        if self.tick % 60 == 0 {
            self.respawn_screens();
        }
    }

    fn wrapping_tick(&self) -> u32 {
        self.tick.wrapping_add(1)
    }

    fn step_player(&mut self, slot: usize) {
        // Work on a copy to keep borrows of self.world simple; write back at end.
        let Some(mut pl) = self.players[slot].clone() else {
            return;
        };

        if pl.iframes > 0 {
            pl.iframes -= 1;
        }
        if pl.harvest_t > 0 {
            pl.harvest_t -= 1;
        }

        if pl.dead_t > 0 {
            pl.dead_t -= 1;
            if pl.dead_t == 0 {
                // Finished characters respawn in town; mid-intro players
                // respawn at the beach start.
                let (sx, sy, x, y) = if pl.intro_done {
                    TOWN_SPAWN
                } else {
                    let sp = self.world.spawn;
                    (sp.sx, sp.sy, sp.x, sp.y)
                };
                pl.sx = sx;
                pl.sy = sy;
                pl.x = fx(x);
                pl.y = fx(y);
                pl.hp = pl.max_hp;
                pl.iframes = PLAYER_IFRAMES;
                pl.kvx = 0;
                pl.kvy = 0;
                pl.transition = None;
                pl.fishing = None;
            }
            pl.prev_buttons = pl.buttons;
            self.players[slot] = Some(pl);
            return;
        }

        if let Some(tr) = &mut pl.transition {
            tr.t += 1;
            if tr.t >= TRANSITION_TICKS {
                pl.transition = None;
            }
            pl.prev_buttons = pl.buttons;
            self.players[slot] = Some(pl);
            return;
        }

        // Knockback dominates while strong.
        if pl.kvx != 0 || pl.kvy != 0 {
            let screen = self.world.screen_at(pl.sx, pl.sy);
            if let Some(screen) = screen {
                let nx = pl.x + pl.kvx;
                if self.feet_clear(screen, nx, pl.y) {
                    pl.x = nx.clamp(MIN_X, MAX_X);
                }
                let ny = pl.y + pl.kvy;
                if self.feet_clear(screen, pl.x, ny) {
                    pl.y = ny.clamp(MIN_Y, MAX_Y);
                }
            }
            pl.kvx = pl.kvx - pl.kvx / 4 - pl.kvx.signum();
            pl.kvy = pl.kvy - pl.kvy / 4 - pl.kvy.signum();
            pl.prev_buttons = pl.buttons;
            self.players[slot] = Some(pl);
            return;
        }

        // Dialogue: freezes the player; A advances pages.
        if pl.dialogue.is_some() {
            if pl.buttons & BTN_A != 0 && pl.prev_buttons & BTN_A == 0 {
                self.advance_dialogue(&mut pl, slot);
            }
            pl.walking = false;
            pl.prev_buttons = pl.buttons;
            self.players[slot] = Some(pl);
            return;
        }

        // Talking takes priority over swinging when an NPC is in reach.
        if pl.buttons & BTN_A != 0 && pl.prev_buttons & BTN_A == 0 {
            if let Some(npc) = self.npc_in_front(&pl) {
                pl.dialogue = Some(self.choose_dialogue(&pl, npc));
                pl.fishing = None;
                pl.prev_buttons = pl.buttons;
                self.players[slot] = Some(pl);
                return;
            }
        }

        // Attack: A edge starts a swing (sword) or a punch/kick (unarmed);
        // movement is locked during the wind-up. Unarmed is shorter/weaker.
        if pl.attack_t > 0 {
            pl.attack_t -= 1;
            pl.walking = false;
            pl.prev_buttons = pl.buttons;
            self.players[slot] = Some(pl);
            return;
        }
        let has_sword = pl
            .equipped(pl.equip_a)
            .is_some_and(|s| self.defs.items[s.def as usize].kind == ItemKind::Sword);
        if pl.buttons & BTN_A != 0 && pl.prev_buttons & BTN_A == 0 {
            pl.attack_t = if has_sword { ATTACK_TICKS } else { UNARMED_TICKS };
            pl.unarmed = !has_sword;
            let (sx, sy) = (pl.sx, pl.sy);
            pl.prev_buttons = pl.buttons;
            self.players[slot] = Some(pl);
            self.emit_cue(sx, sy, cues::SWING);
            return;
        }

        // Active fishing intercepts B (catch attempt) and any movement (cancel).
        if let Some(phase) = pl.fishing {
            let b_pressed = pl.buttons & BTN_B != 0 && pl.prev_buttons & BTN_B == 0;
            let moved = pl.buttons & (BTN_UP | BTN_DOWN | BTN_LEFT | BTN_RIGHT) != 0;
            if moved {
                pl.fishing = None;
            } else {
                match phase {
                    FishPhase::Cast { t } => {
                        if b_pressed {
                            pl.fishing = None; // reeled in early
                        } else if t == 0 {
                            pl.fishing = Some(FishPhase::Bite { t: 40 });
                            self.emit_cue(pl.sx, pl.sy, cues::SHELL);
                        } else {
                            pl.fishing = Some(FishPhase::Cast { t: t - 1 });
                        }
                    }
                    FishPhase::Bite { t } => {
                        if b_pressed {
                            pl.fishing = None;
                            self.land_fish(&mut pl, slot);
                        } else if t == 0 {
                            pl.fishing = None;
                            self.emit_toast(slot, "IT GOT AWAY...");
                        } else {
                            pl.fishing = Some(FishPhase::Bite { t: t - 1 });
                        }
                    }
                }
                pl.walking = false;
                pl.prev_buttons = pl.buttons;
                self.players[slot] = Some(pl);
                return;
            }
        }

        // B item: bow shoots, bomb places, rod casts, shield blocks while held.
        pl.shielding = false;
        if let Some(stack) = pl.equipped(pl.equip_b).copied() {
            let kind = self.defs.items[stack.def as usize].kind;
            let pressed = pl.buttons & BTN_B != 0 && pl.prev_buttons & BTN_B == 0;
            match kind {
                ItemKind::Shield => pl.shielding = pl.buttons & BTN_B != 0,
                ItemKind::Bow if pressed => {
                    if let Some(arrows) = self
                        .defs
                        .item_index("arrow")
                        .and_then(|a| pl.inventory.iter().position(|s| s.def == a && s.qty > 0))
                    {
                        let dmg = self.weapon_damage(&stack);
                        consume_one(&mut pl, arrows);
                        let mut arrow = entity::spawn_arrow(
                            slot as u8, pl.sx, pl.sy, pl.x, pl.y, pl.facing, dmg,
                        );
                        arrow.id = self.next_id;
                        self.next_id += 1;
                        self.entities.push(arrow);
                        self.emit_cue(pl.sx, pl.sy, cues::SHOOT);
                        self.wear_weapon(&mut pl, slot, WearSlot::B);
                    } else {
                        self.emit_toast(slot, "OUT OF ARROWS!");
                    }
                }
                ItemKind::Bomb if pressed => {
                    let inv = pl.inventory.iter().position(|s| s.def == stack.def);
                    if let Some(inv) = inv {
                        consume_one(&mut pl, inv);
                        let mut bomb = entity::spawn_bomb(slot as u8, pl.sx, pl.sy, pl.x, pl.y);
                        bomb.id = self.next_id;
                        self.next_id += 1;
                        self.entities.push(bomb);
                    }
                }
                ItemKind::Rod if pressed => {
                    // Cast only when the tile in front is water.
                    let (fx_, fy_) = facing_tile_center(&pl);
                    let in_water = self
                        .world
                        .screen_at(pl.sx, pl.sy)
                        .is_some_and(|s| self.world.is_water(s, fx_, fy_));
                    if in_water {
                        let wait = 90 + self.rng.below(150);
                        pl.fishing = Some(FishPhase::Cast { t: wait });
                        self.emit_cue(pl.sx, pl.sy, cues::SWING);
                    } else {
                        self.emit_toast(slot, "FACE THE WATER TO FISH");
                    }
                }
                _ => {}
            }
        }
        // Shielding slows you down.
        let speed = if pl.shielding {
            WALK_SPEED / 2
        } else {
            WALK_SPEED
        };

        let mut dx: Fx = 0;
        let mut dy: Fx = 0;
        if pl.buttons & BTN_LEFT != 0 {
            dx -= speed;
        }
        if pl.buttons & BTN_RIGHT != 0 {
            dx += speed;
        }
        if pl.buttons & BTN_UP != 0 {
            dy -= speed;
        }
        if pl.buttons & BTN_DOWN != 0 {
            dy += speed;
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
                pl.prev_buttons = pl.buttons;
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
            let dest = self.world.screen_at(nsx, nsy);
            let (dx_, dy_) = match dir {
                2 => (MAX_X, pl.y),
                3 => (MIN_X, pl.y),
                1 => (pl.x, MAX_Y),
                _ => (pl.x, MIN_Y),
            };
            // Only cross if the landing spot is walkable — walking off an
            // open edge into a rock on the neighbor screen would trap you.
            let clear = dest.is_some_and(|s| self.feet_clear_on(s, dx_, dy_));
            if clear {
                pl.sx = nsx;
                pl.sy = nsy;
                pl.x = dx_;
                pl.y = dy_;
                pl.transition = Some(Transition { dir, t: 0 });
            } else {
                pl.x = pl.x.clamp(MIN_X, MAX_X);
                pl.y = pl.y.clamp(MIN_Y, MAX_Y);
            }
        }

        // Belt and braces: if anything still left us inside a wall (bad
        // warp target, old save), slide to the nearest clear spot.
        if let Some(screen) = self.world.screen_at(pl.sx, pl.sy) {
            if !self.feet_clear_on(screen, pl.x, pl.y) {
                if let Some((ux, uy)) = self.find_clear_near(screen, pl.x, pl.y) {
                    pl.x = ux;
                    pl.y = uy;
                }
            }
        }

        // Key doors: push into one with the right key to open it.
        if pl.walking {
            let pushing = matches!(
                (pl.facing, pl.buttons),
                (0, b) if b & BTN_DOWN != 0)
                || matches!((pl.facing, pl.buttons), (1, b) if b & BTN_UP != 0)
                || matches!((pl.facing, pl.buttons), (2, b) if b & BTN_LEFT != 0)
                || matches!((pl.facing, pl.buttons), (3, b) if b & BTN_RIGHT != 0);
            if pushing {
                let (fx_, fy_) = facing_tile_center(&pl);
                let door = self.world.screen_at(pl.sx, pl.sy).and_then(|screen| {
                    let (idx, tile) = self.world.tile_at(screen, fx_, fy_)?;
                    if self.overrides.contains_key(&(pl.sx, pl.sy, idx)) {
                        return None; // already opened
                    }
                    let gate = self.world.tile_gate.get(tile as usize).copied().unwrap_or(0);
                    let cleared = self.world.tile_cleared.get(tile as usize).copied().unwrap_or(-1);
                    (matches!(gate, 1 | 2) && cleared >= 0).then_some((idx, gate, cleared as u16))
                });
                if let Some((idx, gate, cleared)) = door {
                    let key_name = if gate == 1 { "small_key" } else { "boss_key" };
                    let key = self.defs.item_index(key_name);
                    let key_idx = key.and_then(|k| {
                        pl.inventory.iter().position(|s| s.def == k && s.qty > 0)
                    });
                    if let Some(ki) = key_idx {
                        consume_one(&mut pl, ki);
                        self.overrides.insert((pl.sx, pl.sy, idx), cleared);
                        self.emit_cue(pl.sx, pl.sy, cues::ITEM);
                        self.emit_toast(slot, "THE DOOR OPENS");
                    } else if self.tick % 60 == 0 {
                        self.emit_toast(
                            slot,
                            if gate == 1 { "LOCKED. NEEDS A KEY." } else { "SEALED. NEEDS THE BOSS KEY." },
                        );
                    }
                }
            }
        }

        // Warp tiles (cave mouths, stairs) teleport on step.
        if let Some(screen) = self.world.screen_at(pl.sx, pl.sy) {
            let cx = to_px(pl.x) + 8;
            let cy = to_px(pl.y) + 8;
            let (wtx, wty) = (cx.div_euclid(16), (cy - HUD_H).div_euclid(16));
            if let Some(w) = screen.warps.iter().find(|w| w.tx == wtx && w.ty == wty) {
                let was_beach = pl.sx >= TUTORIAL_COL;
                pl.sx = w.sx;
                pl.sy = w.sy;
                pl.x = fx(w.px).clamp(MIN_X, MAX_X);
                pl.y = fx(w.py).clamp(MIN_Y, MAX_Y);
                pl.transition = None;
                pl.iframes = pl.iframes.max(30);
                // Leaving the tutorial beach for the mainland completes the intro.
                if was_beach && pl.sx < TUTORIAL_COL && !pl.intro_done {
                    pl.intro_done = true;
                    self.emit_toast(slot, "WELCOME TO DRIFTWOOD VILLAGE");
                }
            }
        }

        pl.prev_buttons = pl.buttons;
        self.players[slot] = Some(pl);
    }

    // ---- npcs, dialogue, quests ----

    fn npc_in_front(&self, p: &Player) -> Option<u8> {
        let screen = self.world.screen_at(p.sx, p.sy)?;
        let (fx_, fy_) = facing_tile_center(p);
        let (cx, cy) = (to_px(p.x) + 8, to_px(p.y) + 8);
        // Facing tile, or standing inside the NPC (players pass through them).
        screen
            .npcs
            .iter()
            .find(|n| {
                ((n.x + 8 - fx_).abs() <= 10 && (n.y + 8 - fy_).abs() <= 10)
                    || ((n.x + 8 - cx).abs() <= 12 && (n.y + 8 - cy).abs() <= 12)
            })
            .map(|n| n.npc)
    }

    /// True if a vendor NPC of def `npc` is on the player's screen, nearby.
    fn vendor_in_reach(&self, p: &Player, npc: u8) -> bool {
        let Some(screen) = self.world.screen_at(p.sx, p.sy) else {
            return false;
        };
        let (cx, cy) = (to_px(p.x) + 8, to_px(p.y) + 8);
        screen
            .npcs
            .iter()
            .any(|n| n.npc == npc && (n.x + 8 - cx).abs() <= 28 && (n.y + 8 - cy).abs() <= 28)
    }

    /// Shop listing for a vendor NPC on the player's screen, as UI JSON, or
    /// "null". Called by the JS shell when the player opens a vendor.
    pub fn shop_json(&self, slot: usize, npc: u8) -> String {
        match &self.players[slot.min(MAX_PLAYERS - 1)] {
            Some(p) => self.shop_json_for(p, npc),
            None => "null".to_string(),
        }
    }

    pub fn shop_json_for(&self, p: &Player, npc: u8) -> String {
        let Some(def) = self.defs.npcs.get(npc as usize) else {
            return "null".to_string();
        };
        if def.shop.is_empty() || !self.vendor_in_reach(p, npc) {
            return "null".to_string();
        }
        #[derive(serde::Serialize)]
        struct ShopItem {
            i: usize,
            label: String,
            sprite: u16,
            price: u32,
            qty: u16,
            affordable: bool,
        }
        #[derive(serde::Serialize)]
        struct Shop {
            npc: u8,
            vendor: String,
            shells: u32,
            items: Vec<ShopItem>,
        }
        let shop = Shop {
            npc,
            vendor: def.label.clone(),
            shells: p.shells,
            items: def
                .shop
                .iter()
                .enumerate()
                .map(|(i, e)| ShopItem {
                    i,
                    label: self.defs.items[e.item as usize].label.clone(),
                    sprite: self.defs.items[e.item as usize].sprite,
                    price: e.price,
                    qty: e.qty,
                    affordable: p.shells >= e.price,
                })
                .collect(),
        };
        serde_json::to_string(&shop).unwrap_or_else(|_| "null".to_string())
    }

    /// The vendor NPC the player can currently shop with (on their screen,
    /// in reach), if any.
    pub fn vendor_here(&self, slot: usize) -> i32 {
        match &self.players[slot.min(MAX_PLAYERS - 1)] {
            Some(p) => self.vendor_here_for(p),
            None => -1,
        }
    }

    pub fn vendor_here_for(&self, p: &Player) -> i32 {
        let Some(screen) = self.world.screen_at(p.sx, p.sy) else {
            return -1;
        };
        let (cx, cy) = (to_px(p.x) + 8, to_px(p.y) + 8);
        for n in &screen.npcs {
            if !self.defs.npcs[n.npc as usize].shop.is_empty()
                && (n.x + 8 - cx).abs() <= 28
                && (n.y + 8 - cy).abs() <= 28
            {
                return n.npc as i32;
            }
        }
        -1
    }

    /// Pick what an NPC says: turn-in beats nudge beats new offer beats chatter.
    fn choose_dialogue(&self, p: &Player, npc: u8) -> Dialogue {
        let mut offer = None;
        let mut incomplete = None;
        for (qi, q) in self.defs.quests.iter().enumerate() {
            if q.giver != npc {
                continue;
            }
            let qi = qi as u8;
            match p.quests.iter().find(|pq| pq.quest == qi) {
                Some(pq) if pq.done => {}
                Some(pq) => {
                    if self.objectives_met(p, pq) {
                        return Dialogue {
                            npc,
                            source: DialogueSource::QuestComplete(qi),
                            page: 0,
                        };
                    }
                    incomplete.get_or_insert(qi);
                }
                None => {
                    let unlocked = q.requires.is_none_or(|req| {
                        p.quests.iter().any(|pq| pq.quest == req && pq.done)
                    });
                    if unlocked {
                        offer.get_or_insert(qi);
                    }
                }
            }
        }
        let source = if let Some(qi) = offer {
            DialogueSource::QuestOffer(qi)
        } else if let Some(qi) = incomplete {
            DialogueSource::QuestIncomplete(qi)
        } else {
            let sets = self.defs.npcs[npc as usize].lines.len().max(1) as u32;
            DialogueSource::Idle(((self.tick / 97) % sets) as u8)
        };
        Dialogue {
            npc,
            source,
            page: 0,
        }
    }

    fn dialogue_pages<'a>(&'a self, d: &Dialogue) -> &'a [Vec<String>] {
        dialogue_pages_for(&self.defs, d)
    }

    fn advance_dialogue(&mut self, pl: &mut Player, slot: usize) {
        let Some(mut d) = pl.dialogue else {
            return;
        };
        let pages = self.dialogue_pages(&d).len() as u8;
        d.page += 1;
        if d.page < pages {
            pl.dialogue = Some(d);
            return;
        }
        // Dialogue finished: apply its effect.
        pl.dialogue = None;
        match d.source {
            DialogueSource::QuestOffer(qi) => {
                let q = &self.defs.quests[qi as usize];
                pl.quests.push(PlayerQuest {
                    quest: qi,
                    done: false,
                    progress: vec![0; q.objectives.len()],
                });
                let title = q.title.clone();
                self.emit_toast(slot, &format!("QUEST: {title}"));
            }
            DialogueSource::QuestComplete(qi) => {
                let pq = pl.quests.iter().find(|pq| pq.quest == qi);
                if !pq.is_some_and(|pq| self.objectives_met(pl, pq)) {
                    return; // raced away the items mid-dialogue
                }
                // Consume collect objectives.
                let objectives = self.defs.quests[qi as usize].objectives.clone();
                for o in &objectives {
                    if let defs::Objective::Collect { item, count } = o {
                        let mut left = *count;
                        while left > 0 {
                            let Some(idx) =
                                pl.inventory.iter().position(|s| s.def == *item && s.qty > 0)
                            else {
                                break;
                            };
                            consume_one(pl, idx);
                            left -= 1;
                        }
                    }
                }
                let q = &self.defs.quests[qi as usize];
                let shells = q.reward_shells;
                let rewards = q.reward_items.clone();
                let title = q.title.clone();
                pl.shells += shells;
                for (item, qty) in rewards {
                    give_item(pl, &self.defs, item, qty as u16);
                }
                if let Some(pq) = pl.quests.iter_mut().find(|pq| pq.quest == qi) {
                    pq.done = true;
                }
                self.emit_toast(slot, &format!("DONE: {title}"));
                self.emit_cue(pl.sx, pl.sy, cues::FUSE);
            }
            _ => {}
        }
    }

    fn objectives_met(&self, p: &Player, pq: &PlayerQuest) -> bool {
        objectives_met_static(&self.defs, p, pq)
    }

    /// Bump matching counters on every active quest of this player.
    fn quest_event(pl: &mut Player, defs: &Defs, ev: QuestEvent) {
        for pq in pl.quests.iter_mut().filter(|pq| !pq.done) {
            let q = &defs.quests[pq.quest as usize];
            for (i, o) in q.objectives.iter().enumerate() {
                let hit = matches!(
                    (o, ev),
                    (defs::Objective::Cook { .. }, QuestEvent::Cook)
                        | (defs::Objective::Fuse { .. }, QuestEvent::Fuse)
                        | (defs::Objective::Fish { .. }, QuestEvent::Fish)
                ) || matches!((o, ev),
                    (defs::Objective::Kill { enemy, .. }, QuestEvent::Kill(k)) if *enemy == k);
                if hit {
                    if let Some(c) = pq.progress.get_mut(i) {
                        *c += 1;
                    }
                }
            }
        }
    }

    fn step_entities(&mut self) {
        let mut new_entities = Vec::new();
        // Index loop (not iterator) so brains can borrow world/defs/players.
        for i in 0..self.entities.len() {
            let mut e = self.entities[i].clone();
            match e.etype {
                ET_ENEMY => {
                    let ctx = StepCtx {
                        world: &self.world,
                        defs: &self.defs,
                        tick: self.tick,
                    };
                    for mut spawn in
                        entity::step_enemy(&mut e, &ctx, &self.players, &mut self.rng)
                    {
                        spawn.id = self.next_id;
                        self.next_id += 1;
                        if spawn.etype == ET_PROJECTILE {
                            let (sx, sy) = (spawn.sx, spawn.sy);
                            self.audio.push((sx, sy, cues::SHOOT));
                            self.events.push(GameEvent::Audio {
                                sx,
                                sy,
                                cue: cues::SHOOT,
                            });
                        }
                        new_entities.push(spawn);
                    }
                }
                ET_PROJECTILE => entity::step_projectile(&mut e, &self.world),
                ET_BOMB => {
                    if entity::step_bomb(&mut e) {
                        e.alive = false;
                        let mut blast = entity::blank(ET_BLAST, e.sx, e.sy, e.x, e.y);
                        blast.id = self.next_id;
                        blast.owner = e.owner;
                        self.next_id += 1;
                        let (sx, sy) = (blast.sx, blast.sy);
                        let (bx, by) = (to_px(blast.x) + 8, to_px(blast.y) + 8);
                        new_entities.push(blast);
                        self.emit_cue(sx, sy, cues::BOOM);
                        // Blasts blow brambles open.
                        self.clear_gates_in_box(
                            sx,
                            sy,
                            bx - BLAST_RADIUS,
                            by - BLAST_RADIUS,
                            bx + BLAST_RADIUS,
                            by + BLAST_RADIUS,
                        );
                    }
                }
                ET_BLAST => entity::step_blast(&mut e),
                _ => entity::step_pickup(&mut e),
            }
            // Poison: 1 damage per second while poisoned.
            if e.etype == ET_ENEMY && e.poison_t > 0 {
                e.poison_t -= 1;
                if e.poison_t % 60 == 0 {
                    e.hp -= 1;
                    if e.hp <= 0 {
                        e.alive = false;
                        self.emit_cue(e.sx, e.sy, cues::ENEMY_DIE);
                    } else {
                        self.emit_cue(e.sx, e.sy, cues::HIT);
                    }
                }
            }
            self.entities[i] = e;
        }
        self.entities.extend(new_entities);
    }

    fn resolve_combat(&mut self) {
        // 1. Melee: sword swings and bare-handed punches/kicks hit enemies.
        for slot in 0..MAX_PLAYERS {
            let Some(mut p) = self.players[slot].clone() else {
                continue;
            };
            let window = if p.unarmed { &UNARMED_WINDOW } else { &HIT_WINDOW };
            if p.dead_t > 0 || !window.contains(&p.attack_t) {
                continue;
            }
            let weapon = p.equipped(p.equip_a).copied();
            // Armed = a weapon in hand and we're not in a forced-unarmed
            // attack (which happens when nothing is equipped).
            let armed = weapon.is_some() && !p.unarmed;
            let damage = if armed {
                (self.weapon_damage(&weapon.unwrap()) as i16) + level_damage_bonus(p.level)
            } else {
                UNARMED_DAMAGE + level_damage_bonus(p.level)
            };
            let poisons = armed && self.weapon_poison(&weapon.unwrap());
            let (hx0, hy0, hx1, hy1) = if armed {
                sword_box(&p)
            } else {
                fist_box(&p)
            };
            let mut cues_out = Vec::new();
            let mut connected = false;
            let mut hunt_xp = 0u32;
            let mut killed: Vec<u8> = Vec::new();
            for e in self.entities.iter_mut() {
                if !e.alive || e.etype != ET_ENEMY || e.iframes > 0 {
                    continue;
                }
                if e.sx != p.sx || e.sy != p.sy {
                    continue;
                }
                let (ex0, ey0, ex1, ey1) = e.feet_box();
                if hx0 < ex1 && ex0 < hx1 && hy0 < ey1 && ey0 < hy1 {
                    e.hp -= damage;
                    e.iframes = ENEMY_IFRAMES;
                    if poisons {
                        e.poison_t = 180;
                    }
                    connected = true;
                    // Rooted enemies don't get knocked back.
                    if self.defs.enemies[e.def as usize].brain != Brain::Thornling {
                        e.vx = fx(3) * (e.x - p.x).signum();
                        e.vy = fx(3) * (e.y - p.y).signum();
                    }
                    cues_out.push(if e.hp <= 0 { cues::ENEMY_DIE } else { cues::HIT });
                    if e.hp <= 0 {
                        e.alive = false;
                        hunt_xp += self.defs.enemies[e.def as usize].hunt_xp;
                        killed.push(e.def);
                        Self::quest_event(&mut p, &self.defs, QuestEvent::Kill(e.def));
                    }
                }
            }
            for def in killed {
                self.award_combat_xp(&mut p, slot, def);
            }
            // Bare-handed swing at a tree breaks off a stick (so a broken
            // weapon never leaves you defenceless).
            if !armed && self.try_harvest_stick(&mut p, slot) {
                connected = false; // harvesting consumes the swing; no wear/xp
            }
            // Fire-fused weapons burn through bramble tiles in the swing arc.
            if armed
                && self
                    .weapon_effect(&weapon.unwrap())
                    .is_some_and(|e| e == FuseEffect::Fire)
            {
                let cleared = self.clear_gates_in_box(p.sx, p.sy, hx0, hy0, hx1, hy1);
                if cleared {
                    self.emit_cue(p.sx, p.sy, cues::HIT);
                }
            }
            for c in cues_out {
                self.emit_cue(p.sx, p.sy, c);
            }
            if connected {
                // One wear per swing that lands (armed only).
                if armed {
                    self.wear_weapon(&mut p, slot, WearSlot::A);
                }
                if hunt_xp > 0 {
                    self.award_xp(&mut p, slot, defs::SKILL_HUNTING, hunt_xp);
                }
                self.players[slot] = Some(p);
            } else {
                self.players[slot] = Some(p);
            }
        }

        // 1b. Player arrows and bomb blasts hit enemies.
        let mut arrow_cues = Vec::new();
        let mut ranged_kills: Vec<(usize, u32, u8)> = Vec::new();
        for i in 0..self.entities.len() {
            let proj = self.entities[i].clone();
            if !proj.alive || proj.owner < 0 {
                continue;
            }
            let is_arrow = proj.etype == ET_PROJECTILE && proj.def == PJ_ARROW;
            let is_blast = proj.etype == ET_BLAST && proj.state_t <= 2;
            if !is_arrow && !is_blast {
                continue;
            }
            let mut connected = false;
            for e in self.entities.iter_mut() {
                if !e.alive || e.etype != ET_ENEMY || e.iframes > 0 {
                    continue;
                }
                if e.sx != proj.sx || e.sy != proj.sy {
                    continue;
                }
                let hit = if is_blast {
                    fixed::dist2_px(e.x, e.y, proj.x, proj.y)
                        <= (BLAST_RADIUS as i64) * (BLAST_RADIUS as i64)
                } else {
                    let (ex0, ey0, ex1, ey1) = e.feet_box();
                    let cx = to_px(proj.x) + 8;
                    let cy = to_px(proj.y) + 8;
                    cx >= ex0 && cx <= ex1 && cy >= ey0 && cy <= ey1
                };
                if hit {
                    let dmg = if is_blast { 4 } else { proj.data as i16 };
                    e.hp -= dmg;
                    e.iframes = ENEMY_IFRAMES;
                    e.vx = fx(2) * (e.x - proj.x).signum();
                    e.vy = fx(2) * (e.y - proj.y).signum();
                    arrow_cues.push((e.sx, e.sy, if e.hp <= 0 { cues::ENEMY_DIE } else { cues::HIT }));
                    connected = true;
                    if e.hp <= 0 {
                        e.alive = false;
                        let xp = self.defs.enemies[e.def as usize].hunt_xp;
                        ranged_kills.push((proj.owner as usize, xp, e.def));
                    }
                    if is_arrow {
                        break; // arrows stop on the first enemy hit
                    }
                }
            }
            if is_arrow && connected {
                self.entities[i].alive = false;
            }
        }
        for (sx, sy, c) in arrow_cues {
            self.emit_cue(sx, sy, c);
        }
        for (owner, xp, enemy) in ranged_kills {
            if let Some(mut p) = self.players.get(owner).cloned().flatten() {
                if xp > 0 {
                    self.award_xp(&mut p, owner, defs::SKILL_HUNTING, xp);
                }
                self.award_combat_xp(&mut p, owner, enemy);
                Self::quest_event(&mut p, &self.defs, QuestEvent::Kill(enemy));
                self.players[owner] = Some(p);
            }
        }

        // 2. Enemies / projectiles hurt players; pickups collect.
        for slot in 0..MAX_PLAYERS {
            let Some(mut p) = self.players[slot].clone() else {
                continue;
            };
            if p.dead_t > 0 || p.transition.is_some() {
                continue;
            }
            let px0 = to_px(p.x) + FEET_X0;
            let py0 = to_px(p.y) + FEET_Y0;
            let px1 = to_px(p.x) + FEET_X1;
            let py1 = to_px(p.y) + FEET_Y1;
            let mut changed = false;

            for i in 0..self.entities.len() {
                let mut e = self.entities[i].clone();
                if !e.alive || e.sx != p.sx || e.sy != p.sy {
                    continue;
                }
                let (ex0, ey0, ex1, ey1) = e.feet_box();
                if !(px0 < ex1 && ex0 < px1 && py0 < ey1 && ey0 < py1) {
                    continue;
                }
                match e.etype {
                    // Critters are harmless to touch.
                    ET_ENEMY if p.iframes == 0
                        && self.defs.enemies[e.def as usize].damage > 0 =>
                    {
                        if blocks(&self.defs, &p, e.x, e.y) {
                            p.kvx = fx(2) * (p.x - e.x).signum();
                            p.kvy = fx(2) * (p.y - e.y).signum();
                            self.emit_cue(p.sx, p.sy, cues::BLOCK);
                            self.wear_weapon(&mut p, slot, WearSlot::B);
                            changed = true;
                        } else {
                            let def = &self.defs.enemies[e.def as usize];
                            p.hp -= def.damage;
                            p.iframes = PLAYER_IFRAMES;
                            p.kvx = fx(3) * (p.x - e.x).signum();
                            p.kvy = fx(3) * (p.y - e.y).signum();
                            if def.brain == Brain::Snatcher && p.shells > 0 {
                                let steal = p.shells.min(3);
                                p.shells -= steal;
                                e.data += steal as i32;
                                e.state = 3; // flee
                                e.state_t = 0;
                            }
                            self.emit_cue(p.sx, p.sy, cues::HURT);
                            if p.hp <= 0 {
                                p.dead_t = RESPAWN_TICKS;
                                self.emit_cue(p.sx, p.sy, cues::DIE);
                            }
                            changed = true;
                        }
                    }
                    // Enemy projectiles only (players don't hit themselves
                    // with arrows; blasts are handled separately below).
                    ET_PROJECTILE if p.iframes == 0 && e.owner < 0 => {
                        if blocks(&self.defs, &p, e.x, e.y) {
                            e.alive = false;
                            self.emit_cue(p.sx, p.sy, cues::BLOCK);
                            self.wear_weapon(&mut p, slot, WearSlot::B);
                            changed = true;
                        } else {
                            p.hp -= e.data as i16;
                            p.iframes = PLAYER_IFRAMES;
                            p.kvx = e.vx * 2;
                            p.kvy = e.vy * 2;
                            e.alive = false;
                            self.emit_cue(p.sx, p.sy, cues::HURT);
                            if p.hp <= 0 {
                                p.dead_t = RESPAWN_TICKS;
                                self.emit_cue(p.sx, p.sy, cues::DIE);
                            }
                            changed = true;
                        }
                    }
                    ET_BLAST if p.iframes == 0 && e.state_t <= 2 => {
                        // Bombs don't discriminate. Stand back.
                        if fixed::dist2_px(p.x, p.y, e.x, e.y)
                            <= (BLAST_RADIUS as i64) * (BLAST_RADIUS as i64)
                        {
                            p.hp -= 2;
                            p.iframes = PLAYER_IFRAMES;
                            p.kvx = fx(4) * (p.x - e.x).signum();
                            p.kvy = fx(4) * (p.y - e.y).signum();
                            self.emit_cue(p.sx, p.sy, cues::HURT);
                            if p.hp <= 0 {
                                p.dead_t = RESPAWN_TICKS;
                                self.emit_cue(p.sx, p.sy, cues::DIE);
                            }
                            changed = true;
                        }
                    }
                    ET_PICKUP => {
                        match e.def {
                            PK_HEART => {
                                p.hp = (p.hp + 2).min(p.max_hp);
                                self.emit_cue(p.sx, p.sy, cues::HEART);
                                e.alive = false;
                            }
                            PK_SHELLS => {
                                p.shells += e.data as u32;
                                self.emit_cue(p.sx, p.sy, cues::SHELL);
                                e.alive = false;
                            }
                            _ => {
                                let def = e.data as u8;
                                let kind = self.defs.items[def as usize].kind;
                                if give_item(&mut p, &self.defs, def, 1) {
                                    let label =
                                        self.defs.items[def as usize].label.clone();
                                    self.emit_toast(slot, &format!("GOT {label}"));
                                    self.emit_cue(p.sx, p.sy, cues::ITEM);
                                    // Auto-equip a picked-up weapon if that hand
                                    // is empty (so the stick is ready to swing).
                                    let idx = (p.inventory.len() - 1) as i8;
                                    if kind == ItemKind::Sword && p.equip_a < 0 {
                                        p.equip_a = idx;
                                    } else if matches!(
                                        kind,
                                        ItemKind::Bow | ItemKind::Shield | ItemKind::Rod
                                    ) && p.equip_b < 0
                                    {
                                        p.equip_b = idx;
                                    }
                                    e.alive = false;
                                }
                                // Inventory full: leave it on the ground.
                            }
                        }
                        changed = true;
                    }
                    _ => {}
                }
                self.entities[i] = e;
                if p.dead_t > 0 {
                    break;
                }
            }
            if changed || p.iframes > 0 {
                self.players[slot] = Some(p);
            }
        }
    }

    fn cleanup_and_drops(&mut self) {
        let mut drops = Vec::new();
        for e in &self.entities {
            if e.alive || e.etype != ET_ENEMY || e.hp > 0 {
                continue;
            }
            let def = &self.defs.enemies[e.def as usize];
            // Gels split once instead of dropping loot.
            if def.brain == Brain::Gel && e.data == 0 {
                for k in 0..2u8 {
                    let mut mini = Entity::enemy(
                        0,
                        e.def,
                        1,
                        e.sx,
                        e.sy,
                        to_px(e.x) + if k == 0 { -6 } else { 6 },
                        to_px(e.y),
                    );
                    mini.data = 1;
                    mini.home = e.home;
                    drops.push(mini);
                }
                continue;
            }
            let table = self.defs.drop_tables[def.drop_table].clone();
            for entry in table {
                if !self.rng.chance_permille(entry.permille) {
                    continue;
                }
                let amount = entry.min + self.rng.below(entry.max - entry.min + 1);
                let (def_kind, data) = match entry.item {
                    DropItem::Heart => (PK_HEART, 0),
                    DropItem::Shells => (PK_SHELLS, amount as i32),
                    DropItem::Item(idx) => (PK_ITEM, idx as i32),
                };
                let jx = self.rng.below(13) as i32 - 6;
                let jy = self.rng.below(13) as i32 - 6;
                let mut d =
                    entity::blank(ET_PICKUP, e.sx, e.sy, e.x + fx(jx), e.y + fx(jy));
                d.def = def_kind;
                d.data = data;
                d.home = e.home;
                drops.push(d);
            }
            // Snatchers spill stolen shells on death.
            if def.brain == Brain::Snatcher && e.data > 0 {
                let mut d = entity::blank(ET_PICKUP, e.sx, e.sy, e.x, e.y);
                d.def = PK_SHELLS;
                d.data = e.data;
                d.home = e.home;
                drops.push(d);
            }
        }
        self.entities.retain(|e| e.alive);
        for mut d in drops {
            d.id = self.next_id;
            self.next_id += 1;
            self.entities.push(d);
        }
    }

    fn respawn_screens(&mut self) {
        let mut to_spawn = Vec::new();
        for (idx, screen) in self.world.screens.iter().enumerate() {
            if screen.spawns.is_empty() {
                continue;
            }
            let coords = (screen.x, screen.y);
            let occupied = self
                .players
                .iter()
                .flatten()
                .any(|p| p.sx == screen.x && p.sy == screen.y);
            let has_living = self
                .entities
                .iter()
                .any(|e| e.etype == ET_ENEMY && e.home == coords);
            let last = self.last_spawn.get(&coords).copied().unwrap_or(0);
            if !occupied && !has_living && self.tick.saturating_sub(last) > ENEMY_RESPAWN_TICKS {
                to_spawn.push(idx);
            }
        }
        for idx in to_spawn {
            self.spawn_screen(idx);
        }
    }

    fn feet_clear(&self, screen: &world::Screen, x: Fx, y: Fx) -> bool {
        self.feet_clear_on(screen, x, y)
    }

    fn feet_clear_on(&self, screen: &world::Screen, x: Fx, y: Fx) -> bool {
        let px = to_px(x);
        let py = to_px(y);
        !(self.effective_solid(screen, px + FEET_X0, py + FEET_Y0)
            || self.effective_solid(screen, px + FEET_X1, py + FEET_Y0)
            || self.effective_solid(screen, px + FEET_X0, py + FEET_Y1)
            || self.effective_solid(screen, px + FEET_X1, py + FEET_Y1))
    }

    /// Nearest walkable position to (x, y), searched in growing rings.
    fn find_clear_near(&self, screen: &world::Screen, x: Fx, y: Fx) -> Option<(Fx, Fx)> {
        for r in 1..=10 {
            let step = fx(4) * r;
            for (ddx, ddy) in [
                (0, -1), (0, 1), (-1, 0), (1, 0),
                (-1, -1), (1, -1), (-1, 1), (1, 1),
            ] {
                let nx = (x + ddx * step).clamp(MIN_X, MAX_X);
                let ny = (y + ddy * step).clamp(MIN_Y, MAX_Y);
                if self.feet_clear_on(screen, nx, ny) {
                    return Some((nx, ny));
                }
            }
        }
        None
    }

    // ---- ui actions (host applies; clients send C2H::UiAction) ----

    pub fn ui_action(&mut self, slot: usize, json: &str) {
        #[derive(Deserialize)]
        struct Action {
            action: String,
            #[serde(default)]
            a: i32,
            #[serde(default)]
            b: i32,
        }
        let Ok(act) = serde_json::from_str::<Action>(json) else {
            return;
        };
        let Some(mut p) = self.players[slot.min(MAX_PLAYERS - 1)].clone() else {
            return;
        };

        match act.action.as_str() {
            "equip_a" => {
                let idx = act.a as usize;
                if p.inventory.get(idx).is_some_and(|s| {
                    self.defs.items[s.def as usize].kind == ItemKind::Sword
                }) {
                    p.equip_a = idx as i8;
                }
            }
            "equip_b" => {
                let idx = act.a as usize;
                if p.inventory.get(idx).is_some_and(|s| {
                    matches!(
                        self.defs.items[s.def as usize].kind,
                        ItemKind::Bow | ItemKind::Shield | ItemKind::Bomb | ItemKind::Rod
                    )
                }) {
                    p.equip_b = idx as i8;
                }
            }
            "eat" => {
                let idx = act.a as usize;
                let Some(stack) = p.inventory.get(idx).copied() else {
                    return;
                };
                let def = &self.defs.items[stack.def as usize];
                if def.kind != ItemKind::Food {
                    return;
                }
                p.hp = (p.hp + def.heal).min(p.max_hp);
                self.emit_cue(p.sx, p.sy, cues::HEART);
                consume_one(&mut p, idx);
            }
            // a = npc index, b = shop-entry index. Buy only from a vendor on
            // the player's current screen and standing nearby.
            "buy" => {
                let npc = act.a as usize;
                let entry_idx = act.b as usize;
                let Some(def) = self.defs.npcs.get(npc) else {
                    return;
                };
                let Some(entry) = def.shop.get(entry_idx) else {
                    return;
                };
                if !self.vendor_in_reach(&p, npc as u8) {
                    return;
                }
                if p.shells < entry.price {
                    self.emit_toast(slot, "NOT ENOUGH SHELLS");
                    self.players[slot] = Some(p);
                    return;
                }
                let (item, qty, price) = (entry.item, entry.qty, entry.price);
                if give_item(&mut p, &self.defs, item, qty) {
                    p.shells -= price;
                    let label = self.defs.items[item as usize].label.clone();
                    self.emit_toast(slot, &format!("BOUGHT {label}"));
                    self.emit_cue(p.sx, p.sy, cues::SHELL);
                } else {
                    self.emit_toast(slot, "PACK IS FULL");
                }
            }
            "cook" => {
                let Some(recipe) = self.defs.recipes.get(act.a as usize) else {
                    return;
                };
                let level = self.defs.curve.level_for_xp(p.skills[defs::SKILL_COOKING]);
                if recipe.level > level || !near_fire(&self.world, &p) {
                    return;
                }
                // All inputs present?
                let mut needed: Vec<u8> = recipe.inputs.clone();
                for input in &needed {
                    if !p.inventory.iter().any(|s| s.def == *input && s.qty > 0) {
                        self.emit_toast(slot, "MISSING INGREDIENTS");
                        return;
                    }
                }
                needed.sort_unstable();
                needed.dedup();
                // (Recipes never need 2x the same input in the slice.)
                let output = recipe.output;
                let xp = recipe.xp;
                for input in needed {
                    if let Some(idx) = p.inventory.iter().position(|s| s.def == input) {
                        consume_one(&mut p, idx);
                    }
                }
                give_item(&mut p, &self.defs, output, 1);
                let label = self.defs.items[output as usize].label.clone();
                self.emit_toast(slot, &format!("COOKED {label}!"));
                self.emit_cue(p.sx, p.sy, cues::ITEM);
                self.award_xp(&mut p, slot, defs::SKILL_COOKING, xp);
                Self::quest_event(&mut p, &self.defs, QuestEvent::Cook);
            }
            "fuse" => {
                let (wi, mi) = (act.a as usize, act.b as usize);
                if wi == mi || wi >= p.inventory.len() || mi >= p.inventory.len() {
                    return;
                }
                let weapon = p.inventory[wi];
                let material = p.inventory[mi];
                let w_ok = self.defs.items[weapon.def as usize].is_weapon()
                    && weapon.fused.is_none();
                let m_ok = self.defs.items[material.def as usize].kind == ItemKind::Material;
                if !w_ok || !m_ok {
                    return;
                }
                let w_label = self.defs.items[weapon.def as usize].label.clone();
                let m_label = self.defs.items[material.def as usize].label.clone();
                p.inventory[wi].fused = Some(material.def);
                // Fusing reinforces the weapon as well as empowering it.
                p.inventory[wi].durability += 10;
                consume_one(&mut p, mi);
                self.emit_toast(slot, &format!("FUSED {m_label} TO {w_label}"));
                self.emit_cue(p.sx, p.sy, cues::FUSE);
                Self::quest_event(&mut p, &self.defs, QuestEvent::Fuse);
            }
            _ => {}
        }
        self.players[slot] = Some(p);
    }

    /// Inventory/equipment/skills JSON for the UI overlay.
    pub fn ui_state(&self, slot: usize) -> String {
        match &self.players[slot.min(MAX_PLAYERS - 1)] {
            Some(p) => ui_state_json(
                &self.defs,
                &p.inventory,
                p.equip_a,
                p.equip_b,
                p.skills,
                near_fire(&self.world, p),
                p.fishing.map(|f| match f {
                    FishPhase::Cast { .. } => 0,
                    FishPhase::Bite { .. } => 1,
                }),
                &p.quests,
                p.level,
                p.xp,
            ),
            None => "null".to_string(),
        }
    }

    // ---- snapshots ----

    pub fn snapshot(&self) -> SnapshotData {
        let players: Vec<PlayerSnap> = self
            .players
            .iter()
            .enumerate()
            .filter_map(|(slot, p)| {
                p.as_ref().map(|p| PlayerSnap {
                    slot: slot as u8,
                    sx: p.sx,
                    sy: p.sy,
                    x: p.x,
                    y: p.y,
                    facing: p.facing,
                    walking: p.walking,
                    anim: p.anim,
                    transition: p.transition.map(|t| (t.dir, t.t)),
                    hp: p.hp,
                    max_hp: p.max_hp,
                    shells: p.shells,
                    attack_t: p.attack_t,
                    unarmed: p.unarmed,
                    iframes: p.iframes,
                    dead: p.dead_t > 0,
                    shielding: p.shielding,
                    inventory: p
                        .inventory
                        .iter()
                        .map(|s| ItemSnap {
                            def: s.def,
                            qty: s.qty,
                            durability: s.durability,
                            fused: s.fused.map_or(-1, |f| f as i16),
                        })
                        .collect(),
                    equip_a: p.equip_a,
                    equip_b: p.equip_b,
                    skills: p.skills,
                    level: p.level,
                    xp: p.xp,
                    fishing: p.fishing.map(|f| match f {
                        FishPhase::Cast { .. } => 0,
                        FishPhase::Bite { .. } => 1,
                    }),
                    near_fire: near_fire(&self.world, p),
                    dialogue: p.dialogue.map(|d| {
                        let (kind, idx) = match d.source {
                            DialogueSource::Idle(i) => (0, i),
                            DialogueSource::QuestOffer(q) => (1, q),
                            DialogueSource::QuestIncomplete(q) => (2, q),
                            DialogueSource::QuestComplete(q) => (3, q),
                        };
                        (d.npc, kind, idx, d.page)
                    }),
                    quests: p
                        .quests
                        .iter()
                        .map(|pq| protocol::QuestSnap {
                            quest: pq.quest,
                            done: pq.done,
                            progress: pq.progress.clone(),
                        })
                        .collect(),
                })
            })
            .collect();

        // Interest: entities on any screen that has (or is scrolling from) a player.
        let mut screens: Vec<(i32, i32)> = Vec::new();
        for p in self.players.iter().flatten() {
            screens.push((p.sx, p.sy));
            if let Some(tr) = p.transition {
                let (dx, dy) = match tr.dir {
                    0 => (0, 1),
                    1 => (0, -1),
                    2 => (-1, 0),
                    _ => (1, 0),
                };
                screens.push((p.sx - dx, p.sy - dy));
            }
        }

        let entities = self
            .entities
            .iter()
            .filter(|e| screens.contains(&(e.sx, e.sy)))
            .map(|e| EntitySnap {
                id: e.id,
                etype: e.etype,
                def: e.def,
                data: e.data,
                sx: e.sx,
                sy: e.sy,
                x: e.x,
                y: e.y,
                facing: e.facing,
                anim: e.anim,
                flash: e.iframes > 0,
                big: e.big,
            })
            .collect();

        SnapshotData {
            tick: self.tick,
            players,
            entities,
            overrides: self
                .overrides
                .iter()
                .map(|(&(sx, sy, idx), &t)| (sx, sy, idx, t))
                .collect(),
        }
    }

    // ---- rendering ----

    /// Emit the draw list as seen by `viewpoint`'s player.
    pub fn render(&self, viewpoint: usize, out: &mut DrawList) {
        render_view(
            &self.world,
            &self.defs,
            &self.players,
            &self.entities,
            &self.overrides,
            viewpoint,
            self.tick,
            out,
        );
    }

    /// FNV-1a over the canonical state; used by determinism tests and the
    /// debug overlay. Any sim-visible state must feed in here.
    pub fn state_hash(&self) -> u64 {
        let mut h = Fnv::new();
        h.u32(self.tick);
        h.u64(self.rng.state_bits());
        h.u32(self.next_id);
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
                    h.i32(p.hp as i32);
                    h.i32(p.max_hp as i32);
                    h.u32(p.shells);
                    h.u32(p.level);
                    h.u32(p.xp);
                    h.u32(p.attack_t as u32);
                    h.u32(p.unarmed as u32);
                    h.u32(p.harvest_t);
                    h.u32(p.iframes as u32);
                    h.u32(p.dead_t);
                    h.i32(p.kvx);
                    h.i32(p.kvy);
                    h.u32(p.shielding as u32);
                    h.i32(p.equip_a as i32);
                    h.i32(p.equip_b as i32);
                    for s in p.skills {
                        h.u32(s);
                    }
                    match p.fishing {
                        None => h.u32(0),
                        Some(FishPhase::Cast { t }) => {
                            h.u32(1);
                            h.u32(t);
                        }
                        Some(FishPhase::Bite { t }) => {
                            h.u32(2);
                            h.u32(t);
                        }
                    }
                    match p.dialogue {
                        None => h.u32(0),
                        Some(d) => {
                            h.u32(d.npc as u32 + 1);
                            let (k, i) = match d.source {
                                DialogueSource::Idle(i) => (0, i),
                                DialogueSource::QuestOffer(q) => (1, q),
                                DialogueSource::QuestIncomplete(q) => (2, q),
                                DialogueSource::QuestComplete(q) => (3, q),
                            };
                            h.u32(k);
                            h.u32(i as u32);
                            h.u32(d.page as u32);
                        }
                    }
                    for pq in &p.quests {
                        h.u32(pq.quest as u32);
                        h.u32(pq.done as u32);
                        for c in &pq.progress {
                            h.u32(*c);
                        }
                    }
                    for s in &p.inventory {
                        h.u32(s.def as u32);
                        h.u32(s.qty as u32);
                        h.u32(s.durability as u32);
                        h.i32(s.fused.map_or(-1, |f| f as i32));
                    }
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
        for e in &self.entities {
            h.u32(e.id);
            h.u32(e.etype as u32);
            h.u32(e.def as u32);
            h.i32(e.data);
            h.i32(e.sx);
            h.i32(e.sy);
            h.i32(e.x);
            h.i32(e.y);
            h.i32(e.hp as i32);
            h.u32(e.state as u32);
            h.u32(e.state_t);
            h.i32(e.vx);
            h.i32(e.vy);
            h.i32(e.owner as i32);
            h.u32(e.poison_t);
        }
        for (&(sx, sy, idx), &t) in &self.overrides {
            h.i32(sx);
            h.i32(sy);
            h.i32(idx);
            h.u32(t as u32);
        }
        h.finish()
    }
}

fn kind_str(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Sword => "sword",
        ItemKind::Bow => "bow",
        ItemKind::Shield => "shield",
        ItemKind::Bomb => "bomb",
        ItemKind::Arrow => "arrow",
        ItemKind::Material => "material",
        ItemKind::Rod => "rod",
        ItemKind::Food => "food",
    }
}

/// Shared by the host (live inventory) and clients (snapshot inventory).
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
pub fn ui_state_json(
    defs: &Defs,
    inventory: &[ItemStack],
    equip_a: i8,
    equip_b: i8,
    skills: [u32; 3],
    near_fire: bool,
    fishing: Option<u8>,
    quests: &[PlayerQuest],
    char_level: u32,
    char_xp: u32,
) -> String {
    #[derive(serde::Serialize)]
    struct UiItem {
        i: usize,
        label: String,
        kind: &'static str,
        sprite: u16,
        qty: u16,
        dur: u16,
        max_dur: u16,
        fused: Option<String>,
        heal: i16,
    }
    #[derive(serde::Serialize)]
    struct UiSkill {
        name: &'static str,
        level: u32,
        xp: u32,
        next: u32,
    }
    #[derive(serde::Serialize)]
    struct UiRecipe {
        i: usize,
        label: String,
        sprite: u16,
        inputs: Vec<String>,
        level: u32,
        can_make: bool,
        level_ok: bool,
    }
    #[derive(serde::Serialize)]
    struct UiQuest {
        title: String,
        done: bool,
        objectives: Vec<String>,
    }
    #[derive(serde::Serialize)]
    struct UiState {
        inventory: Vec<UiItem>,
        equip_a: i8,
        equip_b: i8,
        skills: Vec<UiSkill>,
        near_fire: bool,
        recipes: Vec<UiRecipe>,
        /// 0 = line out, 1 = bite window, null = not fishing.
        fishing: Option<u8>,
        quests: Vec<UiQuest>,
        level: u32,
        xp: u32,
        xp_into: u32,
        xp_need: u32,
        max_hp_hearts: i16,
    }

    let cooking_level = defs.curve.level_for_xp(skills[defs::SKILL_COOKING]);
    let state = UiState {
        inventory: inventory
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let def = &defs.items[s.def as usize];
                UiItem {
                    i,
                    label: def.label.clone(),
                    kind: kind_str(def.kind),
                    sprite: def.sprite,
                    qty: s.qty,
                    dur: s.durability,
                    max_dur: def.durability
                        + if s.fused.is_some() { 10 } else { 0 },
                    fused: s.fused.map(|f| defs.items[f as usize].label.clone()),
                    heal: def.heal,
                }
            })
            .collect(),
        equip_a,
        equip_b,
        skills: (0..3)
            .map(|i| {
                let level = defs.curve.level_for_xp(skills[i]);
                UiSkill {
                    name: defs::SKILL_NAMES[i],
                    level,
                    xp: skills[i],
                    next: defs.curve.xp_for_level(level + 1),
                }
            })
            .collect(),
        near_fire,
        recipes: defs
            .recipes
            .iter()
            .enumerate()
            .map(|(i, r)| UiRecipe {
                i,
                label: defs.items[r.output as usize].label.clone(),
                sprite: defs.items[r.output as usize].sprite,
                inputs: r
                    .inputs
                    .iter()
                    .map(|inp| defs.items[*inp as usize].label.clone())
                    .collect(),
                level: r.level,
                can_make: r.inputs.iter().all(|inp| {
                    inventory.iter().any(|s| s.def == *inp && s.qty > 0)
                }),
                level_ok: r.level <= cooking_level,
            })
            .collect(),
        fishing,
        quests: quests
            .iter()
            .map(|pq| {
                let q = &defs.quests[pq.quest as usize];
                UiQuest {
                    title: q.title.clone(),
                    done: pq.done,
                    objectives: q
                        .objectives
                        .iter()
                        .enumerate()
                        .map(|(i, o)| match o {
                            defs::Objective::Kill { enemy, count } => {
                                let have = pq.progress.get(i).copied().unwrap_or(0).min(*count);
                                format!(
                                    "{} {}/{}",
                                    defs.enemies[*enemy as usize].name.to_uppercase(),
                                    have,
                                    count
                                )
                            }
                            defs::Objective::Collect { item, count } => {
                                let have: u32 = inventory
                                    .iter()
                                    .filter(|s| s.def == *item)
                                    .map(|s| s.qty as u32)
                                    .sum();
                                format!(
                                    "{} {}/{}",
                                    defs.items[*item as usize].label,
                                    have.min(*count),
                                    count
                                )
                            }
                            defs::Objective::Cook { count } => {
                                let have = pq.progress.get(i).copied().unwrap_or(0).min(*count);
                                format!("COOK MEALS {have}/{count}")
                            }
                            defs::Objective::Fuse { count } => {
                                let have = pq.progress.get(i).copied().unwrap_or(0).min(*count);
                                format!("FUSE ITEMS {have}/{count}")
                            }
                            defs::Objective::Fish { count } => {
                                let have = pq.progress.get(i).copied().unwrap_or(0).min(*count);
                                format!("CATCH FISH {have}/{count}")
                            }
                        })
                        .collect(),
                }
            })
            .collect(),
        level: char_level,
        xp: char_xp,
        xp_into: char_xp - xp_for_level(char_level),
        xp_need: xp_for_level(char_level + 1) - xp_for_level(char_level),
        max_hp_hearts: max_hp_for_level(char_level) / 2,
    };
    serde_json::to_string(&state).unwrap_or_else(|_| "null".to_string())
}

/// Render the world + players + entities as seen from `viewpoint`'s screen.
/// Free function so the host (live sim state) and clients (interpolated
/// snapshot state) share one code path. Paint order: tiles, pickups,
/// enemies/projectiles, players, HUD.
#[allow(clippy::too_many_arguments)]
pub fn render_view(
    world: &World,
    defs: &Defs,
    players: &[Option<Player>; MAX_PLAYERS],
    entities: &[Entity],
    overrides: &BTreeMap<(i32, i32, i32), u16>,
    viewpoint: usize,
    tick: u32,
    out: &mut DrawList,
) {
    let Some(Some(vp)) = players.get(viewpoint) else {
        out.rect(0, 0, 0, SCREEN_W as u16, SCREEN_H as u16);
        return;
    };

    match vp.transition {
        None => {
            draw_screen(world, overrides, vp.sx, vp.sy, 0, 0, out);
            draw_npcs_on(world, defs, vp, vp.sx, vp.sy, 0, 0, out);
            draw_entities_on(world, defs, entities, vp.sx, vp.sy, 0, 0, tick, out);
            draw_players_on(world, players, vp.sx, vp.sy, 0, 0, tick, out);
        }
        Some(tr) => {
            // vp is already on the NEW screen; the old screen scrolls away.
            let (dx, dy) = match tr.dir {
                0 => (0, 1),
                1 => (0, -1),
                2 => (-1, 0),
                _ => (1, 0),
            };
            let (osx, osy) = (vp.sx - dx, vp.sy - dy);
            let t = tr.t.min(TRANSITION_TICKS) as i32;
            let shift_x = (t * SCREEN_W) / TRANSITION_TICKS as i32;
            let shift_y = (t * (SCREEN_H - HUD_H)) / TRANSITION_TICKS as i32;
            let (new_ox, new_oy) = (
                dx * (SCREEN_W - shift_x),
                dy * ((SCREEN_H - HUD_H) - shift_y),
            );
            let (old_ox, old_oy) = (-dx * shift_x, -dy * shift_y);
            draw_screen(world, overrides, osx, osy, old_ox, old_oy, out);
            draw_screen(world, overrides, vp.sx, vp.sy, new_ox, new_oy, out);
            draw_npcs_on(world, defs, vp, osx, osy, old_ox, old_oy, out);
            draw_npcs_on(world, defs, vp, vp.sx, vp.sy, new_ox, new_oy, out);
            draw_entities_on(world, defs, entities, osx, osy, old_ox, old_oy, tick, out);
            draw_entities_on(world, defs, entities, vp.sx, vp.sy, new_ox, new_oy, tick, out);
            draw_players_on(world, players, osx, osy, old_ox, old_oy, tick, out);
            draw_players_on(world, players, vp.sx, vp.sy, new_ox, new_oy, tick, out);
        }
    }

    draw_hud(world, vp, out);
    draw_dialogue(world, defs, vp, out);
}

fn draw_npcs_on(
    world: &World,
    defs: &Defs,
    vp: &Player,
    sx: i32,
    sy: i32,
    ox: i32,
    oy: i32,
    out: &mut DrawList,
) {
    let Some(screen) = world.screen_at(sx, sy) else {
        return;
    };
    for n in &screen.npcs {
        let def = &defs.npcs[n.npc as usize];
        out.sprite(def.sprite, n.x + ox, n.y + oy, 0, 0);

        // Quest marker as seen by the viewpoint player.
        let mut marker = None;
        for (qi, q) in defs.quests.iter().enumerate() {
            if q.giver != n.npc {
                continue;
            }
            match vp.quests.iter().find(|pq| pq.quest == qi as u8) {
                Some(pq) if pq.done => {}
                Some(pq) => {
                    if objectives_met_static(defs, vp, pq) {
                        marker = Some('?');
                        break;
                    }
                }
                None => {
                    let unlocked = q.requires.is_none_or(|req| {
                        vp.quests.iter().any(|pq| pq.quest == req && pq.done)
                    });
                    if unlocked {
                        marker.get_or_insert('!');
                    }
                }
            }
        }
        if let Some(c) = marker {
            if let Some(g) = world.glyph(c) {
                out.glyph(g, n.x + 4 + ox, n.y - 9 + oy, 1);
            }
        }
    }
}

fn draw_dialogue(world: &World, defs: &Defs, vp: &Player, out: &mut DrawList) {
    let Some(d) = vp.dialogue else {
        return;
    };
    let pages = dialogue_pages_for(defs, &d);
    let Some(lines) = pages.get(d.page as usize) else {
        return;
    };
    // Box: bottom 44px of the playfield, light border, dark fill.
    out.rect(3, 2, SCREEN_H - 46, (SCREEN_W - 4) as u16, 44);
    out.rect(0, 4, SCREEN_H - 44, (SCREEN_W - 8) as u16, 40);
    // Speaker name then up to 3 text lines.
    draw_text(world, &defs.npcs[d.npc as usize].label, 8, SCREEN_H - 41, 1, out);
    for (i, line) in lines.iter().take(3).enumerate() {
        draw_text(world, line, 8, SCREEN_H - 31 + i as i32 * 9, 1, out);
    }
    if let Some(g) = world.glyph('>') {
        out.glyph(g, SCREEN_W - 14, SCREEN_H - 12, 1);
    }
}

fn objectives_met_static(defs: &Defs, p: &Player, pq: &PlayerQuest) -> bool {
    let q = &defs.quests[pq.quest as usize];
    q.objectives.iter().enumerate().all(|(i, o)| match o {
        defs::Objective::Collect { item, count } => {
            let have: u32 = p
                .inventory
                .iter()
                .filter(|s| s.def == *item)
                .map(|s| s.qty as u32)
                .sum();
            have >= *count
        }
        defs::Objective::Kill { count, .. }
        | defs::Objective::Cook { count }
        | defs::Objective::Fuse { count }
        | defs::Objective::Fish { count } => pq.progress.get(i).copied().unwrap_or(0) >= *count,
    })
}

fn draw_screen(
    world: &World,
    overrides: &BTreeMap<(i32, i32, i32), u16>,
    sx: i32,
    sy: i32,
    ox: i32,
    oy: i32,
    out: &mut DrawList,
) {
    let Some(screen) = world.screen_at(sx, sy) else {
        return;
    };
    for ty in 0..world::SCREEN_ROWS {
        for tx in 0..world::SCREEN_COLS {
            let idx = ty * world::SCREEN_COLS + tx;
            let tile = overrides
                .get(&(sx, sy, idx))
                .copied()
                .unwrap_or(screen.tiles[idx as usize]);
            out.tile(tile, tx * 16 + ox, HUD_H + ty * 16 + oy, 0);
        }
    }
}

fn draw_entities_on(
    world: &World,
    defs: &Defs,
    entities: &[Entity],
    sx: i32,
    sy: i32,
    ox: i32,
    oy: i32,
    tick: u32,
    out: &mut DrawList,
) {
    // Pickups under actors.
    for e in entities {
        if e.sx != sx || e.sy != sy || e.etype != ET_PICKUP {
            continue;
        }
        // Blink during the final 2s before despawning (not for persistent
        // map items, state 1).
        if e.state == 0 && e.state_t > entity::PICKUP_TTL - 120 && (tick >> 2) & 1 == 1 {
            continue;
        }
        let sprite = match e.def {
            PK_HEART => world.sprites.heart_drop,
            PK_SHELLS => world.sprites.shell_drop,
            _ => defs
                .items
                .get(e.data as usize)
                .map_or(world.sprites.shell_drop, |it| it.sprite),
        };
        out.sprite(sprite, to_px(e.x) + ox, to_px(e.y) + oy, 0, 0);
    }

    for e in entities {
        if e.sx != sx || e.sy != sy {
            continue;
        }
        let (px, py) = (to_px(e.x) + ox, to_px(e.y) + oy);
        match e.etype {
            ET_ENEMY => {
                // Hit flash: skip frames while invulnerable.
                if e.iframes > 0 && (tick >> 1) & 1 == 1 {
                    continue;
                }
                let def = &defs.enemies[e.def as usize];
                let frame = ((e.anim >> 4) & 1) as u16;
                if e.big {
                    // 2x2 block mirrored from one quadrant sprite.
                    let s = def.sprite + frame;
                    out.sprite(s, px, py, 0, 0);
                    out.sprite(s, px + 16, py, 0, FLAG_FLIP_X);
                    out.sprite(s, px, py + 16, 0, draw::FLAG_FLIP_Y);
                    out.sprite(s, px + 16, py + 16, 0, FLAG_FLIP_X | draw::FLAG_FLIP_Y);
                } else {
                    let flags = if e.facing == 3 { FLAG_FLIP_X } else { 0 };
                    out.sprite(def.sprite + frame, px, py, 0, flags);
                }
            }
            ET_PROJECTILE => match e.def {
                PJ_ARROW => {
                    let (sprite, flags) = match e.facing {
                        1 => (world.sprites.arrow_v, 0),
                        0 => (world.sprites.arrow_v, draw::FLAG_FLIP_Y),
                        2 => (world.sprites.arrow_h, 0),
                        _ => (world.sprites.arrow_h, FLAG_FLIP_X),
                    };
                    out.sprite(sprite, px, py, 0, flags);
                }
                _ => out.sprite(world.sprites.seed, px, py, 0, 0),
            },
            ET_BOMB => {
                // Blink faster as the fuse runs down (anim == ticks alive,
                // which survives the snapshot path; state_t does not).
                let rate = if e.anim > entity::BOMB_FUSE - 30 { 2 } else { 4 };
                if (e.anim >> rate) & 1 == 0 {
                    out.sprite(world.sprites.bomb, px, py, 0, 0);
                }
            }
            ET_BLAST => {
                let frame = ((e.anim / 5).min(1)) as u16;
                let s = world.sprites.blast + frame;
                out.sprite(s, px, py, 0, 0);
                for (dx, dy) in [(-12, 0), (12, 0), (0, -12), (0, 12)] {
                    out.sprite(s, px + dx, py + dy, 0, 0);
                }
            }
            _ => {}
        }
    }
}

fn draw_players_on(
    world: &World,
    players: &[Option<Player>; MAX_PLAYERS],
    sx: i32,
    sy: i32,
    ox: i32,
    oy: i32,
    tick: u32,
    out: &mut DrawList,
) {
    // Draw in y order so southern players overlap northern ones.
    let mut order: Vec<usize> = (0..MAX_PLAYERS)
        .filter(|&i| {
            players[i]
                .as_ref()
                .is_some_and(|p| p.sx == sx && p.sy == sy && p.dead_t == 0)
        })
        .collect();
    order.sort_by_key(|&i| players[i].as_ref().unwrap().y);

    for i in order {
        let p = players[i].as_ref().unwrap();
        let flicker = p.iframes > 0 && (tick >> 1) & 1 == 1;
        let px = to_px(p.x) + ox;
        let py = to_px(p.y) + oy;

        // Sword: behind the player when facing up, in front otherwise.
        // Draw the sword only on an armed swing (bare-handed attacks show no
        // weapon — the attack still connects via the fist hitbox).
        let sword = (p.attack_t > 0 && !p.unarmed).then(|| {
            let (sprite, sxo, syo, flags) = match p.facing {
                1 => (world.sprites.sword_up, 0, -14, 0),
                2 => (world.sprites.sword_side, -14, 2, 0),
                3 => (world.sprites.sword_side, 14, 2, FLAG_FLIP_X),
                _ => (world.sprites.sword_down, 0, 14, 0),
            };
            (sprite, px + sxo, py + syo, flags)
        });

        if let Some((s, x, y, f)) = sword {
            if p.facing == 1 {
                out.sprite(s, x, y, 0, f);
            }
        }
        if !flicker {
            let frame = if p.walking { (p.anim >> 3) & 1 } else { 0 } as u16;
            let (base, flags) = match p.facing {
                1 => (world.sprites.player_up, 0),
                2 => (world.sprites.player_side, 0),
                3 => (world.sprites.player_side, FLAG_FLIP_X),
                _ => (world.sprites.player_down, 0),
            };
            out.sprite(base + frame, px, py, 0, flags);
        }
        if let Some((s, x, y, f)) = sword {
            if p.facing != 1 {
                out.sprite(s, x, y, 0, f);
            }
        }

        // Fishing: bobber on the water tile in front; "!" overhead on a bite.
        if let Some(phase) = p.fishing {
            let (cx, cy) = facing_tile_center(p);
            let bob = if (tick >> 4) & 1 == 1 { 1 } else { 0 };
            out.sprite(world.sprites.bobber, cx - 8 + ox, cy - 8 + bob + oy, 0, 0);
            if matches!(phase, FishPhase::Bite { .. }) {
                if let Some(g) = world.glyph('!') {
                    out.glyph(g, px + 4, py - 9, 1);
                }
            }
        }
    }
}

fn draw_hud(world: &World, vp: &Player, out: &mut DrawList) {
    out.rect(0, 0, 0, SCREEN_W as u16, HUD_H as u16);
    // Hearts (cap the row so a high max_hp doesn't run off-screen; the
    // extra hearts still count, they just don't all draw). '#' full,
    // '%' half, '&' empty.
    let full = (vp.hp.max(0) / 2) as i32;
    let half = (vp.hp.max(0) % 2) as i32;
    let total = ((vp.max_hp / 2) as i32).min(7);
    for i in 0..total {
        let c = if i < full {
            '#'
        } else if i == full && half == 1 {
            '%'
        } else {
            '&'
        };
        if let Some(g) = world.glyph(c) {
            out.glyph(g, 2 + i * 9, 1, 1);
        }
    }

    // Level (centered) with a thin XP bar beneath it.
    let lv = format!("LV{}", vp.level);
    let lvx = (SCREEN_W - lv.len() as i32 * 8) / 2;
    draw_text(world, &lv, lvx, 1, 1, out);
    let cur = level_for_xp(vp.xp);
    let base = xp_for_level(cur);
    let next = xp_for_level(cur + 1).max(base + 1);
    let frac = ((vp.xp - base) * 30 / (next - base)).min(30) as i32;
    out.rect(1, (SCREEN_W - 30) / 2, 11, 30, 2); // track
    if frac > 0 {
        out.rect(3, (SCREEN_W - 30) / 2, 11, frac as u16, 2); // fill
    }

    // Shells: icon + count, right-aligned.
    let text = format!("{}", vp.shells);
    let x0 = SCREEN_W - 4 - (text.len() as i32 + 1) * 8;
    if let Some(g) = world.glyph('$') {
        out.glyph(g, x0, 1, 1);
    }
    draw_text(world, &text, x0 + 9, 1, 1, out);
}

pub fn draw_text(world: &World, text: &str, x: i32, y: i32, variant: u16, out: &mut DrawList) {
    let mut cx = x;
    for c in text.chars() {
        if c != ' ' {
            if let Some(g) = world.glyph(c) {
                out.glyph(g, cx, y, variant);
            }
        }
        cx += 8;
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

/// True if the player is actively shielding toward the attacker.
fn blocks(defs: &Defs, p: &Player, ax: Fx, ay: Fx) -> bool {
    if !p.shielding {
        return false;
    }
    if !p
        .equipped(p.equip_b)
        .is_some_and(|s| defs.items[s.def as usize].kind == ItemKind::Shield)
    {
        return false;
    }
    let dx = ax - p.x;
    let dy = ay - p.y;
    match p.facing {
        1 => dy < 0 && dy.abs() >= dx.abs(),
        0 => dy > 0 && dy.abs() >= dx.abs(),
        2 => dx < 0 && dx.abs() >= dy.abs(),
        _ => dx > 0 && dx.abs() >= dy.abs(),
    }
}

pub fn dialogue_pages_for<'a>(defs: &'a Defs, d: &Dialogue) -> &'a [Vec<String>] {
    match d.source {
        DialogueSource::Idle(set) => {
            let lines = &defs.npcs[d.npc as usize].lines;
            if lines.is_empty() {
                &[]
            } else {
                std::slice::from_ref(&lines[(set as usize) % lines.len()])
            }
        }
        DialogueSource::QuestOffer(q) => &defs.quests[q as usize].offer,
        DialogueSource::QuestIncomplete(q) => &defs.quests[q as usize].incomplete,
        DialogueSource::QuestComplete(q) => &defs.quests[q as usize].complete,
    }
}

/// Pixel center of the tile directly in front of the player.
fn facing_tile_center(p: &Player) -> (i32, i32) {
    let cx = to_px(p.x) + 8;
    let cy = to_px(p.y) + 8;
    match p.facing {
        1 => (cx, cy - 16),
        2 => (cx - 16, cy),
        3 => (cx + 16, cy),
        _ => (cx, cy + 16),
    }
}

/// True when any of the 4 tiles around the player's center is a campfire.
fn near_fire(world: &World, p: &Player) -> bool {
    let Some(screen) = world.screen_at(p.sx, p.sy) else {
        return false;
    };
    let cx = to_px(p.x) + 8;
    let cy = to_px(p.y) + 8;
    [(0, -16), (0, 16), (-16, 0), (16, 0), (0, 0)]
        .iter()
        .any(|(dx, dy)| world.is_fire(screen, cx + dx, cy + dy))
}

fn sword_box(p: &Player) -> (i32, i32, i32, i32) {
    let px = to_px(p.x);
    let py = to_px(p.y);
    match p.facing {
        1 => (px, py - 14, px + 16, py + 4),
        2 => (px - 14, py, px + 4, py + 16),
        3 => (px + 12, py, px + 30, py + 16),
        _ => (px, py + 12, px + 16, py + 30),
    }
}

/// Shorter reach for a bare-handed punch/kick.
fn fist_box(p: &Player) -> (i32, i32, i32, i32) {
    let px = to_px(p.x);
    let py = to_px(p.y);
    match p.facing {
        1 => (px + 2, py - 8, px + 14, py + 4),
        2 => (px - 8, py + 2, px + 4, py + 14),
        3 => (px + 12, py + 2, px + 24, py + 14),
        _ => (px + 2, py + 12, px + 14, py + 24),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2x1-screen bundle: borders solid, interiors open, gap on the shared
    /// edge, one thornling and one gel on screen 0. Screen 1 has a water
    /// tile (id 2) at (5,3) and a campfire (id 3) at (3,4).
    fn test_bundle() -> String {
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
            if sx == 1 {
                tiles[3 * 10 + 5] = 2; // water
                tiles[4 * 10 + 3] = 3; // campfire
                tiles[2 * 10 + 6] = 4; // tree (harvestable)
            }
            let entities = if sx == 0 {
                r#"[{"t":"thornling","tx":2,"ty":2},{"t":"gel","tx":7,"ty":5}]"#
            } else {
                "[]"
            };
            let npcs = if sx == 0 {
                r#"[{"t":"elder","tx":4,"ty":1}]"#
            } else {
                "[]"
            };
            screens.push(format!(
                r#"{{"x":{sx},"y":0,"name":"t{sx}","tiles":{tiles:?},"entities":{entities},"npcs":{npcs}}}"#
            ));
        }
        let sprites = [
            "player_down_0",
            "player_up_0",
            "player_side_0",
            "sword_down",
            "sword_up",
            "sword_side",
            "seed",
            "heart_drop",
            "shell_drop",
            "thornling_0",
            "gel_0",
            "claw",
            "itm_bomb",
            "blast_0",
            "arrow_h",
            "arrow_v",
            "itm_bow",
            "itm_shield",
            "bobber",
            "itm_rod",
            "itm_fish",
            "itm_food",
        ];
        let sprite_names = sprites.map(|s| format!("\"{s}\"")).join(",");
        format!(
            r#"{{"world":{{"tile_names":["floor","wall","water","fire","tree"],
"tile_solid":[false,true,true,true,true],"tile_water":[false,false,true,false,false],
"tile_fire":[false,false,false,true,false],
"tile_tree":[false,false,false,false,true],
"sprite_names":[{sprite_names}],"font_chars":"0123456789#%&$",
"screens":[{}],"spawn":{{"sx":0,"sy":0,"x":72,"y":64}}}},
"items":[
 {{"name":"stick","label":"STICK","sprite":"sword_down","kind":"sword","damage":1,"durability":18}},
 {{"name":"driftwood_sword","label":"DRIFTWOOD SWORD","sprite":"sword_down","kind":"sword","damage":1,"durability":40}},
 {{"name":"oak_bow","label":"OAK BOW","sprite":"itm_bow","kind":"bow","damage":1,"durability":30}},
 {{"name":"wooden_shield","label":"WOODEN SHIELD","sprite":"itm_shield","kind":"shield","durability":20}},
 {{"name":"bomb","label":"BOMB","sprite":"itm_bomb","kind":"bomb"}},
 {{"name":"arrow","label":"ARROW","sprite":"arrow_h","kind":"arrow"}},
 {{"name":"crab_claw","label":"CRAB CLAW","sprite":"claw","kind":"material","fuse_damage":1}},
 {{"name":"wasp_stinger","label":"WASP STINGER","sprite":"claw","kind":"material","fuse_effect":"poison"}},
 {{"name":"fishing_rod","label":"FISHING ROD","sprite":"itm_rod","kind":"rod","durability":25}},
 {{"name":"raw_perch","label":"RAW PERCH","sprite":"itm_fish","kind":"material"}},
 {{"name":"grilled_perch","label":"GRILLED PERCH","sprite":"itm_food","kind":"food","heal":4}}],
"enemies":[
 {{"name":"thornling","brain":"thornling","hp":2,"damage":1,"speed":0,"sprite":"thornling_0","drops":"basic","combat_xp":100}},
 {{"name":"gel","brain":"gel","hp":2,"damage":1,"speed":128,"sprite":"gel_0","drops":"basic"}},
 {{"name":"hare","brain":"critter","hp":1,"damage":0,"speed":320,"sprite":"gel_0","drops":"basic","hunt_xp":20}}],
"drops":{{"basic":[{{"item":"heart","p":400}},{{"item":"shells","p":600,"min":1,"max":3}},{{"item":"crab_claw","p":300}}]}},
"skills":{{"curve":{{"base":100,"growth":50,"max_level":15}},
 "fishing":[{{"item":"raw_perch","min_level":1,"weight":60,"xp":25}}]}},
"recipes":[{{"output":"grilled_perch","inputs":["raw_perch"],"level":1,"xp":30}}],
"npcs":[{{"name":"elder","label":"ELDER","sprite":"gel_0",
 "lines":[["HELLO TRAVELER."]],
 "shop":[{{"item":"driftwood_sword","price":25}},{{"item":"arrow","price":8,"qty":10}}]}}],
"quests":[{{"id":"cull","giver":"elder","title":"CULL THE THORNS",
 "offer":[["KILL A THORNLING."]],"incomplete":[["STILL HISSING..."]],
 "complete":[["IT IS DONE."]],
 "objectives":[{{"type":"kill","target":"thornling","count":1}}],
 "rewards":{{"shells":10,"items":[{{"item":"bomb","qty":2}}]}}}}]}}"#,
            screens.join(",")
        )
    }

    /// Players now start empty-handed; tests that exercise the weapon/skill
    /// systems hand the player a starter kit and equip the sword in A.
    fn give_starter_kit(sim: &mut Sim, slot: usize) {
        let kit = [
            ("driftwood_sword", 1u16),
            ("oak_bow", 1),
            ("wooden_shield", 1),
            ("arrow", 15),
            ("bomb", 5),
            ("fishing_rod", 1),
        ];
        let mut p = sim.players[slot].take().unwrap();
        for (name, qty) in kit {
            if let Some(def) = sim.defs.item_index(name) {
                give_item(&mut p, &sim.defs, def, qty);
            }
        }
        if !p.inventory.is_empty() {
            p.equip_a = 0;
        }
        sim.players[slot] = Some(p);
    }

    fn scripted_run(ticks: u32) -> u64 {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 0xA11CE).unwrap();
        sim.add_player(0);
        sim.add_player(1);
        give_starter_kit(&mut sim, 0);
        give_starter_kit(&mut sim, 1);
        let mut script = Pcg32::new(42, 7);
        for t in 0..ticks {
            if t % 13 == 0 {
                sim.set_input(0, (script.next_u32() & 0x1f) as u16); // incl. A
            }
            if t % 7 == 0 {
                sim.set_input(1, (script.next_u32() & 0x1f) as u16);
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
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 1).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        let x0 = sim.players[0].as_ref().unwrap().x;
        sim.set_input(0, BTN_RIGHT);
        for _ in 0..10 {
            sim.step();
        }
        assert!(sim.players[0].as_ref().unwrap().x > x0);
    }

    #[test]
    fn screen_transition_through_gap() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 1).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        // Spawn (y=64) is aligned with the edge gap (rows 3-4); walk right through it.
        sim.set_input(0, BTN_RIGHT);
        for _ in 0..400 {
            sim.step();
        }
        let p = sim.players[0].as_ref().unwrap();
        assert_eq!(p.sx, 1, "player should have crossed to screen 1");
    }

    #[test]
    fn unarmed_attacks_and_harvests_sticks() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 3).unwrap();
        sim.add_player(0);
        // No starter kit -> empty-handed. Move to screen 1, face the tree at
        // tile (6,2) -> px (96, HUD_H+32). Stand just below it, facing up.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.sx = 1;
            p.x = fx(96);
            p.y = fx(HUD_H + 48);
            p.facing = 1;
            assert!(p.inventory.is_empty());
            assert_eq!(p.equip_a, -1);
        }
        // Punch the tree: should harvest a stick and auto-equip it.
        sim.set_input(0, BTN_A);
        for _ in 0..12 {
            sim.step();
        }
        sim.set_input(0, 0);
        for _ in 0..4 {
            sim.step();
        }
        let stick = sim.defs.item_index("stick").unwrap();
        let p = sim.players[0].as_ref().unwrap();
        assert!(p.inventory.iter().any(|s| s.def == stick), "got a stick");
        assert!(p.equip_a >= 0, "stick auto-equipped");

        // Now unequip and verify a bare hand still damages an enemy. Place a
        // gel right in front and punch it.
        let gel = sim.defs.enemy_index("gel").unwrap();
        {
            let p = sim.players[0].as_mut().unwrap();
            p.equip_a = -1;
            p.x = fx(40);
            p.y = fx(HUD_H + 48);
            p.facing = 3; // right
        }
        let mut e = Entity::enemy(900, gel, 2, 1, 0, 56, HUD_H + 48);
        sim.entities.push(e.clone());
        let _ = &mut e;
        let hp_before = sim.entities.last().unwrap().hp;
        sim.set_input(0, BTN_A);
        for _ in 0..12 {
            sim.step();
        }
        let hit = sim
            .entities
            .iter()
            .find(|x| x.id == 900)
            .map(|x| x.hp < hp_before || !x.alive)
            .unwrap_or(true); // gone = killed
        assert!(hit, "bare hands should damage the gel");
    }

    #[test]
    fn sword_kills_enemy_and_drops_spawn() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 99).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        // Teleport next to the thornling at tile (2,2) -> px (32, 48).
        {
            let p = sim.players[0].as_mut().unwrap();
            p.x = fx(32);
            p.y = fx(48 + 18);
            p.facing = 1; // up
        }
        let enemies_before = sim
            .entities
            .iter()
            .filter(|e| e.etype == ET_ENEMY)
            .count();
        // Swing twice (thornling hp=2), releasing A between swings.
        for _ in 0..2 {
            sim.set_input(0, BTN_A);
            for _ in 0..20 {
                sim.step();
            }
            sim.set_input(0, 0);
            for _ in 0..4 {
                sim.step();
            }
        }
        let enemies_after = sim
            .entities
            .iter()
            .filter(|e| e.etype == ET_ENEMY)
            .count();
        assert_eq!(enemies_after, enemies_before - 1, "thornling should die");
        // With p=400+600+300 drop rolls, seed 99 should yield at least one pickup.
        let pickups = sim
            .entities
            .iter()
            .filter(|e| e.etype == ET_PICKUP)
            .count();
        assert!(pickups > 0, "expected at least one drop");
        // Thornling grants 100 combat XP -> level 2 (needs 60) and a heart.
        let p = sim.players[0].as_ref().unwrap();
        assert_eq!(p.level, 2, "should have levelled up");
        assert!(p.xp >= 100);
        assert_eq!(p.max_hp, max_hp_for_level(2));
    }

    #[test]
    fn enemy_contact_hurts_and_respawn_works() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 5).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        // Walk into the gel's corner long enough to take contact damage.
        sim.set_input(0, BTN_RIGHT | BTN_DOWN);
        let mut hurt = false;
        for _ in 0..600 {
            sim.step();
            if sim.players[0].as_ref().unwrap().hp < 6 {
                hurt = true;
                break;
            }
        }
        assert!(hurt, "gel should reach and hurt the player");
    }

    #[test]
    fn fusion_boosts_damage_and_consumes_material() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 3).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        let claw = sim.defs.item_index("crab_claw").unwrap();
        {
            let p = sim.players[0].as_mut().unwrap();
            give_item(p, &sim.defs, claw, 2);
        }
        let p = sim.players[0].as_ref().unwrap();
        let sword_idx = p
            .inventory
            .iter()
            .position(|s| sim.defs.items[s.def as usize].kind == ItemKind::Sword)
            .unwrap();
        let mat_idx = p.inventory.iter().position(|s| s.def == claw).unwrap();
        let dur_before = p.inventory[sword_idx].durability;
        let dmg_before = sim.weapon_damage(&p.inventory[sword_idx]);

        sim.ui_action(0, &format!(r#"{{"action":"fuse","a":{sword_idx},"b":{mat_idx}}}"#));

        let p = sim.players[0].as_ref().unwrap();
        let sword = &p.inventory[sword_idx];
        assert_eq!(sword.fused, Some(claw));
        assert_eq!(sim.weapon_damage(sword), dmg_before + 1);
        assert_eq!(sword.durability, dur_before + 10);
        assert_eq!(p.inventory.iter().find(|s| s.def == claw).unwrap().qty, 1);
        // Can't fuse twice.
        let mat_idx = p.inventory.iter().position(|s| s.def == claw).unwrap();
        sim.ui_action(0, &format!(r#"{{"action":"fuse","a":{sword_idx},"b":{mat_idx}}}"#));
        let p = sim.players[0].as_ref().unwrap();
        assert_eq!(p.inventory.iter().find(|s| s.def == claw).unwrap().qty, 1);
    }

    #[test]
    fn durability_wears_and_weapon_breaks() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 11).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        // Shrink the sword to 2 durability so the test is quick.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.inventory[0].durability = 2;
            p.x = fx(32);
            p.y = fx(48 + 18);
            p.facing = 1;
        }
        // Swing until it breaks (thornling respawn keeps targets coming).
        for _ in 0..12 {
            sim.set_input(0, BTN_A);
            for _ in 0..20 {
                sim.step();
            }
            sim.set_input(0, 0);
            for _ in 0..40 {
                sim.step();
            }
            let p = sim.players[0].as_ref().unwrap();
            let has_sword = p
                .inventory
                .iter()
                .any(|s| sim.defs.items[s.def as usize].kind == ItemKind::Sword);
            if !has_sword {
                assert_eq!(p.equip_a, -1, "equip slot should clear on break");
                return;
            }
        }
        panic!("sword never broke");
    }

    #[test]
    fn fishing_cooking_eating_loop() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 21).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        let rod = sim.defs.item_index("fishing_rod").unwrap();
        // Move to screen 1, stand left of the water tile (5,3) facing right.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.sx = 1;
            p.x = fx(4 * 16);
            p.y = fx(HUD_H + 3 * 16);
            p.facing = 3;
            let rod_idx = p.inventory.iter().position(|s| s.def == rod).unwrap();
            p.equip_b = rod_idx as i8;
        }
        // Cast.
        sim.set_input(0, BTN_B);
        sim.step();
        sim.set_input(0, 0);
        assert!(matches!(
            sim.players[0].as_ref().unwrap().fishing,
            Some(FishPhase::Cast { .. })
        ));
        // Wait out the bite (max 240 ticks), then hook it.
        for _ in 0..400 {
            sim.step();
            if matches!(
                sim.players[0].as_ref().unwrap().fishing,
                Some(FishPhase::Bite { .. })
            ) {
                break;
            }
        }
        assert!(matches!(
            sim.players[0].as_ref().unwrap().fishing,
            Some(FishPhase::Bite { .. })
        ));
        sim.set_input(0, BTN_B);
        sim.step();
        sim.set_input(0, 0);
        let p = sim.players[0].as_ref().unwrap();
        let perch = sim.defs.item_index("raw_perch").unwrap();
        assert!(p.inventory.iter().any(|s| s.def == perch), "caught a perch");
        assert!(p.skills[defs::SKILL_FISHING] > 0, "fishing xp awarded");

        // Walk next to the campfire (3,4) and cook it.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.x = fx(2 * 16);
            p.y = fx(HUD_H + 4 * 16);
        }
        sim.ui_action(0, r#"{"action":"cook","a":0}"#);
        let p = sim.players[0].as_ref().unwrap();
        let cooked = sim.defs.item_index("grilled_perch").unwrap();
        assert!(p.inventory.iter().any(|s| s.def == cooked), "cooked it");
        assert!(p.skills[defs::SKILL_COOKING] > 0, "cooking xp awarded");

        // Take damage, then eat it.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.hp = 2;
        }
        let eat_idx = sim.players[0]
            .as_ref()
            .unwrap()
            .inventory
            .iter()
            .position(|s| s.def == cooked)
            .unwrap();
        sim.ui_action(0, &format!(r#"{{"action":"eat","a":{eat_idx}}}"#));
        assert_eq!(sim.players[0].as_ref().unwrap().hp, 6);
    }

    #[test]
    fn save_roundtrip_preserves_character() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 51).unwrap();
        sim.add_player(0);
        // Mutate the character: gain shells, xp, items, a quest, move.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.shells = 42;
            p.skills = [120, 30, 7];
            p.hp = 3;
            give_item(p, &sim.defs, sim.defs.item_index("crab_claw").unwrap(), 5);
            p.quests.push(PlayerQuest {
                quest: 0,
                done: false,
                progress: vec![1],
            });
            p.sx = 1;
            p.x = fx(50);
            p.y = fx(70);
        }
        let json = sim.export_save(0);
        assert!(save::migrate(&json).is_some());

        let mut sim2 = Sim::new(&bundle, 99).unwrap();
        sim2.add_player_with_save(0, &json);
        let p = sim2.players[0].as_ref().unwrap();
        assert_eq!(p.shells, 42);
        assert_eq!(p.skills, [120, 30, 7]);
        assert_eq!(p.hp, 3);
        assert_eq!(p.sx, 1);
        assert_eq!(to_px(p.x), 50);
        assert_eq!(p.quests.len(), 1);
        assert_eq!(p.quests[0].progress[0], 1);
        let claw = sim2.defs.item_index("crab_claw").unwrap();
        assert_eq!(
            p.inventory.iter().find(|s| s.def == claw).map(|s| s.qty),
            Some(5)
        );
        // Same hash after re-export (stable round trip).
        assert_eq!(sim2.export_save(0), json);

        // Bad saves fall back to a fresh character at spawn.
        let mut sim3 = Sim::new(&bundle, 7).unwrap();
        sim3.add_player_with_save(0, "{\"schema_version\":999}");
        let p = sim3.players[0].as_ref().unwrap();
        assert_eq!((p.sx, p.sy), (0, 0));
        assert_eq!(p.hp, 6);
    }

    #[test]
    fn vendor_buy_spends_shells() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 7).unwrap();
        sim.add_player(0);
        // Stand right next to the elder (vendor) at tile (4,1) -> px 64,32.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.x = fx(64);
            p.y = fx(40);
            p.shells = 100;
        }
        // Vendor is in reach; shop json is non-null.
        let vendor = sim.vendor_here(0);
        assert!(vendor >= 0, "vendor should be in reach");
        assert_ne!(sim.shop_json(0, vendor as u8), "null");

        // Buy the sword (entry 0, price 25).
        let sword = sim.defs.item_index("driftwood_sword").unwrap();
        sim.ui_action(0, &format!(r#"{{"action":"buy","a":{vendor},"b":0}}"#));
        let p = sim.players[0].as_ref().unwrap();
        assert_eq!(p.shells, 75);
        assert!(p.inventory.iter().any(|s| s.def == sword));

        // Can't afford it 4 more times (75 -> 50 -> 25 -> 0, then fail).
        for _ in 0..3 {
            sim.ui_action(0, &format!(r#"{{"action":"buy","a":{vendor},"b":0}}"#));
        }
        assert_eq!(sim.players[0].as_ref().unwrap().shells, 0);
        sim.ui_action(0, &format!(r#"{{"action":"buy","a":{vendor},"b":0}}"#));
        assert_eq!(sim.players[0].as_ref().unwrap().shells, 0, "broke: no buy");

        // Out of range: walk away, buying does nothing.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.x = fx(140);
            p.y = fx(120);
            p.shells = 100;
        }
        assert_eq!(sim.vendor_here(0), -1);
        sim.ui_action(0, &format!(r#"{{"action":"buy","a":{vendor},"b":1}}"#));
        assert_eq!(sim.players[0].as_ref().unwrap().shells, 100, "no remote buy");
    }

    #[test]
    fn quest_accept_progress_turnin() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 41).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        // Stand under the elder at tile (4,1) -> px 64, py 16+16=32; face up.
        {
            let p = sim.players[0].as_mut().unwrap();
            p.x = fx(64);
            p.y = fx(32 + 18);
            p.facing = 1;
        }
        let talk = |sim: &mut Sim| {
            sim.set_input(0, BTN_A);
            sim.step();
            sim.set_input(0, 0);
            sim.step();
        };
        // Open dialogue (offer has 1 page), advance once to accept.
        talk(&mut sim);
        assert!(sim.players[0].as_ref().unwrap().dialogue.is_some());
        talk(&mut sim);
        let p = sim.players[0].as_ref().unwrap();
        assert!(p.dialogue.is_none());
        assert_eq!(p.quests.len(), 1);
        assert!(!p.quests[0].done);

        // Kill the thornling (teleport next to it like the combat test).
        {
            let p = sim.players[0].as_mut().unwrap();
            p.x = fx(32);
            p.y = fx(48 + 18);
            p.facing = 1;
        }
        for _ in 0..3 {
            sim.set_input(0, BTN_A);
            for _ in 0..20 {
                sim.step();
            }
            sim.set_input(0, 0);
            for _ in 0..4 {
                sim.step();
            }
        }
        let p = sim.players[0].as_ref().unwrap();
        assert_eq!(p.quests[0].progress[0], 1, "kill counted");

        // Return and turn in.
        let shells_before = p.shells;
        {
            let p = sim.players[0].as_mut().unwrap();
            p.x = fx(64);
            p.y = fx(32 + 18);
            p.facing = 1;
        }
        talk(&mut sim); // opens complete dialogue
        talk(&mut sim); // advances past its single page -> rewards
        let p = sim.players[0].as_ref().unwrap();
        assert!(p.quests[0].done, "quest done");
        assert_eq!(p.shells, shells_before + 10);
    }

    #[test]
    fn hunting_critter_awards_xp() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 31).unwrap();
        sim.add_player(0);
        give_starter_kit(&mut sim, 0);
        // Spawn a hare right in front of the player and stab it.
        let hare = sim.defs.enemy_index("hare").unwrap();
        let (px, py) = {
            let p = sim.players[0].as_ref().unwrap();
            (to_px(p.x), to_px(p.y))
        };
        // Overlap the sword arc deeply so the fleeing hare can't escape it.
        let mut e = Entity::enemy(999, hare, 1, 0, 0, px, py - 12);
        e.iframes = 0;
        sim.entities.push(e);
        {
            let p = sim.players[0].as_mut().unwrap();
            p.facing = 1;
        }
        sim.set_input(0, BTN_A);
        for _ in 0..20 {
            sim.step();
        }
        let p = sim.players[0].as_ref().unwrap();
        assert!(p.skills[defs::SKILL_HUNTING] > 0, "hunting xp awarded");
    }

    #[test]
    fn snapshot_roundtrip_and_interpolation() {
        let bundle = test_bundle();
        let mut sim = Sim::new(&bundle, 7).unwrap();
        sim.add_player(0);
        sim.set_input(0, BTN_RIGHT);

        let mut view = client::ClientView::new();
        let bytes0 = protocol::encode(&protocol::H2C::Snapshot(sim.snapshot()));
        for _ in 0..3 {
            sim.step();
        }
        let snap1 = sim.snapshot();

        let Some(protocol::H2C::Snapshot(snap0)) = protocol::decode(&bytes0) else {
            panic!("snapshot did not round-trip");
        };
        let x0 = snap0.players[0].x;
        let x1 = snap1.players[0].x;
        assert!(x1 > x0);
        assert!(!snap1.entities.is_empty(), "entities should be in snapshot");

        view.push(1000, snap0);
        view.push(1050, snap1);
        let (players, entities) = view.sample(1145);
        let xs = players[0].as_ref().unwrap().x;
        assert!(xs > x0 && xs < x1, "expected {x0} < {xs} < {x1}");
        assert!(!entities.is_empty());
    }
}
