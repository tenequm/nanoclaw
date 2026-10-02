/**
 * Persistence for `/voice`: the chat each voice line's LiveKit calls talk in.
 * See migration 027 and src/channels/voice-livekit.ts.
 */
import { getDb } from './connection.js';

export interface VoiceCallTarget {
  /** The voice line's messaging group (channel type `voice`). */
  line_messaging_group_id: string;
  target_messaging_group_id: string;
  thread_id: string | null;
  /** Namespaced user id the call's turns are sent as in the target chat. */
  sender_user_id: string;
  updated_at: string;
}

export async function getVoiceCallTarget(lineMessagingGroupId: string): Promise<VoiceCallTarget | undefined> {
  return getDb().get<VoiceCallTarget>(
    'SELECT * FROM voice_call_targets WHERE line_messaging_group_id = ?',
    lineMessagingGroupId,
  );
}

/** Point a line at a chat, replacing any earlier target. */
export async function setVoiceCallTarget(target: Omit<VoiceCallTarget, 'updated_at'>): Promise<void> {
  await getDb().run(
    `INSERT INTO voice_call_targets
       (line_messaging_group_id, target_messaging_group_id, thread_id, sender_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (line_messaging_group_id) DO UPDATE SET
         target_messaging_group_id = excluded.target_messaging_group_id,
         thread_id = excluded.thread_id,
         sender_user_id = excluded.sender_user_id,
         updated_at = excluded.updated_at`,
    target.line_messaging_group_id,
    target.target_messaging_group_id,
    target.thread_id,
    target.sender_user_id,
    new Date().toISOString(),
  );
}
