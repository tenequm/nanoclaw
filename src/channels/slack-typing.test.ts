/**
 * Slack's overrides of the generic Chat SDK typing surface.
 *
 * Two things are Slack-specific and neither can be inferred from the base
 * Adapter contract, so both are asserted here rather than in the bridge
 * suite:
 *
 *  - `typingRequiresThread`. Slack's assistant status paints only inside a
 *    thread (startTyping no-ops without a threadTs), so a shared-session
 *    chat gets no indicator at all and the host must fall back to a
 *    reaction ack. Every other Chat SDK platform leaves the flag unset.
 *  - `clearTyping` via `setAssistantStatus`. The bridge's generic clear is
 *    `startTyping(tid, '')`, which the vendored Slack adapter turns into
 *    `loading_messages: ['']` — an empty rotation entry with no documented
 *    handling. `setAssistantStatus` omits the field, leaving the documented
 *    empty-status clear on its own.
 *
 * Own file because it mocks the adapter package at the module edge, which
 * the barrel-importing registration suite must not do.
 */
import { describe, it, expect, vi } from 'vitest';

const setAssistantStatus = vi.fn(async () => {});

vi.mock('@chat-adapter/slack', () => ({
  createSlackAdapter: () => ({ name: 'slack', setAssistantStatus }),
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' }),
}));

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

const { createSlackBridge } = await import('./slack.js');

describe('slack typing overrides', () => {
  it('declares that its indicator needs a thread', () => {
    expect(createSlackBridge()!.typingRequiresThread).toBe(true);
  });

  it('clears through setAssistantStatus, without an empty loading_messages entry', async () => {
    setAssistantStatus.mockClear();
    await createSlackBridge()!.clearTyping!('slack:C1', 'slack:C1:1788198342.001');
    expect(setAssistantStatus).toHaveBeenCalledWith('C1', '1788198342.001', '');
  });

  it('no-ops when nothing could have been painted (no thread in the address)', async () => {
    setAssistantStatus.mockClear();
    await createSlackBridge()!.clearTyping!('slack:D1', null);
    expect(setAssistantStatus).not.toHaveBeenCalled();
  });
});
