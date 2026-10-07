/**
 * Who a voice line connects: its named caller, the one agent it is wired to,
 * and the names that agent's calls should transcribe exactly. Every call start
 * and every periodic access check resolves the line here, so a revoked caller
 * or a rewired line ends the call.
 */
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { getVoiceModeLine, getVoiceModeLineForAgent } from '../db/voice-mode-lines.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { readGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { getUser } from '../modules/permissions/db/users.js';

/** Optional per-agent names for the transcription, one per line; added to VOICE_MODE_VOCABULARY. */
export const VOICE_MODE_VOCABULARY_FILE = 'voice.vocabulary.txt';
export const MAX_VOCABULARY_TERMS = 60;
export const MAX_VOCABULARY_BYTES = 1024;
const MAX_VOCABULARY_TERM_CHARS = 80;

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
  linkHash?: string;
}

/** Whether two resolutions of a line still name the same caller and agent; a call ends when they stop. */
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

/** Resolve a named personal line and its explicit access before reading the agent's files. */
export async function resolveVoiceModeLine(
  platformId: string,
  instance?: string | ResolveLineOptions,
  options: ResolveLineOptions = {},
): Promise<VoiceModeLine | null> {
  if (typeof instance === 'object') {
    options = instance;
    instance = undefined;
  }
  try {
    const line = platformId.startsWith('voice-mode:') ? await getVoiceModeLine(platformId.slice(11)) : undefined;
    if (line) {
      if (!(await hasAdminPrivilege(line.owner_user_id, line.agent_group_id))) return null;
      const [caller, group] = await Promise.all([getUser(line.owner_user_id), getAgentGroup(line.agent_group_id)]);
      if (!caller || !group) return null;
      const fileText = options.forCall
        ? readGroupPersona(path.join(GROUPS_DIR, group.folder), VOICE_MODE_VOCABULARY_FILE)
        : null;
      const vocabulary = options.forCall ? voiceModeVocabulary(options.vocabulary, fileText) : undefined;
      const wakeNames = fileText ? voiceModeVocabulary(undefined, fileText) : undefined;
      return {
        caller: { id: caller.id, name: caller.display_name?.trim() || caller.id },
        agentGroupId: group.id,
        agent: {
          name: group.name,
          ...(vocabulary?.length ? { vocabulary } : {}),
          ...(wakeNames?.length ? { wakeNames } : {}),
        },
        linkHash: line.token_hash,
      };
    }
    // Every other line is a hashed-token row (above); only a line from before the rename resolves here.
    if (lineChannelType(platformId) !== LEGACY_VOICE_CHANNEL) return null;
    const caller = await getUser(platformId);
    if (!caller || caller.kind !== LEGACY_VOICE_CHANNEL || !caller.display_name?.trim()) return null;
    const mg = await getMessagingGroupByPlatform(LEGACY_VOICE_CHANNEL, platformId, instance);
    if (!mg || mg.is_group || mg.unknown_sender_policy !== 'strict') return null;
    const wirings = await getMessagingGroupAgents(mg.id);
    if (wirings.length !== 1 || wirings[0].sender_scope !== 'known') return null;
    const groupId = wirings[0].agent_group_id;
    // A line /voice new made for the agent retires its legacy lines.
    if (await getVoiceModeLineForAgent(groupId)) return null;
    if (!(await canAccessAgentGroup(caller.id, groupId)).allowed) return null;
    const group = await getAgentGroup(groupId);
    if (!group) return null;
    // The persona reader's bounded, symlink- and FIFO-safe read: the file is agent-writable.
    const fileText = options.forCall
      ? readGroupPersona(path.join(GROUPS_DIR, group.folder), VOICE_MODE_VOCABULARY_FILE)
      : null;
    const vocabulary = options.forCall ? voiceModeVocabulary(options.vocabulary, fileText) : undefined;
    const wakeNames = fileText ? voiceModeVocabulary(undefined, fileText) : undefined;
    return {
      caller: { id: caller.id, name: caller.display_name.trim() },
      agentGroupId: group.id,
      agent: {
        name: group.name,
        ...(vocabulary?.length ? { vocabulary } : {}),
        ...(wakeNames?.length ? { wakeNames } : {}),
      },
    };
  } catch (err) {
    log.warn('voice-mode: could not authorize the voice line', { platformId, err });
    return null;
  }
}

export const linePlatformId = (lineId: string): string => `voice-mode:${lineId}`;

/** Lines made before the voice-mode rename keep their `voice` rows and `voice:<hash>` ids, so saved links still reach them. */
export const LEGACY_VOICE_CHANNEL = 'voice';

/** The channel a line's own chat is on, by the line's platform id. */
export const lineChannelType = (platformId: string): string =>
  platformId.startsWith(`${LEGACY_VOICE_CHANNEL}:`) ? LEGACY_VOICE_CHANNEL : 'voice-mode';
