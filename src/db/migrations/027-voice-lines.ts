import type { PortableMigration } from './index.js';

/**
 * `voice_lines` - who owns each voice line, and where its LiveKit calls talk.
 *
 * One row per voice line (its `voice` messaging group). The operator creates
 * it (`ncl voice-lines create`), naming the line's owner as that person's user
 * on a chat platform (e.g. `telegram:123`). A line's caller is its own
 * `voice:<line id>` user, which is linked to no other account, so this row is
 * the only link between a line and its owner's chat identity. Only the owner
 * can run `/voice` for the line. That sets the target: a chat (messaging group
 * + thread) wired to the line's agent, where each transcribed turn of a call is
 * routed as a message from the line's own caller. Both target columns stay
 * null until then, and the default rule (WALKIE_MIRROR) picks the chat.
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
        owner_user_id             TEXT NOT NULL,
        target_messaging_group_id TEXT,
        thread_id                 TEXT,
        updated_at                TEXT NOT NULL
      );
    `);
  },
};
