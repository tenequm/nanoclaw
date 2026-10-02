/**
 * The worker's call bridge: ask_agent executions against a fake host, agent
 * replies against a fake AgentSession. The point is the no-answer-is-dropped
 * guarantee: an answer reaches the caller as the tool result or, when the
 * execution was interrupted or its output never confirmed, as a new turn.
 * The interruption case also runs through agents-js's own ToolExecutor and
 * RunContext, so the update() semantics are the framework's, not a mock's.
 */
import { initializeLogger, llm, voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANSWER_PREFIX, liveKitCallSecret, type LiveKitJobMetadata } from './channels/voice-livekit-protocol.js';
import {
  CallBridge,
  HostLink,
  HostMonitor,
  parseJobMetadata,
  probeHost,
  realtimeModelOptions,
  runCall,
  type CallJob,
  type CallSession,
  type SpeechSession,
} from './voice-livekit-worker.js';

initializeLogger({ pretty: false, level: 'error' });

interface FakeSession extends SpeechSession {
  replies: string[];
  idleWaits: number;
  agentState: string;
  userState: string;
  /** Errors the next generateReply calls fail with, in order (a handle whose exception() is set). */
  failures: unknown[];
  /** Runs inside each waitForIdle, to change the world while the bridge waits. */
  onIdleWait?: () => void;
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
    failures: [],
    async waitForIdle() {
      session.idleWaits++;
      session.onIdleWait?.();
    },
    generateReply({ instructions }) {
      session.replies.push(instructions);
      const error = session.failures.shift();
      let done!: () => void;
      const played = new Promise<void>((r) => (done = r));
      playouts.push(done);
      if (autoPlayout) done();
      return { waitForPlayout: () => played, exception: () => error };
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
    bridge.onHostEvent({ type: 'reply', text: 'Dentist at nine.', consultIds: ['c1'] });
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
    bridge.onHostEvent({ type: 'reply', text: 'Done.', consultIds: ['c1'] });
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
    await expect(result).resolves.toBeUndefined();
    bridge.onHostEvent({ type: 'reply', text: 'Booked for eight.', consultIds: ['c1'] });
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
    bridge.onHostEvent({ type: 'reply', text: 'Let me check.', consultIds: ['c1'] });
    expect(await result).toContain('Let me check.');
    bridge.onToolsExecuted(['call_1']);
    bridge.onHostEvent({ type: 'reply', text: 'It is sunny.' });
    await flush();
    expect(session.replies).toEqual([expect.stringContaining('It is sunny.')]);
  });

  it('settles the consults a batched reply names, and a timeout only its own', async () => {
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
    bridge.onHostEvent({ type: 'reply', text: TIMEOUT_LINE, timedOut: true, consultIds: ['c1'] });
    const timedOut = await a;
    expect(timedOut).toContain(TIMEOUT_LINE);
    expect(timedOut).not.toContain(`${ANSWER_PREFIX} (Andy)`);
    bridge.onHostEvent({ type: 'reply', text: 'Both done.', consultIds: ['c2', 'c3'] });
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
    const opts = { ctx: {}, toolCallId: 'fc_9', abortSignal: new AbortController().signal } as unknown as Parameters<
      typeof tool.execute
    >[1];
    await tool.execute({ request: 'hello' }, opts);
    expect(tool.name).toBe('ask_agent');
    expect(spy).toHaveBeenCalledWith('hello', 'fc_9', opts.abortSignal, opts.ctx);
  });

  it('settles replies by consult id, whatever order they arrive in', async () => {
    const bridge = new CallBridge(fakeSession(), fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
      confirmMs: 1000,
    });
    let aDone = false;
    const a = bridge.ask('first', 'a').then((v) => ((aDone = true), v));
    const b = bridge.ask('second', 'b');
    await flush();
    bridge.onHostEvent({ type: 'reply', text: 'Second answer.', consultIds: ['c2'] });
    expect(await b).toContain('Second answer.');
    await flush();
    expect(aDone).toBe(false);
    bridge.onHostEvent({ type: 'reply', text: 'First answer.', consultIds: ['c1'] });
    expect(await a).toContain('First answer.');
    bridge.close();
  });

  it('speaks the answer of an aborted execution as a new turn and keeps the others waiting', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
      confirmMs: 1000,
    });
    const abort = new AbortController();
    const a = bridge.ask('first', 'a', abort.signal);
    const b = bridge.ask('second', 'b');
    await flush();
    abort.abort();
    expect(await a).toBeUndefined();
    bridge.onHostEvent({ type: 'reply', text: 'First answer.', consultIds: ['c1'] });
    await flush();
    expect(session.replies).toEqual([expect.stringContaining('First answer.')]);
    bridge.onHostEvent({ type: 'reply', text: 'Second answer.', consultIds: ['c2'] });
    expect(await b).toContain('Second answer.');
    expect(session.replies).toHaveLength(1);
    bridge.close();
  });

  it('drops a holding line whose answer arrived while it waited for the session to go idle', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
      confirmMs: 1000,
    });
    const result = bridge.ask('q', 'a');
    await flush();
    session.onIdleWait = () => bridge.onHostEvent({ type: 'reply', text: 'Here it is.', consultIds: ['c1'] });
    bridge.onHostEvent({ type: 'thinking' });
    await flush();
    expect(await result).toContain('Here it is.');
    expect(session.replies).toEqual([]);
    bridge.close();
  });

  it('tries a failed turn once more, and gives up after that', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
    });
    session.failures.push(new Error('realtime session closed'));
    await bridge.speak('first');
    expect(session.replies).toEqual(['first', 'first']);
    session.failures.push(new Error('a'), new Error('b'));
    await bridge.speak('second');
    expect(session.replies).toEqual(['first', 'first', 'second', 'second']);
  });

  it('does not repeat a turn the model only started late, since the late generation is still spoken', async () => {
    const session = fakeSession();
    const warn = vi.fn();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
      log: { info: () => undefined, warn },
    });
    session.failures.push(new Error('generateReply timed out waiting for generation_created event.'));
    await bridge.speak('the answer');
    expect(session.replies).toEqual(['the answer']);
    expect(warn).toHaveBeenCalledWith(
      'voice bridge: the model started a turn late; not repeating it',
      expect.any(Error),
    );
    await bridge.speak('next');
    expect(session.replies).toEqual(['the answer', 'next']);
  });
});

describe('Gemini Live settings', () => {
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

/** The ToolExecutor every AgentActivity runs function tools through (agents-js does not export the class). */
interface ToolExecutorLike {
  execute(args: {
    tool: ReturnType<CallBridge['tool']>;
    runCtx: voice.RunContext;
    rawArguments: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
}

function realExecution(bridge: CallBridge, callId: string) {
  const executor = (llm.AsyncToolset.create({ id: 'test', tools: [] }) as unknown as { _executor: ToolExecutorLike })
    ._executor;
  const speechHandle = voice.SpeechHandle.create({ allowInterruptions: true });
  const functionCall = llm.FunctionCall.create({ callId, name: 'ask_agent', args: '{"request":"book a table"}' });
  const runCtx = new voice.RunContext({} as voice.AgentSession, speechHandle, functionCall);
  // The speech's tool task signal: agents-js aborts it 5 s after an interruption of that speech.
  const speechTask = new AbortController();
  const output = executor.execute({
    tool: bridge.tool(),
    runCtx,
    rawArguments: { request: 'book a table' },
    abortSignal: speechTask.signal,
  });
  return { output, speechHandle, functionCall, speechTask };
}

describe('ask_agent under agents-js interruptions (real ToolExecutor and RunContext)', () => {
  it('returns the answer as the tool output when the turn is not interrupted', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
    });
    const run = realExecution(bridge, 'fc_1');
    await flush();
    bridge.onHostEvent({ type: 'reply', text: 'Booked for eight.', consultIds: ['c1'] });
    expect(await run.output).toContain(`${ANSWER_PREFIX} (Andy): Booked for eight.`);
    expect(run.functionCall.extra.__livekit_agents_tool_non_blocking).toBeUndefined();
    bridge.close();
  });

  it('moves to the background on interruption, survives the later abort and speaks the answer as a new turn', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
    });
    const run = realExecution(bridge, 'fc_1');
    await flush();
    run.speechHandle.interrupt();
    // update() resolved the tool's output (Gemini's FunctionResponse for fc_1) with the holding note.
    const output = String(await run.output);
    expect(output).toContain('Andy is still working on this request');
    expect(output).toContain('The task is still running');
    expect(run.functionCall.extra.__livekit_agents_tool_non_blocking).toBe(true);
    // The speech's 5 s cancel no longer reaches the execution.
    run.speechTask.abort();
    await flush();
    bridge.onHostEvent({ type: 'reply', text: 'Booked for eight.', consultIds: ['c1'] });
    await flush();
    expect(session.replies).toEqual([expect.stringContaining(`${ANSWER_PREFIX} (Andy): Booked for eight.`)]);
    bridge.close();
  });

  it('still speaks the answer when the abort lands before any interruption was seen', async () => {
    const session = fakeSession();
    const bridge = new CallBridge(session, fakeHost(), {
      agentName: 'Andy',
      answerWaitMs: 60_000,
      timeoutLine: TIMEOUT_LINE,
    });
    const run = realExecution(bridge, 'fc_1');
    await flush();
    run.speechTask.abort();
    // The framework drops the output of an aborted execution: Gemini gets no FunctionResponse here.
    await expect(run.output).rejects.toThrow('tool call was aborted');
    await flush();
    bridge.onHostEvent({ type: 'reply', text: 'Booked for eight.', consultIds: ['c1'] });
    await flush();
    expect(session.replies).toEqual([expect.stringContaining('Booked for eight.')]);
    bridge.close();
  });
});

const META: LiveKitJobMetadata = {
  v: 1,
  callId: 'call-1',
  lineId: 'voice:abc',
  agentName: 'Andy',
  callerName: 'Ethan',
  callerIdentity: 'caller-1',
  instructions: 'You are Andy.',
  model: 'gemini-3.8-live',
  voice: 'Kore',
  scheduling: 'WHEN_IDLE',
  maxDurationMs: 60_000,
  delegationTimeoutMs: 1000,
  timeoutLine: TIMEOUT_LINE,
  joinTimeoutMs: 1000,
};

function fakeJob(meta: Record<string, unknown> = { ...META }) {
  const shutdownCallbacks: Array<() => Promise<void>> = [];
  const job = {
    job: { metadata: JSON.stringify(meta) },
    room: {},
    connect: vi.fn(async () => undefined),
    waitForParticipant: vi.fn(async () => ({})),
    deleteRoom: vi.fn(async () => undefined),
    shutdown: vi.fn(),
    addShutdownCallback: vi.fn((cb: () => Promise<void>) => shutdownCallbacks.push(cb)),
  };
  return { job, ctx: job as unknown as CallJob, shutdownCallbacks };
}

/** The host side over fetch: routes by path, an NDJSON event stream fed by `emit`. */
function fakeHostFetch(joinedStatus = 200) {
  const calls: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> | null }> = [];
  let push!: (line: string) => void;
  let endStream!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => controller.enqueue(new TextEncoder().encode(`${line}\n`));
      endStream = () => controller.close();
    },
  });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, auth, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (url.includes('/events')) return new Response(stream, { status: 200 });
    if (url.endsWith('/joined')) return new Response('{}', { status: joinedStatus });
    if (url.endsWith('/ask')) return new Response(JSON.stringify({ id: 'k1' }), { status: 202 });
    return new Response(null, { status: 204 });
  });
  return { fetchImpl, calls, emit: (e: unknown) => push(JSON.stringify(e)), endStream };
}

function fakeCallSession() {
  const listeners = new Map<string, (ev: unknown) => void>();
  const base = fakeSession();
  const session = Object.assign(base, {
    on: vi.fn((event: string, listener: (ev: unknown) => void) => listeners.set(event, listener)),
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listeners,
  });
  return session as typeof session & CallSession;
}

const ENV = {
  GEMINI_API_KEY: 'gk-test',
  LIVEKIT_API_SECRET: 'lk-secret',
  LIVEKIT_HOST_URL: 'http://127.0.0.1:3555',
};
const silentLog = { info: () => undefined, warn: () => undefined };

describe('runCall', () => {
  it('runs a call: caller joins, host says yes, Gemini starts, host events are spoken, host end closes all', async () => {
    const { job, ctx } = fakeJob({ ...META, hostUrl: 'http://169.254.169.254', secret: 'from-dispatch' });
    const host = fakeHostFetch();
    const session = fakeCallSession();
    const createSession = vi.fn(() => session);
    await runCall(ctx, { env: ENV, fetchImpl: host.fetchImpl, createSession, log: silentLog });

    expect(job.waitForParticipant).toHaveBeenCalledWith('caller-1');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-1' }), 'gk-test');
    expect(session.start).toHaveBeenCalledWith(
      expect.objectContaining({ inputOptions: { participantIdentity: 'caller-1', closeOnDisconnect: true } }),
    );
    expect(session.replies).toEqual(['The call just connected. Greet the caller briefly.']);
    // The host address and secret come from the worker's settings, never from the dispatch.
    const secret = liveKitCallSecret('lk-secret', 'call-1');
    for (const call of host.calls) {
      expect(call.url.startsWith('http://127.0.0.1:3555/webhook/voice/livekit/agent/')).toBe(true);
      expect(call.auth).toBe(`Bearer ${secret}`);
    }

    host.emit({ type: 'say', text: 'Your taxi is here.' });
    await vi.waitFor(() => expect(session.replies).toHaveLength(2));
    expect(session.replies[1]).toContain('Your taxi is here.');

    host.emit({ type: 'end', reason: 'hangup' });
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('host: hangup'));
    expect(session.close).toHaveBeenCalled();
    expect(job.deleteRoom).toHaveBeenCalled();
    // The host ended it, so the worker does not report back.
    expect(host.calls.some((c) => c.url.endsWith('/ended'))).toBe(false);
  });

  it('names the host URL when the host is unreachable at join', async () => {
    const { job, ctx } = fakeJob();
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await runCall(ctx, { env: ENV, fetchImpl, createSession: vi.fn(), log: { info: () => undefined, warn } });
    expect(warn).toHaveBeenCalledWith('voice worker: ending the call', {
      callId: 'call-1',
      hostUrl: 'http://127.0.0.1:3555',
      reason: 'host refused the call (unreachable)',
    });
    expect(job.shutdown).toHaveBeenCalledWith('host refused the call (unreachable)');
  });

  it('opens no Gemini session when the host refuses the call', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch(409);
    const createSession = vi.fn(() => fakeCallSession());
    await runCall(ctx, { env: ENV, fetchImpl: host.fetchImpl, createSession, log: silentLog });
    expect(createSession).not.toHaveBeenCalled();
    expect(host.calls.at(-1)).toMatchObject({ body: { callId: 'call-1', reason: 'host refused the call (409)' } });
    expect(job.deleteRoom).toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('host refused the call (409)');
  });

  it('ends the call when the caller never joins', async () => {
    const { job, ctx } = fakeJob({ ...META, joinTimeoutMs: 20 });
    job.waitForParticipant.mockImplementation(() => new Promise(() => undefined));
    const host = fakeHostFetch();
    const createSession = vi.fn(() => fakeCallSession());
    await runCall(ctx, { env: ENV, fetchImpl: host.fetchImpl, createSession, log: silentLog });
    expect(createSession).not.toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('caller never joined');
  });

  it('refuses to start without the LiveKit secret it derives the host credential from', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch();
    await runCall(ctx, {
      env: { ...ENV, LIVEKIT_API_SECRET: undefined },
      fetchImpl: host.fetchImpl,
      createSession: vi.fn(),
      log: silentLog,
    });
    expect(job.connect).not.toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('LIVEKIT_API_SECRET is not set for the worker');
  });

  it('reports the end to the host when the host link drops', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch();
    await runCall(ctx, { env: ENV, fetchImpl: host.fetchImpl, createSession: () => fakeCallSession(), log: silentLog });
    host.endStream();
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('host link closed'));
    expect(host.calls.at(-1)).toMatchObject({ body: { reason: 'host link closed' } });
  });
});

describe('host probe', () => {
  const HOST = 'http://127.0.0.1:3555';

  it("takes the host's 404 for an uncredentialed events request as a running voice host", async () => {
    const fetchImpl = vi.fn(async () => new Response('No such call', { status: 404 }));
    expect(await probeHost(HOST, fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(`${HOST}/webhook/voice/livekit/agent/events`, expect.anything());
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });

  it('names what is wrong otherwise', async () => {
    const status = (code: number) => async () => new Response('', { status: code });
    expect(
      await probeHost(HOST, async () => {
        throw new TypeError('fetch failed');
      }),
    ).toBe('is unreachable (fetch failed)');
    expect(await probeHost(HOST, status(403))).toContain('GPT_LIVE_ALLOW_NON_LOOPBACK');
    expect(await probeHost(HOST, status(503))).toContain('not running');
    expect(await probeHost(HOST, status(200))).toContain('not a NanoClaw voice host');
  });

  it('logs the URL, reports an unreachable host once with the fix, and re-probes until it answers', async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const fetchImpl = vi.fn(async () => {
        if (!up) throw new TypeError('fetch failed');
        return new Response('', { status: 404 });
      });
      const log = { info: vi.fn(), error: vi.fn() };
      const monitor = new HostMonitor(HOST, log, fetchImpl, 30_000);
      expect(await monitor.start()).toBe(false);
      expect(log.info).toHaveBeenCalledWith(`voice worker: host URL ${HOST}`);
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error.mock.calls[0][0]).toContain(HOST);
      expect(log.error.mock.calls[0][0]).toContain('set LIVEKIT_HOST_URL in .env');
      expect(monitor.down).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(log.error).toHaveBeenCalledTimes(1);

      up = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.down).toBe(false);
      expect(log.info).toHaveBeenLastCalledWith(`voice worker: the host at ${HOST} answers again`);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one probe between concurrent checks', async () => {
    let answer!: (res: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (answer = r)));
    const monitor = new HostMonitor(HOST, { info: () => undefined, error: () => undefined }, fetchImpl);
    const first = monitor.check();
    const second = monitor.check();
    answer(new Response('', { status: 404 }));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
