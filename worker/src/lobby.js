// LobbyDO: the single global matchmaker. Clients ask for a world to join;
// the lobby hands back a world id (room code). It keeps a small list of live
// worlds and their last-known occupancy, filling world #1 until it's near
// capacity, then world #2, and so on. Worlds are RoomDO instances keyed by
// the id we return here.
//
// Occupancy is refreshed lazily by polling each candidate RoomDO's /count
// before assigning, so a world that emptied out gets reused.

const SOFT_CAP = 24; // primary target: fill a world's DIRECT tier, then prefer
// a new world (a new host = fresh low-latency capacity) so load spreads.
const HARD_FILL = 140; // once worlds are scarce (MAX_WORLDS reached), pack a
// world toward its relay-backed capacity (WORLD_CAP=150) before turning anyone
// away. Slightly under WORLD_CAP to leave headroom for the reservation race.
const MAX_WORLDS = 64; // safety ceiling on simultaneous worlds
// After a fresh world is assigned, route same-version joiners to it for this
// long even before its host's WebSocket has connected. Without this, a burst
// of simultaneous joiners each create their own empty world (the host hasn't
// connected yet, so occupancy reads 0) and the party fragments. The window
// covers the find→signaling→WebRTC-handshake latency.
const RESERVE_MS = 12000;

export class LobbyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/find')) {
      const exclude = url.searchParams.get('exclude');
      const version = url.searchParams.get('version') || 'v0';
      const world = await this.findWorld(exclude, version);
      return Response.json(world);
    }
    if (url.pathname.endsWith('/worlds')) {
      const worlds = (await this.state.storage.get('worlds')) ?? [];
      const live = await Promise.all(
        worlds.map((w) => this.status(w.id).then((s) => ({ id: w.id, version: w.version, ...s }))),
      );
      return Response.json({ worlds: live.filter((w) => w.count > 0) });
    }
    return new Response('not found', { status: 404 });
  }

  /// Ask a RoomDO for occupancy + whether it has a live host.
  async status(id) {
    try {
      const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(id));
      const r = await room.fetch('https://room/count');
      const { count, hasHost } = await r.json();
      return { count, hasHost: !!hasHost };
    } catch {
      return { count: 0, hasHost: false };
    }
  }

  /// Return { code } of a joinable world for the caller's build `version`,
  /// retiring a reported-dead one and creating a fresh world when needed. A
  /// world is joinable when it's empty (joiner hosts) or has a live host and
  /// is under the soft cap. Worlds carry their version so different builds
  /// never share a world (which would cause content-hash mismatches).
  async findWorld(exclude, version) {
    // worlds: [{ id, version, assignedAt }]  (DurableObject requests are
    // serialized, so this read-modify-write is race-free across joiners.)
    let worlds = (await this.state.storage.get('worlds')) ?? [];
    const now = Date.now();

    // Retire a reported-dead world.
    if (exclude) {
      worlds = worlds.filter((w) => w.id !== exclude);
      await this.state.storage.put('worlds', worlds);
    }

    const sameVersion = worlds.filter((w) => w.id !== exclude && w.version === version);

    // An optimistic occupancy estimate, used to keep the reservation race from
    // overfilling without a /count fetch per joiner. `pending` counts the
    // assignments we've handed out since the last real reconcile; `est()` is
    // max(lastCount, pending) — pending leads while hosts/WebRTC are still
    // connecting, lastCount corrects once /count is sampled. DO requests are
    // serialized, so these increments are race-free.
    const est = (w) => Math.max(w.lastCount || 0, w.pending || 0);
    const handOut = async (w) => {
      w.pending = (w.pending || 0) + 1;
      w.assignedAt = now;
      await this.state.storage.put('worlds', worlds);
      return { code: w.id };
    };

    // 1. A freshly-assigned same-version world still inside its reservation
    //    window AND below the soft cap by estimate: route here so a burst lands
    //    together instead of fragmenting. This pass is SYNCHRONOUS up to the one
    //    storage write (no /count fetch) — critical because a fetch is an async
    //    boundary where the DO interleaves the next queued request; an interleave
    //    here would let concurrent spillers each mint a duplicate world. Trusting
    //    `pending` inside the window keeps the burst funnel single-threaded.
    const reserved = sameVersion
      .filter((w) => now - (w.assignedAt || 0) < RESERVE_MS && est(w) < SOFT_CAP)
      .sort((a, b) => (a.assignedAt || 0) - (b.assignedAt || 0))[0];
    if (reserved) return handOut(reserved);

    // 2. No window-open world has room. Reconcile ESTABLISHED (window-lapsed)
    //    worlds against real occupancy and join the first hosted one under cap,
    //    or reuse one that truly emptied. (Only window-lapsed worlds are fetched,
    //    so a burst never reaches this await-heavy path.)
    for (const w of sameVersion) {
      const windowOpen = now - (w.assignedAt || 0) < RESERVE_MS;
      if (windowOpen) continue; // its capacity was just decided synchronously above
      const { count, hasHost } = await this.status(w.id);
      w.lastCount = count;
      if (count <= (w.pending || 0)) w.pending = count; // reconcile stale optimism down
      if (est(w) === 0) {
        await this.state.storage.put('worlds', worlds);
        return handOut(w); // truly empty (no real players, none routed recently)
      }
      if (hasHost && est(w) < SOFT_CAP) {
        await this.state.storage.put('worlds', worlds);
        return handOut(w);
      }
    }

    // 3. Every same-version world is at/over the soft cap. Prefer a NEW world
    //    (a new host brings fresh low-latency direct capacity) so load spreads
    //    across hosts rather than concentrating in one relay-heavy world.
    if (worlds.length < MAX_WORLDS) {
      const next = (await this.state.storage.get('nextWorld')) ?? 1;
      const code = this.newWorldId(next);
      await this.state.storage.put('nextWorld', next + 1);
      const w = { id: code, version, assignedAt: now, pending: 1, lastCount: 0 };
      worlds = [...worlds, w];
      await this.state.storage.put('worlds', worlds);
      return { code };
    }

    // 4. World ceiling reached: pack same-version worlds toward their relay-
    //    backed capacity before turning anyone away. Pick the least-full hosted
    //    one under HARD_FILL so the overflow spreads evenly across hosts.
    const packable = sameVersion
      .filter((w) => (w.lastCount || 0) > 0 && est(w) < HARD_FILL)
      .sort((a, b) => est(a) - est(b))[0];
    if (packable) return handOut(packable);

    // 5. Truly saturated: hand back the least-full same-version world anyway
    //    (the room enforces WORLD_CAP), else a fresh id as a last resort.
    const fallback = sameVersion.sort((a, b) => est(a) - est(b))[0];
    return {
      code: fallback ? fallback.id : this.newWorldId((await this.state.storage.get('nextWorld')) ?? 1),
    };
  }

  newWorldId(n) {
    // Stable, human-ish world id: BRACK-001, BRACK-002, ...
    return `BRACK${String(n).padStart(3, '0')}`;
  }
}
