import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A compact_boundary SDK event must never surface as a `result` provider
// event. The poll loop treats result text as the agent's turn output: a
// synthetic "Context compacted." result has no <message> block, so it fires
// the "response was not delivered — please re-send" nudge and the agent
// duplicates its previous message (observed live: compaction completing at
// turn end produced a doubled reply).

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compact-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('compact_boundary translation', () => {
  it('yields activity, not a result, for compaction; real results still pass through', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 132642 } },
      { type: 'result', subtype: 'success', result: '<message to="user">hello</message>' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('<message to="user">hello</message>');
    // No result event may carry the compaction notice.
    expect(results.some((e) => (e.text ?? '').includes('Context compacted'))).toBe(false);
    // Compaction still registers as activity (heartbeat) alongside the per-message activity events.
    expect(events.filter((e) => e.type === 'activity').length).toBeGreaterThanOrEqual(3);
  });
});

describe('task_started translation', () => {
  it('yields task-started for a background task and progress for its notification', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'task_started', task_id: 't1', description: 'sleep 45; date' },
      { type: 'result', subtype: 'success', result: '<message to="user">on it</message>' },
      { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done' },
      { type: 'result', subtype: 'success', result: '<message to="user">finished</message>' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; description?: string; message?: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string; description?: string; message?: string });

    const started = events.filter((e) => e.type === 'task-started');
    expect(started).toHaveLength(1);
    expect(started[0]!.description).toBe('sleep 45; date');
    expect(events.filter((e) => e.type === 'progress').map((e) => e.message)).toEqual(['done']);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(2);
  });
});
