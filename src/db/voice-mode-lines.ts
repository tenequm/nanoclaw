/**
 * Voice mode's own state: one voice line per agent group, in the skill's own table. The line holds
 * the SHA-256 of its current call-link token (never the token), who minted it (the caller), the
 * chat its calls talk in, and the speech choice its calls start with. `/voice` creates lines and
 * moves their chat, `/voice new` re-mints their link (src/channels/voice-mode-command.ts);
 * the call page finds a line by its token's hash (src/channels/voice-mode.ts).
 *
 * Who may run `/voice` is core's business (owner and admin roles); this table only records what a
 * run produced. No foreign keys into core tables: a line whose chat was deleted, unwired or denied
 * is ignored by its reader (src/channels/voice-mode-livekit.ts), never an integrity error.
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  isTtsProvider,
  LINE_DEFAULT_CHOICE,
  TTS_DEFAULT_CHOICE,
  TTS_REGISTRY,
  type TtsChoice,
  type TtsSaved,
} from '../voice-mode-tts.js';
import { getDb } from './connection.js';
import type { DbDriver } from './driver.js';
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

registerMigration({
  version: 2,
  name: 'module:voice-mode:lines-tts',
  async up(db) {
    await db.exec('ALTER TABLE voice_mode_lines ADD COLUMN tts_provider TEXT');
    await db.exec('ALTER TABLE voice_mode_lines ADD COLUMN tts_model TEXT');
    await db.exec('ALTER TABLE voice_mode_lines ADD COLUMN tts_voice TEXT');
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
  /** The line's saved speech choice: every write stores all three; a read takes a null as a default (see savedTts). */
  tts_provider: string | null;
  tts_model: string | null;
  tts_voice: string | null;
  created_at: string;
  updated_at: string;
}

/** The line's saved speech choice; an unknown provider reads as none. */
export function savedTts(row: VoiceModeLineRow): TtsSaved {
  return {
    provider: isTtsProvider(row.tts_provider) ? row.tts_provider : null,
    model: row.tts_model,
    voice: row.tts_voice,
  };
}

/**
 * Save the line's speech choice while its link and caller are still `current`'s; undefined when there
 * is no such line, or it was re-minted meanwhile.
 */
export async function setVoiceModeLineTts(
  lineId: string,
  choice: TtsChoice,
  current: Pick<VoiceModeLineRow, 'token_hash' | 'owner_user_id'>,
): Promise<VoiceModeLineRow | undefined> {
  return getDb().get<VoiceModeLineRow>(
    `UPDATE voice_mode_lines SET tts_provider = ?, tts_model = ?, tts_voice = ?, updated_at = ?
       WHERE line_id = ? AND token_hash = ? AND owner_user_id = ? RETURNING *`,
    choice.provider,
    choice.model,
    choice.voice,
    new Date().toISOString(),
    lineId,
    current.token_hash,
    current.owner_user_id,
  );
}

/**
 * Give every line a whole speech choice, each missing field what the line already spoke with (see
 * effectiveTts): a missing provider the backup's, a missing model or voice that provider's default. Rows
 * from before every write stored one, or written by an older host after a rollback. Returns the rows
 * changed; a row naming a provider the registry lacks is left as it is.
 */
export async function fillVoiceModeLineTts(db: DbDriver = getDb()): Promise<number> {
  const providers = Object.keys(TTS_REGISTRY);
  const fillable = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM voice_mode_lines WHERE tts_provider IS NULL
       OR (tts_provider IN (${providers.map(() => '?').join(', ')}) AND (tts_model IS NULL OR tts_voice IS NULL))`,
    ...providers,
  );
  if (!fillable?.n) return 0;
  await db.run('UPDATE voice_mode_lines SET tts_provider = ? WHERE tts_provider IS NULL', TTS_DEFAULT_CHOICE.provider);
  for (const entry of Object.values(TTS_REGISTRY)) {
    await db.run(
      `UPDATE voice_mode_lines SET tts_model = COALESCE(tts_model, ?), tts_voice = COALESCE(tts_voice, ?)
         WHERE tts_provider = ? AND (tts_model IS NULL OR tts_voice IS NULL)`,
      entry.defaults.model,
      entry.defaults.voice,
      entry.id,
    );
  }
  return Number(fillable.n);
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
       (line_id, agent_group_id, token_hash, owner_user_id, messaging_group_id, thread_id,
        tts_provider, tts_model, tts_voice, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_group_id) ${onConflict}
     RETURNING *`,
    randomBytes(6).toString('hex'),
    target.agentGroupId,
    hashLinkToken(token),
    target.ownerUserId,
    target.messagingGroupId,
    target.threadId,
    LINE_DEFAULT_CHOICE.provider,
    LINE_DEFAULT_CHOICE.model,
    LINE_DEFAULT_CHOICE.voice,
    now,
    now,
  );
  return line && { line, token };
}

/**
 * Mint a new call link for the agent's line (creating the line on first use), make `ownerUserId` its
 * caller and the given chat its call chat. The previous link stops working; the saved speech choice
 * stays. Returns the line and the new token, which is stored nowhere: the caller hands it out once.
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

registerMigration({
  version: 4,
  name: 'module:voice-mode:lines-tts-concrete',
  async up(db) {
    // The host runs the same fill at every start too: an older host after a rollback writes nulls again.
    await fillVoiceModeLineTts(db);
  },
});
