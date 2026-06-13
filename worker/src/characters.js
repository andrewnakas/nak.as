// Character persistence: one save blob per character, validated on write,
// rate-limited to one write per 10s per character.

import { validateSave } from './validate.js';

const WRITE_INTERVAL_MS = 10000;
const MAX_CHARACTERS = 3;
const MAX_SAVE_BYTES = 32 * 1024;

export async function listCharacters(db, accountId) {
  const { results } = await db
    .prepare(
      'SELECT id, name, level, schema_version, updated_at FROM characters WHERE account_id = ?',
    )
    .bind(accountId)
    .all();
  return results;
}

export async function getCharacter(db, accountId, id) {
  return db
    .prepare('SELECT id, name, data, updated_at FROM characters WHERE id = ? AND account_id = ?')
    .bind(id, accountId)
    .first();
}

export async function createCharacter(db, accountId, name, data) {
  const existing = await db
    .prepare('SELECT COUNT(*) AS n FROM characters WHERE account_id = ?')
    .bind(accountId)
    .first();
  if (existing.n >= MAX_CHARACTERS) return { error: 'character limit reached', status: 409 };

  const err = checkPayload(data);
  if (err) return err;

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO characters (id, account_id, name, schema_version, level, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, accountId, String(name).slice(0, 16), data.schema_version, level(data), JSON.stringify(data), Date.now())
    .run();
  return { id };
}

export async function updateCharacter(db, accountId, id, data) {
  const row = await db
    .prepare('SELECT updated_at FROM characters WHERE id = ? AND account_id = ?')
    .bind(id, accountId)
    .first();
  if (!row) return { error: 'not found', status: 404 };
  if (Date.now() - row.updated_at < WRITE_INTERVAL_MS) {
    return { error: 'too many saves; slow down', status: 429 };
  }

  const err = checkPayload(data);
  if (err) return err;

  await db
    .prepare(
      'UPDATE characters SET data = ?, schema_version = ?, level = ?, updated_at = ? WHERE id = ?',
    )
    .bind(JSON.stringify(data), data.schema_version, level(data), Date.now(), id)
    .run();
  return { ok: true };
}

function checkPayload(data) {
  if (JSON.stringify(data ?? null).length > MAX_SAVE_BYTES) {
    return { error: 'save too large', status: 413 };
  }
  const reason = validateSave(data);
  if (reason) return { error: `invalid save: ${reason}`, status: 422 };
  return null;
}

/// Display "level": highest skill level approximation for the friends list.
function level(data) {
  const max = Math.max(...data.skills, 0);
  return 1 + Math.floor(Math.sqrt(max / 50));
}
