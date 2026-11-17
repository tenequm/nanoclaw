import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { handlePairCommand } from './pairing.js';
import { dispatch } from '../../cli/dispatch.js';
import '../../cli/resources/devices.js';
import { redactVoiceLinks } from '../../channels/telegram-grammy/inbound.js';
import type { InboundEvent } from '../../channels/adapter.js';
const mocks = vi.hoisted(() => ({ deliver: vi.fn(), dm: vi.fn() }));
vi.mock('../../env.js', () => ({ envValue: (key: string) => process.env[key], readEnvFile: () => ({}) }));
vi.mock('../../router.js', () => ({ registerMessageInterceptor: vi.fn() }));
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapterExact: () => ({ deliver: mocks.deliver, supportsThreads: false }),
  getChannelAdapter: () => ({ supportsThreads: false }),
}));
vi.mock('../permissions/user-dm.js', () => ({ ensureUserDm: (...args: unknown[]) => mocks.dm(...args) }));
const event = {
  channelType: 'telegram',
  platformId: 'chat',
  threadId: null,
  message: { id: 'm', content: JSON.stringify({ text: '/pair', senderId: 'u' }) },
} as InboundEvent;
beforeEach(async () => {
  mocks.deliver.mockReset().mockResolvedValue(undefined);
  mocks.dm.mockReset();
  vi.stubEnv('APP_PUBLIC_BASE', 'https://example.test');
  const db = await initTestDb();
  await runMigrations(db);
  await db.run("INSERT INTO users (id,kind,created_at) VALUES ('telegram:u','human','now')");
  await db.run("INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('a','A','a','now')");
  await db.run("INSERT INTO user_roles (user_id,role,granted_at) VALUES ('telegram:u','owner','now')");
  await db.run(
    "INSERT INTO messaging_groups (id,channel_type,platform_id,is_group,created_at,instance) VALUES ('mg','telegram','chat',0,'now','telegram')",
  );
  await db.run(
    "INSERT INTO messaging_group_agents (messaging_group_id,agent_group_id,created_at) VALUES ('mg','a','now')",
  );
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
});
it('pairs an owner privately and stores only a hash', async () => {
  expect(await handlePairCommand(event)).toBe(true);
  const text = mocks.deliver.mock.calls[0][2].content.text as string;
  expect(text.startsWith('https://example.test/app/pair#')).toBe(true);
  const row = await getDb().get<{ code_hash: string }>('SELECT code_hash FROM device_auth_pairing_codes');
  expect(row!.code_hash.length).toBe(64);
  expect(row!.code_hash === text.split('#')[1]).toBe(false);
  expect((await getDb().all('SELECT * FROM device_auth_user_agents')).length).toBe(1);
  expect(redactVoiceLinks(text)).toBe('[pairing link]');
});
it('refuses a member without a role and silently claims unknown or unwired senders', async () => {
  await getDb().run('DELETE FROM user_roles');
  await handlePairCommand(event);
  expect(mocks.deliver.mock.calls[0][2].content.text).toBe('Only an owner or admin of this agent can use /pair.');
  mocks.deliver.mockClear();
  await getDb().run('DELETE FROM users');
  await handlePairCommand(event);
  expect(mocks.deliver).not.toHaveBeenCalled();
  await handlePairCommand({ ...event, platformId: 'unknown' });
  expect(mocks.deliver).not.toHaveBeenCalled();
  expect(await handlePairCommand({ ...event, channelType: 'app' })).toBe(false);
});
it('delivers a group pairing link only in the sender direct chat', async () => {
  await getDb().run('UPDATE messaging_groups SET is_group=1');
  mocks.dm.mockResolvedValue({ platform_id: 'private', channel_type: 'telegram', instance: 'telegram' });
  await handlePairCommand(event);
  expect(mocks.deliver.mock.calls[0][0]).toBe('private');
  expect(mocks.deliver.mock.calls[1][0]).toBe('chat');
  expect(mocks.deliver.mock.calls[1][2].content.text.includes('/app/pair#')).toBe(false);
});
it('does not mint without a private destination or public base', async () => {
  await getDb().run('UPDATE messaging_groups SET is_group=1');
  mocks.dm.mockResolvedValue(null);
  await handlePairCommand(event);
  vi.stubEnv('APP_PUBLIC_BASE', '');
  await handlePairCommand(event);
  expect(await getDb().all('SELECT * FROM device_auth_pairing_codes')).toEqual([]);
});
it('registers host-only pair, list and revoke commands with the link in data', async () => {
  const call = (command: string, args: Record<string, unknown>, agent = false) =>
    dispatch(
      { id: 'r', command: `devices-${command}`, args },
      agent ? { caller: 'agent', sessionId: 's', agentGroupId: 'a', messagingGroupId: 'mg' } : { caller: 'host' },
    );
  const response = await call('pair', { user: 'telegram:u', agents: 'a' });
  expect(response.ok).toBe(true);
  if (response.ok)
    expect(typeof response.data === 'string' && response.data.startsWith('https://example.test/app/pair#')).toBe(true);
  expect(await call('list', { user: 'telegram:u' })).toMatchObject({ ok: true, data: [] });
  expect(await call('revoke', { id: 'missing' })).toMatchObject({ ok: true });
  for (const command of ['pair', 'list', 'revoke'])
    expect(await call(command, { user: 'telegram:u', agents: 'a', id: 'd' }, true)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
});
it('keeps pairing dispatch callable when device commands load first', async () => {
  const { routes } = await import('../../channels/app/routes.js');
  expect(routes.every((route) => typeof route.handler === 'function')).toBe(true);
});
