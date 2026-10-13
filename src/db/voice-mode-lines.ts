/**
 * Voice mode's own state: one voice line per agent group, in the skill's own table. The line holds
 * the SHA-256 of its current call-link token, the token itself sealed under the host's key (see
 * src/secret-seal.ts) so `/voice` can show the link again, its caller (who minted the link), the
 * chat its calls talk in, and the speech choice its calls start with. `/voice` creates lines, shows
 * their link and moves their chat, `/voice new` re-mints their link
 * (src/channels/voice-mode-command.ts); the call page finds a line by its token's hash
 * (src/channels/voice-mode.ts), so calls never need the key.
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
import { openSealed, sealText } from '../secret-seal.js';
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
  /** The current token sealed for `voice-link:<line_id>`; null until a link made before sealing is next opened. */
  link_sealed: string | null;
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

/** The line a call-link token opens, or undefined. Only hashes are compared. */
export async function findVoiceModeLineByToken(token: string): Promise<VoiceModeLineRow | undefined> {
  if (!/^[0-9a-f]{32}$/.test(token)) return undefined;
  return getDb().get<VoiceModeLineRow>('SELECT * FROM voice_mode_lines WHERE token_hash = ?', hashLinkToken(token));
}

const linkContext = (lineId: string): string => `voice-link:${lineId}`;

/**
 * Seal the token that just opened `line` if the line has none sealed yet (a link minted before
 * sealing, or after a rollback cleared it): from then on `/voice` can show it. Guarded by the hash,
 * so a link re-minted meanwhile is never overwritten with this older one.
 */
export async function sealVoiceModeLink(line: VoiceModeLineRow, token: string, key: Buffer): Promise<void> {
  if (line.link_sealed !== null) return;
  await getDb().run(
    'UPDATE voice_mode_lines SET link_sealed = ? WHERE line_id = ? AND token_hash = ? AND link_sealed IS NULL',
    sealText(token, linkContext(line.line_id), key),
    line.line_id,
    hashLinkToken(token),
  );
}

/**
 * The line's current token, opened from its sealed link: `unsealed` when none is stored or the stored
 * one is not the current link (an older host re-minted it), `unreadable` when it does not open with
 * this key. Either stored copy is cleared, so the next call made with the link seals it again.
 */
export async function openVoiceModeLink(
  line: VoiceModeLineRow,
  key: Buffer,
): Promise<{ token: string } | { missing: 'unsealed' | 'unreadable' }> {
  if (line.link_sealed === null) return { missing: 'unsealed' };
  const token = openSealed(line.link_sealed, linkContext(line.line_id), key);
  if (token !== null && hashLinkToken(token) === line.token_hash) return { token };
  await getDb().run(
    'UPDATE voice_mode_lines SET link_sealed = NULL WHERE line_id = ? AND link_sealed = ?',
    line.line_id,
    line.link_sealed,
  );
  return { missing: token === null ? 'unreadable' : 'unsealed' };
}

/** Who a minted link is for and where its calls talk. */
export interface VoiceModeLineTarget {
  agentGroupId: string;
  ownerUserId: string;
  messagingGroupId: string;
  threadId: string | null;
}

/**
 * Insert the agent's line with a fresh token, sealed when a key is given, or apply `onConflict` (an
 * `ON CONFLICT` action) to the one it has. Undefined when the conflict action returned no row.
 */
async function insertLine(
  target: VoiceModeLineTarget,
  key: Buffer | null,
  onConflict: string,
): Promise<{ line: VoiceModeLineRow; token: string } | undefined> {
  const token = randomBytes(16).toString('hex');
  // The seal is bound to the line id, so a re-mint seals for the id the line already has.
  const lineId = (await getVoiceModeLineForAgent(target.agentGroupId))?.line_id ?? randomBytes(6).toString('hex');
  const now = new Date().toISOString();
  const line = await getDb().get<VoiceModeLineRow>(
    `INSERT INTO voice_mode_lines
       (line_id, agent_group_id, token_hash, link_sealed, owner_user_id, messaging_group_id, thread_id,
        tts_provider, tts_model, tts_voice, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_group_id) ${onConflict}
     RETURNING *`,
    lineId,
    target.agentGroupId,
    hashLinkToken(token),
    key ? sealText(token, linkContext(lineId), key) : null,
    target.ownerUserId,
    target.messagingGroupId,
    target.threadId,
    LINE_DEFAULT_CHOICE.provider,
    LINE_DEFAULT_CHOICE.model,
    LINE_DEFAULT_CHOICE.voice,
    now,
    now,
  );
  return line ? { line, token } : undefined;
}

/**
 * Mint a new call link for the agent's line (creating the line on first use, with `ownerUserId` as its
 * caller) and make the given chat its call chat. Only the line's own caller re-mints: another user's
 * line is never taken over, and that throws. The previous link stops working; the saved speech choice
 * stays. The token is sealed when a key is given (`/voice` always gives one).
 */
export async function mintVoiceModeLine(
  target: VoiceModeLineTarget,
  key: Buffer | null = null,
): Promise<{ line: VoiceModeLineRow; token: string }> {
  const minted = await insertLine(
    target,
    key,
    `DO UPDATE SET
       token_hash = excluded.token_hash, link_sealed = excluded.link_sealed, owner_user_id = excluded.owner_user_id,
       messaging_group_id = excluded.messaging_group_id, thread_id = excluded.thread_id,
       updated_at = excluded.updated_at
     WHERE voice_mode_lines.owner_user_id = excluded.owner_user_id`,
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
  key: Buffer | null = null,
): Promise<{ line: VoiceModeLineRow; token: string } | undefined> {
  return insertLine(target, key, 'DO NOTHING');
}

registerMigration({
  version: 4,
  name: 'module:voice-mode:lines-tts-concrete',
  async up(db) {
    // Each missing field becomes what the line already spoke with (see effectiveTts); a provider the registry lacks stays.
    await db.run(
      'UPDATE voice_mode_lines SET tts_provider = ? WHERE tts_provider IS NULL',
      TTS_DEFAULT_CHOICE.provider,
    );
    for (const entry of Object.values(TTS_REGISTRY)) {
      await db.run(
        `UPDATE voice_mode_lines SET tts_model = COALESCE(tts_model, ?), tts_voice = COALESCE(tts_voice, ?)
           WHERE tts_provider = ? AND (tts_model IS NULL OR tts_voice IS NULL)`,
        entry.defaults.model,
        entry.defaults.voice,
        entry.id,
      );
    }
  },
});

registerMigration({
  version: 5,
  name: 'module:voice-mode:lines-link-sealed',
  async up(db) {
    await db.exec('ALTER TABLE voice_mode_lines ADD COLUMN link_sealed TEXT');
  },
});
