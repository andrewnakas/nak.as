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
    /// Latest save pushed by the host (client role).
    pending_save: Option<String>,
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
            pending_save: None,
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

    pub fn add_player_with_save(&mut self, slot: u8, save_json: &str) {
        self.sim.add_player_with_save(slot as usize, save_json);
    }

    pub fn export_save(&self, slot: u8) -> String {
        self.sim.export_save(slot as usize)
    }

    /// Wrap a save for the reliable channel (host -> the owning client).
    pub fn encode_save_state(&self, slot: u8) -> Vec<u8> {
        protocol::encode(&H2C::SaveState {
            json: self.sim.export_save(slot as usize),
        })
    }

    /// A save pushed by the host since the last call (client role).
    pub fn take_pending_save(&mut self) -> Option<String> {
        self.pending_save.take()
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

    /// Vendor NPC the viewpoint player can shop with right now, or -1.
    /// Host uses live state; client uses the latest snapshot position.
    pub fn vendor_here(&self, slot: u8) -> i32 {
        if self.role == ROLE_CLIENT {
            self.view.vendor_here(&self.sim, slot)
        } else {
            self.sim.vendor_here(slot as usize)
        }
    }

    /// Shop listing JSON for a vendor (role-aware), or "null".
    pub fn shop_json(&self, slot: u8, npc: u8) -> String {
        if self.role == ROLE_CLIENT {
            self.view.shop_json(&self.sim, slot, npc)
        } else {
            self.sim.shop_json(slot as usize, npc)
        }
    }

    /// Encode a UI action for sending to the host (client role).
    pub fn encode_ui_action(&self, json: &str) -> Vec<u8> {
        protocol::encode(&C2H::UiAction {
            json: json.to_string(),
        })
    }

    /// Inventory/equipment/skills/quests JSON for the UI overlay (role-aware).
    pub fn ui_state(&self, slot: u8) -> String {
        if self.role == ROLE_CLIENT {
            match self.view.latest_player(slot) {
                Some(p) => sim::ui_state_json(
                    &self.sim.defs,
                    &p.inventory,
                    p.equip_a,
                    p.equip_b,
                    p.skills,
                    self.view.latest_near_fire(slot),
                    self.view.latest_fishing(slot),
                    &p.quests,
                    p.level,
                    p.xp,
                ),
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

    /// Serialized full snapshot (every player + active entities). For solo
    /// and small parties where broadcasting one snapshot to all is cheapest.
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        protocol::encode(&H2C::Snapshot(self.sim.snapshot()))
    }

    /// Serialized per-viewpoint snapshot (only what `slot`'s player can see).
    /// Bounds each client's bandwidth to its own screen — used for larger
    /// worlds so the host's uplink doesn't scale with total player count.
    pub fn snapshot_bytes_for(&self, slot: u8) -> Vec<u8> {
        protocol::encode(&H2C::Snapshot(self.sim.snapshot_for(slot as usize)))
    }

    /// Key for sharing one serialized per-viewpoint snapshot across all clients
    /// that would receive identical bytes (same screen, same transition state).
    /// The host groups peers by this to serialize once per screen, not per peer.
    pub fn snapshot_key(&self, slot: u8) -> i64 {
        self.sim.snapshot_key(slot as usize)
    }

    /// Fingerprint of a screen's snapshot CONTENT (tick excluded) so the host
    /// can skip resending an unchanged static screen between keyframes.
    pub fn snapshot_content_hash(&self, slot: u8) -> u64 {
        self.sim.snapshot_content_hash(slot as usize)
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
            Some(H2C::SaveState { json }) => self.pending_save = Some(json),
            None => {}
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
                &self.view.overrides(),
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

    /// [sx, sy] of the viewpoint player's screen, or empty if unknown.
    pub fn player_screen(&self, slot: u8) -> Vec<i32> {
        let at = if self.role == ROLE_CLIENT {
            self.view.player_screen(slot)
        } else {
            self.sim
                .players
                .get(slot as usize)
                .and_then(|p| p.as_ref())
                .map(|p| (p.sx, p.sy))
        };
        at.map(|(sx, sy)| vec![sx, sy]).unwrap_or_default()
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
