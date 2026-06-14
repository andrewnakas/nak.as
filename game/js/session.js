// Game session orchestration. Solo play is a HostSession with no peers —
// the same authoritative code path runs alone or with a party.

import { TICK_MS, MAX_CATCHUP_TICKS } from './config.js';
import { PeerLink } from './net/rtc.js';
import { toast } from './ui.js';
import { persist } from './saves.js';

const SNAPSHOT_EVERY = 3; // host ticks between snapshots (60/3 = 20 Hz)
const INPUT_KEEPALIVE_MS = 100; // direct (lossy WebRTC): resend input often
const RELAY_HEARTBEAT_MS = 2000; // relay (reliable WS): only a rare liveness ping
const RELAY_PING_MS = 3000; // relay RTT probe cadence (ping/pong through the DO)
const RELAY_STALE_MS = 8000; // host drops a relay peer silent this long (> ping+heartbeat)
const KEYFRAME_MS = 500; // max gap between relay snapshots for a static screen
const AUTOSAVE_TICKS = 900; // 15s
const MAX_SLOTS = 32; // must match sim MAX_PLAYERS
// Above this many peers, switch from one broadcast snapshot to per-client
// filtered snapshots (more CPU per tick, far less bandwidth at scale).
const PERCLIENT_THRESHOLD = 6;

class BaseSession {
  constructor({ game, input, renderer, audio, debugEl }) {
    this.game = game;
    this.input = input;
    this.renderer = renderer;
    this.audio = audio;
    this.debugEl = debugEl;
    this.slot = 0;
    this.stopped = false;
  }

  start() {
    this._last = performance.now();
    this._acc = 0;
    const frame = (now) => {
      if (this.stopped) return;
      this._advance(now, MAX_CATCHUP_TICKS);
      this.renderer.draw(this.game.render_frame(this.slot, now));
      this.audio?.playAll(this.game.drain_audio(this.slot));
      for (const msg of JSON.parse(this.game.drain_toasts(this.slot))) toast(msg);
      if (this.game.tick_count() % 12 === 0) {
        // Show a "press I to shop" hint when standing by a vendor.
        const prompt = document.getElementById('vendor-prompt');
        if (prompt) {
          const near = this.game.vendor_here(this.slot) >= 0;
          prompt.style.display = near ? 'block' : 'none';
        }
      }
      if (this.audio && this.game.tick_count() % 30 === 0) {
        const at = this.game.player_screen(this.slot);
        if (at.length) {
          // Dungeons live in the y>=10 band (Rootcellar x10-13, Tidecrag x7-9).
          const inDungeon = at[1] >= 10 && at[0] >= 7;
          // Boss arenas: Moldra (13,12) and the Tidewarden (9,12).
          const inBoss = (at[0] === 13 || at[0] === 9) && at[1] === 12;
          this.audio.setTrack(inBoss ? 'boss' : inDungeon ? 'dungeon' : 'overworld');
        }
      }
      if (this.debugEl && this.game.tick_count() % 30 === 0) {
        this.debugEl.textContent =
          `tick ${this.game.tick_count()}\n` +
          `hash ${this.game.state_hash().toString(16)}\n` +
          `slot ${this.slot}\n` +
          (this.netInfo?.() ?? '');
      }
      // Sample connection quality ~1/sec for the net HUD + telemetry.
      if (this.game.tick_count() % 60 === 0) this._sampleNet?.();
      // Per-frame hook for World-level overlays (minimap, party markers).
      this.onFrame?.(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // rAF stops in hidden tabs, which would freeze the whole party when the
    // host tabs away; this keeps the sim ticking (no rendering) while hidden.
    // Chrome clamps background timers to ~1/s, hence the large catch-up cap.
    this._bgTimer = setInterval(() => {
      if (document.hidden && !this.stopped) this._advance(performance.now(), 80);
    }, 250);
  }

  _advance(now, maxTicks) {
    this._acc += now - this._last;
    this._last = now;
    this._acc = this.update(now, this._acc, maxTicks);
  }

  stop() {
    this.stopped = true;
    clearInterval(this._bgTimer);
  }
}

export class HostSession extends BaseSession {
  constructor(deps, { onPartyChange, save } = {}) {
    super(deps);
    if (save) this.game.add_player_with_save(0, save);
    else this.game.add_player(0);
    this.peers = new Map(); // remoteId -> { link, slot, name }
    this.pendingNames = new Map();
    this.signaling = null;
    this.onPartyChange = onPartyChange;
    // Per snapshot_key suppression memory: skip resending a screen's snapshot
    // when its bytes are unchanged since last tick, with a periodic keyframe so
    // a just-joined or packet-dropped client always recovers within KEYFRAME_MS.
    this._snapHist = new Map(); // key -> { hash, lastFullAt }
    // Save the local character when the tab closes (cloud write may not
    // finish, but localStorage always does).
    window.addEventListener('beforeunload', () => {
      if (!this.stopped) persist(this.game.export_save(0));
    });
  }

  /// Wire up the signaling channel so remote players can join. The host
  /// keeps this socket open for the life of the party.
  attachSignaling(signaling) {
    this.signaling = signaling;
    signaling.on('peer-joined', (m) => this.pendingNames.set(m.id, m.name));
    signaling.on('peer-left', (m) => this.pendingNames.delete(m.id));
    signaling.on('signal', async (m) => {
      let peer = this.peers.get(m.from);
      if (peer && (peer.relay || !peer.link)) {
        // This peer fell back to the relay tier (its WebRTC link was closed).
        // Ignore any straggler ICE signals — there's no data channel to feed.
        return;
      }
      if (!peer) {
        // First signal from a new joiner: answer their offer.
        const link = new PeerLink(signaling, m.from, false);
        peer = { id: m.from, link, slot: -1, name: this.pendingNames.get(m.from) ?? 'player', relay: false };
        this.peers.set(m.from, peer);
        link.onR = (text) => this._handleReliable(peer, text);
        link.onU = (data) => {
          if (peer.slot >= 0) this.game.handle_client_msg(peer.slot, new Uint8Array(data));
        };
        link.onClosed = () => this._dropPeer(m.from);
      }
      await peer.link.handleSignal(m.payload);
    });

    // ---- relay-tier clients (no WebRTC link; they talk through the DO) ----
    signaling.on('relay-client-joined', (m) => {
      const existing = this.peers.get(m.id);
      if (existing) {
        // This id may already have a half-built DIRECT peer (its WebRTC link
        // failed and it's now falling back to relay). Convert it in place:
        // close the dead link, keep its slot if one was already admitted, and
        // re-route its transport to relay. Without this the host would keep
        // sending snapshots into a dead data channel.
        existing.link?.close();
        existing.link = null;
        existing.relay = true;
        existing.lastSeen = performance.now();
        if (m.name) existing.name = m.name;
      } else {
        this.peers.set(m.id, {
          id: m.id,
          link: null,
          slot: -1,
          name: m.name ?? 'player',
          relay: true,
          lastSeen: performance.now(),
        });
      }
    });
    signaling.on('relay-client-left', (m) => this._dropPeer(m.id));
    signaling.on('relay-up', (m) => {
      const peer = this.peers.get(m.from);
      if (!peer) return;
      peer.lastSeen = performance.now(); // liveness for the stale-relay sweep
      if (m.json) {
        this._handleRelayControl(peer, m.from, m.json);
      } else if (m.data && peer.slot >= 0) {
        this.game.handle_client_msg(peer.slot, b64decode(m.data));
      }
    });
  }

  // Shared hello/handshake logic for both direct (WebRTC) and relay clients.
  // `reply` sends the welcome/reject back over the right transport.
  _admit(peer, msg, reply) {
    if (msg.contentHash !== this.game.content_hash().toString(16)) {
      reply({ t: 'reject', reason: 'version mismatch — reload the page' });
      return;
    }
    // Idempotent re-admit: a client that already holds a slot (e.g. it was
    // admitted over WebRTC, then fell back to relay and re-sent hello) keeps
    // its slot and character — don't allocate a second one or re-add the player.
    if (peer.slot >= 0) {
      reply({ t: 'welcome', slot: peer.slot, contentHash: msg.contentHash });
      return;
    }
    const slot = this._freeSlot();
    if (slot < 0) {
      reply({ t: 'reject', reason: 'world is full' });
      return;
    }
    peer.slot = slot;
    peer.name = String(msg.name ?? peer.name).slice(0, 16);
    if (typeof msg.save === 'string' && msg.save) {
      this.game.add_player_with_save(slot, msg.save);
    } else {
      this.game.add_player(slot);
    }
    reply({ t: 'welcome', slot, contentHash: msg.contentHash });
    this.onPartyChange?.(this.partyList());
    this._broadcastVoiceRoster();
  }

  /// Tell every direct client the slot->id map of all DIRECT members, so they
  /// can build proximity-voice links to each other (the star game topology
  /// doesn't give clients each other's ids otherwise). The host includes
  /// itself (slot 0) and its own id so clients can voice-chat the host too.
  /// Relay clients are excluded — they have no WebRTC and can't join the mesh.
  _broadcastVoiceRoster() {
    const entries = [{ slot: 0, id: this.selfId }];
    for (const peer of this.peers.values()) {
      if (peer.slot >= 0 && !peer.relay && peer.id) {
        entries.push({ slot: peer.slot, id: peer.id });
      }
    }
    const msg = { t: 'voice-roster', entries };
    for (const peer of this.peers.values()) {
      if (peer.slot >= 0 && !peer.relay) peer.link?.sendR(msg);
    }
  }

  _handleReliable(peer, text) {
    if (typeof text !== 'string') {
      // Binary = postcard C2H (UiActions ride the reliable channel).
      if (peer.slot >= 0) this.game.handle_client_msg(peer.slot, new Uint8Array(text));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === 'hello') this._admit(peer, msg, (r) => peer.link.sendR(r));
  }

  _handleRelayControl(peer, fromId, msg) {
    if (msg.t === 'hello') {
      // Welcome/reject travels back to the relay client as {json: ...}.
      this._admit(peer, msg, (r) =>
        this.signaling.send({ t: 'relay-down', to: fromId, json: r }),
      );
    } else if (msg.t === 'ping') {
      // Echo the client's timestamp so it can measure the real DO round-trip
      // (relay-up -> host -> relay-down). Cheap; only the addressed client.
      this.signaling.send({ t: 'relay-down', to: fromId, json: { t: 'pong', ts: msg.ts } });
    }
  }

  _freeSlot() {
    const used = new Set([0, ...[...this.peers.values()].map((p) => p.slot)]);
    // Slots are the sim's player array index; the sim supports many players
    // in a shared world (the lobby caps real occupancy, not this).
    for (let s = 1; s < MAX_SLOTS; s++) if (!used.has(s)) return s;
    return -1;
  }

  _dropPeer(remoteId) {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    if (peer.slot >= 0) this.game.remove_player(peer.slot);
    peer.link?.close(); // relay peers have no WebRTC link
    this.peers.delete(remoteId);
    this.onPartyChange?.(this.partyList());
    this._broadcastVoiceRoster();
  }

  // Route game bytes to a peer over its transport: direct = WebRTC channel,
  // relay = base64 through the DO (relay clients can lose snapshots like the
  // unreliable channel does, so both go via relay-down).
  _sendUnreliable(peer, bytes) {
    if (peer.relay) {
      this.signaling.send({ t: 'relay-down', to: peer.id, data: b64encode(bytes) });
    } else {
      peer.link.sendU(bytes);
    }
  }
  _sendReliable(peer, bytes) {
    if (peer.relay) {
      this.signaling.send({ t: 'relay-down', to: peer.id, data: b64encode(bytes) });
    } else {
      peer.link.sendRBytes(bytes);
    }
  }

  // Send one already-base64-encoded payload to a group of relay clients. One
  // recipient uses relay-down; several use relay-multicast so the bytes cross
  // the host's uplink once and the edge fans them out.
  _sendRelayGroup(ids, b64) {
    if (ids.length === 1) {
      this.signaling.send({ t: 'relay-down', to: ids[0], data: b64 });
    } else {
      this.signaling.send({ t: 'relay-multicast', to: ids, data: b64 });
    }
  }

  partyList() {
    return [{ slot: 0, name: 'you' }].concat(
      [...this.peers.values()]
        .filter((p) => p.slot >= 0)
        .map((p) => ({ slot: p.slot, name: p.name })),
    );
  }

  _sampleNet() {
    for (const peer of this.peers.values()) peer.link?.sampleStats();
    // Reclaim slots held by relay clients that went silent. A relay client
    // sends input-on-change plus a heartbeat (2s) plus a ping (3s), so going
    // quiet past RELAY_STALE_MS means its socket died without a clean close
    // (the DO normally sends relay-client-left, but a hard drop may not). The
    // sweep frees the slot so the world doesn't accrue ghosts at scale.
    const now = performance.now();
    const stale = [];
    for (const peer of this.peers.values()) {
      if (peer.relay && now - (peer.lastSeen ?? now) > RELAY_STALE_MS) stale.push(peer.id);
    }
    for (const id of stale) this._dropPeer(id);
    // Resend the voice roster periodically so a client whose channel wasn't
    // ready at join time (or that enables voice later) still learns everyone's
    // ids. Cheap small JSON, only to direct peers.
    if (this.peers.size) this._broadcastVoiceRoster();
  }

  netInfo() {
    const active = [...this.peers.values()].filter((p) => p.slot >= 0);
    if (!active.length) return `net: host, 0 peers`;
    const direct = active.filter((p) => !p.relay);
    const relay = active.filter((p) => p.relay);
    const rtts = direct.map((p) => p.link?.stats?.rttMs).filter((r) => r != null);
    const avg = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
    const worst = rtts.length ? Math.max(...rtts) : null;
    const relayBit = relay.length ? ` +${relay.length} relay` : '';
    return `net: host, ${direct.length} direct${relayBit} · rtt ~${avg ?? '—'}ms (max ${worst ?? '—'})`;
  }

  sendUiAction(json) {
    this.game.ui_action(0, json);
  }

  update(now, acc, maxTicks) {
    let ticks = 0;
    while (acc >= TICK_MS && ticks < maxTicks) {
      this.game.set_input(0, this.input.read());
      this.game.tick();
      acc -= TICK_MS;
      ticks++;
      if (this.peers.size && this.game.tick_count() % SNAPSHOT_EVERY === 0) {
        // Small party: one full snapshot for everyone (cheapest). Larger: a
        // per-client snapshot filtered to each client's screen, so host uplink
        // scales with players-per-screen, not total world population. Relay
        // clients always get per-client snapshots (they're the overflow tier).
        const broadcast =
          this.peers.size <= PERCLIENT_THRESHOLD
            ? this.game.snapshot_bytes()
            : null;
        // A per-screen cache for THIS tick. A filtered snapshot depends only on
        // the screen+transition (snapshot_key), so peers clustered on the same
        // screen (a town, a boss) share one serialize+encode instead of N —
        // keeping host CPU flat as a screen crowds up. We also reuse the cached
        // base64 string so relay peers encode once, and batch relay peers that
        // share a buffer into a single relay-multicast so the host's uplink
        // sends crowded-screen bytes exactly once regardless of audience size.
        // Relay peers ALWAYS take a filtered snapshot (the overflow tier is
        // bandwidth-bounded), even in a small party where direct peers get the
        // cheap broadcast.
        const cache = new Map(); // snapshot_key -> {snap, b64, ids[], suppress}
        for (const peer of this.peers.values()) {
          if (peer.slot < 0) continue;
          if (broadcast && !peer.relay) {
            peer.link.sendU(broadcast);
            continue;
          }
          const key = this.game.snapshot_key(peer.slot);
          let entry = cache.get(key);
          if (entry === undefined) {
            entry = {
              snap: this.game.snapshot_bytes_for(peer.slot),
              b64: null,
              ids: null,
              slot0: peer.slot,
            };
            cache.set(key, entry);
          }
          if (peer.relay) {
            (entry.ids ??= []).push(peer.id);
          } else {
            // Direct clients ride the lossy WebRTC channel; always send so a
            // dropped change-frame can't strand them between keyframes.
            peer.link.sendU(entry.snap);
          }
        }
        // Flush relay groups. The relay channel is reliable+ordered, so a
        // screen whose bytes are unchanged since last tick can be SUPPRESSED —
        // the client's view simply holds (it already drops tick<=last). A
        // keyframe every KEYFRAME_MS guarantees a just-joined client recovers.
        // This is encoded once per surviving group (relay-multicast) so a static
        // crowded screen costs the host's uplink nothing between keyframes.
        for (const [key, entry] of cache.entries()) {
          if (!entry.ids) continue;
          // Fingerprint the CONTENT (tick excluded) so a static screen hashes
          // identically tick-to-tick; entry.slot0 is any peer's slot on this key.
          const hash = this.game.snapshot_content_hash(entry.slot0);
          const hist = this._snapHist.get(key);
          const fresh = hist && hist.hash === hash && now - hist.lastFullAt < KEYFRAME_MS;
          if (fresh) continue; // unchanged + within keyframe window -> skip
          this._snapHist.set(key, { hash, lastFullAt: now });
          entry.b64 = b64encode(entry.snap);
          this._sendRelayGroup(entry.ids, entry.b64);
        }
        // Evict suppression memory for screen-keys nobody is on anymore.
        if (this._snapHist.size > cache.size + 16) {
          for (const key of this._snapHist.keys()) {
            if (!cache.has(key)) this._snapHist.delete(key);
          }
        }
        const events = this.game.drain_events_bytes();
        if (events.length) {
          // Events are the same bytes for everyone, so encode once for the relay
          // tier and multicast, while direct peers use their reliable channel.
          let eventsB64 = null;
          const relayIds = [];
          for (const peer of this.peers.values()) {
            if (peer.slot < 0) continue;
            if (peer.relay) {
              if (eventsB64 === null) eventsB64 = b64encode(events);
              relayIds.push(peer.id);
            } else {
              peer.link.sendRBytes(events);
            }
          }
          if (relayIds.length) this._sendRelayGroup(relayIds, eventsB64);
        }
      }
      // Autosave: the host persists its own character and pushes each
      // remote player their authoritative save to upload themselves.
      if (this.game.tick_count() % AUTOSAVE_TICKS === 0) {
        persist(this.game.export_save(0));
        for (const peer of this.peers.values()) {
          if (peer.slot >= 0) this._sendReliable(peer, this.game.encode_save_state(peer.slot));
        }
      }
    }
    return acc >= TICK_MS ? 0 : acc;
  }

  stop() {
    super.stop();
    for (const peer of this.peers.values()) peer.link.close();
    // The signaling socket is owned by the World orchestrator (it needs it
    // for migration), so we don't close it here.
  }
}

export class ClientSession extends BaseSession {
  constructor(deps, { onDisconnect, save } = {}) {
    super(deps);
    this.link = null;
    this.lastInputSent = 0;
    this.lastButtons = -1;
    this.onDisconnect = onDisconnect;
    this.save = save ?? null;
  }

  /// Connect to the host through the already-joined signaling room.
  /// Resolves with our assigned slot after the hello/welcome handshake.
  async connect(signaling, hostId, name) {
    this.link = new PeerLink(signaling, hostId, true);
    signaling.on('signal', (m) => {
      if (m.from === hostId) this.link.handleSignal(m.payload);
    });
    signaling.on('host-left', () => this._disconnected());
    this.link.onClosed = () => this._disconnected();
    this.link.onU = (data) =>
      this.game.apply_host_msg(new Uint8Array(data), performance.now());

    await this.link.ready();

    const slot = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host did not respond')), 8000);
      this.link.onR = (text) => {
        const msg = JSON.parse(text);
        clearTimeout(timer);
        if (msg.t === 'welcome') resolve(msg.slot);
        else reject(new Error(msg.reason ?? 'rejected by host'));
      };
      this.link.sendR({
        t: 'hello',
        name,
        save: this.save,
        contentHash: this.game.content_hash().toString(16),
      });
    });

    // Post-handshake, the reliable channel carries binary game events plus the
    // occasional JSON control message (e.g. the voice roster: slot -> peer id,
    // so this client can build proximity-voice links to the others).
    this.link.onR = (data) => {
      if (typeof data !== 'string') {
        this.game.apply_host_msg(new Uint8Array(data), performance.now());
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.t === 'voice-roster') this.onVoiceRoster?.(msg.entries);
    };

    this.slot = slot;
    // Keep the signaling socket open: the World orchestrator listens on it
    // for host-migration events for the life of the world. (It's idle once
    // the WebRTC mesh is up — just a heartbeat — so it costs nothing.)
    return slot;
  }

  _disconnected() {
    if (!this.stopped) {
      this.stop();
      this.onDisconnect?.();
    }
  }

  _sampleNet() {
    this.link?.sampleStats();
  }

  netInfo() {
    const s = this.link?.stats;
    if (!s) return 'net: —';
    const rtt = s.rttMs == null ? '—' : `${s.rttMs}ms`;
    return `net: ${s.state} rtt ${rtt}${s.restarts ? ` (re×${s.restarts})` : ''}`;
  }

  sendUiAction(json) {
    this.link.sendRBytes(this.game.encode_ui_action(json));
  }

  update(now) {
    const buttons = this.input.read();
    const changed = buttons !== this.lastButtons;
    if (changed || now - this.lastInputSent > INPUT_KEEPALIVE_MS) {
      this.link.sendU(this.game.encode_input(buttons));
      this.lastButtons = buttons;
      this.lastInputSent = now;
    }
    // Authoritative saves pushed by the host: persist them as our own.
    const save = this.game.take_pending_save();
    if (save) persist(save);
    return 0; // clients don't tick; they render interpolated snapshots
  }

  stop() {
    super.stop();
    this.link?.close();
  }
}

// ---- base64 for carrying binary game data through JSON WebSocket frames ----
function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/// A client connected over the DO relay tier instead of direct WebRTC. The
/// host's per-viewpoint snapshots/events arrive via `relay-down`; our inputs
/// and UI actions go back via `relay-up`. Same sim/interpolation as a direct
/// client — only the transport differs. Higher latency than P2P, but the
/// browser host serves us through one DO socket instead of a 25th WebRTC link,
/// which is how a world scales past the direct cap.
export class RelayClientSession extends BaseSession {
  constructor(deps, { save, signaling, selfId, name }) {
    super(deps);
    this.signaling = signaling;
    this.selfId = selfId;
    this.name = name;
    this.save = save ?? null;
    this.lastInputSent = 0;
    this.lastButtons = -1;
    this.rttMs = null;
    this._lastPing = 0;
  }

  async start() {
    // Host -> us: snapshots, events, save pushes, welcome handshake.
    this.signaling.on('relay-down', (m) => this._onDown(m));

    const slot = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host did not respond (relay)')), 10000);
      this._onWelcome = (msg) => {
        clearTimeout(timer);
        if (msg.t === 'welcome') resolve(msg.slot);
        else reject(new Error(msg.reason ?? 'rejected by host'));
      };
      // Hello rides relay-up as JSON (host distinguishes it from binary input).
      this._sendUp({
        t: 'hello',
        name: this.name,
        save: this.save,
        contentHash: this.game.content_hash().toString(16),
      });
    });
    this.slot = slot;
    this.game.set_local_slot(slot);
    super.start();
    return slot;
  }

  _onDown(m) {
    if (this.stopped) return;
    // A control message (welcome/reject/pong) arrives as {json}; game data as
    // {data} (base64-encoded snapshot/event bytes).
    if (m.json) {
      if (m.json.t === 'pong') {
        // Round-trip through the DO completed; smooth the RTT estimate.
        const rtt = performance.now() - m.json.ts;
        this.rttMs = this.rttMs === null ? Math.round(rtt) : Math.round(this.rttMs * 0.7 + rtt * 0.3);
      } else {
        this._onWelcome?.(m.json);
      }
    } else if (typeof m.data === 'string') {
      this.game.apply_host_msg(b64decode(m.data), performance.now());
    }
  }

  _sendUp(obj) {
    // obj is either a JSON control message or {bin: Uint8Array}.
    if (obj.bin) {
      this.signaling.send({ t: 'relay-up', data: b64encode(obj.bin) });
    } else {
      this.signaling.send({ t: 'relay-up', json: obj });
    }
  }

  sendUiAction(json) {
    this._sendUp({ bin: this.game.encode_ui_action(json) });
  }

  _sampleNet() {
    /* RTT is sampled inline via ping/pong in update(); nothing to poll here. */
  }

  netInfo() {
    const rtt = this.rttMs === null ? '—' : this.rttMs;
    return `net: relayed · rtt ~${rtt}ms`;
  }

  update(now) {
    const buttons = this.input.read();
    // The relay transport (DO WebSocket) is reliable+ordered, so a sent input
    // always arrives and the host holds it until the next change. No keepalive
    // is needed — unlike the lossy WebRTC channel — which keeps idle relay
    // clients from each flooding the host's single socket 10×/s. We still send
    // a rare heartbeat so the host's last-seen timer doesn't consider us idle.
    const changed = buttons !== this.lastButtons;
    if (changed || now - this.lastInputSent > RELAY_HEARTBEAT_MS) {
      this._sendUp({ bin: this.game.encode_input(buttons) });
      this.lastButtons = buttons;
      this.lastInputSent = now;
    }
    // Measure the relay round-trip every RELAY_PING_MS so the HUD shows real
    // latency and the host can later rebalance struggling clients.
    if (now - this._lastPing > RELAY_PING_MS) {
      this._lastPing = now;
      this._sendUp({ t: 'ping', ts: now });
    }
    const save = this.game.take_pending_save();
    if (save) persist(save);
    return 0;
  }

  stop() {
    super.stop();
  }
}
