//! Wire messages and save-file types shared by host and client code paths.
//! Game-state messages are postcard-serialized (compact, schema-evolvable
//! enough for our append-only habits); JS treats them as opaque bytes.
//! The pre-game handshake (hello/welcome) is plain JSON over the reliable
//! channel and lives in JS — it happens before the sim is involved.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;
pub const SAVE_SCHEMA_VERSION: u32 = 1;

/// One inventory slot inside a snapshot.
#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct ItemSnap {
    pub def: u8,
    pub qty: u16,
    pub durability: u16,
    /// Fused material item def, or -1.
    pub fused: i16,
    /// Attached body-part item def, or -1.
    pub attached: i16,
}

/// One player's state inside a snapshot. Positions are fixed-point
/// (1/256 px) exactly as the sim stores them.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerSnap {
    pub slot: u8,
    pub sx: i32,
    pub sy: i32,
    pub x: i32,
    pub y: i32,
    pub facing: u8,
    pub walking: bool,
    pub anim: u32,
    /// (direction, elapsed ticks) of an active screen-scroll transition.
    pub transition: Option<(u8, u32)>,
    pub hp: i16,
    pub max_hp: i16,
    pub shells: u32,
    pub attack_t: u8,
    pub unarmed: bool,
    pub iframes: u8,
    pub dead: bool,
    pub shielding: bool,
    pub inventory: Vec<ItemSnap>,
    pub equip_a: i8,
    pub equip_b: i8,
    /// XP per skill: [fishing, cooking, hunting].
    pub skills: [u32; 3],
    /// Character RPG level + total combat XP.
    pub level: u32,
    pub xp: u32,
    /// Fishing phase: 0 = waiting, 1 = bite window.
    pub fishing: Option<u8>,
    pub near_fire: bool,
    /// Riding the surfboard (drives the paddle animation on remote clients).
    pub surfing: bool,
    /// (npc, source kind 0..=3, source index, page).
    pub dialogue: Option<(u8, u8, u8, u8)>,
    pub quests: Vec<QuestSnap>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QuestSnap {
    pub quest: u8,
    pub done: bool,
    pub progress: Vec<u32>,
}

/// Entity type tags inside EntitySnap.
pub const ET_ENEMY: u8 = 0;
pub const ET_PROJECTILE: u8 = 1;
pub const ET_PICKUP: u8 = 2;

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct EntitySnap {
    pub id: u32,
    pub etype: u8,
    /// Index into the matching def table (enemy def / projectile kind /
    /// pickup kind; pickup item index rides in `data`).
    pub def: u8,
    pub data: i32,
    pub sx: i32,
    pub sy: i32,
    pub x: i32,
    pub y: i32,
    pub facing: u8,
    pub anim: u32,
    pub flash: bool,
    pub big: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SnapshotData {
    pub tick: u32,
    pub players: Vec<PlayerSnap>,
    pub entities: Vec<EntitySnap>,
    /// Mutated tiles: (sx, sy, tile index, new tile id). Full list — the
    /// world has only a handful of doors/brambles.
    pub overrides: Vec<(i32, i32, i32, u16)>,
}

/// Discrete things that happened in the sim, sent reliably to clients.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum GameEvent {
    /// Sound cue scoped to a screen so each client plays only local sounds.
    Audio { sx: i32, sy: i32, cue: u16 },
    /// Short UI message for one player ("THE SWORD BROKE!").
    Toast { slot: u8, msg: String },
}

/// Client → host.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum C2H {
    Input { seq: u32, buttons: u16 },
    UiAction { json: String },
    Bye,
}

/// Host → client.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum H2C {
    Snapshot(SnapshotData),
    Event { tick: u32, payload: Vec<u8> },
    SaveState { json: String },
}

pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    postcard::to_allocvec(msg).expect("postcard encode")
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Option<T> {
    postcard::from_bytes(bytes).ok()
}
