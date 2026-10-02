/**
 * Voice line owners and `/voice` targets: who owns each voice line, and the
 * chat its LiveKit calls talk in. See migration 027 and
 * src/channels/voice-livekit.ts. Rows are created by the operator
 * (`ncl voice-lines create`, src/cli/resources/voice-lines.ts).
 */
import { getDb } from './connection.js';

export interface VoiceLineRow {
  /** The voice line's messaging group (channel type `voice`). */
  line_messaging_group_id: string;
  /** The line's owner as a namespaced chat user id; the only one who can run /voice for it. */
  owner_user_id: string;
  target_messaging_group_id: string | null;
  thread_id: string | null;
  updated_at: string;
}

export async function getVoiceLine(lineMessagingGroupId: string): Promise<VoiceLineRow | undefined> {
  return getDb().get<VoiceLineRow>('SELECT * FROM voice_lines WHERE line_messaging_group_id = ?', lineMessagingGroupId);
}

/** Point the owner's line at a chat, replacing any earlier target; false when the line is not theirs. */
export async function setVoiceLineTarget(target: {
  lineMessagingGroupId: string;
  ownerUserId: string;
  targetMessagingGroupId: string;
  threadId: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE voice_lines SET target_messaging_group_id = ?, thread_id = ?, updated_at = ?
       WHERE line_messaging_group_id = ? AND owner_user_id = ?`,
    target.targetMessagingGroupId,
    target.threadId,
    new Date().toISOString(),
    target.lineMessagingGroupId,
    target.ownerUserId,
  );
  return result.changes > 0;
}
