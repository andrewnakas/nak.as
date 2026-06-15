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
    /// Body-part attach effect: "" / "damage" / "speed" / "defense".
    #[serde(default)]
    pub attach_effect: String,
    /// Magnitude of the attach effect (damage points, speed 1/256 px/tick,
    /// or defense points subtracted from incoming hits).
    #[serde(default)]
    pub attach_mag: i16,
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
    /// Character (combat) XP granted to the killer.
    #[serde(default)]
    pub combat_xp: u32,
    /// 32x32 rendering + hitbox (boss).
    #[serde(default)]
    pub big: bool,
    /// Enemy name this one periodically summons (boss adds).
    #[serde(default)]
    pub summons: String,
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
    /// Moldra: stalks, spits seed spreads, summons; enrages at half HP.
    Boss,
    /// Brackling: easy goblin fodder that chases and swings at close range.
    Brackling,
    /// Brackling archer: keeps its distance and lobs seed shots.
    BracklingArcher,
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
    /// Swappable mod attached to gear (horn/wing/claw). Non-destructive.
    BodyPart,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FuseEffect {
    None,
    Poison,
    /// Fire-fused weapons clear bramble tiles.
    Fire,
}

/// What attaching a body part to gear does. Attachments are reversible
/// loadout tuning, distinct from permanent crafting/fusion.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AttachEffect {
    None,
    /// Bonus weapon damage (claw/fang).
    Damage,
    /// Bonus move speed in 1/256 px/tick (wing).
    Speed,
    /// Damage subtracted from incoming hits (horn/shell).
    Defense,
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
    pub attach_effect: AttachEffect,
    pub attach_mag: i16,
}

impl ItemDef {
    pub fn is_weapon(&self) -> bool {
        matches!(self.kind, ItemKind::Sword | ItemKind::Bow | ItemKind::Shield)
    }

    /// Gear that a body part can attach to. Weapons and the shield only —
    /// rods (fishing rod / surfboard) are utility items, not stat carriers.
    pub fn is_attachable(&self) -> bool {
        matches!(
            self.kind,
            ItemKind::Sword | ItemKind::Bow | ItemKind::Shield
        )
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
    pub combat_xp: u32,
    pub big: bool,
    pub summons: Option<u8>,
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

// ---- NPCs & quests ----

#[derive(Deserialize)]
pub struct NpcJson {
    pub name: String,
    pub label: String,
    pub sprite: String,
    /// Idle dialogue: one entry per page, each page up to 3 lines of 18 chars.
    pub lines: Vec<Vec<String>>,
    /// If non-empty, this NPC is a vendor selling these (item name, price).
    #[serde(default)]
    pub shop: Vec<ShopEntryJson>,
    /// Weaponsmith: can repair worn gear for shells.
    #[serde(default)]
    pub smith: bool,
}

fn one_u16() -> u16 {
    1
}

#[derive(Deserialize)]
pub struct ShopEntryJson {
    pub item: String,
    pub price: u32,
    #[serde(default = "one_u16")]
    pub qty: u16,
}

pub struct ShopEntry {
    pub item: u8,
    pub price: u32,
    pub qty: u16,
}

pub struct NpcDef {
    pub name: String,
    pub label: String,
    pub sprite: u16,
    pub lines: Vec<Vec<String>>,
    pub shop: Vec<ShopEntry>,
    pub smith: bool,
}

#[derive(Deserialize)]
pub struct QuestJson {
    pub id: String,
    pub giver: String,
    #[serde(default)]
    pub requires: Option<String>,
    pub title: String,
    pub offer: Vec<Vec<String>>,
    pub incomplete: Vec<Vec<String>>,
    pub complete: Vec<Vec<String>>,
    pub objectives: Vec<ObjectiveJson>,
    pub rewards: RewardsJson,
}

#[derive(Deserialize)]
pub struct ObjectiveJson {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub target: String,
    #[serde(default = "one")]
    pub count: u32,
}

#[derive(Deserialize, Default)]
pub struct RewardsJson {
    #[serde(default)]
    pub shells: u32,
    #[serde(default)]
    pub items: Vec<RewardItemJson>,
}

#[derive(Deserialize)]
pub struct RewardItemJson {
    pub item: String,
    #[serde(default = "one")]
    pub qty: u32,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Objective {
    /// Kill `count` of enemy def.
    Kill { enemy: u8, count: u32 },
    /// Hold `count` of item def at turn-in (consumed).
    Collect { item: u8, count: u32 },
    Cook { count: u32 },
    Fuse { count: u32 },
    Fish { count: u32 },
}

pub struct QuestDef {
    pub id: String,
    pub giver: u8,
    pub requires: Option<u8>,
    pub title: String,
    pub offer: Vec<Vec<String>>,
    pub incomplete: Vec<Vec<String>>,
    pub complete: Vec<Vec<String>>,
    pub objectives: Vec<Objective>,
    pub reward_shells: u32,
    pub reward_items: Vec<(u8, u32)>,
}

pub struct Defs {
    pub items: Vec<ItemDef>,
    pub enemies: Vec<EnemyDef>,
    pub drop_tables: Vec<Vec<DropEntry>>,
    pub curve: SkillCurve,
    pub fishing: Vec<FishEntry>,
    pub recipes: Vec<Recipe>,
    pub npcs: Vec<NpcDef>,
    pub quests: Vec<QuestDef>,
}

impl Defs {
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        items: Vec<ItemJson>,
        enemies: Vec<EnemyJson>,
        drops: BTreeMap<String, Vec<DropJson>>,
        skills: SkillsJson,
        recipes: Vec<RecipeJson>,
        npcs: Vec<NpcJson>,
        quests: Vec<QuestJson>,
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

        let enemy_names: Vec<String> = enemies.iter().map(|e| e.name.clone()).collect();
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
                    "boss" => Brain::Boss,
                    "brackling" => Brain::Brackling,
                    "brackling_archer" => Brain::BracklingArcher,
                    other => return Err(format!("enemy '{}': unknown brain '{other}'", e.name)),
                };
                let drop_table = drop_names
                    .iter()
                    .position(|n| *n == e.drops)
                    .ok_or_else(|| format!("enemy '{}': unknown drop table '{}'", e.name, e.drops))?;
                let summons = if e.summons.is_empty() {
                    None
                } else {
                    Some(
                        enemy_names
                            .iter()
                            .position(|n| *n == e.summons)
                            .map(|i| i as u8)
                            .ok_or_else(|| {
                                format!("enemy '{}': unknown summons '{}'", e.name, e.summons)
                            })?,
                    )
                };
                Ok(EnemyDef {
                    brain,
                    hp: e.hp,
                    // Non-boss enemies are eased globally: slower and gentler so
                    // the early game is forgiving. Bosses keep their authored
                    // numbers. (Speed ×0.7, damage capped at 1.)
                    damage: if matches!(brain, Brain::Boss) {
                        e.damage
                    } else {
                        e.damage.min(1)
                    },
                    speed: if matches!(brain, Brain::Boss) {
                        e.speed
                    } else {
                        e.speed * 7 / 10
                    },
                    sprite: sprite_index(&e.sprite)?,
                    drop_table,
                    hunt_xp: e.hunt_xp,
                    combat_xp: e.combat_xp,
                    big: e.big,
                    summons,
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
                    "bodypart" => ItemKind::BodyPart,
                    other => return Err(format!("item '{}': unknown kind '{other}'", it.name)),
                };
                let fuse_effect = match it.fuse_effect.as_str() {
                    "" | "none" => FuseEffect::None,
                    "poison" => FuseEffect::Poison,
                    "fire" => FuseEffect::Fire,
                    other => return Err(format!("item '{}': unknown effect '{other}'", it.name)),
                };
                let attach_effect = match it.attach_effect.as_str() {
                    "" | "none" => AttachEffect::None,
                    "damage" => AttachEffect::Damage,
                    "speed" => AttachEffect::Speed,
                    "defense" => AttachEffect::Defense,
                    other => {
                        return Err(format!("item '{}': unknown attach effect '{other}'", it.name))
                    }
                };
                Ok(ItemDef {
                    sprite: sprite_index(&it.sprite)?,
                    kind,
                    damage: it.damage,
                    durability: it.durability,
                    fuse_damage: it.fuse_damage,
                    fuse_effect,
                    heal: it.heal,
                    attach_effect,
                    attach_mag: it.attach_mag,
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

        let npcs = npcs
            .into_iter()
            .map(|n| {
                let shop = n
                    .shop
                    .iter()
                    .map(|e| {
                        Ok(ShopEntry {
                            item: lookup(&e.item)?,
                            price: e.price,
                            qty: e.qty,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(NpcDef {
                    sprite: sprite_index(&n.sprite)?,
                    name: n.name,
                    label: n.label,
                    lines: n.lines,
                    shop,
                    smith: n.smith,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        let npc_index = |name: &str| -> Result<u8, String> {
            npcs.iter()
                .position(|n| n.name == name)
                .map(|i| i as u8)
                .ok_or_else(|| format!("unknown npc '{name}'"))
        };
        let enemy_lookup = |name: &str| -> Result<u8, String> {
            enemies
                .iter()
                .position(|e| e.name == name)
                .map(|i| i as u8)
                .ok_or_else(|| format!("unknown enemy '{name}'"))
        };
        let quest_ids: Vec<String> = quests.iter().map(|q| q.id.clone()).collect();
        let quests = quests
            .into_iter()
            .map(|q| {
                let objectives = q
                    .objectives
                    .iter()
                    .map(|o| {
                        Ok(match o.kind.as_str() {
                            "kill" => Objective::Kill {
                                enemy: enemy_lookup(&o.target)?,
                                count: o.count,
                            },
                            "collect" => Objective::Collect {
                                item: lookup(&o.target)?,
                                count: o.count,
                            },
                            "cook" => Objective::Cook { count: o.count },
                            "fuse" => Objective::Fuse { count: o.count },
                            "fish" => Objective::Fish { count: o.count },
                            other => {
                                return Err(format!(
                                    "quest '{}': unknown objective '{other}'",
                                    q.id
                                ))
                            }
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let requires = match &q.requires {
                    None => None,
                    Some(id) => Some(
                        quest_ids
                            .iter()
                            .position(|i| i == id)
                            .map(|i| i as u8)
                            .ok_or_else(|| format!("quest '{}': unknown requires '{id}'", q.id))?,
                    ),
                };
                Ok(QuestDef {
                    giver: npc_index(&q.giver)?,
                    requires,
                    objectives,
                    reward_shells: q.rewards.shells,
                    reward_items: q
                        .rewards
                        .items
                        .iter()
                        .map(|r| Ok((lookup(&r.item)?, r.qty)))
                        .collect::<Result<Vec<_>, String>>()?,
                    id: q.id,
                    title: q.title,
                    offer: q.offer,
                    incomplete: q.incomplete,
                    complete: q.complete,
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
            npcs,
            quests,
        })
    }

    pub fn npc_def_index(&self, name: &str) -> Option<u8> {
        self.npcs
            .iter()
            .position(|n| n.name == name)
            .map(|i| i as u8)
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
