import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A voice call starts the agent before its first turn: the query opens idle, and the prompt cache is
// warmed by a forked, unpersisted request that is cut off at its first event.

interface SdkCall {
  prompt: unknown;
  options: Record<string, unknown> & { abortController?: AbortController };
}
let calls: SdkCall[] = [];
let warmEvents: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: SdkCall) => {
    calls.push(args);
    if (typeof args.prompt !== 'string') return (async function* () {})();
    return (async function* () {
      for (const event of warmEvents) yield event;
    })();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

const HOUR = 3_600_000;
let tmp: string;
let prevHome: string | undefined;
let prevConfig: string | undefined;

const messageStart = {
  type: 'stream_event',
  event: { type: 'message_start', message: { usage: { cache_creation_input_tokens: 9, cache_read_input_tokens: 1 } } },
};

/** A transcript whose last response wrote the cache `agoMs` ago, into the given bucket. */
function transcript(sessionId: string, agoMs: number, bucket: '1h' | '5m'): void {
  const dir = path.join(tmp, '.claude', 'projects', '-workspace-agent');
  fs.mkdirSync(dir, { recursive: true });
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const usage = (ms: number) => ({
    cache_creation: {
      ephemeral_1h_input_tokens: bucket === '1h' ? ms : 0,
      ephemeral_5m_input_tokens: bucket === '5m' ? ms : 0,
    },
  });
  const lines = [
    { type: 'user', timestamp: at(agoMs + 9000), message: { role: 'user', content: 'hi' } },
    { type: 'assistant', timestamp: at(agoMs + 5000), message: { usage: usage(100) } },
    { type: 'assistant', timestamp: at(agoMs), message: { usage: usage(50) } },
    { type: 'system', timestamp: at(agoMs - 1000), subtype: 'turn_duration' },
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function provider() {
  const p = createProvider('claude', {});
  p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return p;
}

const input = (continuation?: string) => ({
  prompt: '',
  continuation,
  cwd: tmp,
  systemContext: { instructions: '# You are Ada' },
});

beforeEach(() => {
  calls = [];
  warmEvents = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-warm-'));
  prevHome = process.env.HOME;
  prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = prevConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('claude provider, started ahead of a voice call', () => {
  it('opens an idle query: nothing is sent until the first turn is pushed', async () => {
    const q = provider().query(input('sess-a'));
    const stream = (calls[0].prompt as AsyncIterable<{ message: { content: string } }>)[Symbol.asyncIterator]();
    const first = stream.next();
    const early = await Promise.race([first.then(() => 'sent'), new Promise((r) => setTimeout(() => r('idle'), 50))]);
    expect(early).toBe('idle');
    q.push('first turn');
    expect((await first).value?.message.content).toBe('first turn');
    q.abort();
  });

  it('warms an expired cache with the exact options of a turn, forked, unpersisted and cut off at the first event', async () => {
    transcript('sess-a', 2 * HOUR, '1h');
    warmEvents = [{ type: 'system', subtype: 'init', session_id: 'fork' }, messageStart, { type: 'assistant' }];
    const p = provider();
    await p.warmPromptCache!(input('sess-a'));
    p.query({ ...input('sess-a'), prompt: 'turn' });
    expect(calls).toHaveLength(2);
    const [warm, turn] = calls;
    expect(typeof warm.prompt).toBe('string');
    const { forkSession, persistSession, abortController, hooks, ...warmOptions } = warm.options;
    const { hooks: turnHooks, ...turnOptions } = turn.options;
    // Everything that shapes the request matches the turn's, so the turn reads what the warm wrote.
    expect(warmOptions).toEqual(turnOptions);
    expect(warmOptions.resume).toBe('sess-a');
    expect({ forkSession, persistSession }).toEqual({ forkSession: true, persistSession: false });
    expect(abortController?.signal.aborted).toBe(true);
    // Its only hook refuses every tool; the turn's own hooks (tool state, pre-compact archive) are not run.
    expect(Object.keys(hooks as object)).toEqual(['PreToolUse']);
    expect(Object.keys(turnHooks as object)).toContain('PreCompact');
  });

  it('skips the warm while the cache the last response wrote is still warm', async () => {
    transcript('sess-1h', 20 * 60_000, '1h');
    await provider().warmPromptCache!(input('sess-1h'));
    expect(calls).toHaveLength(0);

    // A 5-minute cache written 20 minutes ago has expired.
    transcript('sess-5m', 20 * 60_000, '5m');
    warmEvents = [messageStart];
    await provider().warmPromptCache!(input('sess-5m'));
    expect(calls).toHaveLength(1);
  });

  it('does not warm a new session, and stops at a compaction instead of paying for it', async () => {
    await provider().warmPromptCache!(input(undefined));
    expect(calls).toHaveLength(0);

    transcript('sess-full', 2 * HOUR, '1h');
    warmEvents = [{ type: 'system', subtype: 'status', status: 'compacting' }, messageStart];
    await provider().warmPromptCache!(input('sess-full'));
    expect(calls).toHaveLength(1);
    expect(calls[0].options.abortController?.signal.aborted).toBe(true);
  });
});
