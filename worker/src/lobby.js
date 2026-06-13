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
      const world = await this.findWorld();
      return Response.json(world);
    }
    if (url.pathname.endsWith('/worlds')) {
      const worlds = (await this.state.storage.get('worlds')) ?? [];
      const live = await Promise.all(worlds.map((id) => this.count(id).then((c) => ({ id, count: c }))));
      return Response.json({ worlds: live.filter((w) => w.count > 0) });
    }
    return new Response('not found', { status: 404 });
  }

  /// Ask a RoomDO for its current occupancy (0 if unreachable).
  async count(id) {
    try {
      const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(id));
      const r = await room.fetch('https://room/count');
      const { count } = await r.json();
      return count;
    } catch {
      return 0;
    }
  }

  /// Return { code } of a world with room, creating a new one if needed.
  async findWorld() {
    let worlds = (await this.state.storage.get('worlds')) ?? [];

    // Reuse the first world under the soft cap (refreshing occupancy).
    for (const id of worlds) {
      const c = await this.count(id);
      if (c < SOFT_CAP) return { code: id };
    }

    // All full (or none exist): spin up a new world.
    if (worlds.length >= MAX_WORLDS) {
      // Pathological load: hand back the least-full existing world anyway.
      let best = worlds[0];
      let bestCount = Infinity;
      for (const id of worlds) {
        const c = await this.count(id);
        if (c < bestCount) {
          best = id;
          bestCount = c;
        }
      }
      return { code: best };
    }

    const code = this.newWorldId(worlds.length + 1);
    worlds = [...worlds, code];
    await this.state.storage.put('worlds', worlds);
    return { code };
  }

  newWorldId(n) {
    // Stable, human-ish world id: BRACK-001, BRACK-002, ...
    return `BRACK${String(n).padStart(3, '0')}`;
  }
}
