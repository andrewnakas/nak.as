-- Bozeman boom map: crowd-sourced reports of unexplained booms.
--
-- Coordinates are stored rounded to 3 decimals (~110 m) — enough to
-- triangulate a source miles away, not enough to point at someone's house.
CREATE TABLE booms (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  -- When the reporter heard it (ms epoch), and how sure they are of that time.
  occurred_at INTEGER NOT NULL,
  time_precision TEXT NOT NULL,   -- exact | minute | hour | vague
  intensity INTEGER NOT NULL,     -- 1 (faint) .. 5 (windows rattled hard)
  sound TEXT NOT NULL,            -- single | double | multiple | rumble | crack | other
  duration TEXT NOT NULL,         -- instant | short | long | unknown
  shook INTEGER NOT NULL,         -- 1 if the reporter felt the house/ground move
  indoors INTEGER,                -- 1 indoors, 0 outdoors, NULL unknown
  direction TEXT NOT NULL,        -- N NE E SE S SW W NW | unknown
  notes TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,          -- salted hash, for rate limiting only
  edit_hash TEXT NOT NULL,        -- hash of the reporter's local secret, for delete
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_booms_occurred ON booms(occurred_at);
CREATE INDEX idx_booms_ip ON booms(ip_hash, created_at);
