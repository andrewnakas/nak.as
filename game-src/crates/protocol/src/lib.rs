//! Wire messages and save-file types shared by host and client code paths.
//! Game-state messages are postcard-serialized (compact, schema-evolvable
//! enough for our append-only habits); JS treats them as opaque bytes.
//! The pre-game handshake (hello/welcome) is plain JSON over the reliable
//! channel and lives in JS — it happens before the sim is involved.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;
pub const SAVE_SCHEMA_VERSION: u32 = 1;

/// One player's state inside a snapshot. Positions are fixed-point
/// (1/256 px) exactly as the sim stores them.
#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
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
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SnapshotData {
    pub tick: u32,
    pub players: Vec<PlayerSnap>,
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
