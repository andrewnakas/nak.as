CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_chars_account ON characters(account_id);

CREATE TABLE friends (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  friend_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, friend_id)
);
