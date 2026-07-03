import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroupByPlatform, getMessagingGroupAgents } from './db/messaging-groups.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

/**
 * Resolve the on-disk group folder for an inbound platform id on a given
 * channel type, by looking up the messaging_group → primary agent_group
 * wiring. Returns null when the platform id is unknown or the messaging
 * group has no agents wired yet. Shared by channel adapters that need to
 * stream attachment bytes to the agent's folder.
 */
export function resolveGroupFolderForPlatformId(channelType: string, platformId: string): string | null {
  const mg = getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) return null;
  const wirings = getMessagingGroupAgents(mg.id);
  if (wirings.length === 0) return null;
  const primary = wirings[0];
  const ag = getAgentGroup(primary.agent_group_id);
  return ag?.folder ?? null;
}
