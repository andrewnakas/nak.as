//! wasm-bindgen surface: thin marshalling between the JS shell and the sim.
//! No game logic lives here.
//!
//! Roles: 0 = host (runs the authoritative sim; solo play is a host with no
//! peers), 1 = client (applies host snapshots, renders interpolated view).

use protocol::{GameEvent, C2H, H2C};
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
    /// Sound cues received over the network (client role).
    client_audio: Vec<(i32, i32, u16)>,
    /// Toasts received over the network for the local player (client role).
    client_toasts: Vec<String>,
    /// Slot of the local player on a client (set by the JS shell post-welcome).
    local_slot: u8,
}

#[wasm_bindgen]
impl Game {
    /// Panics on malformed content; the bundle is validated at build time
    /// by tools/build-maps.mjs + tools/check-content.mjs.
    #[wasm_bindgen(constructor)]
    pub fn new(content_json: &str, role: u8, seed: u64) -> Game {
        Game {
            sim: Sim::new(content_json, seed).expect("invalid content bundle"),
            role,
            view: ClientView::new(),
            input_seq: 0,
            client_audio: Vec::new(),
            client_toasts: Vec::new(),
            local_slot: 0,
        }
    }

    pub fn set_local_slot(&mut self, slot: u8) {
        self.local_slot = slot;
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
            Some(C2H::UiAction { json }) => self.sim.ui_action(slot as usize, &json),
            Some(C2H::Bye) | None => {}
        }
    }

    /// Apply a UI action for a local (host-side) player.
    pub fn ui_action(&mut self, slot: u8, json: &str) {
        self.sim.ui_action(slot as usize, json);
    }

    /// Encode a UI action for sending to the host (client role).
    pub fn encode_ui_action(&self, json: &str) -> Vec<u8> {
        protocol::encode(&C2H::UiAction {
            json: json.to_string(),
        })
    }

    /// Inventory/equipment/skills JSON for the UI overlay (role-aware).
    pub fn ui_state(&self, slot: u8) -> String {
        if self.role == ROLE_CLIENT {
            match self.view.player_ui(slot) {
                Some((items, a, b, skills, near_fire, fishing)) => {
                    sim::ui_state_json(&self.sim.defs, &items, a, b, skills, near_fire, fishing)
                }
                None => "null".to_string(),
            }
        } else {
            self.sim.ui_state(slot as usize)
        }
    }

    /// Toast messages for the viewpoint player since the last call (JSON array).
    pub fn drain_toasts(&mut self, viewpoint: u8) -> String {
        let toasts: Vec<String> = if self.role == ROLE_CLIENT {
            self.client_toasts.drain(..).collect()
        } else {
            self.sim.drain_toasts(viewpoint as usize)
        };
        serde_json::to_string(&toasts).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn tick(&mut self) {
        self.sim.step();
    }

    /// Serialized snapshot to broadcast.
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        protocol::encode(&H2C::Snapshot(self.sim.snapshot()))
    }

    /// Net events since the last call, wrapped for the reliable channel.
    /// Empty result means nothing to send.
    pub fn drain_events_bytes(&mut self) -> Vec<u8> {
        let events = self.sim.drain_events();
        if events.is_empty() {
            return Vec::new();
        }
        protocol::encode(&H2C::Event {
            tick: self.sim.tick,
            payload: protocol::encode(&events),
        })
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
            Some(H2C::Event { payload, .. }) => {
                if let Some(events) = protocol::decode::<Vec<GameEvent>>(&payload) {
                    for ev in events {
                        match ev {
                            GameEvent::Audio { sx, sy, cue } => {
                                self.client_audio.push((sx, sy, cue));
                            }
                            GameEvent::Toast { slot, msg } => {
                                if slot == self.local_slot {
                                    self.client_toasts.push(msg);
                                }
                            }
                        }
                    }
                }
            }
            Some(H2C::SaveState { .. }) | None => {}
        }
    }

    // ---- shared per-frame ----

    pub fn render_frame(&self, viewpoint: u8, now_ms: f64) -> Vec<u16> {
        let mut list = DrawList::new();
        if self.role == ROLE_CLIENT {
            let (players, entities) = self.view.sample(now_ms as u64);
            render_view(
                &self.sim.world,
                &self.sim.defs,
                &players,
                &entities,
                viewpoint as usize,
                self.view.latest_tick(),
                &mut list,
            );
        } else {
            self.sim.render(viewpoint as usize, &mut list);
        }
        list.0
    }

    /// Sound cues for the viewpoint player's screen since the last call.
    pub fn drain_audio(&mut self, viewpoint: u8) -> Vec<u16> {
        if self.role == ROLE_CLIENT {
            let at = self.view.player_screen(viewpoint);
            let out = match at {
                Some((sx, sy)) => self
                    .client_audio
                    .iter()
                    .filter(|(ax, ay, _)| *ax == sx && *ay == sy)
                    .map(|&(_, _, c)| c)
                    .collect(),
                None => Vec::new(),
            };
            self.client_audio.clear();
            out
        } else {
            self.sim.drain_audio(viewpoint as usize)
        }
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
