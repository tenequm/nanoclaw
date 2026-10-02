/**
 * Voice line owners and `/voice` targets: whose chat accounts own each voice
 * line, and the chat its LiveKit calls talk in. See migration 027 and
 * src/channels/voice-livekit.ts. Rows are written by the operator
 * (`ncl voice-lines set|add-owner`, src/cli/resources/voice-lines.ts).
 */
import { getDb } from './connection.js';

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
