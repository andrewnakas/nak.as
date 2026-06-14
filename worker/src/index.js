// Nak's Awakening API: auth, character saves, friends, party signaling.
// Game simulation never runs here — peers host their own sessions.

import {
  authenticate,
  createSession,
  deleteSession,
  hashPassword,
  validPassword,
  validUsername,
  verifyPassword,
} from './auth.js';
import { createCharacter, getCharacter, listCharacters, updateCharacter } from './characters.js';
import { listFriends, respondRequest, sendRequest } from './friends.js';

export { RoomDO } from './room.js';
export { LobbyDO } from './lobby.js';

const PARTY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin === 'https://nak.as') return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(request) {
  const origin = allowedOrigin(request.headers.get('Origin'));
  return {
    'Access-Control-Allow-Origin': origin ?? 'https://nak.as',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Public STUN + free-TURN fallback, used when no managed TURN is configured.
// STUN finds the public-reflexive path; TURN relays when that fails (strict
// NAT, CGNAT, or a hotspot router that can't hairpin two of its own clients).
const FALLBACK_ICE = [
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
];

// Build the ICE server list. With Cloudflare Realtime TURN configured
// (TURN_KEY_ID + TURN_API_TOKEN secrets) we mint short-lived credentials so
// every pair has a reliable relay; otherwise we return the free fallback.
async function iceServers(env) {
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_API_TOKEN;
  if (!keyId || !token) return FALLBACK_ICE;
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // 24h TTL: comfortably outlives a play session; a fresh page load mints
        // new creds anyway (the 5-minute edge cache is just to dedup bursts).
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!r.ok) return FALLBACK_ICE;
    const data = await r.json();
    // Cloudflare returns { iceServers: { urls:[...], username, credential } }.
    // Keep a public STUN too so the host-candidate / reflexive path is tried
    // before falling back to the (metered) relay.
    const cf = data.iceServers;
    if (!cf) return FALLBACK_ICE;
    return [{ urls: 'stun:stun.cloudflare.com:3478' }, cf];
  } catch {
    return FALLBACK_ICE;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;
    const db = env.DB;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // ---- auth ----

    if (method === 'POST' && url.pathname === '/auth/register') {
      const body = await readJson(request);
      if (!body || !validUsername(body.username)) {
        return json(request, 400, { error: 'username: 3-16 letters/digits/_' });
      }
      if (!validPassword(body.password)) {
        return json(request, 400, { error: 'password: at least 8 characters' });
      }
      const taken = await db
        .prepare('SELECT id FROM accounts WHERE username = ?')
        .bind(body.username)
        .first();
      if (taken) return json(request, 409, { error: 'username is taken' });

      const id = crypto.randomUUID();
      await db
        .prepare('INSERT INTO accounts (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, body.username, await hashPassword(body.password), Date.now())
        .run();
      const token = await createSession(db, id);
      return json(request, 200, { token, username: body.username });
    }

    if (method === 'POST' && url.pathname === '/auth/login') {
      const body = await readJson(request);
      if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
        return json(request, 400, { error: 'missing credentials' });
      }
      const account = await db
        .prepare('SELECT id, username, pass_hash FROM accounts WHERE username = ?')
        .bind(body.username)
        .first();
      if (!account || !(await verifyPassword(body.password, account.pass_hash))) {
        return json(request, 401, { error: 'wrong username or password' });
      }
      const token = await createSession(db, account.id);
      return json(request, 200, { token, username: account.username });
    }

    if (method === 'POST' && url.pathname === '/auth/logout') {
      await deleteSession(db, request);
      return json(request, 200, { ok: true });
    }

    // ---- worlds / signaling (no auth required; guests play too) ----

    const lobby = () => env.LOBBY.get(env.LOBBY.idFromName('global'));

    // Matchmaking: hand back a world to auto-join. Optional { exclude }
    // retires an unreachable world; { version } groups same-build peers.
    if (method === 'POST' && url.pathname === '/find-world') {
      const body = await readJson(request);
      const params = new URLSearchParams();
      if (body?.exclude) params.set('exclude', body.exclude);
      if (body?.version) params.set('version', body.version);
      const qs = params.toString();
      const r = await lobby().fetch(`https://lobby/find${qs ? `?${qs}` : ''}`);
      const world = await r.json();
      return json(request, 200, world);
    }
    if (method === 'GET' && url.pathname === '/worlds') {
      const r = await lobby().fetch('https://lobby/worlds');
      return json(request, 200, await r.json());
    }

    // ICE servers for WebRTC (game + voice). Mints short-lived Cloudflare
    // Realtime TURN credentials when configured (secrets TURN_KEY_ID +
    // TURN_API_TOKEN), so cross-NAT and hairpin-broken pairs always have a
    // working relay. Falls back to STUN + the free openrelay TURN otherwise.
    // No auth: guests use voice too. Cached briefly at the edge.
    if (method === 'GET' && url.pathname === '/ice') {
      const ice = await iceServers(env);
      return new Response(JSON.stringify({ iceServers: ice }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
          ...corsHeaders(request),
        },
      });
    }

    // Legacy party code (still usable for private parties).
    if (method === 'POST' && url.pathname === '/party') {
      let code = '';
      const bytes = crypto.getRandomValues(new Uint8Array(5));
      for (const b of bytes) code += PARTY_ALPHABET[b % PARTY_ALPHABET.length];
      return json(request, 200, { code });
    }

    // World/room signaling socket. Accepts world ids (BRACK###) and legacy
    // 5-char party codes.
    const room = url.pathname.match(/^\/ws\/room\/([A-Z0-9]{5,9})$/);
    if (room) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json(request, 426, { error: 'expected websocket' });
      }
      if (request.headers.get('Origin') && !allowedOrigin(request.headers.get('Origin'))) {
        return json(request, 403, { error: 'origin not allowed' });
      }
      const id = env.ROOMS.idFromName(room[1]);
      return env.ROOMS.get(id).fetch(request);
    }

    // ---- authed routes ----

    const account = await authenticate(db, request);
    if (!account) return json(request, 401, { error: 'not logged in' });

    if (method === 'GET' && url.pathname === '/me') {
      return json(request, 200, { username: account.username });
    }

    if (method === 'GET' && url.pathname === '/characters') {
      return json(request, 200, { characters: await listCharacters(db, account.id) });
    }

    if (method === 'POST' && url.pathname === '/characters') {
      const body = await readJson(request);
      if (!body?.data) return json(request, 400, { error: 'missing data' });
      const result = await createCharacter(db, account.id, body.name ?? account.username, body.data);
      if (result.error) return json(request, result.status, { error: result.error });
      return json(request, 200, result);
    }

    if (method === 'GET' && url.pathname === '/friends') {
      return json(request, 200, { friends: await listFriends(db, account.id) });
    }
    if (method === 'POST' && url.pathname === '/friends/request') {
      const body = await readJson(request);
      const result = await sendRequest(db, account.id, body?.username);
      if (result.error) return json(request, result.status, { error: result.error });
      return json(request, 200, result);
    }
    if (method === 'POST' && url.pathname === '/friends/respond') {
      const body = await readJson(request);
      const result = await respondRequest(db, account.id, body?.username, !!body?.accept);
      if (result.error) return json(request, result.status, { error: result.error });
      return json(request, 200, result);
    }

    const charGet = url.pathname.match(/^\/characters\/([0-9a-f-]{36})$/);
    if (charGet && method === 'GET') {
      const row = await getCharacter(db, account.id, charGet[1]);
      if (!row) return json(request, 404, { error: 'not found' });
      return json(request, 200, { ...row, data: JSON.parse(row.data) });
    }
    if (charGet && method === 'PUT') {
      const body = await readJson(request);
      if (!body?.data) return json(request, 400, { error: 'missing data' });
      const result = await updateCharacter(db, account.id, charGet[1], body.data);
      if (result.error) return json(request, result.status, { error: result.error });
      return json(request, 200, result);
    }

    return json(request, 404, { error: 'not found' });
  },
};
