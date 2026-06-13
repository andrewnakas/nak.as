//! Typed content definitions parsed from the JSON bundle: items, enemies,
//! drop tables. Hand-edited JSON lives in game/assets/content/; names are
//! resolved to indexes here, once, at load.

use crate::fixed::Fx;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
pub struct ItemJson {
    pub name: String,
    /// Display name in the inventory UI (uppercase GBC style).
    pub label: String,
    pub sprite: String,
    pub kind: String,
    #[serde(default)]
    pub damage: i16,
    #[serde(default)]
    pub durability: u16,
    #[serde(default)]
    pub fuse_damage: i16,
    #[serde(default)]
    pub fuse_effect: String,
    /// HP restored when eaten (2 = one heart).
    #[serde(default)]
    pub heal: i16,
}

#[derive(Deserialize)]
pub struct EnemyJson {
    pub name: String,
    pub brain: String,
    pub hp: i16,
    pub damage: i16,
    /// 1/256 px per tick.
    pub speed: i32,
    pub sprite: String,
    pub drops: String,
    /// Hunting XP granted to the killer (critters).
    #[serde(default)]
    pub hunt_xp: u32,
}

#[derive(Deserialize)]
pub struct DropJson {
    pub item: String,
    pub p: u32, // permille
    #[serde(default = "one")]
    pub min: u32,
    #[serde(default = "one")]
    pub max: u32,
}

fn one() -> u32 {
    1
}

#[derive(Clone, Copy, PartialEq)]
pub enum Brain {
    Thornling,
    Crab,
    Gel,
    Wasp,
    Snatcher,
    /// Harmless prey: wanders, flees when approached. Hunting XP on kill.
    Critter,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Sword,
    Bow,
    Shield,
    Bomb,
    Arrow,
    Material,
    Rod,
    Food,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FuseEffect {
    None,
    Poison,
}

pub struct ItemDef {
    pub name: String,
    pub label: String,
    pub sprite: u16,
    pub kind: ItemKind,
    pub damage: i16,
    pub durability: u16,
    pub fuse_damage: i16,
    pub fuse_effect: FuseEffect,
    pub heal: i16,
}

impl ItemDef {
    pub fn is_weapon(&self) -> bool {
        matches!(self.kind, ItemKind::Sword | ItemKind::Bow | ItemKind::Shield)
    }

    pub fn stackable(&self) -> bool {
        matches!(
            self.kind,
            ItemKind::Bomb | ItemKind::Arrow | ItemKind::Material | ItemKind::Food
        )
    }
}

pub struct EnemyDef {
    pub name: String,
    pub brain: Brain,
    pub hp: i16,
    pub damage: i16,
    pub speed: Fx,
    pub sprite: u16,
    pub drop_table: usize,
    pub hunt_xp: u32,
}

#[derive(Clone, Copy)]
pub enum DropItem {
    Heart,
    Shells,
    Item(u8),
}

#[derive(Clone, Copy)]
pub struct DropEntry {
    pub item: DropItem,
    pub permille: u32,
    pub min: u32,
    pub max: u32,
}

// ---- skills ----

pub const SKILL_FISHING: usize = 0;
pub const SKILL_COOKING: usize = 1;
pub const SKILL_HUNTING: usize = 2;
pub const SKILL_NAMES: [&str; 3] = ["FISHING", "COOKING", "HUNTING"];

#[derive(Deserialize, Clone, Copy)]
pub struct SkillCurve {
    pub base: u32,
    pub growth: u32,
    pub max_level: u32,
}

impl SkillCurve {
    /// Total XP required to reach `level` (level 1 = 0 XP).
    pub fn xp_for_level(&self, level: u32) -> u32 {
        let n = level.saturating_sub(1);
        self.base * n + self.growth * n.saturating_mul(n.saturating_sub(1)) / 2
    }

    pub fn level_for_xp(&self, xp: u32) -> u32 {
        let mut level = 1;
        while level < self.max_level && xp >= self.xp_for_level(level + 1) {
            level += 1;
        }
        level
    }
}

#[derive(Deserialize)]
pub struct FishJson {
    pub item: String,
    pub min_level: u32,
    pub weight: u32,
    pub xp: u32,
}

#[derive(Deserialize)]
pub struct SkillsJson {
    pub curve: SkillCurve,
    pub fishing: Vec<FishJson>,
}

#[derive(Clone, Copy)]
pub struct FishEntry {
    pub item: u8,
    pub min_level: u32,
    pub weight: u32,
    pub xp: u32,
}

#[derive(Deserialize)]
pub struct RecipeJson {
    pub output: String,
    pub inputs: Vec<String>,
    pub level: u32,
    pub xp: u32,
}

pub struct Recipe {
    pub output: u8,
    pub inputs: Vec<u8>,
    pub level: u32,
    pub xp: u32,
}

pub struct Defs {
    pub items: Vec<ItemDef>,
    pub enemies: Vec<EnemyDef>,
    pub drop_tables: Vec<Vec<DropEntry>>,
    pub curve: SkillCurve,
    pub fishing: Vec<FishEntry>,
    pub recipes: Vec<Recipe>,
}

impl Defs {
    pub fn build(
        items: Vec<ItemJson>,
        enemies: Vec<EnemyJson>,
        drops: BTreeMap<String, Vec<DropJson>>,
        skills: SkillsJson,
        recipes: Vec<RecipeJson>,
        sprite_index: &dyn Fn(&str) -> Result<u16, String>,
    ) -> Result<Defs, String> {
        let item_index: BTreeMap<&str, u8> = items
            .iter()
            .enumerate()
            .map(|(i, it)| (it.name.as_str(), i as u8))
            .collect();

        let mut drop_tables = Vec::new();
        let mut drop_names = Vec::new();
        for (name, entries) in &drops {
            let mut table = Vec::new();
            for e in entries {
                let item = match e.item.as_str() {
                    "heart" => DropItem::Heart,
                    "shells" => DropItem::Shells,
                    other => DropItem::Item(
                        *item_index
                            .get(other)
                            .ok_or_else(|| format!("drop table '{name}': unknown item '{other}'"))?,
                    ),
                };
                if e.min > e.max {
                    return Err(format!("drop table '{name}': min > max"));
                }
                table.push(DropEntry {
                    item,
                    permille: e.p,
                    min: e.min,
                    max: e.max,
                });
            }
            drop_names.push(name.clone());
            drop_tables.push(table);
        }

        let enemies = enemies
            .into_iter()
            .map(|e| {
                let brain = match e.brain.as_str() {
                    "thornling" => Brain::Thornling,
                    "crab" => Brain::Crab,
                    "gel" => Brain::Gel,
                    "wasp" => Brain::Wasp,
                    "snatcher" => Brain::Snatcher,
                    "critter" => Brain::Critter,
                    other => return Err(format!("enemy '{}': unknown brain '{other}'", e.name)),
                };
                let drop_table = drop_names
                    .iter()
                    .position(|n| *n == e.drops)
                    .ok_or_else(|| format!("enemy '{}': unknown drop table '{}'", e.name, e.drops))?;
                Ok(EnemyDef {
                    brain,
                    hp: e.hp,
                    damage: e.damage,
                    speed: e.speed,
                    sprite: sprite_index(&e.sprite)?,
                    drop_table,
                    hunt_xp: e.hunt_xp,
                    name: e.name,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        let items = items
            .into_iter()
            .map(|it| {
                let kind = match it.kind.as_str() {
                    "sword" => ItemKind::Sword,
                    "bow" => ItemKind::Bow,
                    "shield" => ItemKind::Shield,
                    "bomb" => ItemKind::Bomb,
                    "arrow" => ItemKind::Arrow,
                    "material" => ItemKind::Material,
                    "rod" => ItemKind::Rod,
                    "food" => ItemKind::Food,
                    other => return Err(format!("item '{}': unknown kind '{other}'", it.name)),
                };
                let fuse_effect = match it.fuse_effect.as_str() {
                    "" | "none" => FuseEffect::None,
                    "poison" => FuseEffect::Poison,
                    other => return Err(format!("item '{}': unknown effect '{other}'", it.name)),
                };
                Ok(ItemDef {
                    sprite: sprite_index(&it.sprite)?,
                    kind,
                    damage: it.damage,
                    durability: it.durability,
                    fuse_damage: it.fuse_damage,
                    fuse_effect,
                    heal: it.heal,
                    label: it.label,
                    name: it.name,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        // item_index borrowed the consumed ItemJson vec; re-derive from defs.
        let final_index: BTreeMap<&str, u8> = items
            .iter()
            .enumerate()
            .map(|(i, it)| (it.name.as_str(), i as u8))
            .collect();
        let lookup = |name: &str| -> Result<u8, String> {
            final_index
                .get(name)
                .copied()
                .ok_or_else(|| format!("unknown item '{name}'"))
        };
        let fishing = skills
            .fishing
            .iter()
            .map(|f| {
                Ok(FishEntry {
                    item: lookup(&f.item)?,
                    min_level: f.min_level,
                    weight: f.weight,
                    xp: f.xp,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let recipes = recipes
            .iter()
            .map(|r| {
                Ok(Recipe {
                    output: lookup(&r.output)?,
                    inputs: r.inputs.iter().map(|i| lookup(i)).collect::<Result<_, _>>()?,
                    level: r.level,
                    xp: r.xp,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        Ok(Defs {
            items,
            enemies,
            drop_tables,
            curve: skills.curve,
            fishing,
            recipes,
        })
    }

    pub fn enemy_index(&self, name: &str) -> Option<u8> {
        self.enemies
            .iter()
            .position(|e| e.name == name)
            .map(|i| i as u8)
    }

    pub fn item_index(&self, name: &str) -> Option<u8> {
        self.items
            .iter()
            .position(|i| i.name == name)
            .map(|i| i as u8)
    }
}
