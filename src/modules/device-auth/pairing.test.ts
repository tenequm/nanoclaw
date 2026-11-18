import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { handlePairCommand } from './pairing.js';
import { resetAppConfigCache } from '../../channels/app/config.js';
import { dispatch } from '../../cli/dispatch.js';
import '../../cli/resources/devices.js';
import { redactVoiceLinks } from '../../channels/telegram-grammy/inbound.js';
import { renderFS } from '../../channels/telegram-grammy/formatter.js';
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
  resetAppConfigCache();
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
it.each(['/', '///'])('uses one slash in the pair link with trailing %s', async (suffix) => {
  vi.stubEnv('APP_PUBLIC_BASE', `https://app.example.com${suffix}`);
  expect(await handlePairCommand(event)).toBe(true);
  const text = mocks.deliver.mock.calls[0][2].content.text as string;
  expect(text.startsWith('https://app.example.com/app/pair#')).toBe(true);
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
  resetAppConfigCache();
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
  expect(await call('revoke', { id: 'missing' })).toMatchObject({ ok: false, error: { message: 'No such device' } });
  await getDb().run(
    "INSERT INTO device_auth_devices (id,user_id,name,public_key,app_json,created_at) VALUES ('d','telegram:u','test','unused','{}',1)",
  );
  expect(await call('list', { user: 'telegram:u' })).toMatchObject({ ok: true, data: [{ id: 'd', revoked_at: null }] });
  expect(await call('revoke', { id: 'd' })).toMatchObject({ ok: true, data: { revoked: 'd', status: 'revoked' } });
  expect(await call('revoke', { id: 'd' })).toMatchObject({
    ok: true,
    data: { status: 'already_revoked', message: 'Already revoked' },
  });
  expect(await call('list', { user: 'telegram:u' })).toMatchObject({
    ok: true,
    data: [{ id: 'd', revoked_at: expect.any(Number) }],
  });
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

const command = (text: string) =>
  handlePairCommand({
    ...event,
    message: { ...event.message, content: JSON.stringify({ text, senderId: 'u' }) },
  });
const reply = () => mocks.deliver.mock.calls.at(-1)![2].content.text as string;
async function device(id: string, name = 'Phone', user = 'telegram:u', createdAt = 1) {
  await getDb().run(
    'INSERT INTO device_auth_devices (id,user_id,name,public_key,app_json,created_at) VALUES (?,?,?,?,?,?)',
    id,
    user,
    name,
    'unused',
    '{}',
    createdAt,
  );
}
it('lists only live own devices without a role and supports the bot suffix', async () => {
  await getDb().run('DELETE FROM user_roles');
  await getDb().run("INSERT INTO users (id,kind,created_at) VALUES ('telegram:other','human','now')");
  await device('dev_12345678-rest');
  await device('dev_87654321-rest', 'Other', 'telegram:other');
  await command('/pair@bot list');
  expect(reply()).toBe('`Phone` - 12345678 - 1970-01-01T00:00:00.001Z');
  await command('/pair revoke dev_87654321-rest');
  expect(reply()).toBe('No device `dev_87654321-rest`. Send /pair list.');
  await command('/pair@bot revoke 12345678');
  expect(reply()).toBe('Revoked `Phone`.');
  await command('/pair list');
  expect(reply()).toBe('No paired devices.');
});
it.each(['dev_12345678-rest', 'My Phone'])('revokes an own device by %s', async (arg) => {
  await device('dev_12345678-rest', 'My Phone');
  await command(`/pair revoke ${arg}`);
  expect(reply()).toBe('Revoked `My Phone`.');
});
it('prefers an id match over a device named after that id', async () => {
  await device('dev_12345678-rest', 'Phone', 'telegram:u', 1);
  await device('dev_87654321-rest', '12345678', 'telegram:u', 2);
  await command('/pair revoke 12345678');
  expect(reply()).toBe('Revoked `Phone`.');
  expect(await getDb().all('SELECT id FROM device_auth_devices WHERE revoked_at IS NULL')).toEqual([
    { id: 'dev_87654321-rest' },
  ]);
});
it('lists devices by pairing time', async () => {
  await device('dev_bbbbbbbb-rest', 'Second', 'telegram:u', 2000);
  await device('dev_aaaaaaaa-rest', 'First', 'telegram:u', 1000);
  await command('/pair list');
  expect(
    reply()
      .split('\n')
      .map((line) => line.split(' - ')[0]),
  ).toEqual(['`First`', '`Second`']);
});
it('answers a sender without a user row with silence', async () => {
  await getDb().run('DELETE FROM user_roles');
  await getDb().run('DELETE FROM users');
  for (const text of ['/pair list', '/pair revoke 12345678']) await command(text);
  expect(mocks.deliver).not.toHaveBeenCalled();
});
it('contains a failed list or revoke reply', async () => {
  const { log } = await import('../../log.js');
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  try {
    mocks.deliver.mockRejectedValue(new Error('send failed'));
    expect(await command('/pair list')).toBe(true);
    expect(warn).toHaveBeenCalledWith('Pairing reply failed', { kind: 'Error' });
  } finally {
    warn.mockRestore();
  }
});
it('keeps device names literal when the chat renders markdown', async () => {
  const names = ['[Not you? Revoke here](https://evil.example/r)', '||hidden||', 'Phone &#x202E;enohp', 'a&#10;b`c'];
  for (const [i, name] of names.entries()) await device(`dev_${i}0000000-rest`, name, 'telegram:u', i + 1);
  await command('/pair list');
  const listed = renderFS(reply());
  expect(listed.entities.every((entity) => entity.type === 'code')).toBe(true);
  for (const name of names) expect(listed.text).toContain(name.replaceAll('`', ''));
  await command('/pair revoke 00000000');
  const revoked = renderFS(reply());
  expect(revoked.text).toBe(`Revoked ${names[0]}.`);
  expect(revoked.entities.map((entity) => entity.type)).toEqual(['code']);
});
it('refuses group management without revealing or revoking devices', async () => {
  await device('dev_12345678-rest');
  await getDb().run('UPDATE messaging_groups SET is_group=1');
  for (const text of ['/pair list', '/pair revoke 12345678']) {
    await command(text);
    expect(reply()).toBe('Send /pair list in our direct chat.');
  }
  expect(await getDb().get('SELECT revoked_at FROM device_auth_devices')).toEqual({ revoked_at: null });
});
it('treats a message flagged as a group as one even when its chat is stored as direct', async () => {
  await device('dev_12345678-rest');
  const inGroup = (text: string) =>
    handlePairCommand({
      ...event,
      message: { ...event.message, isGroup: true, content: JSON.stringify({ text, senderId: 'u' }) },
    });
  for (const text of ['/pair list', '/pair revoke 12345678']) {
    await inGroup(text);
    expect(reply()).toBe('Send /pair list in our direct chat.');
  }
  mocks.deliver.mockClear();
  mocks.dm.mockResolvedValue({ platform_id: 'private', channel_type: 'telegram', instance: 'telegram' });
  await inGroup('/pair');
  expect(mocks.deliver.mock.calls[0][0]).toBe('private');
  expect(mocks.deliver.mock.calls[1][0]).toBe('chat');
  expect(mocks.deliver.mock.calls[1][2].content.text).toBe('Your pairing link is in our direct chat.');
  expect(await getDb().get('SELECT revoked_at FROM device_auth_devices')).toEqual({ revoked_at: null });
});
it('lists ambiguous names and revokes none', async () => {
  await device('dev_12345678-rest');
  await device('dev_87654321-rest');
  await command('/pair revoke Phone');
  expect(reply()).toContain('`Phone` - 12345678 -');
  expect(reply()).toContain('`Phone` - 87654321 -');
  expect(await getDb().all('SELECT id FROM device_auth_devices WHERE revoked_at IS NOT NULL')).toEqual([]);
});
it.each(['sent', 'missing', 'throw', 'adapter', 'hanging'])(
  'keeps pairing successful when the notice is %s',
  async (mode) => {
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { Readable } = await import('node:stream');
    const { handlePair, mintPairingLink } = await import('./pairing.js');
    const { pairProofText } = await import('../../channels/app/contract.js');
    const { log } = await import('../../log.js');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
      const code = (await mintPairingLink('telegram:u', ['a'])).split('#')[1];
      const name = '\u0000\n\u202e' + 'x'.repeat(70);
      const body = JSON.stringify({
        code,
        publicKey: spki,
        deviceName: name,
        proof: sign('sha256', Buffer.from(pairProofText(code, spki)), privateKey).toString('base64url'),
        app: { version: '1', build: '1', os: 'test' },
      });
      mocks.dm.mockResolvedValue(mode === 'missing' ? null : { platform_id: 'private', channel_type: 'telegram' });
      if (mode === 'throw') mocks.dm.mockRejectedValue(new Error(name));
      if (mode === 'adapter') mocks.deliver.mockRejectedValue(new Error(name));
      if (mode === 'hanging') mocks.deliver.mockReturnValue(new Promise(() => {}));
      const req = Object.assign(Readable.from([Buffer.from(body)]), {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      });
      const res = { writeHead: vi.fn(), end: vi.fn() };
      // The answer does not wait for the notice: a chat send can retry for minutes.
      await handlePair({ req, res } as unknown as Parameters<typeof handlePair>[0]);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
      expect(await getDb().get('SELECT revoked_at FROM device_auth_devices')).toEqual({ revoked_at: null });
      await vi.waitFor(() => expect(mocks.dm).toHaveBeenCalledWith('telegram:u', { privacySafeLogs: true }));
      if (mode === 'sent' || mode === 'hanging') {
        await vi.waitFor(() => expect(mocks.deliver).toHaveBeenCalled());
        expect(mocks.deliver.mock.calls[0][0]).toBe('private');
        expect(reply()).toMatch(
          new RegExp(
            `^Device paired: \`${'x'.repeat(64)}\` at \\d{4}-.*Z\\. To revoke, send /pair list, then /pair revoke <id>\\.$`,
          ),
        );
        expect(warn).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
        expect(warn).toHaveBeenCalledWith('Pairing notice failed', expect.objectContaining({ kind: 'Error' }));
        expect(JSON.stringify(warn.mock.calls)).not.toContain('xxxxx');
      }
    } finally {
      warn.mockRestore();
    }
  },
);
