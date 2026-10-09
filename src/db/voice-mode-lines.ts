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
import { createHash, randomBytes } from 'node:crypto';

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

export interface VoiceModeLineRow {
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

/** Hex SHA-256 of a call-link token: what the table stores and looks a link up by. */
export const hashLinkToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The line with this line id (a `voice-mode:` platform id without its prefix). */
export async function getVoiceModeLine(lineId: string): Promise<VoiceModeLineRow | undefined> {
  return getDb().get<VoiceModeLineRow>('SELECT * FROM voice_mode_lines WHERE line_id = ?', lineId);
}

/** The agent's line; an agent has at most one. */
export async function getVoiceModeLineForAgent(agentGroupId: string): Promise<VoiceModeLineRow | undefined> {
  return getDb().get<VoiceModeLineRow>('SELECT * FROM voice_mode_lines WHERE agent_group_id = ?', agentGroupId);
}

/**
 * Make another chat the line's call chat; its link and caller stay. Only the line's own caller
 * moves it: undefined when the agent has no line, or `callerUserId` is not its caller.
 */
export async function bindVoiceModeLineChat(target: {
  agentGroupId: string;
  callerUserId: string;
  messagingGroupId: string;
  threadId: string | null;
}): Promise<VoiceModeLineRow | undefined> {
  return getDb().get<VoiceModeLineRow>(
    `UPDATE voice_mode_lines SET messaging_group_id = ?, thread_id = ?, updated_at = ?
       WHERE agent_group_id = ? AND owner_user_id = ? RETURNING *`,
    target.messagingGroupId,
    target.threadId,
    new Date().toISOString(),
    target.agentGroupId,
    target.callerUserId,
  );
}

/** The line a call-link token opens, or undefined. Only hashes are compared: the token is stored nowhere. */
export async function findVoiceModeLineByToken(token: string): Promise<VoiceModeLineRow | undefined> {
  if (!/^[0-9a-f]{32}$/.test(token)) return undefined;
  return getDb().get<VoiceModeLineRow>('SELECT * FROM voice_mode_lines WHERE token_hash = ?', hashLinkToken(token));
}

/** Who a minted link is for and where its calls talk. */
export interface VoiceModeLineTarget {
  agentGroupId: string;
  ownerUserId: string;
  messagingGroupId: string;
  threadId: string | null;
}

/**
 * Insert the agent's line with a fresh token, or apply `onConflict` (an `ON CONFLICT` action) to the
 * one it has. Undefined when the conflict action returned no row (`DO NOTHING`).
 */
async function insertLine(
  target: VoiceModeLineTarget,
  onConflict: string,
): Promise<{ line: VoiceModeLineRow; token: string } | undefined> {
  const token = randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  const line = await getDb().get<VoiceModeLineRow>(
    `INSERT INTO voice_mode_lines
       (line_id, agent_group_id, token_hash, owner_user_id, messaging_group_id, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_group_id) ${onConflict}
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
  return line && { line, token };
}

/**
 * Mint a new call link for the agent's line (creating the line on first use), make `ownerUserId` its
 * caller and the given chat its call chat. The previous link stops working. Returns the line and
 * the new token, which is stored nowhere: the caller hands it out once.
 */
export async function mintVoiceModeLine(
  target: VoiceModeLineTarget,
): Promise<{ line: VoiceModeLineRow; token: string }> {
  const minted = await insertLine(
    target,
    `DO UPDATE SET
       token_hash = excluded.token_hash, owner_user_id = excluded.owner_user_id,
       messaging_group_id = excluded.messaging_group_id, thread_id = excluded.thread_id,
       updated_at = excluded.updated_at`,
  );
  if (!minted) throw new Error('voice-mode: the line was not stored');
  return minted;
}

/**
 * Create the agent's line with a first call link, as mintVoiceModeLine does, but never replace one:
 * undefined when the agent already has a line, so a link another run just handed out keeps working.
 */
export async function createVoiceModeLine(
  target: VoiceModeLineTarget,
): Promise<{ line: VoiceModeLineRow; token: string } | undefined> {
  return insertLine(target, 'DO NOTHING');
}

registerMigration({
  version: 3,
  name: 'module:voice-mode:drop-legacy-lines',
  async up(db) {
    // Every line is a voice_mode_lines row; core's 027 still creates the old tables on a fresh DB, and this runs after it.
    await db.exec(`
      DROP TABLE IF EXISTS voice_line_owners;
      DROP TABLE IF EXISTS voice_lines;
    `);
  },
});
