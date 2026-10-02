/**
 * The worker's call bridge: ask_agent executions against a fake host, agent
 * replies against a fake AgentSession. The point is the no-answer-is-dropped
 * guarantee: an answer reaches the caller as the tool result or, when the
 * execution was interrupted or its output never confirmed, as a new turn.
 */
import { initializeLogger } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANSWER_PREFIX,
  CallBridge,
  HostLink,
  parseJobMetadata,
  realtimeModelOptions,
  type SpeechSession,
} from './voice-livekit-worker.js';

interface FakeSession extends SpeechSession {
  replies: string[];
  idleWaits: number;
  agentState: string;
  userState: string;
  /** Resolves the playout of the reply at this index. */
  finishPlayout(i: number): void;
}

function fakeSession(autoPlayout = true): FakeSession {
  const playouts: Array<() => void> = [];
  const session: FakeSession = {
    replies: [],
    idleWaits: 0,
    agentState: 'listening',
    userState: 'listening',
    async waitForIdle() {
      session.idleWaits++;
    },
    generateReply({ instructions }) {
      session.replies.push(instructions);
      let done!: () => void;
      const played = new Promise<void>((r) => (done = r));
      playouts.push(done);
      if (autoPlayout) done();
      return { waitForPlayout: () => played };
    },
    finishPlayout: (i) => playouts[i](),
  };
  return session;
}

function fakeHost(status = 202) {
  const asks: string[] = [];
  return {
    asks,
    post: vi.fn(async (_path: string, body: Record<string, unknown> = {}) => {
      asks.push(String(body.request));
      return new Response(JSON.stringify({ id: `c${asks.length}` }), { status });
    }),
  };
}

const TIMEOUT_LINE = "This is taking longer than expected, I'll tell you as soon as it's done.";
const flush = () => new Promise((r) => setTimeout(r, 5));

describe('CallBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the first agent reply as the tool result, confirmed by the framework', async () => {
    const session = fakeSession();
    const host = fakeHost();
    const bridge = new CallBridge(session, host, {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
      confirmMs: 50,
    });
    const result = bridge.ask('What is on my calendar?', 'call_1');
    await flush();
    expect(host.post).toHaveBeenCalledWith('ask', { request: 'What is on my calendar?' });
    bridge.onHostEvent({ type: 'reply', text: 'Dentist at nine.' });
    const answer = await result;
    expect(answer).toContain(`${ANSWER_PREFIX} (Andy): Dentist at nine.`);
    bridge.onToolsExecuted(['call_1']);
    await new Promise((r) => setTimeout(r, 80));
    expect(session.replies).toEqual([]);
  });

  it('speaks the answer as a new turn when the tool output never reached the model', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
      confirmMs: 20,
    });
    const result = bridge.ask('q', 'call_1');
    await flush();
    bridge.onHostEvent({ type: 'reply', text: 'Done.' });
    await result;
    await new Promise((r) => setTimeout(r, 60));
    expect(session.replies).toHaveLength(1);
    expect(session.replies[0]).toContain('Done.');
  });

  it('keeps the answer when the execution is interrupted and speaks it once idle', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
    });
    const abort = new AbortController();
    const result = bridge.ask('book a table', 'call_1', abort.signal);
    await flush();
    abort.abort();
    await expect(result).resolves.toBe('');
    bridge.onHostEvent({ type: 'reply', text: 'Booked for eight.' });
    await flush();
    expect(session.idleWaits).toBe(1);
    expect(session.replies).toEqual([expect.stringContaining(`${ANSWER_PREFIX} (Andy): Booked for eight.`)]);
  });

  it('speaks interim and extra replies that no execution is waiting for', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
      confirmMs: 1000,
    });
    const result = bridge.ask('q', 'call_1');
    await flush();
    bridge.onHostEvent({ type: 'reply', text: 'Let me check.' });
    expect(await result).toContain('Let me check.');
    bridge.onToolsExecuted(['call_1']);
    bridge.onHostEvent({ type: 'reply', text: 'It is sunny.' });
    await flush();
    expect(session.replies).toEqual([expect.stringContaining('It is sunny.')]);
  });

  it('settles every waiting execution with a batched reply, and a timeout only its own', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
      confirmMs: 1000,
    });
    const a = bridge.ask('first', 'a');
    const b = bridge.ask('second', 'b');
    const c = bridge.ask('third', 'c');
    await flush();
    bridge.onHostEvent({ type: 'reply', text: TIMEOUT_LINE, timedOut: true });
    const timedOut = await a;
    expect(timedOut).toContain(TIMEOUT_LINE);
    expect(timedOut).not.toContain(`${ANSWER_PREFIX} (Andy)`);
    bridge.onHostEvent({ type: 'reply', text: 'Both done.' });
    expect(await b).toContain('Both done.');
    expect(await c).toContain('Answered together');
    bridge.close();
  });

  it('serializes spoken turns so one never supersedes another', async () => {
    const session = fakeSession(false);
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
    });
    bridge.onHostEvent({ type: 'say', text: 'Your taxi is here.' });
    bridge.onHostEvent({ type: 'reply', text: 'Unasked answer.' });
    await flush();
    expect(session.replies).toHaveLength(1);
    expect(session.replies[0]).toContain('not an answer to a question');
    session.finishPlayout(0);
    await flush();
    expect(session.replies).toHaveLength(2);
    session.finishPlayout(1);
  });

  it('adds a holding line only into silence while an answer is pending', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
    });
    bridge.onHostEvent({ type: 'thinking' });
    await flush();
    expect(session.replies).toEqual([]);
    void bridge.ask('q', 'a');
    await flush();
    session.userState = 'speaking';
    bridge.onHostEvent({ type: 'thinking' });
    await flush();
    expect(session.replies).toEqual([]);
    session.userState = 'listening';
    bridge.onHostEvent({ type: 'thinking' });
    await flush();
    expect(session.replies).toEqual([expect.stringContaining('still working')]);
    bridge.close();
  });

  it('tells the model when the host refuses the request', async () => {
    const bridge = (status: number) =>
      new CallBridge(fakeSession(), fakeHost(status), {
        agentName: 'Andy',
        answerWaitMs: 60_000,
        timeoutLine: TIMEOUT_LINE,
      });
    expect(await bridge(429).ask('q', 'a')).toContain('already open');
    expect(await bridge(413).ask('q', 'a')).toContain('too long');
    expect(await bridge(409).ask('q', 'a')).toContain('cannot take requests');
    expect(await bridge(202).ask('x'.repeat(5000), 'a')).toContain('too long');
  });

  it('exposes ask_agent as a tool that passes the call id through', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
    });
    const tool = bridge.tool();
    const spy = vi.spyOn(bridge, 'ask').mockResolvedValue('ok');
    const opts = { toolCallId: 'fc_9', abortSignal: new AbortController().signal } as unknown as Parameters<
      typeof tool.execute
    >[1];
    await tool.execute({ request: 'hello' }, opts);
    expect(spy).toHaveBeenCalledWith('hello', 'fc_9', opts.abortSignal);
  });
});

describe('Gemini Live settings', () => {
  initializeLogger({ pretty: false, level: 'warn' });

  it('builds the google RealtimeModel without thinkingConfig, NON_BLOCKING and WHEN_IDLE', () => {
    const model = new google.realtime.RealtimeModel(
      realtimeModelOptions(
        { model: 'gemini-3.8-live', voice: 'Kore', instructions: 'You are Andy.', scheduling: 'WHEN_IDLE' },
        'gk-test',
      ),
    );
    const options = (model as unknown as { _options: Record<string, unknown> })._options;
    expect(options.model).toBe('gemini-3.8-live');
    expect(options.voice).toBe('Kore');
    expect(options.thinkingConfig).toBeUndefined();
    expect(options.toolBehavior).toBe(google.realtime.Behavior.NON_BLOCKING);
    expect(options.toolResponseScheduling).toBe(google.realtime.FunctionResponseScheduling.WHEN_IDLE);
    expect(options.inputAudioTranscription).toEqual({});
    expect(options.outputAudioTranscription).toEqual({});
  });

  it('leaves response scheduling out for models that reject it', () => {
    const options = realtimeModelOptions(
      { model: 'gemini-3.8-live-extended-thinking', voice: 'Kore', instructions: '', scheduling: null },
      'gk-test',
    );
    expect(options).not.toHaveProperty('toolResponseScheduling');
  });
});

describe('HostLink', () => {
  it('reads NDJSON events split across chunks and authenticates with the call secret', async () => {
    const lines = ['{"type":"reply","te', 'xt":"hi"}\n{"type":"ping"}\n', '{"type":"end","reason":"hangup"}\n'];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const l of lines) controller.enqueue(new TextEncoder().encode(l));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const link = new HostLink({ hostUrl: 'http://127.0.0.1:3001', secret: 's3cret', callId: 'c1' }, fetchImpl);
    const events: unknown[] = [];
    await link.events((e) => events.push(e), new AbortController().signal);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:3001/webhook/voice/livekit/agent/events?call=c1');
    expect(events).toEqual([{ type: 'reply', text: 'hi' }, { type: 'ping' }, { type: 'end', reason: 'hangup' }]);
  });

  it('rejects job metadata that is not a voice call', () => {
    expect(() => parseJobMetadata('{}')).toThrow();
    expect(() => parseJobMetadata('not json')).toThrow();
  });
});
