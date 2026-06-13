// RoomDO: a persistent MMO world's signaling hub AND game-data relay.
//
// Two transport tiers per world:
//   1. Direct P2P (preferred): the host holds a WebRTC link to each of the
//      first DIRECT_CAP clients. Lowest latency.
//   2. Relayed (overflow): clients beyond DIRECT_CAP receive the host's
//      per-viewpoint snapshots THROUGH this DO over the signaling WebSocket,
//      and send their inputs back the same way. The browser host keeps just
//      ONE socket (to this DO) instead of 100 WebRTC connections; the edge
//      does the fan-out. The DO is still a dumb pipe — it never inspects or
//      simulates game state, only forwards opaque bytes between host and the
//      addressed client.
//
// This lifts the hard ceiling from ~24 (one browser's WebRTC limit) toward
// the WORLD_CAP while keeping the host authoritative.

const DIRECT_CAP = 24; // clients served over direct WebRTC before relaying
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
          cap: WORLD_CAP,
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
      // Join the world. The first member becomes host; the next DIRECT_CAP
      // connect over direct WebRTC; the rest are relayed through this DO.
      case 'join': {
        const joined = this.joined();
        if (joined.length >= WORLD_CAP) {
          return this.send(ws, { t: 'error', code: 'full', msg: 'world is full' });
        }
        const host = this.host();
        const becomeHost = !host;
        // Clients beyond the direct cap use the relay tier instead of being
        // turned away. joined includes the host, so subtract it to count the
        // direct *clients* already attached.
        const directClients = joined.filter((m) => !m.meta.host && !m.meta.relayed).length;
        const relayed = !becomeHost && directClients >= DIRECT_CAP;
        Object.assign(meta, {
          joined: true,
          host: becomeHost,
          relayed,
          name: String(msg.name ?? 'player').slice(0, 16),
          joinedAt: this.nextSeq(),
        });
        ws.serializeAttachment(meta);
        if (becomeHost) {
          this.send(ws, { t: 'host', self_id: meta.id });
        } else if (relayed) {
          // Tell the relay client it'll get game data through the DO, and
          // tell the host a relay client appeared so it starts sending to it.
          this.send(ws, { t: 'joined-relay', self_id: meta.id, host_id: host.meta.id });
          this.send(host.ws, { t: 'relay-client-joined', id: meta.id, name: meta.name });
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
      // A direct (WebRTC) client whose peer connection never came up — almost
      // always a network that blocks UDP/TURN but passes this WebSocket — asks
      // to be served over the relay tier instead. We flip it to relayed and tell
      // the host, so a strict-network player still gets into the world rather
      // than bouncing between hosts. (Idempotent if already relayed.)
      case 'request-relay': {
        if (!meta.joined || meta.host) return;
        if (!meta.relayed) {
          meta.relayed = true;
          ws.serializeAttachment(meta);
          const host = this.host();
          if (host) this.send(host.ws, { t: 'relay-client-joined', id: meta.id, name: meta.name });
        }
        this.send(ws, { t: 'joined-relay', self_id: meta.id, host_id: this.host()?.meta.id });
        return;
      }
      // ---- relay tier: opaque game-data forwarding ----
      // Host -> a relay client. msg carries either `data` (base64 game bytes)
      // or `json` (a control message like welcome/reject). The DO forwards
      // verbatim without inspecting either.
      case 'relay-down': {
        if (!meta.host) return;
        const target = this.joined().find((m) => m.meta.id === msg.to && m.meta.relayed);
        if (target) {
          this.send(target.ws, { t: 'relay-down', data: msg.data, json: msg.json });
        }
        return;
      }
      // Host -> many relay clients with ONE shared payload. The host sends a
      // single frame carrying the bytes once plus a recipient id list; the edge
      // fans it out. This is the scale path: a crowded screen's snapshot is
      // serialized + base64-encoded + sent over the host's uplink exactly once
      // no matter how many relay clients are watching it.
      case 'relay-multicast': {
        if (!meta.host) return;
        const ids = Array.isArray(msg.to) ? new Set(msg.to) : null;
        if (!ids) return;
        for (const m of this.joined()) {
          if (m.meta.relayed && ids.has(m.meta.id)) {
            this.send(m.ws, { t: 'relay-down', data: msg.data, json: msg.json });
          }
        }
        return;
      }
      // Relay client -> host (hello / input / ui action).
      case 'relay-up': {
        if (!meta.joined || meta.host) return;
        const host = this.host();
        if (host) {
          this.send(host.ws, { t: 'relay-up', from: meta.id, data: msg.data, json: msg.json });
        }
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
      // Host migration: promote the longest-present DIRECT (non-relayed)
      // member — a relay client has no peer mesh to take over hosting. The
      // new host re-hosts; all clients (direct + relay) reconnect to it.
      const survivors = this.joined().filter((m) => m.meta.id !== meta.id);
      survivors.sort((a, b) => a.meta.joinedAt - b.meta.joinedAt);
      const next = survivors.find((m) => !m.meta.relayed) ?? survivors[0];
      if (next) {
        next.meta.host = true;
        next.meta.relayed = false;
        next.ws.serializeAttachment(next.meta);
        this.send(next.ws, {
          t: 'you-are-host',
          peers: survivors.map((m) => ({ id: m.meta.id, name: m.meta.name })),
        });
        this.broadcast({ t: 'host-migrated', host_id: next.meta.id }, next.meta.id);
      }
      // else: world emptied; it simply goes idle.
    } else if (meta.relayed) {
      // Tell the host to stop sending snapshots to this relay client.
      const host = this.host();
      if (host) this.send(host.ws, { t: 'relay-client-left', id: meta.id });
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
