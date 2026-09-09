# nak.as

Personal site for Andrew Nakas. Single static page that renders an interactive 3D scan via [`<model-viewer>`](https://modelviewer.dev/).

## Deploy

Static site — hosted on Cloudflare Pages.

- Build command: *(none)*
- Build output directory: `/`
- Custom domain: `nak.as`

## Local preview

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Bozeman Boom Map — `/bozemanboom/`

A public Leaflet map for reporting the unexplained booms heard around the
Gallatin Valley, and for fitting a likely source to them. `/bozemanboommap`
redirects here.

Two kinds of data, deliberately kept apart:

- **First-hand reports** (`booms`) — what people file on the site. Only these
  feed the source fit. No accounts: writes are guarded by a bounding box, a
  3-day reporting window, enum validation and a per-IP rate limit, and
  coordinates are rounded to 3 decimals (~110 m) before storage. A reporter
  deletes their own report with a secret their browser keeps in `localStorage`.
- **Chatter** (`mentions`) — public posts about the booms. A cron trigger pulls
  one Reddit search feed every 15 minutes (r/Bozeman, r/bozemanboom, r/Montana),
  keeps the title, a short excerpt and a link back, and reads a location out of
  the text via `src/gazetteer.js` — the Bozeman street grid, so "Baxter and
  Davis" resolves to a corner, with a negation guard so "not the fairgrounds"
  doesn't pin the fairgrounds. Facebook groups are private and have no API, so
  they arrive only when someone pastes a link (`POST /booms/mentions`).

Endpoints: `GET|POST /booms`, `DELETE /booms/:id`, `GET|POST /booms/mentions`,
`DELETE /booms/mentions/:id` (admin), `GET /booms/sources` (scraper status),
`POST /booms/scrape` (admin, runs a tick now).

Deploying a change to the reports API:

```sh
cd worker
wrangler d1 migrations apply naks-awakening --remote   # first time only
wrangler deploy
```

Optional worker vars: `BOOM_SALT` (salt for the rate-limit IP hashes),
`BOOM_ADMIN_TOKEN` (send as `X-Boom-Admin` to hide junk or force a scrape) and
`BOOM_SUBREDDITS` (comma-separated, overrides the default feed list).

Reddit rate-limits the public RSS feeds hard, which is why the scraper takes one
feed per tick and keeps its place in the rotation when it gets a 429.
