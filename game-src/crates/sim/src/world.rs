//! Static world data: screens of tiles, collision, enemy spawn points,
//! font charset, spawn point. Loaded once from the content bundle
//! (world part built by tools/build-maps.mjs).

use crate::draw::HUD_H;
use serde::Deserialize;
use std::collections::BTreeMap;

pub const SCREEN_COLS: i32 = 10;
pub const SCREEN_ROWS: i32 = 8;

#[derive(Deserialize)]
pub struct WorldJson {
    pub tile_solid: Vec<bool>,
    pub sprite_names: Vec<String>,
    pub font_chars: String,
    pub screens: Vec<ScreenJson>,
    pub spawn: SpawnJson,
}

#[derive(Deserialize)]
pub struct ScreenJson {
    x: i32,
    y: i32,
    tiles: Vec<u16>,
    #[serde(default)]
    entities: Vec<EntitySpawnJson>,
}

#[derive(Deserialize)]
struct EntitySpawnJson {
    t: String,
    tx: i32,
    ty: i32,
}

#[derive(Deserialize)]
pub struct SpawnJson {
    sx: i32,
    sy: i32,
    x: i32,
    y: i32,
}

pub struct EnemySpawn {
    pub enemy: u8, // index into Defs::enemies, resolved by Sim::new
    pub x: i32,    // pixel position, screen space
    pub y: i32,
}

pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub tiles: Vec<u16>,
    pub spawns: Vec<EnemySpawn>,
}

#[derive(Clone, Copy)]
pub struct Spawn {
    pub sx: i32,
    pub sy: i32,
    pub x: i32,
    pub y: i32,
}

/// Sprite-sheet indices the sim looks up by name at load time.
pub struct SpriteIds {
    pub player_down: u16,
    pub player_up: u16,
    pub player_side: u16,
    pub sword_down: u16,
    pub sword_up: u16,
    pub sword_side: u16,
    pub seed: u16,
    pub heart_drop: u16,
    pub shell_drop: u16,
    pub bomb: u16,
    pub blast: u16,
    pub arrow_h: u16,
    pub arrow_v: u16,
}

pub struct World {
    pub tile_solid: Vec<bool>,
    pub screens: Vec<Screen>,
    index: BTreeMap<(i32, i32), usize>,
    pub spawn: Spawn,
    pub sprites: SpriteIds,
    font: BTreeMap<char, u16>,
}

impl World {
    /// Builds the world; `resolve_enemy` maps map-file enemy names to def
    /// indexes (the defs are parsed before the world).
    pub fn build(
        raw: WorldJson,
        resolve_enemy: &dyn Fn(&str) -> Result<u8, String>,
    ) -> Result<World, String> {
        let find = |name: &str| -> Result<u16, String> {
            sprite_index(&raw.sprite_names, name)
        };
        let sprites = SpriteIds {
            player_down: find("player_down_0")?,
            player_up: find("player_up_0")?,
            player_side: find("player_side_0")?,
            sword_down: find("sword_down")?,
            sword_up: find("sword_up")?,
            sword_side: find("sword_side")?,
            seed: find("seed")?,
            heart_drop: find("heart_drop")?,
            shell_drop: find("shell_drop")?,
            bomb: find("itm_bomb")?,
            blast: find("blast_0")?,
            arrow_h: find("arrow_h")?,
            arrow_v: find("arrow_v")?,
        };

        let font = raw
            .font_chars
            .chars()
            .enumerate()
            .map(|(i, c)| (c, i as u16))
            .collect();

        let mut screens = Vec::with_capacity(raw.screens.len());
        let mut index = BTreeMap::new();
        for s in raw.screens {
            if s.tiles.len() != (SCREEN_COLS * SCREEN_ROWS) as usize {
                return Err(format!("screen {},{} has {} tiles", s.x, s.y, s.tiles.len()));
            }
            let spawns = s
                .entities
                .iter()
                .map(|e| {
                    Ok(EnemySpawn {
                        enemy: resolve_enemy(&e.t)?,
                        x: e.tx * 16,
                        y: HUD_H + e.ty * 16,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            index.insert((s.x, s.y), screens.len());
            screens.push(Screen {
                x: s.x,
                y: s.y,
                tiles: s.tiles,
                spawns,
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
            font,
        })
    }

    pub fn screen_at(&self, sx: i32, sy: i32) -> Option<&Screen> {
        self.index.get(&(sx, sy)).map(|&i| &self.screens[i])
    }

    pub fn glyph(&self, c: char) -> Option<u16> {
        self.font.get(&c.to_ascii_uppercase()).copied()
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

pub fn sprite_index(names: &[String], name: &str) -> Result<u16, String> {
    names
        .iter()
        .position(|n| n == name)
        .map(|i| i as u16)
        .ok_or_else(|| format!("unknown sprite '{name}'"))
}
