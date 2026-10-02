/**
 * Who a voice line connects: its named caller, the one agent it is wired to,
 * and the names that agent's calls should transcribe exactly. Every call start
 * and every periodic access check resolves the line here, so a revoked caller
 * or a rewired line ends the call.
 */
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { getUser } from '../modules/permissions/db/users.js';

/** Optional per-agent names for the transcription, one per line; added to VOICE_VOCABULARY. */
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
}

/** Whether two resolutions of a line still name the same caller and agent; a call ends when they stop. */
export function sameCallerAndAgent(a: VoiceLine, b: VoiceLine): boolean {
  return a.caller.id === b.caller.id && a.caller.name === b.caller.name && a.agentGroupId === b.agentGroupId;
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
 * The names a voice call should know: VOICE_VOCABULARY (comma-separated) plus the agent's
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
  /** VOICE_VOCABULARY as the adapter read it at startup; merged with the agent's vocabulary file. */
  vocabulary?: string;
}

/** Resolve a named personal line and its explicit access before reading the agent's files. */
export async function resolveVoiceLine(
  platformId: string,
  options: ResolveLineOptions = {},
): Promise<VoiceLine | null> {
  try {
    const caller = await getUser(platformId);
    if (!caller || caller.kind !== 'voice-mode' || !caller.display_name?.trim()) return null;
    const mg = await getMessagingGroupByPlatform('voice-mode', platformId);
    if (!mg || mg.is_group || mg.unknown_sender_policy !== 'strict') return null;
    const wirings = await getMessagingGroupAgents(mg.id);
    if (wirings.length !== 1 || wirings[0].sender_scope !== 'known') return null;
    const groupId = wirings[0].agent_group_id;
    if (!(await canAccessAgentGroup(caller.id, groupId)).allowed) return null;
    const group = await getAgentGroup(groupId);
    if (!group) return null;
    const vocabulary = options.forCall
      ? voiceVocabulary(options.vocabulary, readVocabularyFile(path.join(GROUPS_DIR, group.folder)))
      : undefined;
    return {
      caller: { id: caller.id, name: caller.display_name.trim() },
      agentGroupId: group.id,
      agent: { name: group.name, ...(vocabulary?.length ? { vocabulary } : {}) },
    };
  } catch (err) {
    log.warn('voice-mode: could not authorize the voice line', { platformId, err });
    return null;
  }
}
