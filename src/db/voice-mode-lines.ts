/**
 * Voice mode's own state: one voice line per agent group, in the skill's own table. The line holds
 * the SHA-256 of its current call-link token (never the token), who minted it (the caller), and
 * the chat its calls talk in. `/voice` creates lines and moves their chat, `/voice new` re-mints their
 * link (src/channels/voice-mode-command.ts);
 * the call page finds a line by its token's hash (src/channels/voice-mode.ts).
 *
 * Who may run `/voice` is core's business (owner and admin roles); this table only records what a
 * run produced. No foreign keys into core tables: a line whose chat was deleted, unwired or denied
 * is ignored by its reader (src/channels/voice-mode-livekit.ts), never an integrity error.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { getDb } from './connection.js';
import { registerMigration } from './migrations/index.js';

registerMigration({
  version: 1,
  name: 'module:voice-mode:lines',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS voice_mode_lines (
        line_id            TEXT PRIMARY KEY,
        agent_group_id     TEXT NOT NULL UNIQUE,
        token_hash         TEXT NOT NULL UNIQUE,
        owner_user_id      TEXT NOT NULL,
        messaging_group_id TEXT,
        thread_id          TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
    `);
  },
});

export interface VoiceModeLine {
  /** Random and stable for the line's life; calls, rooms and limits are keyed by it, not by the token. */
  line_id: string;
  agent_group_id: string;
  /** Hex SHA-256 of the current call-link token. */
  token_hash: string;
  /** The user who minted the current link; calls speak as them and need their admin role. */
  owner_user_id: string;
  /** The chat calls talk in, and its thread. */
  messaging_group_id: string | null;
  thread_id: string | null;
  created_at: string;
  updated_at: string;
}

export const hashLinkToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export async function getVoiceModeLine(lineId: string): Promise<VoiceModeLine | undefined> {
  return getDb().get<VoiceModeLine>('SELECT * FROM voice_mode_lines WHERE line_id = ?', lineId);
}

export async function getVoiceModeLineForAgent(agentGroupId: string): Promise<VoiceModeLine | undefined> {
  return getDb().get<VoiceModeLine>('SELECT * FROM voice_mode_lines WHERE agent_group_id = ?', agentGroupId);
}

/** Make another chat the line's call chat; its link and caller stay. Undefined when the agent has no line. */
export async function bindVoiceModeLineChat(target: {
  agentGroupId: string;
  messagingGroupId: string;
  threadId: string | null;
}): Promise<VoiceModeLine | undefined> {
  return getDb().get<VoiceModeLine>(
    `UPDATE voice_mode_lines SET messaging_group_id = ?, thread_id = ?, updated_at = ?
       WHERE agent_group_id = ? RETURNING *`,
    target.messagingGroupId,
    target.threadId,
    new Date().toISOString(),
    target.agentGroupId,
  );
}

/** The line a call-link token opens, or undefined. Only hashes are compared: the token is stored nowhere. */
export async function findVoiceModeLineByToken(token: string): Promise<VoiceModeLine | undefined> {
  if (!/^[0-9a-f]{32}$/.test(token)) return undefined;
  const hash = hashLinkToken(token);
  const row = await getDb().get<VoiceModeLine>('SELECT * FROM voice_mode_lines WHERE token_hash = ?', hash);
  // The row was found by an equal hash; the constant-time check keeps the comparison explicit.
  return row && timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex')) ? row : undefined;
}

/**
 * Mint a new call link for the agent's line (creating the line on first use), make `ownerUserId` its
 * caller and the given chat its call chat. The previous link stops working. Returns the line and
 * the new token, which is stored nowhere: the caller hands it out once.
 */
export async function mintVoiceModeLine(target: {
  agentGroupId: string;
  ownerUserId: string;
  messagingGroupId: string;
  threadId: string | null;
}): Promise<{ line: VoiceModeLine; token: string }> {
  const token = randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  const line = await getDb().get<VoiceModeLine>(
    `INSERT INTO voice_mode_lines
       (line_id, agent_group_id, token_hash, owner_user_id, messaging_group_id, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_group_id) DO UPDATE SET
       token_hash = excluded.token_hash, owner_user_id = excluded.owner_user_id,
       messaging_group_id = excluded.messaging_group_id, thread_id = excluded.thread_id,
       updated_at = excluded.updated_at
     RETURNING *`,
    randomBytes(6).toString('hex'),
    target.agentGroupId,
    hashLinkToken(token),
    target.ownerUserId,
    target.messagingGroupId,
    target.threadId,
    now,
    now,
  );
  if (!line) throw new Error('voice-mode: the line was not stored');
  return { line, token };
}
