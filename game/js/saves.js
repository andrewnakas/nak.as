// Character persistence: localStorage always (instant, offline-safe),
// cloud (D1 via the worker) layered on top when logged in. Guest saves are
// adopted into the account on first login.

import { authToken, characters } from './api.js';

const LOCAL_KEY = 'naks_save';
const CHAR_KEY = 'naks_char_id';
const CLOUD_INTERVAL_MS = 15000;

let lastCloudWrite = 0;

export function loadLocal() {
  return localStorage.getItem(LOCAL_KEY);
}

export function storeLocal(json) {
  if (json && json !== 'null') localStorage.setItem(LOCAL_KEY, json);
}

/// Resolve the save to start with: cloud character if logged in (creating
/// one from the guest save on first login), else local.
export async function loadStartingSave(name) {
  if (!authToken()) return loadLocal();
  try {
    const list = await characters.list();
    if (list.length) {
      localStorage.setItem(CHAR_KEY, list[0].id);
      const c = await characters.get(list[0].id);
      return JSON.stringify(c.data);
    }
    // First login: adopt the guest save (or start fresh next save).
    const local = loadLocal();
    if (local) {
      const { id } = await characters.create(name, JSON.parse(local));
      localStorage.setItem(CHAR_KEY, id);
    }
    return local;
  } catch (err) {
    console.warn('cloud load failed; using local save', err);
    return loadLocal();
  }
}

/// Persist a fresh save snapshot: local immediately, cloud at most every
/// CLOUD_INTERVAL_MS (the server enforces 10s; we stay above it).
export function persist(json) {
  if (!json || json === 'null') return;
  storeLocal(json);
  if (!authToken()) return;
  const now = Date.now();
  if (now - lastCloudWrite < CLOUD_INTERVAL_MS) return;
  lastCloudWrite = now;

  const push = async () => {
    let id = localStorage.getItem(CHAR_KEY);
    if (!id) {
      const created = await characters.create(
        localStorage.getItem('naks_name') || 'NAK',
        JSON.parse(json),
      );
      localStorage.setItem(CHAR_KEY, created.id);
      return;
    }
    await characters.update(id, JSON.parse(json));
  };
  push().catch((err) => console.warn('cloud save failed', err));
}
