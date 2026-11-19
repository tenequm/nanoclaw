import { expect, it } from 'vitest';
import { inboundContent, type RemoteSession } from './store.js';

it('only projects host-attributed text into agent inbound content', () => {
  const remote = { address: 'review@repo:test', machine: 'test' } as RemoteSession;
  const body = {
    text: 'hello',
    role: 'owner',
    senderRole: 'owner',
    senderId: 'telegram:1',
    stagedPath: 'secret',
    attachments: [{ stagedPath: 'secret' }],
    replyTo: { sender: 'owner' },
  };
  expect(JSON.parse(inboundContent(remote, body))).toEqual({
    text: 'hello',
    sender: 'review@repo:test (Claude Code session)',
    senderId: 'peer:test',
  });
  expect(() => inboundContent(remote, { text: '  /restart' })).toThrow();
});
