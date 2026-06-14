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
import { Minimap } from './minimap.js';

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
        // The direct WebRTC link didn't come up. Two causes look the same here:
        // (a) our network blocks UDP/TURN (very common on strict/corporate/mobile
        // networks that still pass this WebSocket), or (b) the host is a ghost.
        // Try the RELAY tier to the same host first — it rides the working
        // signaling socket, so case (a) players still get in. Only if relay also
        // fails (no real host) do we re-find a world.
        if (!this._triedRelay && reply.host_id) {
          this._triedRelay = true;
          setStatus('peer link blocked — connecting through the relay…', true);
          try {
            await this._requestRelayFallback();
            this._refindCount = 0;
            this._triedRelay = false;
            setStatus('');
            showWorld(this.code, false);
            return;
          } catch {
            // relay didn't take either — fall through to re-find
          }
        }
        // Couldn't reach the host at all (ghost/stale host in this world). Don't
        // bubble up and dump the player back to the menu — find another world.
        if (this._refindCount < 4) {
          this._refindCount = (this._refindCount || 0) + 1;
          this._triedRelay = false;
          setStatus('that world was unreachable — finding another…', true);
          this.code = await findWorld(this.code, this.version); // exclude the dead one
          return this._connect();
        }
        // Repeatedly failing — likely our network blocks both WebRTC and the
        // relay path (rare). Give clear guidance.
        setStatus(
          "couldn't reach any world host. your network may block connections — try another network.",
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

  /// WebRTC fallback: our direct link to the host failed (network blocks
  /// UDP/TURN), so ask the room to serve us over the relay tier on the same
  /// signaling socket. Resolves once we're ticking as a relay client; rejects
  /// if no host is actually present (so the caller can re-find a world).
  async _requestRelayFallback() {
    // Tear down any half-built direct session first.
    this.session?.stop();
    this.session = null;
    const reply = await this.signaling.request({ t: 'request-relay' }, ['joined-relay']);
    if (!reply.host_id) throw new Error('no host to relay through');
    await this._startRelayClient(reply.self_id);
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

  /// Set up the discovered-screens minimap and a per-frame update that tracks
  /// the local player's screen + draws other players (party-colored) as dots.
  _startMinimap(localSlot) {
    const worldObj = JSON.parse(this.deps.worldJson);
    this._map = new Minimap(worldObj, this.name);
    const mm = document.getElementById('minimap');
    if (mm) mm.hidden = false;

    this.session.onFrame = () => {
      const v = this.session.game.visible_players?.() ?? [];
      let self = null;
      const others = [];
      for (let i = 0; i + 5 <= v.length; i += 5) {
        const slot = v[i],
          sx = v[i + 1],
          sy = v[i + 2];
        if (slot === localSlot) self = { sx, sy };
        else others.push({ sx, sy, party: this._party?.has(slot) ?? false });
      }
      // Auto-follow a party member across screen changes.
      this._followTick(v, localSlot);
      if (self) this._map.visit(self.sx, self.sy);
      // Throttle the actual draw to ~6/s; visit() already redraws on discovery.
      const now = performance.now();
      if (now - (this._mapDrawAt || 0) > 160) {
        this._mapDrawAt = now;
        this._map.render(self, others);
        // Surface voice diagnostics in the debug overlay (helps debug on real
        // devices: shows mic state + each peer's connection/ICE state).
        const dbg = this.deps.debugEl;
        if (dbg && this._voice && dbg.style.display !== 'none') {
          let line = dbg.querySelector('#voice-dbg');
          if (!line) {
            line = document.createElement('div');
            line.id = 'voice-dbg';
            dbg.appendChild(line);
          }
          line.textContent = this._voice.status();
        }
      }
    };
  }

  /// Stand up the proximity-voice mesh for our local player at `localSlot`.
  /// The mic stays OFF until the player toggles voice on (privacy); this just
  /// prepares the mesh and its slot->id roster so toggling is instant.
  _startVoice(localSlot) {
    if (this._voice || !navigator.mediaDevices?.getUserMedia) return;
    // slot -> signaling id, kept current from the host roster (client) or our
    // own peer map (host). `_rosterEntries` keeps the full {slot,id,name} list
    // for the party UI; `_slotToId` is the id lookup the voice mesh needs.
    this._slotToId = new Map();
    this._rosterEntries = [];
    this._voiceRoster = (entries) => {
      this._slotToId = new Map(entries.map((e) => [e.slot, e.id]));
      this._rosterEntries = entries;
      this._onRosterUpdate?.();
    };

    const localPos = () => {
      const v = this.session?.game.visible_players?.() ?? [];
      for (let i = 0; i + 5 <= v.length; i += 5) {
        if (v[i] === localSlot) return { slot: localSlot, sx: v[i + 1], sy: v[i + 2], x: v[i + 3], y: v[i + 4] };
      }
      return null;
    };
    const allPlayers = () => {
      const v = this.session?.game.visible_players?.() ?? [];
      const out = [];
      for (let i = 0; i + 5 <= v.length; i += 5) {
        out.push({ slot: v[i], sx: v[i + 1], sy: v[i + 2], x: v[i + 3], y: v[i + 4] });
      }
      return out;
    };
    const resolvePeerId = (slot) => {
      // Host knows ids directly from its peer map; clients use the roster.
      if (this.session?.peers) {
        if (slot === 0) return this.selfId;
        for (const p of this.session.peers.values()) if (p.slot === slot) return p.id;
      }
      return this._slotToId.get(slot) ?? null;
    };

    // Build the mesh lazily on first toggle: that click both unlocks audio and
    // is the user gesture getUserMedia needs. The toggle calls this factory.
    const makeMesh = async () => {
      if (this._voice) return this._voice;
      this.deps.audio?.unlock?.();
      const audioCtx = this.deps.audio?.ctx;
      if (!audioCtx) throw new Error('audio not ready');
      const { VoiceMesh } = await import('./net/voice.js');
      this._voice = new VoiceMesh({
        signaling: this.signaling,
        getLocal: localPos,
        getPlayers: allPlayers,
        resolvePeerId,
        audioCtx,
      });
      this._voice.setSelfId(this.selfId);
      return this._voice;
    };
    import('./ui.js').then(({ installVoiceToggle, installAudioControls }) => {
      installAudioControls?.(this.deps.audio);
      installVoiceToggle?.(makeMesh, this.deps.audio);
    });
  }

  /// Stand up the party system: a clickable world roster (invite players),
  /// invite/accept prompts over signaling, and the derived party set that
  /// drives always-on voice, minimap coloring, and warp/follow.
  _startParty(localSlot) {
    this._localSlot = localSlot;
    const idToSlot = (id) => this._rosterEntries.find((e) => e.id === id)?.slot;
    const nameOf = (id) => this._rosterEntries.find((e) => e.id === id)?.name ?? 'player';

    this._party = new Set(); // member SLOTS (consumed by minimap + voice)
    import('./net/party.js').then(({ Party }) => {
      this._partyMgr = new Party({
        signaling: this.signaling,
        selfId: this.selfId,
        nameOf,
        onChange: () => {
          // Re-derive the slot set from member ids, then push to voice/minimap.
          const slots = new Set();
          for (const id of this._partyMgr.members) {
            const s = idToSlot(id);
            if (s != null) slots.add(s);
          }
          this._party = slots;
          this._voice?.setAlwaysHear?.([...slots]);
          this._renderRoster?.();
        },
        onInvite: ({ id, name }) => {
          import('./ui.js').then(({ confirmToast }) =>
            confirmToast(`${name} invites you to a party`, 'JOIN', 'NO', (ok) =>
              ok ? this._partyMgr.accept(id) : this._partyMgr.decline(id),
            ),
          );
        },
      });
      // When the roster changes (someone joins/leaves), re-resolve party slots
      // and redraw the clickable list.
      this._onRosterUpdate = () => {
        this._partyMgr.onChange();
        this._renderRoster?.();
      };
      this._installRosterUI();
    });
  }

  /// Build the clickable world-roster panel: every other player is a row with
  /// an INVITE button (or a party badge), plus WARP/FOLLOW for party members.
  _installRosterUI() {
    import('./ui.js').then(({ installPartyRoster }) => {
      this._renderRoster = installPartyRoster({
        roster: () => this._rosterEntries,
        localSlot: () => this._localSlot,
        party: () => this._party,
        slotToId: (slot) => this._slotToId.get(slot),
        invite: (id) => this._partyMgr?.invite(id),
        leave: () => this._partyMgr?.leave(),
        warpTo: (slot) => this._warpToMember(slot),
        follow: (slot) => this._toggleFollow(slot),
        following: () => this._followSlot,
      });
      this._renderRoster();
    });
  }

  /// Teleport our local player to a party member (sim 'warp' ui_action; the
  /// host resolves the target's live position authoritatively).
  _warpToMember(slot) {
    this.session?.sendUiAction(JSON.stringify({ action: 'warp', a: slot }));
  }

  /// Toggle auto-follow of a party member. While following, we warp to them
  /// whenever they cross into a screen different from ours (see _followTick).
  _toggleFollow(slot) {
    this._followSlot = this._followSlot === slot ? null : slot;
    this._followLastScreen = null;
  }

  /// Called from the minimap frame loop. If following a member, warp when they
  /// change screens (and aren't already with us). Throttled to avoid spamming.
  _followTick(visible, localSlot) {
    if (this._followSlot == null) return;
    let me = null;
    let them = null;
    for (let i = 0; i + 5 <= visible.length; i += 5) {
      if (visible[i] === localSlot) me = { sx: visible[i + 1], sy: visible[i + 2] };
      else if (visible[i] === this._followSlot) them = { sx: visible[i + 1], sy: visible[i + 2] };
    }
    // Stop following if they've left the world (no longer in the roster).
    if (!this._party?.has(this._followSlot)) {
      this._followSlot = null;
      return;
    }
    if (!them || !me) return;
    const theirScreen = `${them.sx},${them.sy}`;
    const sameScreen = me.sx === them.sx && me.sy === them.sy;
    const now = performance.now();
    if (!sameScreen && theirScreen !== this._followLastScreen && now - (this._followAt || 0) > 1500) {
      this._followLastScreen = theirScreen;
      this._followAt = now;
      this._warpToMember(this._followSlot);
    }
  }

  async _startHost() {
    const save = await this._save();
    const game = new Game(this.deps.worldJson, ROLE_HOST, randomSeed());
    const session = new HostSession({ ...this.deps, game }, { save });
    session.selfId = this.selfId;
    session.selfName = this.name;
    session.attachSignaling(this.signaling);
    session.start();
    this.session = session;
    this._installInventory();
    this._startVoice(0);
    session.onVoiceRoster = (entries) => this._voiceRoster?.(entries);
    this._startParty(0);
    this._startMinimap(0);
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
    let slot;
    try {
      slot = await session.connect(this.signaling, hostId, this.name);
    } catch (err) {
      // Close the half-open peer connection so it can't leak ICE candidates or
      // fire a late onDisconnect that races the relay fallback.
      session.stop();
      throw err;
    }
    game.set_local_slot(slot);
    session.start();
    this.session = session;
    this._installInventory();
    // Proximity voice: the host pushes a slot->id roster over the reliable
    // channel; feed it to the mesh so we can build voice links to nearby peers.
    session.onVoiceRoster = (entries) => this._voiceRoster?.(entries);
    this._startVoice(slot);
    this._startParty(slot);
    this._startMinimap(slot);
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
