// One WebRTC connection between the host and a client (star topology: the
// host holds up to 3 of these; each client holds exactly one).
//
// Channels: 'u' — unordered, no retransmits (inputs, snapshots);
//           'r' — reliable ordered (handshake JSON, events, saves).
// The JOINING client is the offerer and creates both channels.

// STUN first (direct/hole-punched when possible), then free public TURN
// relays so cross-NAT pairs (phone on cellular ↔ home computer) still
// connect. TURN is the fallback the browser uses only when STUN fails.
const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

export const CONNECT_TIMEOUT_MS = 15000;

export class PeerLink {
  constructor(signaling, remoteId, isOfferer) {
    this.remoteId = remoteId;
    this.pc = new RTCPeerConnection(ICE_CONFIG);
    this.u = null;
    this.r = null;
    this.onU = null; // fn(ArrayBuffer)
    this.onR = null; // fn(string)
    this.onClosed = null;
    this._closed = false;
    this._pendingIce = [];
    this._signalChain = Promise.resolve();

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        signaling.send({ t: 'signal', to: remoteId, payload: { ice: e.candidate } });
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(this.pc.connectionState)) {
        this._fireClosed();
      }
    };

    if (isOfferer) {
      this._adopt(this.pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
      this._adopt(this.pc.createDataChannel('r'));
      this.pc
        .createOffer()
        .then((offer) => this.pc.setLocalDescription(offer))
        .then(() => signaling.send({ t: 'signal', to: remoteId, payload: { sdp: this.pc.localDescription } }));
    } else {
      this.pc.ondatachannel = (e) => this._adopt(e.channel);
    }

    this._signaling = signaling;
  }

  _adopt(ch) {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (e) =>
      ch.label === 'u' ? this.onU?.(e.data) : this.onR?.(e.data);
    this[ch.label] = ch;
  }

  _fireClosed() {
    if (!this._closed) {
      this._closed = true;
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
        () => reject(new Error("Couldn't reach the other player. This usually means a strict network (corporate wifi / CGNAT). Try a phone hotspot, or have someone else host.")),
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

  sendU(bytes) {
    if (this.u?.readyState === 'open') this.u.send(bytes);
  }

  sendR(obj) {
    if (this.r?.readyState === 'open') this.r.send(JSON.stringify(obj));
  }

  sendRBytes(bytes) {
    if (this.r?.readyState === 'open') this.r.send(bytes);
  }

  close() {
    this._closed = true;
    this.pc.close();
  }
}
