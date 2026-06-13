// One WebRTC connection between two peers (star topology: the host holds one
// of these per client; each client holds one to the host).
//
// Channels: 'u' — unordered, no retransmits (inputs, snapshots);
//           'r' — reliable ordered (handshake JSON, events, saves).
// The JOINING peer is the offerer and creates both channels.
//
// Robustness: a transient `disconnected` (network blip) triggers an ICE
// restart and a grace window before we give up; only a hard `failed`/`closed`
// after that window fires onClosed. Connection quality (RTT, send-buffer
// pressure) is sampled via getStats for observability and backpressure.

// STUN first (direct/hole-punched when possible), then TURN relays so
// cross-NAT pairs (phone on cellular ↔ home computer) still connect. TURN is
// the fallback the browser uses only when STUN fails. TCP/443 TURN punches
// through restrictive corporate firewalls that block UDP entirely.
export const ICE_CONFIG = {
  iceServers: [
    {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
      ],
    },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  // Gather a few extra candidate pairs so a failed primary path has a
  // ready backup; modest pool keeps setup fast.
  iceCandidatePoolSize: 2,
};

export const CONNECT_TIMEOUT_MS = 15000;
// How long a `disconnected` state may persist (while we ICE-restart) before
// we declare the link dead. WebRTC often recovers a blip within a second or
// two; this grace prevents a hiccup from becoming a teardown.
const DISCONNECT_GRACE_MS = 6000;
// Stop queueing snapshots once the unreliable channel's send buffer backs up
// past this — on a slow link, dropping stale snapshots beats growing latency.
const MAX_SEND_BUFFER = 256 * 1024;

export class PeerLink {
  constructor(signaling, remoteId, isOfferer) {
    this.remoteId = remoteId;
    this.isOfferer = isOfferer;
    this.pc = new RTCPeerConnection(ICE_CONFIG);
    this.u = null;
    this.r = null;
    this.onU = null; // fn(ArrayBuffer)
    this.onR = null; // fn(string)
    this.onClosed = null;
    this._closed = false;
    this._pendingIce = [];
    this._signalChain = Promise.resolve();
    this._disconnectTimer = null;
    this._restarting = false;
    // Live connection-quality snapshot (filled by sampleStats()).
    this.stats = { rttMs: null, sendBuffer: 0, state: 'new', restarts: 0 };

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        signaling.send({ t: 'signal', to: remoteId, payload: { ice: e.candidate } });
      }
    };

    this.pc.onconnectionstatechange = () => this._onStateChange();
    // iceConnectionState transitions are more granular than connectionState on
    // some browsers (notably Firefox); watch both so a recovery is noticed.
    this.pc.oniceconnectionstatechange = () => this._onStateChange();

    if (isOfferer) {
      this._adopt(this.pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
      this._adopt(this.pc.createDataChannel('r'));
      this._makeOffer();
    } else {
      this.pc.ondatachannel = (e) => this._adopt(e.channel);
    }

    this._signaling = signaling;
  }

  _makeOffer(restart = false) {
    return this.pc
      .createOffer(restart ? { iceRestart: true } : undefined)
      .then((offer) => this.pc.setLocalDescription(offer))
      .then(() =>
        this._signaling.send({
          t: 'signal',
          to: this.remoteId,
          payload: { sdp: this.pc.localDescription },
        }),
      )
      .catch(() => {});
  }

  _onStateChange() {
    const cs = this.pc.connectionState;
    const ice = this.pc.iceConnectionState;
    this.stats.state = cs;

    // Recovered — cancel any pending grace teardown.
    if (cs === 'connected' || ice === 'connected' || ice === 'completed') {
      if (this._disconnectTimer) {
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = null;
      }
      this._restarting = false;
      return;
    }

    // Transient blip: try to heal (ICE restart, offerer side) within a grace
    // window before declaring the link dead.
    if (cs === 'disconnected' || ice === 'disconnected') {
      if (!this._disconnectTimer && !this._closed) {
        if (this.isOfferer && !this._restarting) {
          this._restarting = true;
          this.stats.restarts += 1;
          this._makeOffer(true);
        }
        this._disconnectTimer = setTimeout(() => this._fireClosed(), DISCONNECT_GRACE_MS);
      }
      return;
    }

    // Hard failure.
    if (cs === 'failed' || ice === 'failed') {
      // One ICE restart attempt on a fresh failure (offerer); else give up.
      if (this.isOfferer && !this._restarting && !this._closed) {
        this._restarting = true;
        this.stats.restarts += 1;
        this._makeOffer(true);
        this._disconnectTimer ??= setTimeout(() => this._fireClosed(), DISCONNECT_GRACE_MS);
        return;
      }
      this._fireClosed();
      return;
    }

    if (cs === 'closed') this._fireClosed();
  }

  _adopt(ch) {
    ch.binaryType = 'arraybuffer';
    // Cap the unreliable channel's queue so a slow consumer can't grow an
    // unbounded backlog; we check bufferedAmount before sending.
    if (ch.label === 'u') {
      try {
        ch.bufferedAmountLowThreshold = 64 * 1024;
      } catch {
        /* not supported everywhere */
      }
    }
    ch.onmessage = (e) => (ch.label === 'u' ? this.onU?.(e.data) : this.onR?.(e.data));
    this[ch.label] = ch;
  }

  _fireClosed() {
    if (!this._closed) {
      this._closed = true;
      if (this._disconnectTimer) clearTimeout(this._disconnectTimer);
      this.onClosed?.();
    }
  }

  /// Signals are serialized through a promise chain, and ICE candidates that
  /// arrive before the remote description are queued — otherwise fast trickle
  /// ICE loses candidates and the connection silently never forms.
  handleSignal(payload) {
    this._signalChain = this._signalChain.then(() => this._applySignal(payload)).catch(() => {});
    return this._signalChain;
  }

  async _applySignal(payload) {
    if (payload.sdp) {
      // An incoming offer during an established session is a renegotiation
      // (e.g. the peer's ICE restart). setRemoteDescription handles both.
      await this.pc.setRemoteDescription(payload.sdp);
      for (const ice of this._pendingIce.splice(0)) {
        await this.pc.addIceCandidate(ice).catch(() => {});
      }
      if (payload.sdp.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this._signaling.send({
          t: 'signal',
          to: this.remoteId,
          payload: { sdp: this.pc.localDescription },
        });
      }
    } else if (payload.ice) {
      if (this.pc.remoteDescription) {
        await this.pc.addIceCandidate(payload.ice).catch(() => {});
      } else {
        this._pendingIce.push(payload.ice);
      }
    }
  }

  /// Resolves when both channels are open; rejects on timeout (strict NATs).
  ready() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Couldn't reach the other player. This usually means a strict network (corporate wifi / CGNAT). Try a phone hotspot, or have someone else host.",
            ),
          ),
        CONNECT_TIMEOUT_MS,
      );
      const check = () => {
        if (this.u?.readyState === 'open' && this.r?.readyState === 'open') {
          clearTimeout(timer);
          resolve();
          return true;
        }
        return false;
      };
      if (check()) return;
      const poll = setInterval(() => {
        if (check() || this._closed) {
          clearInterval(poll);
          if (this._closed) {
            clearTimeout(timer);
            reject(new Error('connection closed during setup'));
          }
        }
      }, 100);
    });
  }

  /// Send on the unreliable channel, dropping if the send buffer is backed up
  /// (a slow link is better served by the next fresh snapshot than a backlog).
  sendU(bytes) {
    const ch = this.u;
    if (ch?.readyState !== 'open') return false;
    if (ch.bufferedAmount > MAX_SEND_BUFFER) return false; // backpressure: drop
    ch.send(bytes);
    return true;
  }

  sendR(obj) {
    if (this.r?.readyState === 'open') this.r.send(JSON.stringify(obj));
  }

  sendRBytes(bytes) {
    if (this.r?.readyState === 'open') this.r.send(bytes);
  }

  /// Sample connection quality via getStats (RTT from the selected candidate
  /// pair, current send-buffer depth). Cheap enough to call ~1/sec.
  async sampleStats() {
    this.stats.sendBuffer = this.u?.bufferedAmount ?? 0;
    try {
      const report = await this.pc.getStats();
      for (const s of report.values()) {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
          if (typeof s.currentRoundTripTime === 'number') {
            this.stats.rttMs = Math.round(s.currentRoundTripTime * 1000);
          }
        }
      }
    } catch {
      /* getStats not available / link gone */
    }
    return this.stats;
  }

  close() {
    this._closed = true;
    if (this._disconnectTimer) clearTimeout(this._disconnectTimer);
    this.pc.close();
  }
}
