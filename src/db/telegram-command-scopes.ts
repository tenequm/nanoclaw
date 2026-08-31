/**
 * Persistence for the telegram-grammy command-scope janitor.
 *
 * Stores the exact set of Telegram Bot API command scopes that the adapter
 * last pushed via setMyCommands, so the next startup can diff against the
 * current grants and deleteMyCommands for the scopes that fell away. See
 * migration 025 and src/channels/telegram-grammy/commands/scope-sync.ts.
 *
 * Channel-neutral shape on purpose: a `scope_key` string plus the raw JSON of
 * the scope object. The DB layer knows nothing about Telegram; the adapter
 * owns the encoding.
 */
import { getDb } from './connection.js';

export interface AppliedCommandScope {
  scopeKey: string;
  scopeJson: string;
}

/** All command scopes recorded as applied by a previous adapter run. */
export async function getAppliedCommandScopes(): Promise<AppliedCommandScope[]> {
  const rows = await getDb().all<{ scope_key: string; scope_json: string }>(
    'SELECT scope_key, scope_json FROM telegram_command_scopes ORDER BY scope_key',
  );
  return rows.map((r) => ({ scopeKey: r.scope_key, scopeJson: r.scope_json }));
}

/**
 * Replace the applied-scope record with exactly `scopes`. Runs in one
 * transaction so a crash mid-write never leaves a half-updated record that
 * would make the next janitor pass delete live scopes.
 */
export async function replaceAppliedCommandScopes(scopes: readonly AppliedCommandScope[]): Promise<void> {
  const db = getDb();
  const appliedAt = new Date().toISOString();
  await db.transaction(async () => {
    await db.run('DELETE FROM telegram_command_scopes');
    for (const s of scopes) {
      await db.run(
        'INSERT INTO telegram_command_scopes (scope_key, scope_json, applied_at) VALUES (?, ?, ?)',
        s.scopeKey,
        s.scopeJson,
        appliedAt,
      );
    }
  });
}
