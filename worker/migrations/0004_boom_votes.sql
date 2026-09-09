-- Voting on reports, using the accounts the site already has.
--
-- One vote per account per report, so ballot-stuffing costs an account rather
-- than a browser refresh. A heavily downvoted report is dropped from the source
-- fit: the crowd is the filter for someone typing nonsense into the map.
CREATE TABLE boom_votes (
  boom_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (boom_id, account_id)
);

CREATE INDEX idx_boom_votes_boom ON boom_votes(boom_id);
CREATE INDEX idx_boom_votes_account ON boom_votes(account_id);

-- Signed-in reports get attributed to the account; anonymous ones stay NULL.
ALTER TABLE booms ADD COLUMN account_id TEXT;
