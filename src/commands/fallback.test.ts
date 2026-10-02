import { describe, expect, it } from 'vitest';

import type { InboundEvent } from '../channels/adapter.js';
import type { MessagingGroup } from '../types.js';
import { voiceChatContext, type HostCommandContext } from './fallback.js';

const ctx = (threadId: string | null, messageId: string): HostCommandContext => ({
  command: 'voice',
  args: '',
  mg: { id: 'mg-1' } as MessagingGroup,
  event: {
    channelType: 'slack',
    platformId: 'slack:C1',
    threadId,
    message: { id: messageId, kind: 'chat-sdk', content: '{}', timestamp: '2026-10-02T00:00:00Z' },
  } as InboundEvent,
  userId: 'slack:U1',
  agents: [],
  adapterSupportsThreads: true,
});

describe('the chat /voice binds', () => {
  it('is the chat itself for a top-level message, whose thread is only its own ts', () => {
    expect(voiceChatContext(ctx('slack:C1:1712.5', '1712.5'))).toEqual({ messagingGroupId: 'mg-1', threadId: null });
  });

  it('is the thread for a message sent inside one, and the chat on a threadless platform', () => {
    expect(voiceChatContext(ctx('slack:C1:1700.1', '1712.5'))).toEqual({
      messagingGroupId: 'mg-1',
      threadId: 'slack:C1:1700.1',
    });
    expect(voiceChatContext(ctx(null, '42'))).toEqual({ messagingGroupId: 'mg-1', threadId: null });
  });
});
