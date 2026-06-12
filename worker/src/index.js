// Nak's Awakening API: party signaling now; auth/saves/friends in Phase 7.
// Game simulation never runs here — peers host their own sessions.

export { RoomDO } from './room.js';

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method === 'POST' && url.pathname === '/party') {
      let code = '';
      const bytes = crypto.getRandomValues(new Uint8Array(5));
      for (const b of bytes) code += PARTY_ALPHABET[b % PARTY_ALPHABET.length];
      return json(request, 200, { code });
    }

    const room = url.pathname.match(/^\/ws\/room\/([A-Z2-9]{5})$/);
    if (room) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json(request, 426, { error: 'expected websocket' });
      }
      // Browsers can't set headers on WebSocket requests, so Origin is the
      // only check available here; it blocks casual cross-site abuse.
      if (request.headers.get('Origin') && !allowedOrigin(request.headers.get('Origin'))) {
        return json(request, 403, { error: 'origin not allowed' });
      }
      const id = env.ROOMS.idFromName(room[1]);
      return env.ROOMS.get(id).fetch(request);
    }

    return json(request, 404, { error: 'not found' });
  },
};
