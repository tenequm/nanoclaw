import type { PortableMigration } from './index.js';

/**
 * `voice_lines` + `voice_line_owners` - who owns each voice line, and where its
 * LiveKit calls talk.
 *
 * One `voice_lines` row per voice line (its `voice` messaging group), created by
 * the operator (`ncl voice-lines set`). Its owners are one person's chat
 * accounts (e.g. `telegram:123` and `slack:U123`), one `voice_line_owners` row
 * each (`ncl voice-lines add-owner`). A line's caller is its own
 * `voice:<line id>` user, which is linked to no other account, so these rows
 * are the only link between a line and its owner's chat identities. Only an
 * owner account can run `/voice` for the line. That sets the target: a chat
 * (messaging group + thread) wired to the line's agent, where each transcribed
 * turn of a call is routed as a message from the line's own caller. The last
 * `/voice` from any owner account wins. Both target columns stay null until
 * then, and the default rule (VOICE_MIRROR) picks the chat.
 *
 * No foreign keys: a row whose chat was deleted, unwired or denied is ignored
 * by the reader (src/channels/voice-livekit.ts), never an integrity error.
 */
export const migration027: PortableMigration = {
  version: 27,
  name: 'voice-lines',
  async up(db) {
    await db.exec(`
      CREATE TABLE voice_lines (
        line_messaging_group_id   TEXT PRIMARY KEY,
        target_messaging_group_id TEXT,
        thread_id                 TEXT,
        updated_at                TEXT NOT NULL
      );
      CREATE TABLE voice_line_owners (
        line_messaging_group_id TEXT NOT NULL,
        owner_user_id           TEXT NOT NULL,
        PRIMARY KEY (line_messaging_group_id, owner_user_id)
      );
    `);
  },
};
