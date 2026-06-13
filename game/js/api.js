// Fetch wrappers for the central API. Bearer token lives in localStorage;
// guests simply never get one.

import { CONFIG } from './config.js';

const TOKEN_KEY = 'naks_token';
const USER_KEY = 'naks_user';

export function authToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function authUser() {
  return authToken() ? localStorage.getItem(USER_KEY) : null;
}

function headers(json = false) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  const token = authToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function call(method, path, body) {
  const r = await fetch(`${CONFIG.apiBase}${path}`, {
    method,
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export async function register(username, password) {
  const { token } = await call('POST', '/auth/register', { username, password });
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
}

export async function login(username, password) {
  const { token } = await call('POST', '/auth/login', { username, password });
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
}

export async function logout() {
  try {
    await call('POST', '/auth/logout');
  } finally {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
}

export async function createParty() {
  const r = await fetch(`${CONFIG.apiBase}/party`, { method: 'POST' });
  if (!r.ok) throw new Error(`couldn't create a party (HTTP ${r.status})`);
  return (await r.json()).code;
}

/// Ask the lobby for a world to auto-join. Returns its code. `exclude`
/// reports an unreachable world (dead host) to retire it; `version` is the
/// caller's content build tag so the lobby only groups same-version peers.
export async function findWorld(exclude, version) {
  const body = {};
  if (exclude) body.exclude = exclude;
  if (version) body.version = version;
  const hasBody = Object.keys(body).length > 0;
  const r = await fetch(`${CONFIG.apiBase}/find-world`, {
    method: 'POST',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`couldn't reach the world server (HTTP ${r.status})`);
  return (await r.json()).code;
}

export const characters = {
  list: () => call('GET', '/characters').then((d) => d.characters),
  get: (id) => call('GET', `/characters/${id}`),
  create: (name, data) => call('POST', '/characters', { name, data }),
  update: (id, data) => call('PUT', `/characters/${id}`, { data }),
};

export const friends = {
  list: () => call('GET', '/friends').then((d) => d.friends),
  request: (username) => call('POST', '/friends/request', { username }),
  respond: (username, accept) => call('POST', '/friends/respond', { username, accept }),
};
