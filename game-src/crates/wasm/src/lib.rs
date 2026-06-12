//! wasm-bindgen surface: thin marshalling between the JS shell and the sim.
//! No game logic lives here.
//!
//! Roles: 0 = host (runs the authoritative sim; solo play is a host with no
//! peers), 1 = client (applies host snapshots, renders interpolated view).

use protocol::{C2H, H2C};
use sim::client::ClientView;
use sim::draw::DrawList;
use sim::{render_view, Sim};
use wasm_bindgen::prelude::*;

pub const ROLE_HOST: u8 = 0;
pub const ROLE_CLIENT: u8 = 1;

#[wasm_bindgen]
pub struct Game {
    sim: Sim,
    role: u8,
    view: ClientView,
    input_seq: u32,
}

#[wasm_bindgen]
impl Game {
    /// Panics on malformed content; world.json is validated at build time
    /// by tools/build-maps.mjs.
    #[wasm_bindgen(constructor)]
    pub fn new(content_json: &str, role: u8, seed: u64) -> Game {
        Game {
            sim: Sim::new(content_json, seed).expect("invalid world content"),
            role,
            view: ClientView::new(),
            input_seq: 0,
        }
    }

    pub fn content_hash(&self) -> u64 {
        self.sim.content_hash
    }

    // ---- host path ----

    pub fn add_player(&mut self, slot: u8) {
        self.sim.add_player(slot as usize);
    }

    pub fn remove_player(&mut self, slot: u8) {
        self.sim.remove_player(slot as usize);
    }

    pub fn set_input(&mut self, slot: u8, buttons: u16) {
        self.sim.set_input(slot as usize, buttons);
    }

    /// Decode and apply one message from the client in `slot`.
    pub fn handle_client_msg(&mut self, slot: u8, bytes: &[u8]) {
        match protocol::decode::<C2H>(bytes) {
            Some(C2H::Input { buttons, .. }) => self.sim.set_input(slot as usize, buttons),
            Some(C2H::UiAction { .. }) => {} // arrives with menus/fusion
            Some(C2H::Bye) | None => {}
        }
    }

    pub fn tick(&mut self) {
        self.sim.step();
    }

    /// Serialized snapshot to broadcast (same for every slot until
    /// per-screen interest filtering lands with enemies).
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        protocol::encode(&H2C::Snapshot(self.sim.snapshot()))
    }

    // ---- client path ----

    pub fn encode_input(&mut self, buttons: u16) -> Vec<u8> {
        self.input_seq = self.input_seq.wrapping_add(1);
        protocol::encode(&C2H::Input {
            seq: self.input_seq,
            buttons,
        })
    }

    pub fn apply_host_msg(&mut self, bytes: &[u8], now_ms: f64) {
        match protocol::decode::<H2C>(bytes) {
            Some(H2C::Snapshot(snap)) => self.view.push(now_ms as u64, snap),
            Some(H2C::Event { .. }) | Some(H2C::SaveState { .. }) | None => {}
        }
    }

    // ---- shared per-frame ----

    pub fn render_frame(&self, viewpoint: u8, now_ms: f64) -> Vec<u16> {
        let mut list = DrawList::new();
        if self.role == ROLE_CLIENT {
            let players = self.view.sample(now_ms as u64);
            render_view(&self.sim.world, &players, viewpoint as usize, &mut list);
        } else {
            self.sim.render(viewpoint as usize, &mut list);
        }
        list.0
    }

    pub fn tick_count(&self) -> u32 {
        if self.role == ROLE_CLIENT {
            self.view.latest_tick()
        } else {
            self.sim.tick
        }
    }

    pub fn state_hash(&self) -> u64 {
        self.sim.state_hash()
    }
}
