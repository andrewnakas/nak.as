// Bozeman boom map — public, unauthenticated crowd reports.
//
// Anyone can file a report, so every guard is server-side: a bounding box
// around the Gallatin Valley, a reporting window of the last 3 days, enum
// checks on every field, and a per-IP rate limit. Coordinates are rounded to
// 3 decimals (~110 m) before they touch the database — plenty to triangulate
// a boom heard from miles away, not enough to identify a house.

import { sha256hex } from './auth.js';

const DAY = 86400000;

// How far back a report may be dated. The map itself keeps everything.
export const REPORT_WINDOW_MS = 3 * DAY;

// Bozeman and surrounding country: Gallatin + Madison + Paradise valleys,
// the Bridgers, Big Sky, Livingston, Three Forks.
const BBOX = { minLat: 44.5, maxLat: 46.6, minLon: -113.0, maxLon: -109.2 };

const SOUNDS = new Set(['single', 'double', 'multiple', 'rumble', 'crack', 'other']);
const DURATIONS = new Set(['instant', 'short', 'long', 'unknown']);
const PRECISIONS = new Set(['exact', 'minute', 'hour', 'vague']);
const DIRECTIONS = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'unknown']);

// Per-IP caps. Generous enough for a household comparing notes on one event,
// tight enough that a single browser can't paint the valley.
const MAX_PER_HOUR = 8;
const MAX_PER_DAY = 25;

const NOTES_MAX = 400;
const NAME_MAX = 32;

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function clean(text, max) {
  if (typeof text !== 'string') return null;
  // Drop control/format characters, collapse runs of whitespace.
  const t = text.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

// Salted so the stored hash can't be reversed against the (small) space of
// Montana IPs by anyone who gets a copy of the table.
async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256hex(`boom:${env.BOOM_SALT || 'nak.as'}:${ip}`);
}

// A report this far underwater is treated as junk: hidden from the fit and
// dimmed on the map. It stays readable — deletion is for the reporter and the
// admin, not for a pile-on.
export const DISPUTED_AT = -3;

// The public shape. ip_hash and edit_hash never leave the worker.
function publicRow(r) {
  const score = (r.up ?? 0) - (r.down ?? 0);
  return {
    id: r.id,
    score,
    up: r.up ?? 0,
    down: r.down ?? 0,
    disputed: score <= DISPUTED_AT,
    account: r.username ?? null,
    lat: r.lat,
    lon: r.lon,
    at: r.occurred_at,
    prec: r.time_precision,
    intensity: r.intensity,
    sound: r.sound,
    duration: r.duration,
    shook: !!r.shook,
    indoors: r.indoors === null ? null : !!r.indoors,
    direction: r.direction,
    notes: r.notes,
    name: r.name,
    created: r.created_at,
  };
}

export async function listBooms(db, url) {
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 3, 1), 3650);
  const since = Date.now() - days * DAY;
  const { results } = await db
    .prepare(
      `SELECT b.*, a.username,
              COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 END), 0)  AS up,
              COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 END), 0) AS down
       FROM booms b
       LEFT JOIN boom_votes v ON v.boom_id = b.id
       LEFT JOIN accounts a   ON a.id = b.account_id
       WHERE b.hidden = 0 AND b.occurred_at >= ?
       GROUP BY b.id
       ORDER BY b.occurred_at DESC LIMIT 5000`,
    )
    .bind(since)
    .all();
  return { booms: (results ?? []).map(publicRow), since, now: Date.now() };
}

export async function createBoom(db, request, env, body, account) {
  if (!body || typeof body !== 'object') return { status: 400, error: 'expected JSON' };

  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: 400, error: 'pick a spot on the map first' };
  }
  if (lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) {
    return { status: 400, error: 'that location is outside the Bozeman area' };
  }

  const at = Number(body.at);
  const now = Date.now();
  if (!Number.isFinite(at)) return { status: 400, error: 'when did you hear it?' };
  // A little slack forward for clocks that run fast.
  if (at > now + 600000) return { status: 400, error: 'that time is in the future' };
  if (at < now - REPORT_WINDOW_MS) {
    return { status: 400, error: 'reports are limited to the last 3 days' };
  }

  const intensity = Math.round(Number(body.intensity));
  if (!(intensity >= 1 && intensity <= 5)) return { status: 400, error: 'pick a loudness 1-5' };

  const prec = PRECISIONS.has(body.prec) ? body.prec : 'vague';
  const sound = SOUNDS.has(body.sound) ? body.sound : 'other';
  const duration = DURATIONS.has(body.duration) ? body.duration : 'unknown';
  const direction = DIRECTIONS.has(body.direction) ? body.direction : 'unknown';
  const indoors = body.indoors === null || body.indoors === undefined ? null : body.indoors ? 1 : 0;
  const notes = clean(body.notes, NOTES_MAX);
  const name = clean(body.name, NAME_MAX);

  const secret = typeof body.secret === 'string' ? body.secret : '';
  if (secret.length < 16 || secret.length > 128) return { status: 400, error: 'bad client token' };

  const ip = await ipHash(request, env);
  const hour = await db
    .prepare('SELECT COUNT(*) AS n FROM booms WHERE ip_hash = ? AND created_at > ?')
    .bind(ip, now - 3600000)
    .first();
  if ((hour?.n ?? 0) >= MAX_PER_HOUR) {
    return { status: 429, error: 'too many reports from here in the last hour' };
  }
  const day = await db
    .prepare('SELECT COUNT(*) AS n FROM booms WHERE ip_hash = ? AND created_at > ?')
    .bind(ip, now - DAY)
    .first();
  if ((day?.n ?? 0) >= MAX_PER_DAY) {
    return { status: 429, error: 'daily report limit reached' };
  }

  const row = {
    id: crypto.randomUUID(),
    lat: round3(lat),
    lon: round3(lon),
    occurred_at: at,
    time_precision: prec,
    intensity,
    sound,
    duration,
    shook: body.shook ? 1 : 0,
    indoors,
    direction,
    notes,
    name,
    created_at: now,
    ip_hash: ip,
    edit_hash: await sha256hex(secret),
    hidden: 0,
    account_id: account?.id ?? null,
    username: account?.username ?? null,
  };
  await db
    .prepare(
      `INSERT INTO booms (id, lat, lon, occurred_at, time_precision, intensity, sound,
        duration, shook, indoors, direction, notes, name, created_at, ip_hash, edit_hash,
        hidden, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      row.id, row.lat, row.lon, row.occurred_at, row.time_precision, row.intensity, row.sound,
      row.duration, row.shook, row.indoors, row.direction, row.notes, row.name, row.created_at,
      row.ip_hash, row.edit_hash, row.account_id,
    )
    .run();

  return { status: 200, body: { boom: publicRow(row) } };
}

// A reporter can retract their own report with the secret their browser kept.
// The admin token (BOOM_ADMIN_TOKEN) deletes anything, for obvious junk.
export async function deleteBoom(db, env, id, secret, adminToken, account) {
  const row = await db
    .prepare('SELECT edit_hash, account_id FROM booms WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return { status: 404, error: 'not found' };

  const admin = env.BOOM_ADMIN_TOKEN && adminToken === env.BOOM_ADMIN_TOKEN;
  const owner = account && row.account_id && row.account_id === account.id;
  if (!admin && !owner) {
    if (typeof secret !== 'string' || !secret) return { status: 403, error: 'not your report' };
    if ((await sha256hex(secret)) !== row.edit_hash) {
      return { status: 403, error: 'not your report' };
    }
  }
  await db.batch([
    db.prepare('DELETE FROM boom_votes WHERE boom_id = ?').bind(id),
    db.prepare('DELETE FROM booms WHERE id = ?').bind(id),
  ]);
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------- votes

// value 1 or -1 casts, 0 retracts. Re-casting the same value also retracts, so
// the arrow behaves like a toggle.
export async function voteBoom(db, id, account, value) {
  if (![1, -1, 0].includes(value)) return { status: 400, error: 'vote must be 1, -1 or 0' };
  const boom = await db.prepare('SELECT id FROM booms WHERE id = ?').bind(id).first();
  if (!boom) return { status: 404, error: 'no such report' };

  const current = await db
    .prepare('SELECT value FROM boom_votes WHERE boom_id = ? AND account_id = ?')
    .bind(id, account.id)
    .first();

  if (value === 0 || current?.value === value) {
    await db
      .prepare('DELETE FROM boom_votes WHERE boom_id = ? AND account_id = ?')
      .bind(id, account.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO boom_votes (boom_id, account_id, value, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(boom_id, account_id) DO UPDATE SET value = excluded.value,
           created_at = excluded.created_at`,
      )
      .bind(id, account.id, value, Date.now())
      .run();
  }

  const tally = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN value = 1 THEN 1 END), 0) AS up,
              COALESCE(SUM(CASE WHEN value = -1 THEN 1 END), 0) AS down
       FROM boom_votes WHERE boom_id = ?`,
    )
    .bind(id)
    .first();

  const mine = value === 0 || current?.value === value ? 0 : value;
  const score = (tally?.up ?? 0) - (tally?.down ?? 0);
  return {
    status: 200,
    body: { id, up: tally?.up ?? 0, down: tally?.down ?? 0, score, mine, disputed: score <= DISPUTED_AT },
  };
}

// The signed-in visitor's own votes, so the arrows come back lit on reload.
// Kept out of the cacheable list endpoint on purpose.
export async function myVotes(db, account) {
  const { results } = await db
    .prepare('SELECT boom_id, value FROM boom_votes WHERE account_id = ?')
    .bind(account.id)
    .all();
  const votes = {};
  for (const r of results ?? []) votes[r.boom_id] = r.value;
  return { votes };
}
