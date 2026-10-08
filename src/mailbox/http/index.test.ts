import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-mailbox-http-wrapper-${process.pid}` }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { heartbeatPath } from '../../session-manager.js';
import { SqliteAgentMailbox } from '../sqlite/index.js';
import { HttpServedAgentMailbox, readMailboxHttpSettings, type MailboxHttpSettings } from './index.js';
import { MAILBOX_HTTP_PATH } from './server.js';

const KEY = { agentGroupId: 'ag-1', sessionId: 'sess-1' };
const httpSettings: MailboxHttpSettings = { transport: 'http', bind: '127.0.0.1', port: 0, url: 'http://host.test:1' };

afterAll(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

function spyDelegate() {
  const delegate = new SqliteAgentMailbox();
  return {
    delegate,
    exists: vi.spyOn(delegate, 'exists'),
    prepare: vi.spyOn(delegate, 'prepare'),
    destroy: vi.spyOn(delegate, 'destroy'),
    session: vi.spyOn(delegate, 'session'),
  };
}

describe('HttpServedAgentMailbox', () => {
  it('delegates every storage operation to the SQLite mailbox', async () => {
    const spies = spyDelegate();
    const mailbox = new HttpServedAgentMailbox(spies.delegate, () => httpSettings);
    expect(await mailbox.exists(KEY)).toBe(false);
    mailbox.prepare(KEY);
    expect(await mailbox.exists(KEY)).toBe(true);
    await mailbox.session(KEY, async (session) => {
      await session.insertMessage({
        id: 'm1',
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        platformId: null,
        channelType: null,
        threadId: null,
        content: '{}',
        processAfter: null,
        recurrence: null,
      });
    });
    expect(await mailbox.session(KEY, (session) => session.countDueMessages())).toBe(1);
    await mailbox.destroy(KEY);
    expect(spies.exists).toHaveBeenCalledWith(KEY);
    expect(spies.prepare).toHaveBeenCalledWith(KEY);
    expect(spies.session).toHaveBeenCalledTimes(2);
    expect(spies.destroy).toHaveBeenCalledWith(KEY);
    expect(await mailbox.exists(KEY)).toBe(false);
  });

  it('hands the runner the endpoint and a fresh per-spawn token, never in its environment', async () => {
    const mailbox = new HttpServedAgentMailbox(new SqliteAgentMailbox(), () => httpSettings);
    const first = (await mailbox.runnerContext(KEY))!;
    expect(first).toMatchObject({ transport: 'http', protocol: 1, url: `http://host.test:1${MAILBOX_HTTP_PATH}` });
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await mailbox.runnerEnvironment(KEY)).toEqual({});

    const second = (await mailbox.runnerContext(KEY))!;
    expect(second.token).not.toBe(first.token);
    expect(mailbox.verifyToken(KEY, second.token)).toBe(true);
    expect(mailbox.verifyToken(KEY, first.token), 'a replaced container is fenced out').toBe(false);
    expect(mailbox.verifyToken({ ...KEY, sessionId: 'other' }, second.token)).toBe(false);

    // A restarted host reads the token the surviving container was spawned with.
    const restarted = new HttpServedAgentMailbox(new SqliteAgentMailbox(), () => httpSettings);
    expect(restarted.verifyToken(KEY, second.token)).toBe(true);
    const tokenFile = path.join(TEST_DIR, 'v2-sessions', KEY.agentGroupId, '.mailbox-http', `${KEY.sessionId}.token`);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(tokenFile.startsWith(path.dirname(heartbeatPath(KEY.agentGroupId, KEY.sessionId)))).toBe(false);

    await restarted.destroy(KEY);
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it('falls back to the SQLite runner context when the transport is set to sqlite', async () => {
    const mailbox = new HttpServedAgentMailbox(new SqliteAgentMailbox(), () => ({
      ...httpSettings,
      transport: 'sqlite',
    }));
    expect(await mailbox.runnerContext(KEY)).toBeNull();
    await mailbox.listen();
    expect(mailbox.address()).toBeUndefined();
  });

  it('listens on the configured bind and stops on close', async () => {
    const mailbox = new HttpServedAgentMailbox(new SqliteAgentMailbox(), () => httpSettings);
    await mailbox.listen();
    const address = mailbox.address()!;
    expect(address.address).toBe('127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${address.port}${MAILBOX_HTTP_PATH}`, { method: 'POST' });
    expect(response.status).toBe(401);
    await mailbox.close();
    expect(mailbox.address()).toBeUndefined();
  });

  it('touches the same heartbeat file the host sweep reads', async () => {
    const mailbox = new HttpServedAgentMailbox(new SqliteAgentMailbox(), () => httpSettings);
    mailbox.prepare(KEY);
    const context = (await mailbox.runnerContext(KEY))!;
    await mailbox.listen();
    const response = await fetch(`http://127.0.0.1:${mailbox.address()!.port}${MAILBOX_HTTP_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.token}`,
        'x-nanoclaw-agent-group': KEY.agentGroupId,
        'x-nanoclaw-session': KEY.sessionId,
      },
      body: JSON.stringify({ ops: [{ op: 'heartbeat' }] }),
    });
    expect(response.status).toBe(200);
    expect(fs.existsSync(heartbeatPath(KEY.agentGroupId, KEY.sessionId))).toBe(true);
    await mailbox.close();
    await mailbox.destroy(KEY);
  });
});

describe('readMailboxHttpSettings', () => {
  it('defaults to the http transport on a fixed port, never a wildcard bind', () => {
    const settings = readMailboxHttpSettings({ NANOCLAW_MAILBOX_HTTP_BIND: '172.17.0.1' });
    expect(settings).toMatchObject({ transport: 'http', port: 3010, bind: '172.17.0.1' });
    expect(settings.url, 'a bridge bind is advertised as itself').toBe('http://172.17.0.1:3010');
    if (os.platform() !== 'linux') expect(readMailboxHttpSettings({}).bind).toBe('127.0.0.1');
  });

  it('advertises host.docker.internal for loopback binds and honours an explicit URL', () => {
    expect(
      readMailboxHttpSettings({ NANOCLAW_MAILBOX_HTTP_BIND: '127.0.0.1', NANOCLAW_MAILBOX_HTTP_PORT: '4000' }).url,
    ).toBe('http://host.docker.internal:4000');
    expect(
      readMailboxHttpSettings({ NANOCLAW_MAILBOX_HTTP_BIND: '127.0.0.1', NANOCLAW_MAILBOX_HTTP_URL: 'http://mbx:9/' })
        .url,
    ).toBe('http://mbx:9');
  });

  it('rejects an unknown transport or port instead of guessing', () => {
    expect(() => readMailboxHttpSettings({ NANOCLAW_MAILBOX_TRANSPORT: 'nfs' })).toThrow('http or sqlite');
    expect(() => readMailboxHttpSettings({ NANOCLAW_MAILBOX_HTTP_PORT: 'x' })).toThrow('valid port');
    expect(readMailboxHttpSettings({ NANOCLAW_MAILBOX_TRANSPORT: 'SQLite' }).transport).toBe('sqlite');
  });
});
