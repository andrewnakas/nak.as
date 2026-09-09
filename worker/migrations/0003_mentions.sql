-- Public chatter about the booms: Reddit posts found by the scraper, plus
-- links people paste in (Facebook groups, news, anywhere).
--
-- A mention is a CITATION, not a measurement. We keep a short excerpt and
-- always link back to the original. Mentions never feed the source fit — only
-- first-hand reports in `booms` do.
CREATE TABLE mentions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- reddit | facebook | news | link
  kind TEXT NOT NULL DEFAULT 'report',  -- report (someone describing a boom) | discussion
  external_id TEXT,               -- e.g. reddit's t3_1wafpnn; NULL for pasted links
  url TEXT NOT NULL,
  title TEXT,
  excerpt TEXT,                   -- short quote, trimmed at ingest
  author TEXT,                    -- public handle as shown on the source
  subreddit TEXT,
  posted_at INTEGER NOT NULL,     -- when the post went up
  heard_at INTEGER,               -- clock time stated in the post, if any
  -- Location parsed out of the text, or set by whoever pasted the link.
  lat REAL,
  lon REAL,
  place TEXT,                     -- human label: "Kagy corner area"
  place_conf TEXT,                -- stated | area | NULL (unplaced)
  submitted_by TEXT,              -- name given by whoever pasted the link
  ip_hash TEXT,
  fetched_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_mentions_ext ON mentions(source, external_id);
CREATE INDEX idx_mentions_posted ON mentions(posted_at);
CREATE INDEX idx_mentions_ip ON mentions(ip_hash, fetched_at);

-- Scraper bookkeeping: which source is next in the rotation, and how the last
-- fetch went. Reddit rate-limits aggressively, so we hit one source per tick.
CREATE TABLE scrape_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
