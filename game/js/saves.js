// Character persistence: localStorage always (instant, offline-safe),
// cloud (D1 via the worker) layered on top when logged in. Guest saves are
// adopted into the account on first login.

import { authToken, characters } from './api.js';
import { CONFIG } from './config.js';

const LOCAL_KEY = 'naks_save';
const LOCAL_AT_KEY = 'naks_save_at'; // wall-clock ms of the last local write
const CHAR_KEY = 'naks_char_id';
const CLOUD_INTERVAL_MS = 15000;

let lastCloudWrite = 0;

export function loadLocal() {
  return localStorage.getItem(LOCAL_KEY);
}

export function storeLocal(json) {
  if (json && json !== 'null') {
    localStorage.setItem(LOCAL_KEY, json);
    localStorage.setItem(LOCAL_AT_KEY, String(Date.now()));
  }
}

/// Resolve the save to start with: cloud character if logged in (creating
/// one from the guest save on first login), else local. When BOTH a cloud
/// character and a local save exist, prefer whichever is NEWER — so a cloud
/// write that never landed (tab closed before it flushed) can't clobber newer
/// local progress on the next session.
export async function loadStartingSave(name) {
  if (!authToken()) return loadLocal();
  try {
    const list = await characters.list();
    if (list.length) {
      localStorage.setItem(CHAR_KEY, list[0].id);
      const c = await characters.get(list[0].id);
      const cloudAt = Number(c.updated_at) || 0;
      const localAt = Number(localStorage.getItem(LOCAL_AT_KEY)) || 0;
      const local = loadLocal();
      // Newer-wins: if our local save is newer than the cloud's last write,
      // push local up and play from it; otherwise trust the cloud.
      if (local && localAt > cloudAt) {
        characters.update(list[0].id, JSON.parse(local)).catch(() => {});
        return local;
      }
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
/// CLOUD_INTERVAL_MS (background, non-blocking).
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

/// Final, reliable cloud write for tab-close / page-hide. Uses fetch with
/// `keepalive` so the request survives the document being torn down (sendBeacon
/// can't do an authenticated PUT). Always writes local; skips the 15s throttle
/// because this is the last chance to save the session's progress. Best-effort.
export function flush(json) {
  if (!json || json === 'null') return;
  storeLocal(json);
  const token = authToken();
  const id = localStorage.getItem(CHAR_KEY);
  if (!token || !id) return;
  try {
    fetch(`${CONFIG.apiBase}/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: JSON.parse(json) }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* unload best-effort */
  }
}
