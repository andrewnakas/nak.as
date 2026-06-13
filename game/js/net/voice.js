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

import { ICE_CONFIG } from './rtc.js';

const VOICE_RANGE_PX = 160; // within this world-pixel distance => audible
const SAME_SCREEN_ONLY = true; // only mesh with players on your screen
const PROXIMITY_HZ = 4; // how often to re-evaluate who's in range

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

  /// Turn the mic on (asks permission the first time) and start meshing.
  async enable() {
    if (this.enabled) return;
    if (!this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    }
    this.enabled = true;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
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

  _updateProximity() {
    if (!this.enabled) return;
    const me = this.getLocal();
    if (!me) return;
    const inRange = new Set();
    for (const p of this.getPlayers()) {
      if (p.slot === me.slot) continue;
      if (SAME_SCREEN_ONLY && (p.sx !== me.sx || p.sy !== me.sy)) continue;
      const dx = (p.x - me.x) / 256; // fixed-point 1/256 px -> px
      const dy = (p.y - me.y) / 256;
      const dist = Math.hypot(dx, dy);
      if (dist > VOICE_RANGE_PX) continue;
      const id = this.resolvePeerId(p.slot);
      if (!id || id === this._selfId) continue;
      inRange.add(id);
      const peer = this.peers.get(id);
      if (peer) {
        peer.setSpatial(dx, dy, dist, VOICE_RANGE_PX);
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
      send: (payload) => this.signaling.send({ t: 'voice-signal', to: remoteId, payload }),
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
  constructor({ remoteId, initiator, ctx, master, micStream, send, onClosed }) {
    this.remoteId = remoteId;
    this.ctx = ctx;
    this.send = send;
    this.onClosed = onClosed;
    this._pendingIce = [];
    this._chain = Promise.resolve();
    this.pc = new RTCPeerConnection(ICE_CONFIG);

    // Outbound: our mic. (Track may be disabled when muted; silence flows.)
    for (const track of micStream?.getAudioTracks() ?? []) {
      this.pc.addTrack(track, micStream);
    }

    // Inbound: remote mic -> panner -> master. A StereoPanner places the voice
    // left/right; a gain attenuates with distance (set live in setSpatial).
    this.panner = ctx.createStereoPanner();
    this.dist = ctx.createGain();
    this.dist.gain.value = 0;
    this.panner.connect(this.dist);
    this.dist.connect(master);

    this.pc.ontrack = (e) => {
      // A MediaStream node feeds the graph; we must also sink the stream to a
      // muted <audio> element or some browsers won't pull frames through WebAudio.
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      const src = ctx.createMediaStreamSource(stream);
      src.connect(this.panner);
      this._keepAlive = new window.Audio();
      this._keepAlive.muted = true;
      this._keepAlive.srcObject = stream;
      this._keepAlive.play().catch(() => {});
    };

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ ice: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.onClosed?.();
    };

    if (initiator) this._makeOffer();
  }

  _makeOffer() {
    this._chain = this._chain
      .then(() => this.pc.createOffer())
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
    const pan = Math.max(-1, Math.min(1, dx / range));
    // Inverse-ish falloff: full near, ~0 at the edge. Squared for a natural
    // dropoff so distant voices sit quietly in the mix.
    const near = Math.max(0, 1 - dist / range);
    const vol = near * near;
    const t = this.ctx.currentTime;
    this.panner.pan.setTargetAtTime(pan, t, 0.08);
    this.dist.gain.setTargetAtTime(vol, t, 0.08);
  }

  close() {
    try {
      this._keepAlive?.pause();
      this.pc.getSenders().forEach((s) => s.track && this.pc.removeTrack(s));
      this.pc.close();
    } catch {
      // already gone
    }
  }
}
