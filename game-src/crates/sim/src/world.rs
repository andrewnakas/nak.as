//! Static world data: screens of tiles, collision, spawn point.
//! Loaded once from world.json (built by tools/build-maps.mjs).

use crate::draw::HUD_H;
use serde::Deserialize;
use std::collections::BTreeMap;

pub const SCREEN_COLS: i32 = 10;
pub const SCREEN_ROWS: i32 = 8;

#[derive(Deserialize)]
struct WorldJson {
    tile_solid: Vec<bool>,
    sprite_names: Vec<String>,
    screens: Vec<ScreenJson>,
    spawn: SpawnJson,
}

#[derive(Deserialize)]
struct ScreenJson {
    x: i32,
    y: i32,
    tiles: Vec<u16>,
}

#[derive(Deserialize)]
struct SpawnJson {
    sx: i32,
    sy: i32,
    x: i32,
    y: i32,
}

pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub tiles: Vec<u16>,
}

#[derive(Clone, Copy)]
pub struct Spawn {
    pub sx: i32,
    pub sy: i32,
    pub x: i32,
    pub y: i32,
}

/// Sprite-sheet indices the sim references by name at load time.
pub struct SpriteIds {
    pub player_down: u16,
    pub player_up: u16,
    pub player_side: u16,
}

pub struct World {
    pub tile_solid: Vec<bool>,
    pub screens: Vec<Screen>,
    index: BTreeMap<(i32, i32), usize>,
    pub spawn: Spawn,
    pub sprites: SpriteIds,
}

impl World {
    pub fn from_json(json: &str) -> Result<World, String> {
        let raw: WorldJson = serde_json::from_str(json).map_err(|e| e.to_string())?;

        let find = |name: &str| -> Result<u16, String> {
            raw.sprite_names
                .iter()
                .position(|n| n == name)
                .map(|i| i as u16)
                .ok_or_else(|| format!("world.json missing sprite '{name}'"))
        };
        let sprites = SpriteIds {
            player_down: find("player_down_0")?,
            player_up: find("player_up_0")?,
            player_side: find("player_side_0")?,
        };

        let mut screens = Vec::with_capacity(raw.screens.len());
        let mut index = BTreeMap::new();
        for s in raw.screens {
            if s.tiles.len() != (SCREEN_COLS * SCREEN_ROWS) as usize {
                return Err(format!("screen {},{} has {} tiles", s.x, s.y, s.tiles.len()));
            }
            index.insert((s.x, s.y), screens.len());
            screens.push(Screen {
                x: s.x,
                y: s.y,
                tiles: s.tiles,
            });
        }

        Ok(World {
            tile_solid: raw.tile_solid,
            screens,
            index,
            spawn: Spawn {
                sx: raw.spawn.sx,
                sy: raw.spawn.sy,
                x: raw.spawn.x,
                y: raw.spawn.y,
            },
            sprites,
        })
    }

    pub fn screen_at(&self, sx: i32, sy: i32) -> Option<&Screen> {
        self.index.get(&(sx, sy)).map(|&i| &self.screens[i])
    }

    /// Solidity of the pixel (screen space; playfield starts at y=HUD_H).
    /// Pixels outside the playfield are walkable so edge transitions can
    /// trigger; the sim clamps when there is no neighbor screen.
    pub fn is_solid(&self, screen: &Screen, px: i32, py: i32) -> bool {
        let tx = px.div_euclid(16);
        let ty = (py - HUD_H).div_euclid(16);
        if tx < 0 || tx >= SCREEN_COLS || ty < 0 || ty >= SCREEN_ROWS {
            return false;
        }
        let tile = screen.tiles[(ty * SCREEN_COLS + tx) as usize] as usize;
        self.tile_solid.get(tile).copied().unwrap_or(true)
    }
}
