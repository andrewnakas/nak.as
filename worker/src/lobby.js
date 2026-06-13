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
    // worlds: [{ id, version }]
    let worlds = (await this.state.storage.get('worlds')) ?? [];

    // Retire a reported-dead world.
    if (exclude) {
      worlds = worlds.filter((w) => w.id !== exclude);
      await this.state.storage.put('worlds', worlds);
    }

    const sameVersion = worlds.filter((w) => w.version === version);

    // Reuse the first joinable same-version world (skip hostless ghosts).
    for (const w of sameVersion) {
      const { count, hasHost } = await this.status(w.id);
      if (count === 0) return { code: w.id }; // empty: joiner hosts it
      if (hasHost && count < SOFT_CAP) return { code: w.id };
    }

    // None joinable: spin up a fresh world with a new monotonic id (avoids
    // reusing a retired id whose DO may still hold a ghost).
    if (worlds.length < MAX_WORLDS) {
      const next = (await this.state.storage.get('nextWorld')) ?? 1;
      const code = this.newWorldId(next);
      await this.state.storage.put('nextWorld', next + 1);
      worlds = [...worlds, { id: code, version }];
      await this.state.storage.put('worlds', worlds);
      return { code };
    }

    // Pathological load: any same-version world, else a fresh one anyway.
    const fallback = sameVersion[0];
    return { code: fallback ? fallback.id : this.newWorldId((await this.state.storage.get('nextWorld')) ?? 1) };
  }

  newWorldId(n) {
    // Stable, human-ish world id: BRACK-001, BRACK-002, ...
    return `BRACK${String(n).padStart(3, '0')}`;
  }
}
