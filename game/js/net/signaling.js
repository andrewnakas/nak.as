// WebSocket client for the RoomDO signaling relay.

import { CONFIG } from '../config.js';

export class Signaling {
  constructor(code) {
    this.code = code;
    this.ws = null;
    this.handlers = new Map(); // msg.t -> fn(msg)
  }

  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${CONFIG.wsBase}/ws/room/${this.code}`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('signaling connection failed'));
      this.ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        this.handlers.get(msg.t)?.(msg);
      };
      this.ws.onclose = () => this.handlers.get('_closed')?.();
    });
  }

  /// One request/response over the socket: send, await a response type.
  request(msg, okType, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signaling timeout')), timeoutMs);
      this.on(okType, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.on('error', (m) => {
        clearTimeout(timer);
        reject(new Error(m.msg ?? m.code));
      });
      this.send(msg);
    });
  }

  send(msg) {
    this.ws?.send(JSON.stringify(msg));
  }

  close() {
    this.ws?.close(1000);
    this.ws = null;
  }
}
