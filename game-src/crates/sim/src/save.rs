//! Character save files. Items/quests are stored by NAME, not index, so
//! saves survive content reordering; unknown names are dropped on load.
//! The schema_version migration chain lives here (single source of truth
//! for both client load and any future tooling).

use crate::defs::Defs;
use crate::{ItemStack, Player, PlayerQuest};
use serde::{Deserialize, Serialize};

pub const SAVE_SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct SaveData {
    pub schema_version: u32,
    pub sx: i32,
    pub sy: i32,
    pub x: i32,
    pub y: i32,
    pub hp: i16,
    pub max_hp: i16,
    pub shells: u32,
    pub inventory: Vec<SaveItem>,
    pub equip_a: i8,
    pub equip_b: i8,
    pub skills: [u32; 3],
    pub quests: Vec<SaveQuest>,
}

#[derive(Serialize, Deserialize)]
pub struct SaveItem {
    pub item: String,
    pub qty: u16,
    pub durability: u16,
    pub fused: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct SaveQuest {
    pub id: String,
    pub done: bool,
    pub progress: Vec<u32>,
}

pub fn export(defs: &Defs, p: &Player) -> String {
    let data = SaveData {
        schema_version: SAVE_SCHEMA_VERSION,
        sx: p.sx,
        sy: p.sy,
        x: crate::fixed::to_px(p.x),
        y: crate::fixed::to_px(p.y),
        hp: p.hp,
        max_hp: p.max_hp,
        shells: p.shells,
        inventory: p
            .inventory
            .iter()
            .map(|s| SaveItem {
                item: defs.items[s.def as usize].name.clone(),
                qty: s.qty,
                durability: s.durability,
                fused: s.fused.map(|f| defs.items[f as usize].name.clone()),
            })
            .collect(),
        equip_a: p.equip_a,
        equip_b: p.equip_b,
        skills: p.skills,
        quests: p
            .quests
            .iter()
            .map(|pq| SaveQuest {
                id: defs.quests[pq.quest as usize].id.clone(),
                done: pq.done,
                progress: pq.progress.clone(),
            })
            .collect(),
    };
    serde_json::to_string(&data).unwrap_or_else(|_| "null".to_string())
}

/// Migrate any known older schema up to the current one. Returns the JSON
/// unchanged for current saves, None for unparseable/unknown input.
pub fn migrate(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    match v.get("schema_version")?.as_u64()? {
        x if x == SAVE_SCHEMA_VERSION as u64 => Some(json.to_string()),
        // Future: 1 -> 2 migrations chain here.
        _ => None,
    }
}

/// Apply a save to a freshly-added player. Tolerant: unknown items/quests
/// are skipped, positions are clamped by the caller's add_player logic.
pub fn apply(defs: &Defs, p: &mut Player, json: &str) -> bool {
    let Some(json) = migrate(json) else {
        return false;
    };
    let Ok(data) = serde_json::from_str::<SaveData>(&json) else {
        return false;
    };

    p.max_hp = data.max_hp.clamp(2, 40);
    p.hp = data.hp.clamp(1, p.max_hp);
    p.shells = data.shells;
    p.skills = data.skills;

    p.inventory.clear();
    for s in data.inventory.iter().take(crate::INVENTORY_CAP) {
        let Some(def) = defs.item_index(&s.item) else {
            continue;
        };
        p.inventory.push(ItemStack {
            def,
            qty: s.qty.max(1).min(crate::STACK_CAP),
            durability: s.durability,
            fused: s.fused.as_deref().and_then(|f| defs.item_index(f)),
        });
    }
    let valid_equip = |e: i8| e >= 0 && (e as usize) < p.inventory.len();
    p.equip_a = if valid_equip(data.equip_a) { data.equip_a } else { -1 };
    p.equip_b = if valid_equip(data.equip_b) { data.equip_b } else { -1 };

    p.quests = data
        .quests
        .iter()
        .filter_map(|sq| {
            let quest = defs
                .quests
                .iter()
                .position(|q| q.id == sq.id)? as u8;
            let n_obj = defs.quests[quest as usize].objectives.len();
            let mut progress = sq.progress.clone();
            progress.resize(n_obj, 0);
            Some(PlayerQuest {
                quest,
                done: sq.done,
                progress,
            })
        })
        .collect();

    // Position: trust it if the screen exists; otherwise spawn point.
    (data.sx, data.sy, data.x, data.y) != (0, 0, 0, 0)
        && set_position(p, data.sx, data.sy, data.x, data.y)
}

fn set_position(p: &mut Player, sx: i32, sy: i32, x: i32, y: i32) -> bool {
    p.sx = sx;
    p.sy = sy;
    p.x = crate::fixed::fx(x.clamp(0, 144));
    p.y = crate::fixed::fx(y.clamp(16, 128));
    true
}
