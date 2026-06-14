// WebSocket client for the RoomDO signaling relay.

import { CONFIG } from '../config.js';

export class Signaling {
  constructor(code) {
    this.code = code;
    this.ws = null;
    // msg.t -> Set<fn>. Multiple subsystems (World, HostSession, VoiceMesh)
    // listen on the same socket and sometimes the SAME event type, so each
    // type fans out to every registered handler instead of just the last one.
    this.handlers = new Map();
  }

  on(type, fn) {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(type, fn) {
    this.handlers.get(type)?.delete(fn);
    return this;
  }

  _emit(type, msg) {
    const set = this.handlers.get(type);
    if (!set) return;
    // Copy so a handler that calls off() mid-dispatch can't mutate during iter.
    for (const fn of [...set]) fn(msg);
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
        this._emit(msg.t, msg);
      };
      this.ws.onclose = () => this._emit('_closed', {});
    });
  }

  /// Send a message and await any of `okTypes`; rejects on 'error'.
  /// The one-shot handlers are removed once matched so they don't leak.
  request(msg, okTypes, timeoutMs = 12000) {
    const types = Array.isArray(okTypes) ? okTypes : [okTypes];
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        for (const t of types) this.off(t, done);
        this.off('error', onErr);
      };
      const done = (m) => {
        cleanup();
        resolve(m);
      };
      const onErr = (m) => {
        cleanup();
        reject(new Error(m.msg ?? m.code));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('signaling timeout'));
      }, timeoutMs);
      for (const t of types) this.on(t, done);
      this.on('error', onErr);
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
