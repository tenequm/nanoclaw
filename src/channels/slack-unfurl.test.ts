/**
 * Every Slack post goes out with link and media unfurls off. The /voice reply
 * (src/commands/fallback.ts) carries a voice line's call link, a credential,
 * and relies on this so Slack's unfurler never fetches it: a bump of
 * @chat-adapter/slack that drops it must fail here.
 */
import { createSlackAdapter } from '@chat-adapter/slack';
import { describe, expect, it, vi } from 'vitest';

describe('Slack posts', () => {
  it('turn link and media unfurls off', async () => {
    const adapter = createSlackAdapter({ botToken: 'xoxb-test', signingSecret: 'test-secret' });
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1712.5' });
    (adapter as unknown as { _client: { chat: { postMessage: typeof postMessage } } })._client.chat.postMessage =
      postMessage;
    await adapter.postMessage('slack:C1', { markdown: 'https://host.example/webhook/voice/livekit?t=0123abcd' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', unfurl_links: false, unfurl_media: false }),
    );
  });
});
