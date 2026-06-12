//! Client-side snapshot buffer. Clients run no simulation: they store the
//! host's snapshots stamped with local receive time and render an
//! interpolated view ~120 ms in the past, so movement is smooth between
//! 20 Hz snapshots. Integer math throughout (times are whole milliseconds).

use crate::{Player, Transition, MAX_PLAYERS};
use protocol::{PlayerSnap, SnapshotData};

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

    /// Reconstruct the player array as of (now - delay), lerping between the
    /// two snapshots that bracket the target time.
    pub fn sample(&self, now_ms: u64) -> [Option<Player>; MAX_PLAYERS] {
        let mut out: [Option<Player>; MAX_PLAYERS] = [None, None, None, None];
        let (Some(first), Some(last)) = (self.snaps.first(), self.snaps.last()) else {
            return out;
        };

        let target = now_ms.saturating_sub(RENDER_DELAY_MS).clamp(first.0, last.0);
        let idx = self
            .snaps
            .partition_point(|(t, _)| *t <= target)
            .saturating_sub(1);
        let (t0, a) = &self.snaps[idx];
        let (t1, b) = self.snaps.get(idx + 1).map_or((t0, a), |(t, s)| (t, s));

        let span = t1.saturating_sub(*t0);
        let frac_num = target.saturating_sub(*t0).min(span);

        for pb in &b.players {
            let slot = pb.slot as usize;
            if slot >= MAX_PLAYERS {
                continue;
            }
            let pa = a.players.iter().find(|p| p.slot == pb.slot);
            out[slot] = Some(lerp_player(pa, pb, frac_num, span));
        }
        out
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
        transition,
    }
}
