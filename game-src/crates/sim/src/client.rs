//! Client-side snapshot buffer. Clients run no simulation: they store the
//! host's snapshots stamped with local receive time and render an
//! interpolated view ~120 ms in the past, so movement is smooth between
//! 20 Hz snapshots. Integer math throughout (times are whole milliseconds).

use crate::entity::Entity;
use crate::{ItemStack, Player, Transition, MAX_PLAYERS};
use protocol::{EntitySnap, PlayerSnap, SnapshotData};

/// How far behind the freshest snapshot we render.
const RENDER_DELAY_MS: u64 = 120;
const BUFFER_CAP: usize = 16;

pub struct ClientView {
    /// (local receive time ms, snapshot), newest last.
    snaps: Vec<(u64, SnapshotData)>,
}

impl ClientView {
    pub fn new() -> Self {
        ClientView { snaps: Vec::new() }
    }

    pub fn push(&mut self, now_ms: u64, snap: SnapshotData) {
        // Drop out-of-order arrivals (unreliable channel may reorder).
        if let Some((_, last)) = self.snaps.last() {
            if snap.tick <= last.tick {
                return;
            }
        }
        self.snaps.push((now_ms, snap));
        if self.snaps.len() > BUFFER_CAP {
            self.snaps.remove(0);
        }
    }

    pub fn latest_tick(&self) -> u32 {
        self.snaps.last().map_or(0, |(_, s)| s.tick)
    }

    /// The slot player's current screen, from the freshest snapshot
    /// (used to filter sound cues client-side).
    pub fn player_screen(&self, slot: u8) -> Option<(i32, i32)> {
        self.snaps
            .last()
            .and_then(|(_, s)| s.players.iter().find(|p| p.slot == slot))
            .map(|p| (p.sx, p.sy))
    }

    /// Latest known player state for the UI overlay (uninterpolated).
    pub fn latest_player(&self, slot: u8) -> Option<Player> {
        self.snaps
            .last()
            .and_then(|(_, s)| s.players.iter().find(|p| p.slot == slot))
            .map(|p| lerp_player(None, p, 0, 0))
    }

    /// All players in the freshest snapshot as (slot, sx, sy, x, y) — used by
    /// proximity voice to place each peer's audio relative to the listener.
    pub fn latest_player_positions(&self) -> Vec<(u8, i32, i32, i32, i32)> {
        self.snaps
            .last()
            .map(|(_, s)| s.players.iter().map(|p| (p.slot, p.sx, p.sy, p.x, p.y)).collect())
            .unwrap_or_default()
    }

    /// Vendor NPC the slot player can shop with (snapshot position + static
    /// world/defs the client already has).
    pub fn vendor_here(&self, sim: &crate::Sim, slot: u8) -> i32 {
        match self.latest_player(slot) {
            Some(p) => sim.vendor_here_for(&p),
            None => -1,
        }
    }

    pub fn shop_json(&self, sim: &crate::Sim, slot: u8, npc: u8) -> String {
        match self.latest_player(slot) {
            Some(p) => sim.shop_json_for(&p, npc),
            None => "null".to_string(),
        }
    }

    pub fn smith_here(&self, sim: &crate::Sim, slot: u8) -> i32 {
        match self.latest_player(slot) {
            Some(p) => sim.smith_here_for(&p),
            None => -1,
        }
    }

    pub fn price_json(&self, sim: &crate::Sim, slot: u8) -> String {
        match self.latest_player(slot) {
            Some(p) => sim.price_json_for(&p),
            None => "[]".to_string(),
        }
    }

    /// near_fire from the freshest snapshot (not derivable from Player).
    pub fn latest_near_fire(&self, slot: u8) -> bool {
        self.snaps
            .last()
            .and_then(|(_, s)| s.players.iter().find(|p| p.slot == slot))
            .is_some_and(|p| p.near_fire)
    }

    pub fn latest_fishing(&self, slot: u8) -> Option<u8> {
        self.snaps
            .last()
            .and_then(|(_, s)| s.players.iter().find(|p| p.slot == slot))
            .and_then(|p| p.fishing)
    }

    /// Effective tiles from the freshest snapshot, keyed for the renderer:
    /// reversible (plate/water state) layered OVER one-way overrides, matching
    /// the host's `effective_tile`. The renderer paints whatever this returns.
    pub fn overrides(&self) -> std::collections::BTreeMap<(i32, i32, i32), u16> {
        self.snaps
            .last()
            .map(|(_, s)| {
                let mut m: std::collections::BTreeMap<(i32, i32, i32), u16> = s
                    .overrides
                    .iter()
                    .map(|&(sx, sy, idx, t)| ((sx, sy, idx), t))
                    .collect();
                for &(sx, sy, idx, t) in &s.reversible {
                    m.insert((sx, sy, idx), t);
                }
                m
            })
            .unwrap_or_default()
    }

    /// Reversible plate/water tiles from the freshest snapshot (the subset that
    /// recloses each tick), keyed for callers that need just that layer.
    pub fn reversible(&self) -> std::collections::BTreeMap<(i32, i32, i32), u16> {
        self.snaps
            .last()
            .map(|(_, s)| {
                s.reversible
                    .iter()
                    .map(|&(sx, sy, idx, t)| ((sx, sy, idx), t))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Reconstruct players + entities as of (now - delay), lerping between
    /// the two snapshots that bracket the target time.
    pub fn sample(&self, now_ms: u64) -> ([Option<Player>; MAX_PLAYERS], Vec<Entity>) {
        let mut players: [Option<Player>; MAX_PLAYERS] = std::array::from_fn(|_| None);
        let (Some(first), Some(last)) = (self.snaps.first(), self.snaps.last()) else {
            return (players, Vec::new());
        };

        let target = now_ms.saturating_sub(RENDER_DELAY_MS).clamp(first.0, last.0);
        let idx = self
            .snaps
            .partition_point(|(t, _)| *t <= target)
            .saturating_sub(1);
        let (t0, a) = &self.snaps[idx];
        let (t1, b) = self.snaps.get(idx + 1).map_or((t0, a), |(t, s)| (t, s));

        let span = t1.saturating_sub(*t0);
        let num = target.saturating_sub(*t0).min(span);

        for pb in &b.players {
            let slot = pb.slot as usize;
            if slot >= MAX_PLAYERS {
                continue;
            }
            let pa = a.players.iter().find(|p| p.slot == pb.slot);
            players[slot] = Some(lerp_player(pa, pb, num, span));
        }

        let entities = b
            .entities
            .iter()
            .map(|eb| {
                let ea = a.entities.iter().find(|e| e.id == eb.id);
                lerp_entity(ea, eb, num, span)
            })
            .collect();

        (players, entities)
    }
}

fn lerp_i32(a: i32, b: i32, num: u64, den: u64) -> i32 {
    if den == 0 {
        return b;
    }
    a + ((b - a) as i64 * num as i64 / den as i64) as i32
}

fn lerp_player(pa: Option<&PlayerSnap>, pb: &PlayerSnap, num: u64, den: u64) -> Player {
    // Only interpolate when both ends exist on the same screen and share
    // transition phase; otherwise snap to the newer state.
    let (x, y, transition) = match pa {
        Some(pa) if pa.sx == pb.sx && pa.sy == pb.sy => {
            let tr = match (pa.transition, pb.transition) {
                (Some((da, ta)), Some((db, tb))) if da == db => Some(Transition {
                    dir: db,
                    t: lerp_i32(ta as i32, tb as i32, num, den) as u32,
                }),
                (_, Some((d, t))) => Some(Transition { dir: d, t }),
                _ => None,
            };
            (
                lerp_i32(pa.x, pb.x, num, den),
                lerp_i32(pa.y, pb.y, num, den),
                tr,
            )
        }
        _ => (
            pb.x,
            pb.y,
            pb.transition.map(|(dir, t)| Transition { dir, t }),
        ),
    };

    Player {
        sx: pb.sx,
        sy: pb.sy,
        x,
        y,
        facing: pb.facing,
        walking: pb.walking,
        anim: pb.anim,
        buttons: 0,
        prev_buttons: 0,
        transition,
        hp: pb.hp,
        max_hp: pb.max_hp,
        shells: pb.shells,
        inventory: items_from_snaps(&pb.inventory),
        equip_a: pb.equip_a,
        equip_b: pb.equip_b,
        attack_t: pb.attack_t,
        unarmed: pb.unarmed,
        harvest_t: 0,
        shielding: pb.shielding,
        iframes: pb.iframes,
        kvx: 0,
        kvy: 0,
        dead_t: u32::from(pb.dead),
        skills: pb.skills,
        level: pb.level,
        xp: pb.xp,
        bonus_hp: 0, // remote players: max_hp comes straight from the snapshot
        fishing: pb.fishing.map(|f| {
            if f == 0 {
                crate::FishPhase::Cast { t: 1 }
            } else {
                crate::FishPhase::Bite { t: 1 }
            }
        }),
        dialogue: pb.dialogue.map(|(npc, kind, idx, page)| crate::Dialogue {
            npc,
            source: match kind {
                1 => crate::DialogueSource::QuestOffer(idx),
                2 => crate::DialogueSource::QuestIncomplete(idx),
                3 => crate::DialogueSource::QuestComplete(idx),
                _ => crate::DialogueSource::Idle(idx),
            },
            page,
        }),
        quests: pb
            .quests
            .iter()
            .map(|q| crate::PlayerQuest {
                quest: q.quest,
                done: q.done,
                progress: q.progress.clone(),
            })
            .collect(),
        intro_done: true, // remote players' intro state is irrelevant locally
        surfing: pb.surfing,
        wave_boost: 0, // local-only timer; not needed for rendering
        climbing: false, // anim/flavor only; recomputed locally each step
        slide_dir: -1, // sim-local; remote players render from interpolated x/y
        shield_t: 0, // sim-local; parry timing is host-authoritative
        push_t: 0, // sim-local; block-push cadence is host-authoritative
    }
}

fn items_from_snaps(snaps: &[protocol::ItemSnap]) -> Vec<ItemStack> {
    snaps
        .iter()
        .map(|s| ItemStack {
            def: s.def,
            qty: s.qty,
            durability: s.durability,
            fused: u8::try_from(s.fused).ok(),
            attached: u8::try_from(s.attached).ok(),
        })
        .collect()
}

fn lerp_entity(ea: Option<&EntitySnap>, eb: &EntitySnap, num: u64, den: u64) -> Entity {
    let (x, y) = match ea {
        Some(ea) if ea.sx == eb.sx && ea.sy == eb.sy => (
            lerp_i32(ea.x, eb.x, num, den),
            lerp_i32(ea.y, eb.y, num, den),
        ),
        _ => (eb.x, eb.y),
    };
    Entity {
        id: eb.id,
        etype: eb.etype,
        def: eb.def,
        data: eb.data,
        sx: eb.sx,
        sy: eb.sy,
        x,
        y,
        vx: 0,
        vy: 0,
        hp: 1,
        facing: eb.facing,
        state: 0,
        state_t: 0,
        anim: eb.anim,
        iframes: u8::from(eb.flash),
        home: (eb.sx, eb.sy),
        home_px: eb.x,
        home_py: eb.y,
        alive: true,
        owner: -1,
        poison_t: 0,
        big: eb.big,
    }
}
