/**
 * Pure-unit tests for the chat-command binding. No live bot, no DB: only the
 * pieces that are pure functions of their inputs - grant->scope mapping, the
 * callback index payload encode/decode, and the text builders.
 */
import type { Context } from 'grammy';
import { describe, expect, it } from 'vitest';

import { readAgentIndex } from './context.js';
import type { CommandGrant } from './grants.js';
import { agentPickerPrompt, failureMessage, statusCard } from './render.js';
import { grantToScope } from './scope-sync.js';

const ADMIN_CMDS = ['status', 'model', 'config', 'restart'] as const;

describe('grantToScope', () => {
  it('maps a chat_member grant to a chat_member scope + stable key', () => {
    const grant: CommandGrant = {
      chatPlatformId: 'telegram:-1003927289090',
      kind: 'chat_member',
      userId: 'telegram:95307956',
      commands: ADMIN_CMDS,
    };
    const r = grantToScope(grant);
    expect(r).toEqual({
      scopeKey: 'chat_member:-1003927289090:95307956',
      scope: { type: 'chat_member', chat_id: -1003927289090, user_id: 95307956 },
    });
  });

  it('maps a chat grant (owner DM) to a chat scope + stable key', () => {
    const grant: CommandGrant = {
      chatPlatformId: 'telegram:95307956',
      kind: 'chat',
      commands: ADMIN_CMDS,
    };
    const r = grantToScope(grant);
    expect(r).toEqual({
      scopeKey: 'chat:95307956',
      scope: { type: 'chat', chat_id: 95307956 },
    });
  });

  it('rejects a chat_member grant with no user id', () => {
    const grant: CommandGrant = {
      chatPlatformId: 'telegram:-100123',
      kind: 'chat_member',
      commands: ADMIN_CMDS,
    };
    expect(grantToScope(grant)).toBeNull();
  });

  it('rejects a grant with a non-numeric chat id', () => {
    const grant: CommandGrant = {
      chatPlatformId: 'telegram:notanumber',
      kind: 'chat',
      commands: ADMIN_CMDS,
    };
    expect(grantToScope(grant)).toBeNull();
  });

  it('produces distinct keys per (chat, user) so the janitor diff is exact', () => {
    const base = { kind: 'chat_member' as const, commands: ADMIN_CMDS };
    const a = grantToScope({ ...base, chatPlatformId: 'telegram:-100', userId: 'telegram:1' });
    const b = grantToScope({ ...base, chatPlatformId: 'telegram:-100', userId: 'telegram:2' });
    const c = grantToScope({ ...base, chatPlatformId: 'telegram:-200', userId: 'telegram:1' });
    const keys = new Set([a?.scopeKey, b?.scopeKey, c?.scopeKey]);
    expect(keys.size).toBe(3);
  });
});

describe('readAgentIndex (callback payload decode)', () => {
  const withMatch = (match: unknown): Context => ({ match }) as unknown as Context;

  it('decodes a valid non-negative integer payload', () => {
    expect(readAgentIndex(withMatch('0'))).toBe(0);
    expect(readAgentIndex(withMatch('2'))).toBe(2);
    expect(readAgentIndex(withMatch(' 3 '))).toBe(3);
  });

  it('defaults to 0 for empty, missing, or malformed payloads', () => {
    expect(readAgentIndex(withMatch(''))).toBe(0);
    expect(readAgentIndex(withMatch(undefined))).toBe(0);
    expect(readAgentIndex(withMatch('-1'))).toBe(0);
    expect(readAgentIndex(withMatch('abc'))).toBe(0);
    expect(readAgentIndex(withMatch('1.5'))).toBe(0);
  });

  it('round-trips an encoded index (String(i) -> readAgentIndex)', () => {
    for (let i = 0; i < 5; i++) {
      expect(readAgentIndex(withMatch(String(i)))).toBe(i);
    }
  });
});

describe('render text builders', () => {
  it('renders a compact status card with the running dot and model line', () => {
    const card = statusCard({
      agentName: 'Emma',
      agentGroupId: 'ag-1',
      model: 'claude-opus-4-8',
      modelLabel: 'Opus 4.8',
      effort: 'high',
      autoCompactWindow: 400000,
      maxMessagesPerPrompt: null,
      provider: 'claude',
      cliScope: 'group',
      sessionCount: 2,
      configUpdatedAt: '2026-07-10T00:28:00.000Z',
      activation: { engageMode: 'mention', engagePattern: null, senderScope: 'known' },
      contextTokens: 113000,
      contextWindow: 400000,
      sessionOutputTokens: 46000,
      sessionTurns: 214,
      queueDepth: 1,
      taskCount: 3,
    });
    expect(card).toContain('📊 **Emma**');
    expect(card).toContain('**Model:** Opus 4.8 (`claude-opus-4-8`), high effort');
    expect(card).toContain('**Context:** 113k / 400k (28%)');
    expect(card).toContain('**Session:** 46k out over 214 turns');
    expect(card).toContain('**Activation:** mention, known senders');
    expect(card).toContain('**Sessions:** 2 | **Queue:** 1 | **Tasks:** 3');
    // Typography: no banned unicode glyphs.
    expect(card).not.toMatch(/[\u2013\u2014\u2026\u2192\u2190\u2022\u00a0]/);
  });

  it('omits empty segments and shows non-default extras', () => {
    const card = statusCard({
      agentName: 'Stan',
      agentGroupId: 'ag-2',
      model: null,
      modelLabel: null,
      effort: null,
      autoCompactWindow: null,
      maxMessagesPerPrompt: null,
      provider: 'opencode',
      cliScope: 'global',
      sessionCount: 0,
      configUpdatedAt: null,
      activation: null,
      contextTokens: null,
      contextWindow: null,
      sessionOutputTokens: null,
      sessionTurns: null,
      queueDepth: 0,
      taskCount: 0,
    });
    expect(card).toContain('**Model:** (default)');
    expect(card).toContain('**Provider:** opencode');
    expect(card).toContain('**CLI scope:** global');
    expect(card).toContain('**Sessions:** 0');
    expect(card).not.toContain('Context:');
    expect(card).not.toContain('Queue:');
    expect(card).not.toContain('Tasks:');
  });

  it('failureMessage returns an admins-only string for unauthorized', () => {
    expect(failureMessage({ ok: false, reason: 'unauthorized' })).toBe('🚫 Admins only.');
  });

  it('agentPickerPrompt names the count and command', () => {
    const p = agentPickerPrompt('model', [
      { agentGroupId: 'a', agentName: 'Emma' },
      { agentGroupId: 'b', agentName: 'Stan' },
    ]);
    expect(p).toContain('2 agents');
    expect(p).toContain('/model');
  });
});
