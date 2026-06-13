// Game session orchestration. Solo play is a HostSession with no peers —
// the same authoritative code path runs alone or with a party.

import { TICK_MS, MAX_CATCHUP_TICKS } from './config.js';
import { PeerLink } from './net/rtc.js';
import { toast } from './ui.js';
import { persist } from './saves.js';

const SNAPSHOT_EVERY = 3; // host ticks between snapshots (60/3 = 20 Hz)
const INPUT_KEEPALIVE_MS = 100;
const AUTOSAVE_TICKS = 900; // 15s

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
          const inDungeon = at[0] >= 10 && at[1] >= 10;
          this.audio.setTrack(
            at[0] === 13 && at[1] === 12 ? 'boss' : inDungeon ? 'dungeon' : 'overworld',
          );
        }
      }
      if (this.debugEl && this.game.tick_count() % 30 === 0) {
        this.debugEl.textContent =
          `tick ${this.game.tick_count()}\n` +
          `hash ${this.game.state_hash().toString(16)}\n` +
          `slot ${this.slot}`;
      }
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
      if (!peer) {
        // First signal from a new joiner: answer their offer.
        const link = new PeerLink(signaling, m.from, false);
        peer = { link, slot: -1, name: this.pendingNames.get(m.from) ?? 'player' };
        this.peers.set(m.from, peer);
        link.onR = (text) => this._handleReliable(peer, text);
        link.onU = (data) => {
          if (peer.slot >= 0) this.game.handle_client_msg(peer.slot, new Uint8Array(data));
        };
        link.onClosed = () => this._dropPeer(m.from);
      }
      await peer.link.handleSignal(m.payload);
    });
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
    if (msg.t === 'hello') {
      if (msg.contentHash !== this.game.content_hash().toString(16)) {
        peer.link.sendR({ t: 'reject', reason: 'version mismatch — reload the page' });
        return;
      }
      const slot = this._freeSlot();
      if (slot < 0) {
        peer.link.sendR({ t: 'reject', reason: 'party is full' });
        return;
      }
      peer.slot = slot;
      peer.name = String(msg.name ?? peer.name).slice(0, 16);
      if (typeof msg.save === 'string' && msg.save) {
        this.game.add_player_with_save(slot, msg.save);
      } else {
        this.game.add_player(slot);
      }
      peer.link.sendR({ t: 'welcome', slot, contentHash: msg.contentHash });
      this.onPartyChange?.(this.partyList());
    }
  }

  _freeSlot() {
    const used = new Set([0, ...[...this.peers.values()].map((p) => p.slot)]);
    for (let s = 1; s < 4; s++) if (!used.has(s)) return s;
    return -1;
  }

  _dropPeer(remoteId) {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    if (peer.slot >= 0) this.game.remove_player(peer.slot);
    peer.link.close();
    this.peers.delete(remoteId);
    this.onPartyChange?.(this.partyList());
  }

  partyList() {
    return [{ slot: 0, name: 'you' }].concat(
      [...this.peers.values()]
        .filter((p) => p.slot >= 0)
        .map((p) => ({ slot: p.slot, name: p.name })),
    );
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
        const snap = this.game.snapshot_bytes();
        for (const peer of this.peers.values()) {
          if (peer.slot >= 0) peer.link.sendU(snap);
        }
        const events = this.game.drain_events_bytes();
        if (events.length) {
          for (const peer of this.peers.values()) {
            if (peer.slot >= 0) peer.link.sendRBytes(events);
          }
        }
      }
      // Autosave: the host persists its own character and pushes each
      // remote player their authoritative save to upload themselves.
      if (this.game.tick_count() % AUTOSAVE_TICKS === 0) {
        persist(this.game.export_save(0));
        for (const peer of this.peers.values()) {
          if (peer.slot >= 0) peer.link.sendRBytes(this.game.encode_save_state(peer.slot));
        }
      }
    }
    return acc >= TICK_MS ? 0 : acc;
  }

  stop() {
    super.stop();
    for (const peer of this.peers.values()) peer.link.close();
    this.signaling?.close();
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

    // Post-handshake, the reliable channel carries binary game events.
    this.link.onR = (data) => {
      if (typeof data !== 'string') {
        this.game.apply_host_msg(new Uint8Array(data), performance.now());
      }
    };

    this.slot = slot;
    // Mesh is up; the client no longer needs the signaling socket.
    signaling.close();
    return slot;
  }

  _disconnected() {
    if (!this.stopped) {
      this.stop();
      this.onDisconnect?.();
    }
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
