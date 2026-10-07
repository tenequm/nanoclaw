/**
 * Who a voice line connects: its named caller, the one agent it is wired to,
 * and the names that agent's calls should transcribe exactly. Every call start
 * and every periodic access check resolves the line here, so a revoked caller
 * or a rewired line ends the call.
 */
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { getVoiceModeLine } from '../db/voice-mode-lines.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { log } from '../log.js';
import { getUser } from '../modules/permissions/db/users.js';

/** Optional per-agent names for the transcription, one per line; added to VOICE_MODE_VOCABULARY. */
export const VOICE_MODE_VOCABULARY_FILE = 'voice.vocabulary.txt';
export const MAX_VOCABULARY_TERMS = 60;
export const MAX_VOCABULARY_BYTES = 1024;
const MAX_VOCABULARY_TERM_CHARS = 80;
/** Far more than MAX_VOCABULARY_BYTES of terms ever needs; nothing past it is read. */
const MAX_VOCABULARY_READ_BYTES = 64 * 1024;

/**
 * The agent's vocabulary file, or null. The group folder is writable from the agent container, so
 * the read follows no symlink, never blocks on a planted FIFO (O_NONBLOCK) and is bounded.
 */
function readVocabularyFile(groupDir: string): string | null {
  const file = path.join(groupDir, VOICE_MODE_VOCABULARY_FILE);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buf = Buffer.alloc(Math.min(stat.size, MAX_VOCABULARY_READ_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf-8', 0, n).trim() || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn('voice-mode: could not read the agent vocabulary file; calls use VOICE_MODE_VOCABULARY only', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface VoiceModeAgent {
  name: string;
  /** Names the transcription should recognise and spell exactly; see voiceModeVocabulary. */
  vocabulary?: readonly string[];
  /** The agent's own vocabulary file entries: other names the wake phrase `hey <agent>` takes. */
  wakeNames?: readonly string[];
}

export interface VoiceModeCaller {
  id: string;
  name: string;
}
export interface VoiceModeLine {
  agent: VoiceModeAgent;
  caller: VoiceModeCaller;
  agentGroupId: string;
  /** The line's link token hash: a new link (`/voice new`) ends the calls on the old one. */
  linkHash: string;
}

/** Whether two resolutions of a line still name the same caller, agent and link; a call ends when they stop. */
export function sameCallerAndAgent(a: VoiceModeLine, b: VoiceModeLine): boolean {
  return (
    a.caller.id === b.caller.id &&
    a.caller.name === b.caller.name &&
    a.agentGroupId === b.agentGroupId &&
    a.linkHash === b.linkHash
  );
}

/**
 * The names a voice call should know: VOICE_MODE_VOCABULARY (comma-separated) plus the agent's
 * vocabulary file (one per line); none when both are empty. Trimmed, deduplicated
 * case-insensitively and capped, since every term travels to the transcription.
 */
export function voiceModeVocabulary(envList: string | undefined, fileText: string | null): string[] {
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

/** The resolved line, with the agent's vocabulary file read only for a call's setup. */
function buildLine(
  caller: VoiceModeCaller,
  group: { id: string; name: string; folder: string },
  options: ResolveLineOptions,
  linkHash: string,
): VoiceModeLine {
  const fileText = options.forCall ? readVocabularyFile(path.join(GROUPS_DIR, group.folder)) : null;
  const vocabulary = options.forCall ? voiceModeVocabulary(options.vocabulary, fileText) : undefined;
  const wakeNames = fileText ? voiceModeVocabulary(undefined, fileText) : undefined;
  return {
    caller,
    agentGroupId: group.id,
    agent: {
      name: group.name,
      ...(vocabulary?.length ? { vocabulary } : {}),
      ...(wakeNames?.length ? { wakeNames } : {}),
    },
    linkHash,
  };
}

/** Resolve a line's caller and agent, and the caller's owner or admin role over it, before reading the agent's files. */
export async function resolveVoiceModeLine(
  platformId: string,
  options: ResolveLineOptions = {},
): Promise<VoiceModeLine | null> {
  try {
    const lineId = lineIdOf(platformId);
    const line = lineId ? await getVoiceModeLine(lineId) : undefined;
    if (!line || !(await hasAdminPrivilege(line.owner_user_id, line.agent_group_id))) return null;
    const [caller, group] = await Promise.all([getUser(line.owner_user_id), getAgentGroup(line.agent_group_id)]);
    if (!caller || !group) return null;
    const name = caller.display_name?.trim() || caller.id;
    return buildLine({ id: caller.id, name }, group, options, line.token_hash);
  } catch (err) {
    log.warn('voice-mode: could not authorize the voice line', { platformId, err });
    return null;
  }
}

/** The channel of every line /voice makes, and the prefix of their platform ids. */
export const VOICE_MODE_CHANNEL = 'voice-mode';

/** The platform id of the voice_mode_lines row `lineId`: `voice-mode:<line id>`. */
export const linePlatformId = (lineId: string): string => `${VOICE_MODE_CHANNEL}:${lineId}`;

/** The voice_mode_lines id a platform id names, or null for any other id. */
export const lineIdOf = (platformId: string): string | null =>
  platformId.startsWith(`${VOICE_MODE_CHANNEL}:`) ? platformId.slice(VOICE_MODE_CHANNEL.length + 1) : null;
