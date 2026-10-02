/**
 * Voice line owners and `/voice` targets: whose chat accounts own each voice
 * line, and the chat its LiveKit calls talk in. See src/channels/voice-mode-livekit.ts.
 * Rows are written by the operator (`ncl voice-lines set|add-owner`,
 * src/cli/resources/voice-mode-lines.ts).
 */
import { getDb } from './connection.js';
import { registerMigration } from './migrations/index.js';

/**
 * `voice_lines` + `voice_line_owners` - who owns each voice line, and where its
 * LiveKit calls talk.
 *
 * One `voice_lines` row per voice line (its `voice-mode` messaging group), created by
 * the operator (`ncl voice-lines set`). Its owners are one person's chat
 * accounts (e.g. `telegram:123` and `slack:U123`), one `voice_line_owners` row
 * each (`ncl voice-lines add-owner`). A line's caller is its own
 * `voice-mode:<line id>` user, which is linked to no other account, so these rows
 * are the only link between a line and its owner's chat identities. Only an
 * owner account can run `/voice` for the line. That sets the target: a chat
 * (messaging group + thread) wired to the line's agent, where each transcribed
 * turn of a call is routed as a message from the line's own caller. The last
 * `/voice` from any owner account wins. Both target columns stay null until
 * then, and the default rule (VOICE_MIRROR) picks the chat.
 *
 * No foreign keys: a row whose chat was deleted, unwired or denied is ignored
 * by the reader (src/channels/voice-mode-livekit.ts), never an integrity error.
 * A module migration (registered on import, applied at host start), so the
 * skill adds no line to the core migration barrel and needs no number.
 */
registerMigration({
  version: 1,
  name: 'module:voice-mode:voice-lines',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS voice_lines (
        line_messaging_group_id   TEXT PRIMARY KEY,
        target_messaging_group_id TEXT,
        thread_id                 TEXT,
        updated_at                TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS voice_line_owners (
        line_messaging_group_id TEXT NOT NULL,
        owner_user_id           TEXT NOT NULL,
        PRIMARY KEY (line_messaging_group_id, owner_user_id)
      );
    `);
  },
});

export interface VoiceLineRow {
  /** The voice line's messaging group (channel type `voice`). */
  line_messaging_group_id: string;
  target_messaging_group_id: string | null;
  thread_id: string | null;
  updated_at: string;
}

export async function getVoiceLine(lineMessagingGroupId: string): Promise<VoiceLineRow | undefined> {
  return getDb().get<VoiceLineRow>('SELECT * FROM voice_lines WHERE line_messaging_group_id = ?', lineMessagingGroupId);
}

/** The line's owner accounts (namespaced chat user ids); only these can run /voice for it. */
export async function getVoiceLineOwners(lineMessagingGroupId: string): Promise<string[]> {
  const rows = await getDb().all<{ owner_user_id: string }>(
    'SELECT owner_user_id FROM voice_line_owners WHERE line_messaging_group_id = ? ORDER BY owner_user_id',
    lineMessagingGroupId,
  );
  return rows.map((r) => r.owner_user_id);
}

export async function isVoiceLineOwner(lineMessagingGroupId: string, userId: string): Promise<boolean> {
  const row = await getDb().get(
    'SELECT 1 AS owned FROM voice_line_owners WHERE line_messaging_group_id = ? AND owner_user_id = ?',
    lineMessagingGroupId,
    userId,
  );
  return row !== undefined;
}

/** Point the line at a chat, replacing any earlier target; false when `ownerUserId` is not one of its owners. */
export async function setVoiceLineTarget(target: {
  lineMessagingGroupId: string;
  ownerUserId: string;
  targetMessagingGroupId: string;
  threadId: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE voice_lines SET target_messaging_group_id = ?, thread_id = ?, updated_at = ?
       WHERE line_messaging_group_id = ? AND EXISTS (
         SELECT 1 FROM voice_line_owners o
          WHERE o.line_messaging_group_id = voice_lines.line_messaging_group_id AND o.owner_user_id = ?)`,
    target.targetMessagingGroupId,
    target.threadId,
    new Date().toISOString(),
    target.lineMessagingGroupId,
    target.ownerUserId,
  );
  return result.changes > 0;
}
