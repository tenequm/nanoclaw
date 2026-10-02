/**
 * Who a voice line connects: its caller (whoever minted its current link), its agent, and the
 * names that agent's calls should transcribe exactly. Every call start, turn and periodic access
 * check resolves the line here, so a revoked role or a link re-minted by someone else ends the call.
 */
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getVoiceModeLine } from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getUser } from '../modules/permissions/db/users.js';

/** Optional per-agent names for the transcription, one per line; added to VOICE_MODE_VOCABULARY. */
export const VOICE_VOCABULARY_FILE = 'voice.vocabulary.txt';
export const MAX_VOCABULARY_TERMS = 60;
export const MAX_VOCABULARY_BYTES = 1024;
const MAX_VOCABULARY_TERM_CHARS = 80;

export interface VoiceAgent {
  name: string;
  /** Names the transcription should recognise and spell exactly; see voiceVocabulary. */
  vocabulary?: readonly string[];
}

export interface VoiceCaller {
  id: string;
  name: string;
}
export interface VoiceLine {
  agent: VoiceAgent;
  caller: VoiceCaller;
  agentGroupId: string;
  /** The hash of the line's current link token: a re-minted link changes it. */
  linkHash?: string;
}

/**
 * Whether two resolutions of a line still name the same caller, agent and link; a call ends when
 * they stop, so `/voice` (which re-mints the link) also cuts off a call made with the old one.
 */
export function sameCallerAndAgent(a: VoiceLine, b: VoiceLine): boolean {
  return (
    a.caller.id === b.caller.id &&
    a.caller.name === b.caller.name &&
    a.agentGroupId === b.agentGroupId &&
    a.linkHash === b.linkHash
  );
}

/** Read at most this much of the vocabulary file; only MAX_VOCABULARY_BYTES of terms are kept. */
const MAX_VOCABULARY_FILE_BYTES = 16 * 1024;

/**
 * The agent's vocabulary file, or null. The group folder is writable from the agent's container, so
 * the read follows no symlink, refuses anything but a regular file (O_NONBLOCK: a FIFO planted there
 * must not block the host) and is bounded.
 */
function readVocabularyFile(groupDir: string): string | null {
  const file = path.join(groupDir, VOICE_VOCABULARY_FILE);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buf = Buffer.alloc(Math.min(stat.size, MAX_VOCABULARY_FILE_BYTES));
    return buf.toString('utf-8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn('voice-mode: could not read the vocabulary file', { file, err });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The names a voice call should know: VOICE_MODE_VOCABULARY (comma-separated) plus the agent's
 * vocabulary file (one per line); none when both are empty. Trimmed, deduplicated
 * case-insensitively and capped, since every term travels to the transcription.
 */
export function voiceVocabulary(envList: string | undefined, fileText: string | null): string[] {
  const terms = [...(envList ?? '').split(','), ...(fileText ?? '').split(/\r?\n/)];
  const out: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, ' ').trim();
    if (!term || term.length > MAX_VOCABULARY_TERM_CHARS || seen.has(term.toLowerCase())) continue;
    const size = Buffer.byteLength(term) + (out.length > 0 ? 2 : 0);
    if (out.length >= MAX_VOCABULARY_TERMS || bytes + size > MAX_VOCABULARY_BYTES) break;
    seen.add(term.toLowerCase());
    out.push(term);
    bytes += size;
  }
  return out;
}

export interface ResolveLineOptions {
  /** Read the agent's vocabulary file too. Only call setup needs it; the periodic access checks do not. */
  forCall?: boolean;
  /** VOICE_MODE_VOCABULARY as the adapter read it at startup; merged with the agent's vocabulary file. */
  vocabulary?: string;
}

/** A line's platform id (`voice-mode:<line id>`): what calls, rooms and limits are keyed by. */
export const linePlatformId = (lineId: string): string => `voice-mode:${lineId}`;

/**
 * Resolve a line and its access before reading the agent's files. The caller is the user who minted
 * the line's current link, and stays one only while core grants them an owner or admin role over
 * the line's agent (the same check `/voice` makes).
 */
export async function resolveVoiceLine(
  platformId: string,
  options: ResolveLineOptions = {},
): Promise<VoiceLine | null> {
  try {
    const line = platformId.startsWith('voice-mode:') ? await getVoiceModeLine(platformId.slice(11)) : undefined;
    if (!line || !(await hasAdminPrivilege(line.owner_user_id, line.agent_group_id))) return null;
    const [caller, group] = await Promise.all([getUser(line.owner_user_id), getAgentGroup(line.agent_group_id)]);
    if (!caller || !group) return null;
    const vocabulary = options.forCall
      ? voiceVocabulary(options.vocabulary, readVocabularyFile(path.join(GROUPS_DIR, group.folder)))
      : undefined;
    return {
      caller: { id: caller.id, name: caller.display_name?.trim() || caller.id },
      agentGroupId: group.id,
      agent: { name: group.name, ...(vocabulary?.length ? { vocabulary } : {}) },
      linkHash: line.token_hash,
    };
  } catch (err) {
    log.warn('voice-mode: could not authorize the voice line', { platformId, err });
    return null;
  }
}
