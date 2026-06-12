//! Wire messages and save-file types shared by host and client code paths.
//! Everything here is postcard-serialized; JS treats payloads as opaque bytes.
//! Filled out in Phase 2 (netcode) and Phase 7 (saves).

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;
pub const SAVE_SCHEMA_VERSION: u32 = 1;

/// Client → host.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum C2H {
    Hello {
        name: String,
        content_hash: u64,
        proto: u16,
    },
    Input {
        seq: u32,
        buttons: u16,
    },
    UiAction {
        json: String,
    },
    Bye,
}

/// Host → client.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum H2C {
    Welcome {
        slot: u8,
        seed: u64,
    },
    Reject {
        reason: String,
    },
    Snapshot {
        tick: u32,
        payload: Vec<u8>,
    },
    Event {
        tick: u32,
        payload: Vec<u8>,
    },
    SaveState {
        json: String,
    },
}

pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    postcard::to_allocvec(msg).expect("postcard encode")
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Option<T> {
    postcard::from_bytes(bytes).ok()
}
