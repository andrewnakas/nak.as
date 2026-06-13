// Accounts and bearer-token sessions. PBKDF2-SHA256 at 25k iterations:
// sized for the Workers free-tier 10ms CPU cap; acceptable for game
// accounts when combined with unique salts and login rate limiting.

const PBKDF2_ITERS = 25000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const enc = new TextEncoder();

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERS);
  return `pbkdf2$${PBKDF2_ITERS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iters, salt, expected] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const hash = b64(await pbkdf2(password, fromB64(salt), Number(iters)));
  // Length-equal string compare; timing is dominated by PBKDF2 anyway.
  return hash === expected;
}

export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function validUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(u);
}

export function validPassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 128;
}

export async function createSession(db, accountId) {
  const token = newToken();
  await db
    .prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256hex(token), accountId, Date.now() + SESSION_TTL_MS)
    .run();
  return token;
}

/// Resolve the bearer token to an account row, or null.
export async function authenticate(db, request) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT a.id, a.username FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256hex(token), Date.now())
    .first();
  return row ?? null;
}

export async function deleteSession(db, request) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return;
  await db
    .prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(await sha256hex(token))
    .run();
}
