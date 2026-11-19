import path from 'node:path';

import { DUE_MESSAGE_COUNT_SQL } from '../mailbox/sqlite/session-db.js';
import { inboundDbPath, outboundDbPath } from '../mailbox/sqlite/paths.js';
import { sessionsBaseDir } from '../session-manager.js';
import { readStatusMailbox } from './status-reader.js';
export type { TranscriptStats } from './status-reader.js';

export async function readSessionStatus(
  agentGroupId: string,
  sessionId: string | null,
  scope: 'session' | 'group' = 'group',
  claude = true,
) {
  if (!sessionId && scope === 'session') return { queueDepth: 0, stats: null };
  return readStatusMailbox({
    root: path.join(sessionsBaseDir(), agentGroupId, '.claude-shared', 'projects'),
    inbound: sessionId ? inboundDbPath(agentGroupId, sessionId) : null,
    outbound: sessionId ? outboundDbPath(agentGroupId, sessionId) : null,
    queueSql: DUE_MESSAGE_COUNT_SQL,
    claude,
    scope,
  });
}

export async function readTranscriptStats(
  agentGroupId: string,
  sessionId: string | null,
  scope: 'session' | 'group' = 'group',
) {
  return (await readSessionStatus(agentGroupId, sessionId, scope)).stats;
}
