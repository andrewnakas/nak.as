// World orchestrator: connects to a peer-hosted MMO world and runs the
// right session role, handling host migration.
//
// Flow: ask the lobby for a world -> open its signaling socket -> send
// 'join'. The server replies 'host' (you're the first peer; host the sim)
// or 'joined' (connect to the existing host). If the host later leaves, the
// server promotes someone; that peer gets 'you-are-host' and rebuilds as a
// host, and everyone else gets 'host-migrated' and reconnects to the new
// host. Characters persist through all of this (cloud/local saves).

import { Game } from '../pkg/naks_awakening.js';
import { Signaling } from './net/signaling.js';
import { findWorld } from './api.js';
import { HostSession, ClientSession, RelayClientSession } from './session.js';
import { loadStartingSave } from './saves.js';
import { setStatus, showWorld, showConnecting, hideConnecting } from './ui.js';

const ROLE_HOST = 0;
const ROLE_CLIENT = 1;

export class World {
  constructor({ worldJson, input, renderer, audio, debugEl, name }) {
    this.deps = { worldJson, input, renderer, audio, debugEl };
    this.name = name;
    this.signaling = null;
    this.session = null;
    this.code = null;
    this.selfId = null;
    this.reconnecting = false;
  }

  async join() {
    setStatus('finding a world…');
    // Tag the world request with our content version so the lobby only ever
    // groups peers running the same build — no cross-version mismatches.
    this.version = this._contentVersion();
    this.code = await findWorld(undefined, this.version);
    await this._connect();
  }

  /// A short, stable version tag derived from the content hash of a throwaway
  /// Game instance. Same build => same tag on every device.
  _contentVersion() {
    const g = new Game(this.deps.worldJson, 0, 0n);
    return g.content_hash().toString(16).slice(0, 8);
  }

  async _connect() {
    // Fresh signaling socket per (re)connect.
    this.signaling?.close();
    this.signaling = new Signaling(this.code);

    // Persistent membership/migration handlers (set before join).
    this.signaling.on('host-migrated', (m) => this._onHostMigrated(m));
    this.signaling.on('you-are-host', (m) => this._onPromoted(m));
    this.signaling.on('_closed', () => this._onSocketClosed());

    await this.signaling.connect();
    setStatus('joining the world…');

    const reply = await this.signaling.request(
      { t: 'join', name: this.name },
      ['host', 'joined', 'joined-relay'],
    );
    this.selfId = reply.self_id;

    if (reply.t === 'host') {
      await this._startHost();
    } else if (reply.t === 'joined-relay') {
      // World is past the host's direct cap — we play over the DO relay.
      await this._startRelayClient(reply.self_id);
    } else {
      try {
        await this._startClient(reply.host_id);
      } catch (err) {
        if (/version mismatch/i.test(err.message)) {
          return this._handleVersionMismatch();
        }
        // Couldn't reach the host (ghost/stale host in this world). Don't
        // bubble up and dump the player back to the menu — find another
        // world instead. Mark this one so the lobby skips it.
        if (this._refindCount < 4) {
          this._refindCount = (this._refindCount || 0) + 1;
          setStatus('that world was unreachable — finding another…', true);
          this.code = await findWorld(this.code, this.version); // exclude the dead one
          return this._connect();
        }
        // Repeatedly failing — likely our own network blocks WebRTC entirely.
        setStatus(
          "couldn't reach any world host. your network may block peer connections — try another network.",
          true,
        );
        throw err;
      }
    }
    this._refindCount = 0;
    setStatus('');
    showWorld(this.code, reply.t === 'host');
  }

  /// Join over the relay tier: snapshots arrive through the signaling socket
  /// (relay-down), inputs go back the same way (relay-up). No WebRTC link.
  async _startRelayClient(selfId) {
    const save = await this._save();
    const game = new Game(this.deps.worldJson, ROLE_CLIENT, 0n);
    const session = new RelayClientSession(
      { ...this.deps, game },
      { save, signaling: this.signaling, selfId, name: this.name },
    );
    setStatus('joining the world…');
    showConnecting('joining the world…');
    await session.start();
    this.session = session;
    this._installInventory();
    hideConnecting();
  }

  /// Host runs a different build than us. Reload once to pull fresh assets
  /// (fixes the common case where our tab is stale); if that doesn't help,
  /// host our own fresh world so the player still gets in.
  async _handleVersionMismatch() {
    const KEY = 'naks_reloaded_for_version';
    if (!sessionStorage.getItem(KEY)) {
      sessionStorage.setItem(KEY, '1');
      setStatus('updating to the latest version…');
      // Cache-bust reload so the CDN gives us the newest files.
      location.reload();
      return;
    }
    // Already reloaded once and still mismatched — the host is the stale one.
    // Start our own fresh world rather than dead-end on a black screen.
    sessionStorage.removeItem(KEY);
    setStatus('starting a fresh world on this version…');
    await this._startHost();
    showWorld(this.code, true);
  }

  async _save() {
    return loadStartingSave(this.name);
  }

  async _startHost() {
    const save = await this._save();
    const game = new Game(this.deps.worldJson, ROLE_HOST, randomSeed());
    const session = new HostSession({ ...this.deps, game }, { save });
    session.attachSignaling(this.signaling);
    session.start();
    this.session = session;
    this._installInventory();
  }

  async _startClient(hostId) {
    this.hostId = hostId;
    const save = await this._save();
    const game = new Game(this.deps.worldJson, ROLE_CLIENT, 0n);
    const session = new ClientSession(
      { ...this.deps, game },
      {
        save,
        onDisconnect: () => {
          // Our WebRTC link to the host died (past the ICE-restart grace).
          // The host may still be alive (our side blipped) — try reconnecting
          // to the same host first over the still-open signaling socket;
          // only re-find a world if the host is genuinely gone.
          if (!this.reconnecting) this._reconnectToHost();
        },
      },
    );
    setStatus('connecting to the world host…');
    showConnecting('connecting to the world…');
    const slot = await session.connect(this.signaling, hostId, this.name);
    game.set_local_slot(slot);
    session.start();
    this.session = session;
    this._installInventory();
    // Connected cleanly — clear the one-shot reload guard so a future deploy
    // can trigger a refresh again.
    sessionStorage.removeItem('naks_reloaded_for_version');
    this._reconnectTries = 0;

    // Watchdog: if no snapshot has advanced the tick within a few seconds,
    // the WebRTC path silently failed (strict NAT). Hide the black screen
    // behind a clear message and re-find a world rather than sit there.
    this._snapshotWatch(session);
  }

  /// The WebRTC link to the host dropped but the world/signaling is still up.
  /// Re-establish a fresh peer connection to the same host (keeping our world,
  /// slot, and character) before giving up and re-finding a world.
  async _reconnectToHost() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this._reconnectTries = (this._reconnectTries || 0) + 1;
    this.session?.stop();

    // After a few failed same-host reconnects the host is probably gone —
    // wait briefly for a server host-migration, else re-find a world.
    if (this._reconnectTries > 3 || !this.signaling || this.signaling.ws?.readyState !== 1) {
      this.reconnecting = false;
      setStatus('lost the host — finding a world…', true);
      return this._refind();
    }

    setStatus('reconnecting to the host…');
    showConnecting('reconnecting…');
    try {
      this.reconnecting = false; // _startClient sets its own guards
      await this._startClient(this.hostId);
    } catch {
      // Couldn't reach the same host — fall back to re-finding a world.
      this._refind();
    }
  }

  _snapshotWatch(session) {
    clearInterval(this._watch);
    let waited = 0;
    this._watch = setInterval(() => {
      if (this.session !== session || session.stopped) {
        clearInterval(this._watch);
        return;
      }
      const t = session.game.tick_count();
      if (t > 0) {
        hideConnecting();
        clearInterval(this._watch);
        return;
      }
      waited += 1;
      if (waited === 4) showConnecting('still connecting… (strict network?)');
      if (waited >= 9) {
        clearInterval(this._watch);
        setStatus('could not reach the world host — finding another…', true);
        this._refind();
      }
    }, 1000);
  }

  _installInventory() {
    // Lazy import to avoid a cycle (ui.js imports api.js imports nothing
    // circular, but InventoryUI references session methods we now have).
    import('./ui.js').then(({ InventoryUI }) => new InventoryUI(this.session));
  }

  async _onHostMigrated(m) {
    // The host changed. Tear down our session and reconnect to the new host
    // (still on the same signaling socket, same world). Direct clients re-peer
    // to the new host; relay clients re-join (they may now be a direct client
    // if the world shrank, or stay relayed).
    if (this.reconnecting) return;
    this.reconnecting = true;
    setStatus('host changed — reconnecting…');
    const wasRelay = this.session instanceof RelayClientSession;
    this.session?.stop();
    try {
      if (wasRelay) {
        // Re-join: the server re-classifies us (direct vs relay) for the new host.
        this.reconnecting = false;
        await this._connect();
      } else {
        await this._startClient(m.host_id);
        this.reconnecting = false;
      }
    } catch {
      this.reconnecting = false;
      this._refind();
    }
  }

  async _onPromoted() {
    // We were promoted to host. Rebuild as a host session; the world's
    // enemies reset (they respawn anyway), players keep their characters.
    this.reconnecting = true;
    this.session?.stop();
    setStatus('you are now hosting this world…');
    await this._startHost();
    showWorld(this.code, true);
    this.reconnecting = false;
  }

  _onSocketClosed() {
    // For direct clients/hosts the signaling socket is only needed during
    // connect + for migration events, so a close while playing is survivable
    // (the WebRTC link carries the game). For a RELAY client the socket IS the
    // game transport, so a close means we must reconnect.
    if (this.reconnecting || this._shuttingDown) return;
    const relay = this.session instanceof RelayClientSession;
    if (!relay && this.session && this.session.game.tick_count() > 0) return; // direct, playing
    this._refind();
  }

  /// Find a fresh world, with exponential backoff so a failing network can't
  /// spin a reconnect storm.
  async _refind() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.session?.stop();

    this._attempts = (this._attempts || 0) + 1;
    if (this._attempts > 8) {
      setStatus(
        "couldn't reach the world — your network may block peer connections. try another network or reload.",
        true,
      );
      this.reconnecting = false;
      return;
    }
    const backoff = Math.min(1000 * 2 ** (this._attempts - 1), 15000);
    await new Promise((r) => setTimeout(r, backoff));

    try {
      this.code = await findWorld(undefined, this.version);
      this.reconnecting = false;
      await this._connect();
      this._attempts = 0; // connected — reset
    } catch (err) {
      this.reconnecting = false;
      setStatus(`couldn't reach the world: ${err.message}`, true);
      // try again after backoff
      this._onSocketClosed();
    }
  }
}

function randomSeed() {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}
