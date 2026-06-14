// Proximity voice chat over a direct-client WebRTC mesh.
//
// The game's transport is a star (everyone ↔ host), but voice wants nearby
// players to hear each other directly. So this module maintains a SEPARATE set
// of voice-only RTCPeerConnections between players who are in range, signalled
// through the RoomDO on a dedicated `voice-signal` namespace (so voice SDP/ICE
// never collides with the game link).
//
// Each tick of the proximity update:
//   - read every visible player's position from the sim (visible_players())
//   - players within VOICE_RANGE on the same screen should have a voice link;
//     those out of range get torn down.
//   - incoming remote audio is panned + attenuated by the peer's position
//     relative to the local player, so a voice fades with distance and sits
//     left/right by where the speaker is.
//
// Privacy: the mic is OFF until the player explicitly enables voice (toggle).
// We never capture audio without that opt-in.

import { getIceConfig, iceConfigSync } from './rtc.js';

const VOICE_RANGE_PX = 360; // distance at which a non-party voice fades to silence
const PROXIMITY_HZ = 4; // how often to re-evaluate proximity / volumes
// A voice link that never reaches `connected` within this window is torn down
// and retried, so a one-off ICE failure self-heals instead of sitting dead.
const VOICE_CONNECT_TIMEOUT_MS = 12000;

export class VoiceMesh {
  /// signaling: the world's Signaling socket (carries voice-signal).
  /// getLocal: () => { slot, x, y, sx, sy } | null  — listener position.
  /// getPlayers: () => Array<{ slot, sx, sy, x, y }> — all visible players.
  /// resolvePeerId: (slot) => remoteId|null — map a sim slot to a signaling id.
  constructor({ signaling, getLocal, getPlayers, resolvePeerId, audioCtx }) {
    this.signaling = signaling;
    this.getLocal = getLocal;
    this.getPlayers = getPlayers;
    this.resolvePeerId = resolvePeerId;
    this.ctx = audioCtx;
    this.enabled = false;
    this.micStream = null;
    this.peers = new Map(); // remoteId -> VoicePeer
    this._timer = null;
    this._selfId = null;
    // Managed-TURN ICE config (fetched on enable); static fallback until then.
    this._iceConfig = iceConfigSync();

    // All voice routes through one gain so a master mute is instant.
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);

    this.signaling.on('voice-signal', (m) => this._onSignal(m));
    // A peer leaving the world tears down its voice link too.
    this.signaling.on('peer-left', (m) => this._drop(m.id));
    this.signaling.on('relay-client-left', (m) => this._drop(m.id));
  }

  setSelfId(id) {
    this._selfId = id;
  }

  /// How many nearby peers we currently have a LIVE voice connection to.
  connectedCount() {
    let n = 0;
    for (const p of this.peers.values()) {
      if (p.pc?.connectionState === 'connected') n++;
    }
    return n;
  }

  /// Human-readable voice diagnostics for the debug overlay (so a real-device
  /// tester can report exactly where it's stuck).
  status() {
    if (!this.enabled) return 'voice: off';
    const mic = this.micStream ? 'mic✓' : 'mic✗';
    const turn = this._iceConfig?.iceServers?.some((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith('turn')),
    )
      ? 'turn✓'
      : 'turn✗';
    const policy = this._iceConfig?.iceTransportPolicy === 'relay' ? ' relay-only' : '';
    const peers = [...this.peers.values()].map(
      (p) =>
        `${p.remoteId.slice(0, 4)}:${p.pc?.connectionState ?? '?'}/${p.pc?.iceConnectionState ?? '?'}${p.candType ? '/' + p.candType : ''}`,
    );
    return `voice: ${mic} ${turn}${policy} peers[${peers.join(' ')}]`;
  }

  /// Turn the mic on (asks permission the first time) and start meshing.
  /// MUST be called from a user gesture (the toggle click) so iOS lets us both
  /// resume the AudioContext and later play remote audio elements.
  async enable() {
    if (this.enabled) return;
    // Resume audio inside the gesture (iOS requires this synchronously-ish).
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    // Fetch managed-TURN credentials so cross-NAT / hairpin-broken pairs relay.
    this._iceConfig = await getIceConfig().catch(() => iceConfigSync());
    if (!this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      // Attach the live mic to any peers created before permission resolved.
      for (const peer of this.peers.values()) peer.attachMic?.(this.micStream);
    }
    this.enabled = true;
    if (!this._timer) {
      this._timer = setInterval(() => this._updateProximity(), 1000 / PROXIMITY_HZ);
    }
  }

  /// Mute the mic (keeps connections so unmuting is instant) — or fully stop.
  setMuted(muted) {
    this.enabled = !muted;
    for (const track of this.micStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    // When muted we keep voice links so we still HEAR others; only our mic is
    // silenced (track.enabled=false sends silence).
  }

  /// Stop everything (leaving the world).
  stop() {
    clearInterval(this._timer);
    this._timer = null;
    for (const id of [...this.peers.keys()]) this._drop(id);
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micStream = null;
    this.enabled = false;
  }

  // ---- proximity meshing ----

  /// Force-connect to a specific slot regardless of distance (party voice).
  /// alwaysHear[slot] = true keeps the link up + at full volume.
  setAlwaysHear(slots) {
    this._always = new Set(slots ?? []);
  }

  _updateProximity() {
    if (!this.enabled) return;
    const me = this.getLocal();
    if (!me) return;
    const inRange = new Set();
    for (const p of this.getPlayers()) {
      if (p.slot === me.slot) continue;
      const id = this.resolvePeerId(p.slot);
      if (!id || id === this._selfId) continue;
      const partyAlways = this._always?.has(p.slot);
      // Connect to EVERY direct player in the world when voice is on; distance
      // only controls VOLUME (and party members stay full volume anywhere).
      // Connecting broadly — rather than only to pixel-adjacent players — is
      // what makes voice actually usable: you hear people as you wander near,
      // and "is my voice even working" no longer depends on standing on someone.
      const dx = (p.x - me.x) / 256 + (p.sx - me.sx) * 160; // include screen offset
      const dy = (p.y - me.y) / 256 + (p.sy - me.sy) * 128;
      const dist = Math.hypot(dx, dy);
      inRange.add(id);
      const peer = this.peers.get(id);
      if (peer) {
        if (partyAlways) peer.setVolume(1); // party = clear, distance-independent
        else peer.setSpatial(dx, dy, dist, VOICE_RANGE_PX);
      } else {
        // Deterministic initiator: the lexicographically-smaller id offers, so
        // both sides don't create a connection simultaneously (glare).
        const initiator = (this._selfId ?? '') < id;
        this._connect(id, initiator);
      }
    }
    // Tear down links to players no longer in range.
    for (const id of [...this.peers.keys()]) {
      if (!inRange.has(id)) this._drop(id);
    }
  }

  _connect(remoteId, initiator) {
    if (this.peers.has(remoteId)) return;
    const peer = new VoicePeer({
      remoteId,
      initiator,
      ctx: this.ctx,
      master: this.master,
      micStream: this.micStream,
      iceConfig: this._iceConfig,
      send: (payload) => this.signaling.send({ t: 'voice-signal', to: remoteId, payload }),
      // A dead link drops, then the next proximity tick re-offers it (with a
      // fresh ICE gather) — so a transient failure self-heals.
      onClosed: () => this._drop(remoteId),
    });
    this.peers.set(remoteId, peer);
  }

  _onSignal(m) {
    if (!this.enabled) return;
    let peer = this.peers.get(m.from);
    if (!peer) {
      // Incoming offer from a peer we haven't connected to yet — we're the
      // answerer.
      this._connect(m.from, false);
      peer = this.peers.get(m.from);
    }
    peer?.handleSignal(m.payload);
  }

  _drop(remoteId) {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    peer.close();
    this.peers.delete(remoteId);
  }
}

// One voice-only WebRTC connection to a nearby player, with a spatializer on
// the inbound audio so the speaker is positioned by their in-game location.
class VoicePeer {
  constructor({ remoteId, initiator, ctx, master, micStream, send, onClosed, iceConfig }) {
    this.remoteId = remoteId;
    this.ctx = ctx;
    this.send = send;
    this.onClosed = onClosed;
    this.initiator = initiator;
    this._pendingIce = [];
    this._chain = Promise.resolve();
    this._restarted = false;
    this._dead = false;
    this.pc = new RTCPeerConnection(iceConfig ?? iceConfigSync());

    // Outbound: our mic. (Track may be disabled when muted; silence flows.)
    // If the mic isn't ready yet (permission still resolving), attachMic() wires
    // it in later. We always add a transceiver so the SDP negotiates audio both
    // ways even when our mic arrives a moment after the offer.
    this._micAdded = false;
    if (micStream) this.attachMic(micStream);
    else {
      try {
        this.pc.addTransceiver('audio', { direction: 'sendrecv' });
      } catch {
        // older browsers: addTrack on attachMic will create the m-line
      }
    }

    // Inbound audio path. Cross-browser reality: WebAudio's
    // MediaStreamAudioSourceNode produces SILENCE for remote WebRTC streams on
    // Safari/iOS. So the actual playback always happens through a real <audio>
    // element (works everywhere), and we apply distance falloff via the
    // element's `volume`. Where WebAudio CAN tap an element (Chrome/Firefox) we
    // additionally route it through a StereoPanner for left/right placement;
    // iOS just gets distance-attenuated mono, which is still good proximity.
    this._el = new window.Audio();
    this._el.autoplay = true;
    this._el.volume = 0;
    // playsInline avoids iOS trying to go fullscreen for media. Attaching to the
    // DOM (off-screen) makes autoplay-after-gesture far more reliable on iOS
    // Safari than a detached element.
    this._el.setAttribute('playsinline', '');
    this._el.setAttribute('autoplay', '');
    this._el.style.display = 'none';
    document.body.appendChild(this._el);
    this._vol = 0; // last distance volume, applied to whichever sink is live
    this._panViaWebAudio = false;

    this.pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this._el.srcObject = stream;
      // Retry play a few times: the first call may be blocked until the audio
      // pipeline is ready, especially on iOS right after the enable gesture.
      const tryPlay = (n) => {
        this._el.play().catch(() => {
          if (n > 0) setTimeout(() => tryPlay(n - 1), 300);
        });
      };
      tryPlay(5);
      // Try the WebAudio panner path (desktop). If createMediaElementSource
      // throws or the browser is known-flaky, we silently stay on the element.
      try {
        if (ctx.createStereoPanner && !isIOS()) {
          this.panner = ctx.createStereoPanner();
          this.dist = ctx.createGain();
          this.dist.gain.value = 0;
          const src = ctx.createMediaElementSource(this._el);
          src.connect(this.panner);
          this.panner.connect(this.dist);
          this.dist.connect(master);
          // The element feeds WebAudio now, so mute its direct output to avoid
          // double playback; volume is controlled via the gain node instead.
          this._el.volume = 0;
          this._el.muted = true;
          this._panViaWebAudio = true;
        }
      } catch {
        this._panViaWebAudio = false;
      }
      this.setVolume(this._vol);
    };

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ ice: e.candidate });
    };
    const onState = () => this._onStateChange();
    this.pc.onconnectionstatechange = onState;
    // iceConnectionState is more granular on some browsers (Firefox); watch both.
    this.pc.oniceconnectionstatechange = onState;

    // Watchdog: if we never reach `connected`, tear down so the mesh re-offers
    // with a fresh ICE gather instead of leaving a permanently-stuck link.
    this._watchdog = setTimeout(() => {
      const s = this.pc.connectionState;
      if (s !== 'connected' && s !== 'completed') this._die();
    }, VOICE_CONNECT_TIMEOUT_MS);

    if (initiator) this._makeOffer();
  }

  _onStateChange() {
    const cs = this.pc.connectionState;
    const ice = this.pc.iceConnectionState;
    if (cs === 'connected' || ice === 'connected' || ice === 'completed') {
      clearTimeout(this._watchdog);
      this._watchdog = null;
      this._sampleCandType();
      return;
    }
    if (cs === 'failed' || ice === 'failed') {
      // One ICE restart attempt (initiator) before giving up — recovers a
      // dropped candidate path without a full re-handshake. Then the mesh's
      // proximity tick rebuilds the peer entirely if it still can't connect.
      if (this.initiator && !this._restarted && !this._dead) {
        this._restarted = true;
        this._makeOffer(true);
        return;
      }
      this._die();
      return;
    }
    if (cs === 'closed') this._die();
  }

  _die() {
    if (this._dead) return;
    this._dead = true;
    clearTimeout(this._watchdog);
    this.onClosed?.();
  }

  /// Record how this link actually connected (host = LAN, srflx = STUN/public,
  /// relay = TURN). Shown in the debug overlay so a tester can see whether a
  /// pair went LAN-direct or had to relay — the key NAT-traversal signal.
  async _sampleCandType() {
    try {
      const report = await this.pc.getStats();
      let localId = null;
      for (const s of report.values()) {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
          localId = s.localCandidateId;
        }
      }
      for (const s of report.values()) {
        if (s.id === localId && s.candidateType) this.candType = s.candidateType;
      }
    } catch {
      /* getStats unavailable */
    }
  }

  /// Add (or replace into) our outbound mic track. Safe to call once the mic
  /// resolves even if the connection was created earlier.
  attachMic(micStream) {
    if (this._micAdded) return;
    const track = micStream.getAudioTracks()[0];
    if (!track) return;
    // Reuse an existing audio transceiver's sender if we pre-created one.
    const sender = this.pc.getSenders().find((s) => !s.track && s.replaceTrack);
    if (sender) sender.replaceTrack(track).catch(() => {});
    else this.pc.addTrack(track, micStream);
    this._micAdded = true;
  }

  _makeOffer(restart = false) {
    this._chain = this._chain
      .then(() => this.pc.createOffer(restart ? { iceRestart: true } : undefined))
      .then((o) => this.pc.setLocalDescription(o))
      .then(() => this.send({ sdp: this.pc.localDescription }))
      .catch(() => {});
  }

  handleSignal(payload) {
    this._chain = this._chain
      .then(async () => {
        if (payload.sdp) {
          await this.pc.setRemoteDescription(payload.sdp);
          for (const ice of this._pendingIce.splice(0)) {
            await this.pc.addIceCandidate(ice).catch(() => {});
          }
          if (payload.sdp.type === 'offer') {
            const ans = await this.pc.createAnswer();
            await this.pc.setLocalDescription(ans);
            this.send({ sdp: this.pc.localDescription });
          }
        } else if (payload.ice) {
          if (this.pc.remoteDescription) {
            await this.pc.addIceCandidate(payload.ice).catch(() => {});
          } else {
            this._pendingIce.push(payload.ice);
          }
        }
      })
      .catch(() => {});
  }

  /// Position the inbound voice: pan by horizontal offset, attenuate by
  /// distance with a smooth falloff to zero at the range edge.
  setSpatial(dx, dy, dist, range) {
    // Inverse-ish falloff: full near, ~0 at the edge. Squared for a natural
    // dropoff so distant voices sit quietly in the mix.
    const near = Math.max(0, 1 - dist / range);
    this.setVolume(near * near);
    if (this._panViaWebAudio && this.panner) {
      const pan = Math.max(-1, Math.min(1, dx / range));
      this.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.08);
    }
  }

  /// Apply the distance volume to whichever output sink is live.
  setVolume(vol) {
    this._vol = vol;
    if (this._panViaWebAudio && this.dist) {
      this.dist.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.08);
    } else if (this._el) {
      this._el.muted = false;
      this._el.volume = Math.max(0, Math.min(1, vol));
    }
  }

  close() {
    this._dead = true;
    clearTimeout(this._watchdog);
    try {
      if (this._el) {
        this._el.pause();
        this._el.srcObject = null;
        this._el.remove();
      }
      this.pc.getSenders().forEach((s) => s.track && this.pc.removeTrack(s));
      this.pc.close();
    } catch {
      // already gone
    }
  }
}

// iOS Safari (incl. iPadOS posing as Mac) needs the audio-element playback path;
// WebAudio MediaStream nodes are silent there for remote tracks.
function isIOS() {
  const ua = navigator.userAgent || '';
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
