// RoomDO: a persistent MMO world's signaling hub. Unlike a 4-player party,
// a world stays open for its lifetime: late joiners connect to the current
// host, and if the host leaves we promote another member (host migration)
// so the shared world survives. The DO only relays SDP/ICE + membership; it
// never sees game state.
//
// A browser host can't hold 150 WebRTC connections, so the practical cap is
// connection-bound: CONNECT_CAP is the most peers one host serves before the
// lobby spills new players into the next world.

const CONNECT_CAP = 24; // peers a single host serves (host migration resets headroom)
export const WORLD_CAP = 150; // hard ceiling on world membership

export class RoomDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      // The lobby pokes /count to read live occupancy + host presence.
      if (new URL(request.url).pathname.endsWith('/count')) {
        return Response.json({
          count: this.joinedCount(),
          hasHost: !!this.host(),
          cap: CONNECT_CAP,
        });
      }
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      id: crypto.randomUUID().slice(0, 8),
      name: null,
      host: false,
      joined: false,
      joinedAt: 0,
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  members() {
    return this.state.getWebSockets().map((ws) => ({ ws, meta: ws.deserializeAttachment() }));
  }

  joined() {
    return this.members().filter((m) => m.meta.joined);
  }

  joinedCount() {
    return this.joined().length;
  }

  host() {
    return this.joined().find((m) => m.meta.host);
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket gone; close handler cleans up
    }
  }

  broadcast(msg, exceptId) {
    for (const { ws, meta } of this.joined()) {
      if (meta.id !== exceptId) this.send(ws, msg);
    }
  }

  webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { t: 'error', code: 'bad-json' });
    }
    const meta = ws.deserializeAttachment();

    switch (msg.t) {
      // Join the world. The first member becomes host; everyone else
      // connects to the current host. Full worlds reject (lobby retries next).
      case 'join': {
        const joined = this.joined();
        if (joined.length >= WORLD_CAP) {
          return this.send(ws, { t: 'error', code: 'full', msg: 'world is full' });
        }
        const host = this.host();
        const becomeHost = !host;
        // Connection-bound spill: a host beyond CONNECT_CAP turns joiners away.
        if (host && joined.length >= CONNECT_CAP) {
          return this.send(ws, { t: 'error', code: 'host-full', msg: 'host saturated' });
        }
        Object.assign(meta, {
          joined: true,
          host: becomeHost,
          name: String(msg.name ?? 'player').slice(0, 16),
          joinedAt: this.nextSeq(),
        });
        ws.serializeAttachment(meta);
        if (becomeHost) {
          this.send(ws, { t: 'host', self_id: meta.id });
        } else {
          this.broadcast({ t: 'peer-joined', id: meta.id, name: meta.name }, meta.id);
          this.send(ws, {
            t: 'joined',
            self_id: meta.id,
            host_id: host.meta.id,
            peers: this.joined().map((m) => ({ id: m.meta.id, name: m.meta.name, host: m.meta.host })),
          });
        }
        return;
      }
      case 'signal': {
        if (!meta.joined) return;
        const target = this.joined().find((m) => m.meta.id === msg.to);
        if (target) this.send(target.ws, { t: 'signal', from: meta.id, payload: msg.payload });
        return;
      }
      case 'leave':
        return ws.close(1000, 'leave');
      default:
        return this.send(ws, { t: 'error', code: 'bad-type' });
    }
  }

  webSocketClose(ws) {
    const meta = ws.deserializeAttachment();
    if (!meta.joined) return;

    if (meta.host) {
      // Host migration: promote the longest-present remaining member.
      const survivors = this.joined().filter((m) => m.meta.id !== meta.id);
      survivors.sort((a, b) => a.meta.joinedAt - b.meta.joinedAt);
      const next = survivors[0];
      if (next) {
        next.meta.host = true;
        next.ws.serializeAttachment(next.meta);
        // New host rebuilds the world from its latest snapshot; clients
        // reconnect to it. (The old host's screen state is already on every
        // client via interpolation buffers.)
        this.send(next.ws, { t: 'you-are-host', peers: survivors.map((m) => ({ id: m.meta.id, name: m.meta.name })) });
        this.broadcast({ t: 'host-migrated', host_id: next.meta.id }, next.meta.id);
      }
      // else: world emptied; it simply goes idle.
    } else {
      this.broadcast({ t: 'peer-left', id: meta.id }, meta.id);
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  // Monotonic join sequence (stored on the DO via storage-free counter on
  // the latest joinedAt; good enough for ordering migrations).
  nextSeq() {
    const max = Math.max(0, ...this.members().map((m) => m.meta.joinedAt || 0));
    return max + 1;
  }
}
