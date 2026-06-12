// Environment-aware configuration for the game shell.

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

export const CONFIG = {
  apiBase: isLocal ? 'http://localhost:8787' : 'https://api.nak.as',
  wsBase: isLocal ? 'ws://localhost:8787' : 'wss://api.nak.as',
  version: '0.1.0',
  debug: isLocal || new URLSearchParams(location.search).has('debug'),
};

export const TICKS_PER_SEC = 60;
export const TICK_MS = 1000 / TICKS_PER_SEC;
export const MAX_CATCHUP_TICKS = 5;

export const LOGICAL_W = 160;
export const LOGICAL_H = 144;
