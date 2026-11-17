import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createAgentGroup, initDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import type { AgentGroup } from '../../types.js';
import { appAgentInstructions } from './agent-docs.js';

let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'n6-app-doc-'));
  await runMigrations(await initDb(join(directory, 'test.db'), { role: 'test' }));
});
afterEach(async () => {
  await closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function composeFor(channels: string[]): Promise<string> {
  const group: AgentGroup = {
    id: 'ag-doc',
    name: 'Test agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  await createAgentGroup(group);
  await ensureContainerConfig(group.id);
  await updateContainerConfigJson(group.id, 'skills', []);
  for (const channel of channels) {
    await createMessagingGroup({
      id: channel,
      channel_type: channel,
      instance: channel,
      platform_id: `${channel}:test`,
      name: channel,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: group.created_at,
    });
    await createMessagingGroupAgent({
      id: `wire-${channel}`,
      messaging_group_id: channel,
      agent_group_id: group.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 0,
      created_at: group.created_at,
    });
  }
  const groupDirectory = join(directory, group.folder);
  await composeGroupProjectDoc(group, groupDirectory, { fileName: 'AGENTS.md' }, []);
  return readFileSync(join(groupDirectory, 'AGENTS.md'), 'utf8');
}

describe('app agent formatting', () => {
  it.each([['app'], ['app', 'telegram']])(
    'includes the section for wiring %j even without selected skills',
    async (...channels) => {
      const doc = await composeFor(channels);
      expect(doc).toContain('# Hey Dan app formatting\n');
      expect(doc).toContain(appAgentInstructions());
      expect(doc).toContain('shell variables (`$HOME`)');
      expect(doc).toContain('any line with two dollar signs in backticks');
    },
  );

  it.each([[], ['telegram']])('omits the section without app wiring %j', async (...channels) => {
    expect(await composeFor(channels)).not.toContain('# Hey Dan app formatting');
  });
});
