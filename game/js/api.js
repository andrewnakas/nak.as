// Fetch wrappers for the central API (auth/saves arrive in Phase 7).

import { CONFIG } from './config.js';

export async function createParty() {
  const r = await fetch(`${CONFIG.apiBase}/party`, { method: 'POST' });
  if (!r.ok) throw new Error(`couldn't create a party (HTTP ${r.status})`);
  return (await r.json()).code;
}
