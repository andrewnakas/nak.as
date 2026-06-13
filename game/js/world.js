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
import { setStatus, showWorld } from './ui.js';

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
      await this._startClient(reply.host_id);
    }
    setStatus('');
    showWorld(this.code, reply.t === 'host');
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
    const slot = await session.connect(this.signaling, hostId, this.name);
    game.set_local_slot(slot);
    session.start();
    this.session = session;
    this._installInventory();
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
