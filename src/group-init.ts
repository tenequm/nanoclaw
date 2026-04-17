import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { initContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Container path where groups/global is mounted. The symlink we drop
// into each group's dir resolves to this target inside the container.
// It's a dangling symlink on the host — that's fine, host tools don't
// follow it and the container mount makes it valid at read time.
const GLOBAL_MEMORY_CONTAINER_PATH = '/workspace/global/CLAUDE.md';

// Symlink name inside the group's dir. Claude Code's @-import only
// follows paths inside cwd, so we can't reference /workspace/global
// directly — we symlink into the group dir and import the symlink.
export const GLOBAL_MEMORY_LINK_NAME = '.claude-global.md';
export const GLOBAL_CLAUDE_IMPORT = `@./${GLOBAL_MEMORY_LINK_NAME}`;

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
      permissions: {
        allow: ['mcp__surf__*'],
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime: at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path. After init, the
 * host never overwrites any of these paths automatically — agents own them.
 * To pull in upstream changes, use the host-mediated reset/refresh tools.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const projectRoot = process.cwd();
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/.claude-global.md — symlink into the group dir so
  // Claude Code's @-import can follow it. Uses lstat to avoid tripping
  // existsSync on a dangling symlink (target only resolves inside the
  // container).
  const globalLinkPath = path.join(groupDir, GLOBAL_MEMORY_LINK_NAME);
  let linkExists = false;
  try {
    fs.lstatSync(globalLinkPath);
    linkExists = true;
  } catch {
    /* missing — recreate */
  }
  if (!linkExists) {
    fs.symlinkSync(GLOBAL_MEMORY_CONTAINER_PATH, globalLinkPath);
    initialized.push('.claude-global.md');
  }

  // groups/<folder>/CLAUDE.md — written once, then owned by the group
  const claudeMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdFile)) {
    const body = [GLOBAL_CLAUDE_IMPORT, '', opts?.instructions ?? `# ${group.name}`].join('\n') + '\n';
    fs.writeFileSync(claudeMdFile, body);
    initialized.push('CLAUDE.md');
  }

  // groups/<folder>/container.json — empty container config, replaces the
  // former agent_groups.container_config DB column. Self-modification flows
  // read and write this file directly.
  if (initContainerConfig(group.folder)) {
    initialized.push('container.json');
  }

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    initialized.push('.claude-shared');
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  }

  const skillsDst = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    const skillsSrc = path.join(projectRoot, 'container', 'skills');
    if (fs.existsSync(skillsSrc)) {
      fs.cpSync(skillsSrc, skillsDst, { recursive: true });
      initialized.push('skills/');
    }
  }

  // 3. data/v2-sessions/<id>/agent-runner-src/ — per-group source copy
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', group.id, 'agent-runner-src');
  if (!fs.existsSync(groupRunnerDir)) {
    const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
    if (fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, groupRunnerDir, { recursive: true });
      initialized.push('agent-runner-src/');
    }
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}
