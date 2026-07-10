/**
 * Persistence for the telegram-grammy command-scope janitor.
 *
 * Stores the exact set of Telegram Bot API command scopes that the adapter
 * last pushed via setMyCommands, so the next startup can diff against the
 * current grants and deleteMyCommands for the scopes that fell away. See
 * migration 020 and src/channels/telegram-grammy/commands/scope-sync.ts.
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
export function getAppliedCommandScopes(): AppliedCommandScope[] {
  const rows = getDb()
    .prepare('SELECT scope_key, scope_json FROM telegram_command_scopes ORDER BY scope_key')
    .all() as { scope_key: string; scope_json: string }[];
  return rows.map((r) => ({ scopeKey: r.scope_key, scopeJson: r.scope_json }));
}

/**
 * Replace the applied-scope record with exactly `scopes`. Runs in one
 * transaction so a crash mid-write never leaves a half-updated record that
 * would make the next janitor pass delete live scopes.
 */
export function replaceAppliedCommandScopes(scopes: readonly AppliedCommandScope[]): void {
  const db = getDb();
  const appliedAt = new Date().toISOString();
  const tx = db.transaction((list: readonly AppliedCommandScope[]) => {
    db.prepare('DELETE FROM telegram_command_scopes').run();
    const insert = db.prepare(
      'INSERT INTO telegram_command_scopes (scope_key, scope_json, applied_at) VALUES (?, ?, ?)',
    );
    for (const s of list) insert.run(s.scopeKey, s.scopeJson, appliedAt);
  });
  tx(scopes);
}
