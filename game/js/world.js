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
import { HostSession, ClientSession } from './session.js';
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
    this.code = await findWorld();
    await this._connect();
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
      ['host', 'joined'],
    );
    this.selfId = reply.self_id;

    if (reply.t === 'host') {
      await this._startHost();
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
          this.code = await findWorld(this.code); // exclude the dead one
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
    const save = await this._save();
    const game = new Game(this.deps.worldJson, ROLE_CLIENT, 0n);
    const session = new ClientSession(
      { ...this.deps, game },
      {
        save,
        onDisconnect: () => {
          // The host vanished without a clean migration (e.g. crash). The
          // server will promote someone; we wait for host-migrated, but if
          // nothing comes, re-find a world.
          if (!this.reconnecting) {
            setStatus('host disconnected — finding a new world…', true);
            this._refind();
          }
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

    // Watchdog: if no snapshot has advanced the tick within a few seconds,
    // the WebRTC path silently failed (strict NAT). Hide the black screen
    // behind a clear message and re-find a world rather than sit there.
    this._snapshotWatch(session);
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
    // The host changed. Tear down our client session and reconnect to the
    // new host (still on the same signaling socket, same world).
    if (this.session?.slot !== undefined && this.session instanceof ClientSession) {
      this.reconnecting = true;
      this.session.stop();
      setStatus('host changed — reconnecting…');
      try {
        await this._startClient(m.host_id);
      } catch {
        this._refind();
      }
      this.reconnecting = false;
    }
  }

  async _onPromoted() {
    // We were promoted to host. Rebuild as a host session; the world's
    // enemies reset (they respawn anyway), players keep their characters.
    this.reconnecting = true;
    this.session?.stop();
    setStatus('you are now hosting this world…');
    await this._startHost();
    this.reconnecting = false;
  }

  _onSocketClosed() {
    // Signaling socket dropped entirely (network blip). Re-find a world.
    if (!this.reconnecting && !this._shuttingDown) {
      this._refind();
    }
  }

  async _refind() {
    this.reconnecting = true;
    this.session?.stop();
    try {
      this.code = await findWorld();
      await this._connect();
    } catch (err) {
      setStatus(`couldn't reach the world: ${err.message}`, true);
    }
    this.reconnecting = false;
  }
}

function randomSeed() {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}
