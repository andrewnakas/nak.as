#!/usr/bin/env node
// Fetch Reddit search feeds and hand them to the boom-map worker.
//
// Why a runner rather than only the worker's cron: Reddit rate-limits and
// sometimes outright blocks datacenter ranges, and Cloudflare's edge is exactly
// that. A GitHub runner is a second, independent path to the same feeds. The
// worker still does all the classifying and geocoding — this script only
// fetches XML and posts it — so both routes agree on what a post means.
//
//   node tools/boom-scrape.mjs                 # the routine pass
//   node tools/boom-scrape.mjs --backfill      # every historical query
//   node tools/boom-scrape.mjs --dry-run       # fetch and report, store nothing
//
// Env: BOOM_API (default https://api.nak.as), BOOM_ADMIN_TOKEN (required unless
// --dry-run).

const API = process.env.BOOM_API || 'https://api.nak.as';
const TOKEN = process.env.BOOM_ADMIN_TOKEN || '';
const args = new Set(process.argv.slice(2));
const BACKFILL = args.has('--backfill');
const DRY = args.has('--dry-run');

const UA = 'web:nak.as-bozeman-boom-map:0.1 (+https://nak.as/bozemanboom/)';

const SUBS = ['Bozeman', 'bozemanboom', 'Montana'];

// The routine pass: recent posts, the phrasings people actually use.
const RECENT = [
  { sub: 'Bozeman', q: 'boom', t: 'month' },
  { sub: 'Bozeman', q: 'explosion OR "loud bang" OR "sonic boom"', t: 'month' },
  { sub: 'Bozeman', q: '"what was that" OR "did anyone hear"', t: 'month' },
  { sub: 'bozemanboom', q: 'boom', t: 'year' },
  { sub: 'Montana', q: 'bozeman boom', t: 'year' },
];

// The backfill: every query against every subreddit, all time, both sort
// orders. Reddit caps a feed at 100 items and offers no paging, so breadth of
// queries is the only way to reach further back.
const QUERIES = [
  'boom', 'booms', '"loud boom"', '"huge boom"', 'explosion', '"loud bang"',
  '"sonic boom"', '"what was that noise"', '"did anyone hear"', '"heard a boom"',
  '"house shook"', '"windows rattled"', 'rumble', 'blast',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function feedUrl({ sub, q, t = 'all', sort = 'new' }) {
  return `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.rss` +
    `?q=${encodeURIComponent(q)}&restrict_sr=1&sort=${sort}&limit=100&t=${t}`;
}

// Reddit answers 429 readily. Back off and retry rather than losing the query.
async function fetchFeed(url, attempt = 1) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/atom+xml' } });
  if (r.status === 429 && attempt <= 4) {
    const wait = 20000 * attempt;
    console.log(`  429 — waiting ${wait / 1000}s (attempt ${attempt})`);
    await sleep(wait);
    return fetchFeed(url, attempt + 1);
  }
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, status: r.status, xml: await r.text() };
}

async function send(xml, subreddit) {
  if (DRY) {
    const n = (xml.match(/<entry>/g) || []).length;
    return { added: 0, kept: 0, received: n, dry: true };
  }
  const r = await fetch(`${API}/booms/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Boom-Admin': TOKEN },
    body: JSON.stringify({ xml, subreddit, backfill: BACKFILL }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `ingest failed: HTTP ${r.status}`);
  return body;
}

async function main() {
  if (!TOKEN && !DRY) {
    console.error('BOOM_ADMIN_TOKEN is not set — refusing to run.');
    process.exit(1);
  }

  const jobs = BACKFILL
    ? SUBS.flatMap((sub) =>
        QUERIES.flatMap((q) => [
          { sub, q, t: 'all', sort: 'new' },
          { sub, q, t: 'all', sort: 'top' },
        ]))
    : RECENT;

  console.log(`${BACKFILL ? 'Backfill' : 'Routine'} pass: ${jobs.length} feeds${DRY ? ' (dry run)' : ''}`);

  let totals = { added: 0, kept: 0, failed: 0 };
  for (const [i, job] of jobs.entries()) {
    const label = `r/${job.sub} ${job.q} [${job.sort ?? 'new'}/${job.t ?? 'all'}]`;
    try {
      const res = await fetchFeed(feedUrl(job));
      if (!res.ok) {
        totals.failed++;
        console.log(`✗ ${label} — HTTP ${res.status}`);
      } else {
        const stored = await send(res.xml, job.sub);
        totals.added += stored.added || 0;
        totals.kept += stored.kept || 0;
        console.log(`✓ ${label} — ${stored.received} entries, ${stored.kept} boom-related, ${stored.added} new`);
      }
    } catch (err) {
      totals.failed++;
      console.log(`✗ ${label} — ${err.message}`);
    }
    // Deliberately unhurried: this is somebody else's server.
    if (i < jobs.length - 1) await sleep(BACKFILL ? 12000 : 8000);
  }

  console.log(`\nDone: ${totals.added} new mentions, ${totals.kept} boom-related seen, ${totals.failed} feeds failed.`);
  // A pass where every feed failed is worth failing the job over; a few 429s
  // are normal and must not turn the run red.
  if (totals.failed === jobs.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
