import type { PortableMigration } from './index.js';

/**
 * `voice_call_targets` - where a voice line's LiveKit calls talk, set by the
 * `/voice` chat command.
 *
 * One row per voice line (its `voice` messaging group). The target is a chat
 * (messaging group + thread) wired to the line's agent; each transcribed turn
 * of a call is routed into that chat's session as an inbound message from
 * `sender_user_id` (the user who ran `/voice`). Running `/voice` in another
 * chat of the same agent replaces the row. No row means the default rule
 * (WALKIE_MIRROR) picks the chat.
 *
 * No foreign keys: a row whose chat was deleted, unwired or denied is ignored
 * by the reader (src/channels/voice-livekit.ts), never an integrity error.
 */
export const migration027: PortableMigration = {
  version: 27,
  name: 'voice-call-targets',
  async up(db) {
    await db.exec(`
      CREATE TABLE voice_call_targets (
        line_messaging_group_id   TEXT PRIMARY KEY,
        target_messaging_group_id TEXT NOT NULL,
        thread_id                 TEXT,
        sender_user_id            TEXT NOT NULL,
        updated_at                TEXT NOT NULL
      );
    `);
  },
};
