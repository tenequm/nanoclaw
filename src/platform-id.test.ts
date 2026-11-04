/**
 * Agent-scoped message ids and their inverse.
 *
 * `messages_in.id` is PRIMARY KEY and one platform message fans out to a row
 * per agent group, so the router suffixes the platform id with the group.
 * The container then addresses a message by that ROW id, which means every
 * `edit_message` / `add_reaction` reaching an adapter carries the suffix —
 * and adapters need the platform's own id back.
 */
import { describe, expect, it } from 'vitest';

import { agentScopedMessageId, namespacedPlatformId, platformMessageId } from './platform-id.js';

describe('namespacedPlatformId', () => {
  it('prefixes Chat SDK ids and leaves native id formats alone', () => {
    expect(namespacedPlatformId('slack', 'C123')).toBe('slack:C123');
    expect(namespacedPlatformId('slack', 'slack:C123')).toBe('slack:C123');
    expect(namespacedPlatformId('whatsapp', '15551234@s.whatsapp.net')).toBe('15551234@s.whatsapp.net');
    expect(namespacedPlatformId('signal', '+15551234567')).toBe('+15551234567');
    expect(namespacedPlatformId('signal', 'group:abc')).toBe('group:abc');
    expect(namespacedPlatformId('deltachat', '12')).toBe('12');
  });
});

describe('agent scoping round-trip', () => {
  it('recovers a Slack ts, which carries dots but never the group suffix', () => {
    const scoped = agentScopedMessageId('1788196934.001629', 'b12619b5-19c8-48a8-a03e-dad2b8683a58');
    expect(scoped).toBe('1788196934.001629:b12619b5-19c8-48a8-a03e-dad2b8683a58');
    // Verbatim, this string reached Slack's reactions.add as a ts and came
    // back message_not_found.
    expect(platformMessageId(scoped, 'b12619b5-19c8-48a8-a03e-dad2b8683a58')).toBe('1788196934.001629');
  });

  it('recovers a Telegram compound id, which is itself colon-separated', () => {
    const scoped = agentScopedMessageId('1000001:1716', 'ag-1700000000000-abc123');
    expect(platformMessageId(scoped, 'ag-1700000000000-abc123')).toBe('1000001:1716');
  });

  it('leaves an id that was never scoped untouched', () => {
    // Outbound rows resolve through delivered.platform_message_id, which is
    // already the platform's own id.
    expect(platformMessageId('1788196934.001629', 'ag-1')).toBe('1788196934.001629');
  });

  it('matches the exact suffix only, never a lookalike group id', () => {
    // A prefix of the real group id must not strip anything: the match is
    // anchored on ":<agentGroupId>", not on "contains".
    expect(platformMessageId('1788.0001:ag-1700000000000-abc123', 'ag-1700000000000-abc')).toBe(
      '1788.0001:ag-1700000000000-abc123',
    );
    expect(platformMessageId('1788.0001:ag-other', 'ag-1')).toBe('1788.0001:ag-other');
  });
});
