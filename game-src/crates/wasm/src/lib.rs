//! wasm-bindgen surface: thin marshalling between the JS shell and the sim.
//! No game logic lives here.

use sim::draw::DrawList;
use sim::Sim;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Game {
    sim: Sim,
}

#[wasm_bindgen]
impl Game {
    /// Panics on malformed content; world.json is validated at build time
    /// by tools/build-maps.mjs.
    #[wasm_bindgen(constructor)]
    pub fn new(content_json: &str, seed: u64) -> Game {
        Game {
            sim: Sim::new(content_json, seed).expect("invalid world content"),
        }
    }

    pub fn add_player(&mut self, slot: u8) {
        self.sim.add_player(slot as usize);
    }

    pub fn set_input(&mut self, slot: u8, buttons: u16) {
        self.sim.set_input(slot as usize, buttons);
    }

    pub fn tick(&mut self) {
        self.sim.step();
    }

    pub fn render_frame(&self, viewpoint: u8) -> Vec<u16> {
        let mut list = DrawList::new();
        self.sim.render(viewpoint as usize, &mut list);
        list.0
    }

    pub fn tick_count(&self) -> u32 {
        self.sim.tick
    }

    pub fn state_hash(&self) -> u64 {
        self.sim.state_hash()
    }
}
