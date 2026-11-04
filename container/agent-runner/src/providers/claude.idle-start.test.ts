import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A voice call starts the agent before its first turn: the query opens idle and the turn is pushed later.

let prompts: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: unknown }) => {
    prompts.push(args.prompt);
    return (async function* () {})();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  prompts = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-idle-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('claude provider, started ahead of a voice call', () => {
  it('opens an idle query: nothing is sent until the first turn is pushed', async () => {
    const provider = createProvider('claude', {});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    expect(provider.startsIdle).toBe(true);
    const q = provider.query({ prompt: '', continuation: 'sess-a', cwd: tmp });
    expect(prompts).toHaveLength(1);
    const stream = (prompts[0] as AsyncIterable<{ message: { content: string } }>)[Symbol.asyncIterator]();
    const first = stream.next();
    const early = await Promise.race([first.then(() => 'sent'), new Promise((r) => setTimeout(() => r('idle'), 50))]);
    expect(early).toBe('idle');
    q.push('first turn');
    expect((await first).value?.message.content).toBe('first turn');
    q.abort();
  });
});
