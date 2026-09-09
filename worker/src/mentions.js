// Public chatter about the booms.
//
// Two ways in:
//   1. A cron-driven scrape of Reddit search feeds (r/Bozeman and friends).
//   2. Links people paste in themselves — the only route for Facebook groups,
//      which have no public API and cannot be scraped.
//
// A mention is a citation, never a measurement: we keep a short excerpt, always
// link back, and never feed mentions into the source fit.

import { sha256hex } from './auth.js';
import { findPlace } from './gazetteer.js';

const DAY = 86400000;

// Reddit rate-limits the unauthenticated feeds hard, so a tick fetches exactly
// one (subreddit, query) pair and the rotation walks the list. With a 15-minute
// cron that is four requests an hour, which nobody can call abusive.
const FEEDS = [
  { sub: 'Bozeman', q: 'boom' },
  { sub: 'Bozeman', q: 'explosion OR "loud bang" OR "sonic boom"' },
  { sub: 'Bozeman', q: '"what was that" OR "did anyone hear"' },
  { sub: 'Montana', q: 'bozeman boom' },
  { sub: 'bozemanboom', q: 'boom' },
];

// The search query is loose, so filter again here. "Boomer", "boom town" and
// "boomerang" are not booms.
const IS_BOOM = /\b(booms?|boomed|explosions?|shock ?wave|sonic boom|loud bang)\b/i;
const NOT_BOOM = /\b(boomer|boomers|boomerang|boom ?town|baby boom|business is booming|booming (economy|business|market))\b/i;

// Somebody describing an experience, as opposed to discussing the phenomenon.
// "Is this the new boom?" under a post about a bear is chatter; "my house
// shook" is a report. Both are worth linking; only one is worth a pin.
const FIRST_HAND = /\b(heard|hear|felt|feel|shook|shaking|shake|rattled|rattling|woke|woken|jolted|scared|windows|dishes|bed shook|whole house)\b/i;

// Reddit's RSS pads every body with a submitter footer; it is not content.
const RSS_BOILERPLATE = /\s*submitted by\s*\/u\/\S+\s*(\[link\])?\s*(\[comments\])?\s*$/i;

const EXCERPT_MAX = 320;
const MAX_AGE_MS = 45 * DAY;

// Where a pasted link may point. Anything else is refused rather than stored.
const LINK_HOSTS = [
  ['facebook.com', 'facebook'], ['m.facebook.com', 'facebook'], ['fb.com', 'facebook'],
  ['fb.watch', 'facebook'], ['web.facebook.com', 'facebook'],
  ['reddit.com', 'reddit'], ['old.reddit.com', 'reddit'], ['redd.it', 'reddit'],
  ['nextdoor.com', 'nextdoor'],
  ['x.com', 'x'], ['twitter.com', 'x'],
  ['instagram.com', 'instagram'],
  ['youtube.com', 'youtube'], ['youtu.be', 'youtube'],
  ['tiktok.com', 'tiktok'],
  ['bozemandailychronicle.com', 'news'], ['nbcmontana.com', 'news'], ['ktvh.com', 'news'],
  ['kbzk.com', 'news'], ['montanarightnow.com', 'news'], ['explorebigsky.com', 'news'],
  ['mtpr.org', 'news'], ['abcfoxmontana.com', 'news'],
];

const MAX_LINKS_PER_HOUR = 10;

// ---------------------------------------------------------------- text utils

function decodeEntities(s) {
  return s
    .replace(/&(?:amp|#38);/g, '&')
    .replace(/&(?:lt|#60);/g, '<')
    .replace(/&(?:gt|#62);/g, '>')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(s) {
  // Reddit double-encodes the post body inside <content>, so decode, drop the
  // markup, then decode again for entities that were nested.
  const once = decodeEntities(s || '');
  return decodeEntities(once.replace(/<[^>]*>/g, ' '))
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s, max) {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// ---------------------------------------------------------------- time

// Everyone posting here is on Mountain Time; the worker is on UTC. Resolve the
// offset at the instant in question so MDT/MST both come out right.
function denverOffsetMs(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - ms;
}

function denverParts(ms) {
  const off = denverOffsetMs(ms);
  const d = new Date(ms + off);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), off };
}

// Pull a stated clock time out of the text: "1143pm", "11:43 pm", "around 9:15".
// Anchored to the post's own day, and only accepted if it lands in the 24 hours
// before the post — a time later than the post is somebody's typo or a plan.
export function parseHeardAt(text, postedAt) {
  if (!text) return null;
  const m =
    text.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i) ||
    text.match(/\b(\d{1,2})(\d{2})\s*([ap])\.?m\.?/i) ||
    text.match(/\b(\d{1,2})\s*([ap])\.?m\.?/i);
  if (!m) return null;

  let hour, minute, ampm;
  if (m.length === 4) {
    hour = Number(m[1]); minute = Number(m[2]); ampm = m[3].toLowerCase();
  } else {
    hour = Number(m[1]); minute = 0; ampm = m[2].toLowerCase();
  }
  if (!(hour >= 1 && hour <= 12) || !(minute >= 0 && minute <= 59)) return null;
  if (ampm === 'p' && hour !== 12) hour += 12;
  if (ampm === 'a' && hour === 12) hour = 0;

  const { y, m: mo, d, off } = denverParts(postedAt);
  let at = Date.UTC(y, mo, d, hour, minute) - off;
  if (at > postedAt + 30 * 60000) at -= DAY;          // stated time was yesterday
  if (at < postedAt - DAY) return null;               // too far back to trust
  return at;
}

// ---------------------------------------------------------------- reddit

function parseAtom(xml) {
  const out = [];
  for (const chunk of xml.split('<entry>').slice(1)) {
    const entry = chunk.split('</entry>')[0];
    const pick = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1] : null;
    };
    const link = entry.match(/<link[^>]*href="([^"]+)"/);
    const id = pick('id');
    if (!id || !link) continue;
    out.push({
      id: decodeEntities(id).trim(),
      url: decodeEntities(link[1]).split('?')[0],
      title: stripHtml(pick('title') || ''),
      body: stripHtml(pick('content') || ''),
      author: stripHtml(entry.match(/<name>([\s\S]*?)<\/name>/)?.[1] || ''),
      updated: Date.parse(decodeEntities(pick('updated') || '')) || null,
    });
  }
  return out;
}

async function readState(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM scrape_state WHERE key = ?').bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

async function writeState(db, key, value) {
  await db
    .prepare(
      `INSERT INTO scrape_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

// Fetch one feed, store what's new. Returns a small report for the status view.
export async function scrapeOnce(db, env) {
  const feeds = env.BOOM_SUBREDDITS
    ? env.BOOM_SUBREDDITS.split(',').map((s) => ({ sub: s.trim(), q: 'boom' })).filter((f) => f.sub)
    : FEEDS;

  const state = await readState(db, 'reddit', { next: 0, log: [] });
  const feed = feeds[state.next % feeds.length];
  const now = Date.now();

  const url = `https://www.reddit.com/r/${encodeURIComponent(feed.sub)}/search.rss` +
    `?q=${encodeURIComponent(feed.q)}&restrict_sr=1&sort=new&limit=25&t=month`;

  const result = { feed: `r/${feed.sub}: ${feed.q}`, at: now, added: 0, seen: 0 };
  try {
    const r = await fetch(url, {
      headers: {
        // Reddit asks for a descriptive agent with a contact route; this is it.
        'User-Agent': 'web:nak.as-bozeman-boom-map:0.1 (+https://nak.as/bozemanboom/)',
        Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      },
    });
    result.status = r.status;
    if (!r.ok) {
      result.error = r.status === 429 ? 'rate limited by reddit' : `http ${r.status}`;
    } else {
      const entries = parseAtom(await r.text());
      result.seen = entries.length;
      const stored = await ingestEntries(db, entries, feed.sub, { maxAgeMs: MAX_AGE_MS });
      result.added = stored.added;
      result.kept = stored.kept;
    }
  } catch (err) {
    result.error = String(err?.message || err).slice(0, 160);
  }

  // A rate-limited tick keeps its place in the rotation — otherwise a 429
  // silently costs that feed a whole cycle.
  const advance = result.status !== 429;
  const log = [result, ...(state.log || [])].slice(0, 12);
  await writeState(db, 'reddit', {
    next: advance ? (state.next + 1) % feeds.length : state.next,
    log,
  });
  return result;
}

// Turn raw feed entries into stored mentions. Shared by the worker's cron and
// by POST /booms/ingest, so a post is judged the same way whoever fetched it.
//
// `maxAgeMs` is how far back to accept — the routine scrape keeps a month and a
// half, the historical backfill passes Infinity.
export async function ingestEntries(db, entries, subreddit, opts = {}) {
  const maxAge = opts.maxAgeMs ?? MAX_AGE_MS;
  const now = Date.now();
  let added = 0;
  let kept = 0;

  for (const e of entries ?? []) {
    if (!e || typeof e.id !== 'string' || typeof e.url !== 'string') continue;
    const title = stripHtml(e.title || '');
    const body = stripHtml(e.body || '').replace(RSS_BOILERPLATE, '');
    const text = `${title} ${body}`;
    if (!IS_BOOM.test(text) || NOT_BOOM.test(text)) continue;

    const posted = Number(e.updated) || now;
    if (posted < now - maxAge || posted > now + 3600000) continue;

    const place = findPlace(text);
    const heardAt = parseHeardAt(text, posted);
    // "Boom 11:26pm near Ferguson and Babcock" is a report even though it never
    // says "heard": a boom in the title plus a place or a time is somebody
    // logging an event, not discussing one.
    const titled = IS_BOOM.test(title) && (place || heardAt);
    const kind = FIRST_HAND.test(text) || titled ? 'report' : 'discussion';

    kept++;
    const isNew = await upsertMention(db, {
      kind,
      source: 'reddit',
      external_id: e.id,
      url: e.url.split('?')[0],
      title: clip(title, 200),
      excerpt: clip(body, EXCERPT_MAX),
      author: clip(stripHtml(e.author || ''), 64),
      subreddit: clip(stripHtml(e.subreddit || subreddit || ''), 40),
      posted_at: posted,
      heard_at: heardAt,
      lat: place?.lat ?? null,
      lon: place?.lon ?? null,
      place: place?.name ?? null,
      place_conf: place?.conf ?? null,
    });
    if (isNew) added++;
  }
  return { added, kept };
}

// Parse an Atom feed handed over by an outside fetcher (the GitHub Action posts
// raw XML when Reddit will talk to a runner but not to the edge).
export function parseFeed(xml) {
  return parseAtom(xml).map((e) => ({
    id: e.id, url: e.url, title: e.title, body: e.body, author: e.author, updated: e.updated,
  }));
}

// Insert if new; refresh the text of one we already have. Returns true when the
// row is new, which is what the status view counts.
async function upsertMention(db, m) {
  const existing = await db
    .prepare('SELECT id FROM mentions WHERE source = ? AND external_id = ?')
    .bind(m.source, m.external_id)
    .first();

  if (existing) {
    await db
      .prepare(
        `UPDATE mentions SET title = ?, excerpt = ?, kind = ?, heard_at = COALESCE(heard_at, ?),
           lat = COALESCE(lat, ?), lon = COALESCE(lon, ?), place = COALESCE(place, ?),
           place_conf = COALESCE(place_conf, ?), fetched_at = ?
         WHERE id = ?`,
      )
      .bind(m.title, m.excerpt, m.kind, m.heard_at, m.lat, m.lon, m.place, m.place_conf, Date.now(), existing.id)
      .run();
    return false;
  }

  await db
    .prepare(
      `INSERT INTO mentions (id, source, kind, external_id, url, title, excerpt, author, subreddit,
         posted_at, heard_at, lat, lon, place, place_conf, submitted_by, ip_hash, fetched_at, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0)`,
    )
    .bind(
      crypto.randomUUID(), m.source, m.kind, m.external_id, m.url, m.title, m.excerpt, m.author,
      m.subreddit, m.posted_at, m.heard_at, m.lat, m.lon, m.place, m.place_conf, Date.now(),
    )
    .run();
  return true;
}

// ---------------------------------------------------------------- read

function publicMention(r) {
  return {
    id: r.id,
    source: r.source,
    kind: r.kind || 'report',
    url: r.url,
    title: r.title,
    excerpt: r.excerpt,
    author: r.author,
    subreddit: r.subreddit,
    at: r.heard_at ?? r.posted_at,
    posted: r.posted_at,
    timed: r.heard_at !== null,
    lat: r.lat,
    lon: r.lon,
    place: r.place,
    conf: r.place_conf,
    by: r.submitted_by,
  };
}

export async function listMentions(db, url) {
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 3, 1), 3650);
  const since = Date.now() - days * DAY;
  const { results } = await db
    .prepare(
      `SELECT * FROM mentions WHERE hidden = 0 AND COALESCE(heard_at, posted_at) >= ?
       ORDER BY COALESCE(heard_at, posted_at) DESC LIMIT 500`,
    )
    .bind(since)
    .all();
  return { mentions: (results ?? []).map(publicMention) };
}

export async function scrapeStatus(db) {
  const state = await readState(db, 'reddit', { next: 0, log: [] });
  const counts = await db
    .prepare('SELECT source, COUNT(*) AS n FROM mentions WHERE hidden = 0 GROUP BY source')
    .all();
  return { rotation: state.next, log: state.log ?? [], counts: counts.results ?? [] };
}

// ---------------------------------------------------------------- write

// Someone pasting a link — the only supported route for Facebook group posts,
// which are private and have no API to read.
export async function submitLink(db, request, env, body) {
  if (!body || typeof body.url !== 'string') return { status: 400, error: 'paste a link first' };

  let parsed;
  try { parsed = new URL(body.url.trim()); } catch { return { status: 400, error: 'that is not a link' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { status: 400, error: 'links must be http(s)' };
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const match = LINK_HOSTS.find(([h]) => host === h || host.endsWith(`.${h}`));
  if (!match) {
    return { status: 400, error: 'that site is not on the list — Facebook, Reddit, Nextdoor, X, Instagram, YouTube, TikTok and Montana news sites are' };
  }
  const source = match[1];

  const ip = await sha256hex(`boom:${env.BOOM_SALT || 'nak.as'}:${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM mentions WHERE ip_hash = ? AND fetched_at > ?')
    .bind(ip, Date.now() - 3600000)
    .first();
  if ((recent?.n ?? 0) >= MAX_LINKS_PER_HOUR) {
    return { status: 429, error: 'too many links from here in the last hour' };
  }

  // The canonical URL is the identity: paste the same post twice, get one row.
  const canonical = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
  const dupe = await db.prepare('SELECT id FROM mentions WHERE url = ?').bind(canonical).first();
  if (dupe) return { status: 409, error: 'that post is already on the map' };

  const now = Date.now();
  const at = Number(body.at);
  const heardAt = Number.isFinite(at) && at <= now + 600000 && at > now - 45 * DAY ? at : null;

  // A pin the submitter dropped wins; otherwise try to read a place out of
  // whatever they quoted.
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const pinned = Number.isFinite(lat) && Number.isFinite(lon) &&
    lat > 44.5 && lat < 46.6 && lon > -113 && lon < -109.2;
  const quoted = clip(typeof body.excerpt === 'string' ? stripHtml(body.excerpt) : '', EXCERPT_MAX);
  const guess = pinned ? null : findPlace(`${quoted || ''} ${body.place || ''}`);

  const row = {
    id: crypto.randomUUID(),
    source,
    kind: 'report',            // somebody bothered to paste it, treat it as one
    external_id: null,
    url: canonical,
    title: clip(typeof body.title === 'string' ? stripHtml(body.title) : '', 200),
    excerpt: quoted,
    author: null,
    subreddit: null,
    posted_at: heardAt ?? now,
    heard_at: heardAt,
    lat: pinned ? Math.round(lat * 1000) / 1000 : guess?.lat ?? null,
    lon: pinned ? Math.round(lon * 1000) / 1000 : guess?.lon ?? null,
    place: pinned ? clip(typeof body.place === 'string' ? stripHtml(body.place) : '', 80) : guess?.name ?? null,
    place_conf: pinned ? 'stated' : guess?.conf ?? null,
    submitted_by: clip(typeof body.by === 'string' ? stripHtml(body.by) : '', 32),
    ip_hash: ip,
    fetched_at: now,
  };

  await db
    .prepare(
      `INSERT INTO mentions (id, source, kind, external_id, url, title, excerpt, author, subreddit,
         posted_at, heard_at, lat, lon, place, place_conf, submitted_by, ip_hash, fetched_at, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(
      row.id, row.source, row.kind, row.external_id, row.url, row.title, row.excerpt, row.author,
      row.subreddit, row.posted_at, row.heard_at, row.lat, row.lon, row.place, row.place_conf,
      row.submitted_by, row.ip_hash, row.fetched_at,
    )
    .run();

  return { status: 200, body: { mention: publicMention(row) } };
}

// Private-group posts (Facebook) collected by a member browsing their own
// account. The text is read here to work out where and when, then dropped: the
// stored row keeps the derived place and time and a link back, never the
// wording and never the poster's name. A link into a private group only opens
// for other members anyway, so the excerpt would be the only thing actually
// republished — and that is exactly what we are not doing.
export async function ingestRedacted(db, items) {
  const now = Date.now();
  let added = 0;
  let skipped = 0;

  for (const item of items ?? []) {
    if (!item || typeof item.url !== 'string') { skipped++; continue; }
    let parsed;
    try { parsed = new URL(item.url); } catch { skipped++; continue; }
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const match = LINK_HOSTS.find(([h]) => host === h || host.endsWith(`.${h}`));
    if (!match) { skipped++; continue; }

    // Read the text, keep only what it tells us about where and when.
    const text = stripHtml(String(item.text || ''));
    if (!IS_BOOM.test(text) || NOT_BOOM.test(text)) { skipped++; continue; }
    const postedAt = Number(item.at) || now;
    const place = findPlace(text);
    const heardAt = parseHeardAt(text, postedAt);
    const kind = FIRST_HAND.test(text) || (place || heardAt) ? 'report' : 'discussion';

    const canonical = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
    const dupe = await db.prepare('SELECT id FROM mentions WHERE url = ?').bind(canonical).first();
    if (dupe) { skipped++; continue; }

    await db
      .prepare(
        `INSERT INTO mentions (id, source, kind, external_id, url, title, excerpt, author,
           subreddit, posted_at, heard_at, lat, lon, place, place_conf, submitted_by, ip_hash,
           fetched_at, hidden)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
      )
      .bind(
        crypto.randomUUID(), match[1], kind, canonical,
        // A neutral title: enough to know what the row is, nothing quoted.
        clip(item.group ? `Post in ${stripHtml(item.group)}` : 'Facebook group post', 200),
        postedAt, heardAt,
        place?.lat ?? null, place?.lon ?? null, place?.name ?? null, place?.conf ?? null,
        clip(stripHtml(item.by || ''), 32),
        now,
      )
      .run();
    added++;
  }
  return { added, skipped };
}

export async function hideMention(db, env, id, adminToken) {
  if (!env.BOOM_ADMIN_TOKEN || adminToken !== env.BOOM_ADMIN_TOKEN) {
    return { status: 403, error: 'admin only' };
  }
  await db.prepare('UPDATE mentions SET hidden = 1 WHERE id = ?').bind(id).run();
  return { status: 200, body: { ok: true } };
}
