import type { Migration } from './index.js';

/**
 * `telegram_command_scopes` - the set of Telegram Bot API command scopes the
 * telegram-grammy adapter has most recently pushed via setMyCommands.
 *
 * The startup "scope janitor" (src/channels/telegram-grammy/commands/scope-sync.ts)
 * diffs the current command grants against this table so it can call
 * deleteMyCommands for scopes that a previous run registered but that are no
 * longer granted (revoked admins, unwired chats). Without persistence the
 * janitor could only guess at stale per-chat scopes; the bot token also
 * carries scopes from a prior install (OpenClaw) that live only on Telegram's
 * side, so a durable record of what THIS install applied is the reliable diff
 * key.
 *
 * One row per applied scope. `scope_key` is a stable string encoding of the
 * BotCommandScope object (e.g. "chat_member:-100123:95307956" or
 * "chat:95307956"). `scope_json` stores the exact object so the janitor can
 * hand it straight to deleteMyCommands without reparsing the key.
 */
export const migration020: Migration = {
  version: 20,
  name: 'telegram-command-scopes',
  up(db) {
    db.exec(`
      CREATE TABLE telegram_command_scopes (
        scope_key  TEXT PRIMARY KEY,
        scope_json TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  },
};
