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

    // Matchmaking: hand back a world to auto-join. An optional { exclude }
    // reports a world whose host was unreachable so the lobby retires it.
    if (method === 'POST' && url.pathname === '/find-world') {
      const body = await readJson(request);
      const exclude = body?.exclude ? `?exclude=${encodeURIComponent(body.exclude)}` : '';
      const r = await lobby().fetch(`https://lobby/find${exclude}`);
      const world = await r.json();
      return json(request, 200, world);
    }
    if (method === 'GET' && url.pathname === '/worlds') {
      const r = await lobby().fetch('https://lobby/worlds');
      return json(request, 200, await r.json());
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
