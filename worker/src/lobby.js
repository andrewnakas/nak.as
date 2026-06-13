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
      const world = await this.findWorld(exclude);
      return Response.json(world);
    }
    if (url.pathname.endsWith('/worlds')) {
      const worlds = (await this.state.storage.get('worlds')) ?? [];
      const live = await Promise.all(worlds.map((id) => this.status(id).then((s) => ({ id, ...s }))));
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

  /// Return { code } of a joinable world, retiring a reported-dead one and
  /// creating a fresh world when needed. A world is joinable when it's empty
  /// (the joiner becomes host) or it has a live host and is under the soft cap.
  async findWorld(exclude) {
    let worlds = (await this.state.storage.get('worlds')) ?? [];

    // Retire a world the caller reported as unreachable (dead host).
    if (exclude && worlds.includes(exclude)) {
      worlds = worlds.filter((w) => w !== exclude);
      await this.state.storage.put('worlds', worlds);
    }

    // Reuse the first world that's joinable (skip hostless non-empty ghosts).
    for (const id of worlds) {
      if (id === exclude) continue;
      const { count, hasHost } = await this.status(id);
      if (count === 0) return { code: id }; // empty: joiner hosts it
      if (hasHost && count < SOFT_CAP) return { code: id };
    }

    // None joinable: spin up a fresh world with a NEW id. A monotonic
    // counter avoids reusing a retired id whose Durable Object may still
    // hold a ghost host.
    if (worlds.length < MAX_WORLDS) {
      let next = (await this.state.storage.get('nextWorld')) ?? 1;
      const code = this.newWorldId(next);
      await this.state.storage.put('nextWorld', next + 1);
      worlds = [...worlds, code];
      await this.state.storage.put('worlds', worlds);
      return { code };
    }

    // Pathological load: least-full hosted world, else any.
    let best = worlds.find((w) => w !== exclude) ?? worlds[0];
    return { code: best };
  }

  newWorldId(n) {
    // Stable, human-ish world id: BRACK-001, BRACK-002, ...
    return `BRACK${String(n).padStart(3, '0')}`;
  }
}
