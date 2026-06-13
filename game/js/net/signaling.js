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

  /// Send a message and await any of `okTypes`; rejects on 'error'.
  /// The matched handler is left in place only briefly — callers that need
  /// ongoing events should register them via on() before/after.
  request(msg, okTypes, timeoutMs = 12000) {
    const types = Array.isArray(okTypes) ? okTypes : [okTypes];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signaling timeout')), timeoutMs);
      const done = (m) => {
        clearTimeout(timer);
        for (const t of types) this.handlers.delete(t);
        this.handlers.delete('error');
        resolve(m);
      };
      for (const t of types) this.on(t, done);
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
