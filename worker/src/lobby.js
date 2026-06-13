// LobbyDO: the single global matchmaker. Clients ask for a world to join;
// the lobby hands back a world id (room code). It keeps a small list of live
// worlds and their last-known occupancy, filling world #1 until it's near
// capacity, then world #2, and so on. Worlds are RoomDO instances keyed by
// the id we return here.
//
// Occupancy is refreshed lazily by polling each candidate RoomDO's /count
// before assigning, so a world that emptied out gets reused.

const SOFT_CAP = 24; // assign here until a world reaches this, then spill
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

    // 1. A freshly-assigned same-version world inside its reservation window:
    //    route here even if its host hasn't connected yet, so a burst of
    //    simultaneous joiners lands together instead of fragmenting.
    const reserved = sameVersion
      .filter((w) => now - (w.assignedAt || 0) < RESERVE_MS)
      .sort((a, b) => (a.assignedAt || 0) - (b.assignedAt || 0))[0];
    if (reserved) return { code: reserved.id };

    // 2. An established, hosted same-version world under the soft cap.
    for (const w of sameVersion) {
      const { count, hasHost } = await this.status(w.id);
      if (hasHost && count > 0 && count < SOFT_CAP) return { code: w.id };
      if (count === 0) {
        // Empty (host left): reuse it and refresh its reservation so the next
        // joiner pairs with this one too.
        w.assignedAt = now;
        await this.state.storage.put('worlds', worlds);
        return { code: w.id };
      }
    }

    // 3. None joinable: spin up a fresh world with a new monotonic id.
    if (worlds.length < MAX_WORLDS) {
      const next = (await this.state.storage.get('nextWorld')) ?? 1;
      const code = this.newWorldId(next);
      await this.state.storage.put('nextWorld', next + 1);
      worlds = [...worlds, { id: code, version, assignedAt: now }];
      await this.state.storage.put('worlds', worlds);
      return { code };
    }

    // Pathological load: any same-version world, else a fresh id anyway.
    const fallback = sameVersion[0];
    return {
      code: fallback ? fallback.id : this.newWorldId((await this.state.storage.get('nextWorld')) ?? 1),
    };
  }

  newWorldId(n) {
    // Stable, human-ish world id: BRACK-001, BRACK-002, ...
    return `BRACK${String(n).padStart(3, '0')}`;
  }
}
