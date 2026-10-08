import fs from 'fs';

import { getAgentMailbox, type AgentMailbox } from './mailbox/index.js';

const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

/**
 * The heartbeat location is deployment-configurable via
 * NANOCLAW_HEARTBEAT_PATH for setups that relocate the workspace heartbeat.
 * Unset = today's path, byte-identical. Read per call so the container env,
 * not import order, decides.
 */
export function heartbeatPath(): string {
  return process.env.NANOCLAW_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH;
}

function registeredMailbox(): AgentMailbox | undefined {
  try {
    return getAgentMailbox();
  } catch {
    return undefined; // no composition loaded (unit tests importing this module alone)
  }
}

export function touchHeartbeat(): void {
  if (registeredMailbox()?.heartbeat?.()) return;
  const heartbeat = heartbeatPath();
  const now = new Date();
  try {
    fs.utimesSync(heartbeat, now, now);
  } catch {
    try {
      fs.writeFileSync(heartbeat, '');
    } catch {
      // Parent may not exist in tests.
    }
  }
}
