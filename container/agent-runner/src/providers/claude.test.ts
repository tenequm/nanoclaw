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

  it('does NOT emit per-AssistantMessage: narration-with-tool is dropped, only the final answer is delivered once', async () => {
    // A text+tool_use AM ("Reading config…") is per-turn narration, NOT the
    // answer — it must not be emitted at all. The final text-only AM is the
    // answer, delivered once at the ResultMessage boundary. Emitting these
    // per-AM is what caused the duplicate-message bug (see the translator's
    // "Turn-boundary delivery model" block).
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
    expect(sequence).toEqual([['result', 'Here is the answer.']]);
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

  it('context compaction emits a user-facing `notice`, never a `result`', async () => {
    // Compaction must be visible to the user AND must not flow through the
    // result/dispatch path (where, as bare text, it would trip the false
    // "not delivered" nudge — same bug class). See claude.ts compact_boundary.
    const sysCompact = (preTokens: number): SDKMessage =>
      ({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { pre_tokens: preTokens },
        session_id: 'test-session',
      } as unknown as SDKMessage);
    const events = await collect(iter([sysInit, sysCompact(120000)]));
    expect(events.filter((e) => e.type === 'result')).toHaveLength(0);
    const notices = events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    if (notices[0].type === 'notice') {
      expect(notices[0].message).toContain('compacted');
      expect(notices[0].message).toContain('120,000');
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

// ── Duplicate-message regression suite ──────────────────────────────────────
//
// These lock in the ONE-result-per-turn invariant that fixes the duplicate
// messages bug. Root cause: the translator used to emit a `result` for every
// text-only AssistantMessage; the poll-loop's "not wrapped → not delivered"
// nudge (which runs once per `result`) then false-fired on intermediate
// narration and made the agent re-send its answer. See the "Turn-boundary
// delivery model" block on translateSdkMessages and the agent-loop docs:
// https://code.claude.com/docs/en/agent-sdk/agent-loop
//
// If any of these go red, something reintroduced per-AssistantMessage emission
// — do NOT "fix" the test by loosening the count; fix the emit logic.
describe('translateSdkMessages — duplicate-message regression (one result per turn)', () => {
  const am = (content: unknown[], parentToolUseId: string | null = null): SDKMessage =>
    ({
      type: 'assistant',
      message: { content },
      parent_tool_use_id: parentToolUseId,
      session_id: 'test-session',
    } as unknown as SDKMessage);
  const txt = (text: string) => am([{ type: 'text', text }]);
  const textTool = (text: string) =>
    am([{ type: 'text', text }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }]);
  const resultTexts = (events: ProviderEvent[]) =>
    events.flatMap((e) => (e.type === 'result' ? [e.text] : []));

  it('the live repro shape: bare narration mid-turn never becomes its own result', async () => {
    // Exactly the sequence captured live: a bare-text narration
    // AM, then a tool, then the final wrapped answer. The narration must NOT
    // produce a result (which would have false-fired the nudge); only the
    // final answer is delivered, once.
    const answer = '<message to="g">Перевірив все покроково: ...</message>';
    const events = await collect(
      iter([sysInit, txt('Now let me test the browser.'), textTool('checking…'), txt(answer), sysResultSuccess(answer)]),
    );
    expect(resultTexts(events)).toEqual([answer]);
  });

  it('multi-turn stream: each turn emits exactly one result, buffer resets between turns', async () => {
    // A warm container processes many turns in one stream. Turn N must not
    // leak its buffered text into turn N+1, and identical answers across turns
    // must each be delivered (cross-turn dedup would drop legit repeats).
    const events = await collect(
      iter([sysInit, txt('answer A'), sysResultSuccess('answer A'), txt('answer A'), sysResultSuccess('answer A')]),
    );
    expect(resultTexts(events)).toEqual(['answer A', 'answer A']);
  });

  it('empty ResultMessage.result after narration: recovers the ANSWER, not the narration', async () => {
    // The empty-RM SDK quirk (reason the AM-read exists) combined with mid-turn
    // narration: the buffered value must be the final answer, never an earlier
    // narration AM.
    const events = await collect(
      iter([sysInit, txt('thinking out loud'), textTool('searching…'), txt('the real answer'), sysResultSuccess('')]),
    );
    expect(resultTexts(events)).toEqual(['the real answer']);
  });

  it('turn with no text answer (tools / send_message only): a single result with null text', async () => {
    // The agent replied via send_message / only used tools. Exactly one result
    // event, carrying null — the poll-loop then delivers nothing and does not
    // nudge. Must not crash or emit extra events.
    const events = await collect(iter([sysInit, textTool('working…'), sysResultSuccess('')]));
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(resultTexts(events)).toEqual([null]);
  });
});
