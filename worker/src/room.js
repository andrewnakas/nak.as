// RoomDO: WebRTC signaling relay for one party, addressed by party code.
// Uses the WebSocket Hibernation API so idle rooms cost nothing. The DO
// relays SDP/ICE blindly between peers; it never sees game state. Sockets
// are expected to close once the mesh is up.

const MAX_MEMBERS = 4;

export class RoomDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      id: crypto.randomUUID().slice(0, 8),
      name: null,
      host: false,
      joined: false,
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  members() {
    return this.state.getWebSockets().map((ws) => ({ ws, meta: ws.deserializeAttachment() }));
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket already gone; close handler will clean up
    }
  }

  broadcast(msg, exceptId) {
    for (const { ws, meta } of this.members()) {
      if (meta.joined && meta.id !== exceptId) this.send(ws, msg);
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
    const all = this.members();
    const joined = all.filter((m) => m.meta.joined);

    switch (msg.t) {
      case 'create': {
        if (joined.some((m) => m.meta.host)) {
          return this.send(ws, { t: 'error', code: 'exists', msg: 'party already exists' });
        }
        Object.assign(meta, { host: true, joined: true, name: String(msg.name ?? 'host').slice(0, 16) });
        ws.serializeAttachment(meta);
        return this.send(ws, { t: 'created', self_id: meta.id });
      }
      case 'join': {
        const host = joined.find((m) => m.meta.host);
        if (!host) {
          return this.send(ws, { t: 'error', code: 'no-party', msg: 'no such party' });
        }
        if (joined.length >= MAX_MEMBERS) {
          return this.send(ws, { t: 'error', code: 'full', msg: 'party is full' });
        }
        Object.assign(meta, { joined: true, name: String(msg.name ?? 'player').slice(0, 16) });
        ws.serializeAttachment(meta);
        this.broadcast({ t: 'peer-joined', id: meta.id, name: meta.name }, meta.id);
        return this.send(ws, {
          t: 'joined',
          self_id: meta.id,
          host_id: host.meta.id,
          peers: joined.map((m) => ({ id: m.meta.id, name: m.meta.name })),
        });
      }
      case 'signal': {
        if (!meta.joined) return;
        const target = all.find((m) => m.meta.id === msg.to && m.meta.joined);
        if (target) {
          this.send(target.ws, { t: 'signal', from: meta.id, payload: msg.payload });
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
    if (meta.joined) {
      this.broadcast(meta.host ? { t: 'host-left' } : { t: 'peer-left', id: meta.id }, meta.id);
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}
