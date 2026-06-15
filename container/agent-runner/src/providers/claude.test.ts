import { describe, expect, it } from 'bun:test';

import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

import { classifyResult, extractAssistantText, translateSdkMessages } from './claude.js';
import type { ProviderEvent } from './types.js';
import failingTurn from './__fixtures__/failing-turn.json' with { type: 'json' };

// SDK message fixtures carry many fields (uuid, session_id, usage, modelUsage,
// permission_denials, etc.). The helpers only read narrow fields, so we cast
// minimal partials rather than building exhaustive fixtures.
const am = (content: unknown[], parentToolUseId: string | null = null): SDKAssistantMessage =>
  ({ type: 'assistant', message: { content }, parent_tool_use_id: parentToolUseId } as unknown as SDKAssistantMessage);

const rm = (m: Record<string, unknown>): SDKResultMessage => m as unknown as SDKResultMessage;

describe('extractAssistantText', () => {
  it('returns empty for no content', () => {
    expect(extractAssistantText(am([]))).toEqual({ text: '', hasToolUse: false });
  });

  it('concatenates text blocks and detects tool_use', () => {
    const msg = am([
      { type: 'text', text: 'Looking…' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', text: ' here is what I found' },
    ]);
    expect(extractAssistantText(msg)).toEqual({
      text: 'Looking… here is what I found',
      hasToolUse: true,
    });
  });

  it('treats whitespace-only text as empty', () => {
    expect(extractAssistantText(am([{ type: 'text', text: '   \n  ' }]))).toEqual({
      text: '',
      hasToolUse: false,
    });
  });

  it('ignores thinking blocks', () => {
    const msg = am([
      { type: 'thinking', thinking: 'internal' },
      { type: 'text', text: 'visible' },
    ]);
    expect(extractAssistantText(msg)).toEqual({ text: 'visible', hasToolUse: false });
  });

  it('detects tool_use with no text', () => {
    const msg = am([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]);
    expect(extractAssistantText(msg)).toEqual({ text: '', hasToolUse: true });
  });
});

describe('classifyResult', () => {
  it('success with text', () => {
    expect(classifyResult(rm({ type: 'result', subtype: 'success', result: 'done', stop_reason: 'end_turn' })))
      .toEqual({ kind: 'success', text: 'done' });
  });

  it('success with empty text', () => {
    expect(classifyResult(rm({ type: 'result', subtype: 'success', result: '', stop_reason: 'end_turn' })))
      .toEqual({ kind: 'success', text: '' });
  });

  it('refusal short-circuits success', () => {
    expect(classifyResult(rm({ type: 'result', subtype: 'success', result: '', stop_reason: 'refusal' })))
      .toEqual({ kind: 'refusal' });
  });

  it('maps each error subtype to a known message', () => {
    const subtypes = [
      'error_max_turns',
      'error_max_budget_usd',
      'error_during_execution',
      'error_max_structured_output_retries',
    ] as const;
    for (const subtype of subtypes) {
      const result = classifyResult(rm({ type: 'result', subtype, stop_reason: null }));
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.subtype).toBe(subtype);
        expect(result.message.length).toBeGreaterThan(0);
      }
    }
  });
});

// Helpers for translator integration tests.

async function* iter(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  for (const m of messages) yield m;
}

async function collect(source: AsyncIterable<SDKMessage>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of translateSdkMessages(source)) events.push(e);
  return events;
}

const sysInit: SDKMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'test-session',
} as unknown as SDKMessage;

const sysResultSuccess = (text: string): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    result: text,
    stop_reason: 'end_turn',
    session_id: 'test-session',
  } as unknown as SDKMessage);

const sysResultError = (subtype: string): SDKMessage =>
  ({
    type: 'result',
    subtype,
    stop_reason: null,
    session_id: 'test-session',
  } as unknown as SDKMessage);

describe('translateSdkMessages — replay of the actual failing turn', () => {
  it('emits the 10,791-char analysis as a result event despite empty ResultMessage.result', async () => {
    // The bug: lines 98-99 of the failing JSONL transcript are:
    //   - AM with single text block (10,791 chars Ukrainian analysis), no tool_use.
    //   - AM with single TodoWrite tool_use, no text.
    // The old translator only handled `result` events and dropped both AMs.
    // Whatever the SDK emitted as ResultMessage, the user saw nothing.
    //
    // We construct the failing turn here: replay the two real AMs from the
    // JSONL, then synthesize an empty-result ResultSuccess to mimic the worst
    // case (CLI v2.1+ behavior). With the new translator, the text-only AM
    // must produce a `result` event before the empty RM is processed.
    const messages = [
      sysInit,
      ...failingTurn.messages.map((m) => m as unknown as SDKMessage),
      sysResultSuccess(''), // worst case: empty result
    ];
    const events = await collect(iter(messages));
    const results = events.filter((e) => e.type === 'result');
    const errors = events.filter((e) => e.type === 'error');
    const progress = events.filter((e) => e.type === 'progress');

    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(progress).toHaveLength(0);
    if (results[0].type === 'result' && results[0].text) {
      expect(results[0].text.length).toBeGreaterThan(10000);
      expect(results[0].text.startsWith('Готово, прочитав усі три')).toBe(true);
    }
  });

  it('does not double-emit when ResultMessage.result mirrors the final AM', async () => {
    // Happy-path SDK behavior: text-only AM, then RM.result equals that text.
    // We must NOT emit two `result` events with the same content.
    const finalAm = failingTurn.messages[0] as unknown as SDKMessage;
    const finalText = (finalAm as SDKAssistantMessage).message.content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { type: string; text?: string }) => b.text ?? '')
      .join('');
    const messages = [sysInit, finalAm, sysResultSuccess(finalText)];
    const events = await collect(iter(messages));
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
  });
});

describe('translateSdkMessages — synthetic scenarios', () => {
  const am = (content: unknown[], parentToolUseId: string | null = null): SDKMessage =>
    ({
      type: 'assistant',
      message: { content },
      parent_tool_use_id: parentToolUseId,
      session_id: 'test-session',
    } as unknown as SDKMessage);

  it('emits progress for AM with text+tool_use, then result for final text-only AM', async () => {
    const messages = [
      sysInit,
      am([{ type: 'text', text: 'Reading config…' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      am([{ type: 'text', text: 'Here is the answer.' }]),
      sysResultSuccess('Here is the answer.'),
    ];
    const events = await collect(iter(messages));
    const sequence = events
      .filter((e) => e.type !== 'activity' && e.type !== 'init')
      .map((e) => {
        if (e.type === 'progress') return ['progress', e.message] as const;
        if (e.type === 'result') return ['result', e.text] as const;
        return [e.type] as const;
      });
    expect(sequence).toEqual([
      ['progress', 'Reading config…'],
      ['result', 'Here is the answer.'],
    ]);
  });

  it('skips subagent narration (parent_tool_use_id set)', async () => {
    const messages = [
      sysInit,
      am([{ type: 'text', text: 'subagent internal thoughts' }], 'parent-tool-1'),
      am([{ type: 'text', text: 'top-level reply' }]),
      sysResultSuccess('top-level reply'),
    ];
    const events = await collect(iter(messages));
    const texts = events.flatMap((e) => {
      if (e.type === 'result' && e.text) return [e.text];
      if (e.type === 'progress') return [e.message];
      return [];
    });
    expect(texts).toEqual(['top-level reply']);
  });

  it('emits classified error for RM error subtypes', async () => {
    const messages = [sysInit, sysResultError('error_max_turns')];
    const events = await collect(iter(messages));
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0].type === 'error') {
      expect(errors[0].retryable).toBe(false);
      expect(errors[0].classification).toBe('error_max_turns');
      expect(errors[0].message).toContain('maximum turn limit');
    }
  });

  it('yields one activity event per SDK message', async () => {
    const messages = [
      sysInit,
      am([{ type: 'text', text: 'reply' }]),
      sysResultSuccess('reply'),
    ];
    const events = await collect(iter(messages));
    const activity = events.filter((e) => e.type === 'activity');
    expect(activity).toHaveLength(messages.length);
  });
});
