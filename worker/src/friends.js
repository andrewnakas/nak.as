// Friends: requests by username, accept/decline, list with character info.

export async function listFriends(db, accountId) {
  const { results } = await db
    .prepare(
      `SELECT a.username,
              f.status,
              f.account_id = ?1 AS outgoing,
              (SELECT MAX(level) FROM characters c WHERE c.account_id = a.id) AS level
       FROM friends f
       JOIN accounts a ON a.id = CASE WHEN f.account_id = ?1 THEN f.friend_id ELSE f.account_id END
       WHERE f.account_id = ?1 OR f.friend_id = ?1`,
    )
    .bind(accountId)
    .all();
  return results.map((r) => ({
    username: r.username,
    level: r.level ?? 1,
    status: r.status === 'accepted' ? 'friend' : r.outgoing ? 'sent' : 'incoming',
  }));
}

export async function sendRequest(db, accountId, username) {
  const target = await db
    .prepare('SELECT id FROM accounts WHERE username = ?')
    .bind(username ?? '')
    .first();
  if (!target) return { error: 'no such player', status: 404 };
  if (target.id === accountId) return { error: 'that is you', status: 400 };

  const existing = await db
    .prepare(
      'SELECT status FROM friends WHERE (account_id = ?1 AND friend_id = ?2) OR (account_id = ?2 AND friend_id = ?1)',
    )
    .bind(accountId, target.id)
    .first();
  if (existing) return { error: 'request already exists', status: 409 };

  await db
    .prepare(
      "INSERT INTO friends (account_id, friend_id, status, created_at) VALUES (?, ?, 'pending', ?)",
    )
    .bind(accountId, target.id, Date.now())
    .run();
  return { ok: true };
}

export async function respondRequest(db, accountId, username, accept) {
  const from = await db
    .prepare('SELECT id FROM accounts WHERE username = ?')
    .bind(username ?? '')
    .first();
  if (!from) return { error: 'no such player', status: 404 };

  if (accept) {
    const r = await db
      .prepare(
        "UPDATE friends SET status = 'accepted' WHERE account_id = ? AND friend_id = ? AND status = 'pending'",
      )
      .bind(from.id, accountId)
      .run();
    if (!r.meta.changes) return { error: 'no pending request', status: 404 };
  } else {
    await db
      .prepare('DELETE FROM friends WHERE account_id = ? AND friend_id = ?')
      .bind(from.id, accountId)
      .run();
  }
  return { ok: true };
}
