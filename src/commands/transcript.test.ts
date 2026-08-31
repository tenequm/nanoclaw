import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A temp sessions base so the transcript reader globs a controlled tree. The
// session -> sdk-id mapping (outbound.db) is not exercised here: we drive the
// newest-.jsonl fallback (sessionId = null) to test the JSONL parser directly.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-transcript-'));

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../session-manager.js', () => ({
  sessionsBaseDir: () => TMP,
  outboundDbPath: (agentGroupId: string, sessionId: string) => path.join(TMP, agentGroupId, sessionId, 'outbound.db'),
  openOutboundDb: () => {
    throw new Error('outbound.db not used in this test');
  },
}));

import { readTranscriptStats } from './transcript.js';

const AGENT = 'ag-x';

function assistant(id: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', message: { id, usage } });
}

beforeAll(() => {
  const dir = path.join(TMP, AGENT, '.claude-shared', 'projects', '-workspace-agent');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    assistant('msg_a', {
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
      output_tokens: 20,
    }),
    // Duplicate of msg_a (the SDK log repeats identical id lines) - must NOT double-count.
    assistant('msg_a', {
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
      output_tokens: 20,
    }),
    // An assistant line with no usage is skipped.
    JSON.stringify({ type: 'assistant', message: { id: 'msg_x' } }),
    assistant('msg_b', {
      input_tokens: 20,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 0,
      output_tokens: 30,
    }),
    '', // trailing blank line
  ];
  fs.writeFileSync(path.join(dir, 'feea4a69-72ab-4b6d-a34f-0c9f50726549.jsonl'), lines.join('\n'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readTranscriptStats', () => {
  it('accumulates output + turns and dedupes by message.id, context = last turn', () => {
    const stats = readTranscriptStats(AGENT, null);
    expect(stats).not.toBeNull();
    if (!stats) throw new Error('expected stats');
    // msg_a counted once + msg_b -> 2 turns.
    expect(stats.turns).toBe(2);
    // output = 20 (msg_a) + 30 (msg_b).
    expect(stats.outputTokens).toBe(50);
    // context = last unique turn (msg_b): 20 + 200 + 0.
    expect(stats.contextTokens).toBe(220);
  });

  it('returns null for a group with no transcript tree', () => {
    expect(readTranscriptStats('no-such-group', null)).toBeNull();
  });
});
