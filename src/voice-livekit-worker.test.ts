/**
 * The walkie-talkie worker: the walkie rules (turn order, reply gating, thinking, failure
 * lines) against fake host and voice, the Gemini retry wrappers against fake streams, the
 * text helpers, and runCall end to end with a fake room and session. The LiveKit session,
 * Silero and Gemini themselves are not loaded here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initializeLogger, tokenize } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  type LiveKitJobMetadata,
} from './channels/voice-livekit-protocol.js';
import {
  AWAIT_REPLY_MS,
  FAILURE_LINES,
  GeminiTranscribeSTT,
  HostLink,
  hostLossReason,
  interactionText,
  languageOf,
  MAX_IDLE_WAIT_MS,
  MAX_VOCABULARY_TERMS,
  parseJobMetadata,
  pathSegment,
  pruneRecordings,
  readJobHeader,
  recordingDays,
  runCall,
  speakableText,
  sttVocabulary,
  TURN_SETTLE_MS,
  TurnCapture,
  Walkie,
  writeTurnRecording,
  type CallJob,
  type CallVoice,
  type CallVoiceEvents,
  type TurnAudio,
  type TurnRecord,
  type TurnTake,
  type VoiceSettings,
  type WalkieDeps,
} from './voice-livekit-worker.js';

initializeLogger({ pretty: false, level: 'error' });

const flush = () => new Promise((r) => setTimeout(r, 5));
const SILENCE = 2500;

afterEach(() => {
  vi.useRealTimers();
});

describe('speakable text', () => {
  it('strips markdown, links, URLs, code and markup to sentences', () => {
    const md = [
      '# Plan',
      'Here is **the plan** for _today_:',
      '- Call [Anna](https://t.me/anna) at ten',
      '1. Check https://example.com/x?y=1 later',
      '```ts',
      'const x = 1;',
      '```',
      'Use `ncl` then <b>rest</b>.',
      '| a | b |',
      '|---|---|',
      '> quoted line',
      '---',
      'snake_case_name stays.',
    ].join('\n');
    expect(speakableText(md)).toBe(
      'Plan. Here is the plan for today: Call Anna at ten. Check later. Use ncl then rest. a, b. quoted line. snake_case_name stays.',
    );
  });

  it('keeps comparisons, decimals and abbreviations as written', () => {
    expect(speakableText('Version 2.4 costs 3.50 dollars, e.g. cheap. If x < 5 and y > 3 then ok.')).toBe(
      'Version 2.4 costs 3.50 dollars, e.g. cheap. If x < 5 and y > 3 then ok.',
    );
    expect(speakableText('Use <code class="x">this</code> or <br/> that')).toBe('Use this or that.');
  });

  it('reaches the TTS in sentence batches that keep decimals and abbreviations whole', async () => {
    // The tokenizer the session's StreamAdapter batches with.
    const stream = new tokenize.basic.SentenceTokenizer({
      minTokenLength: 250,
      maxTokenLength: 400,
      firstTokenLength: 20,
    }).stream();
    const text = `Version 2.4 costs 3.50 dollars, e.g. cheap. ${'Then more words follow here. '.repeat(20)}`;
    stream.pushText(text);
    stream.endInput();
    const tokens: string[] = [];
    for await (const ev of stream) tokens.push(ev.token);
    expect(tokens[0]).toBe('Version 2.4 costs 3.50 dollars, e.g. cheap.');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.length).toBeLessThan(6);
    expect(tokens.every((t) => t.length <= 400)).toBe(true);
    expect(tokens.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });
});

describe('helpers', () => {
  it('names why the host did not take a turn', () => {
    expect(hostLossReason({ accepted: false, status: 429 })).toBe('rate_limited');
    expect(hostLossReason({ accepted: false, status: 409 })).toBe('rejected');
    expect(hostLossReason({ accepted: false, error: 'The operation was aborted due to timeout' })).toBe('timeout');
  });

  it('reads the language of a transcript from its script', () => {
    expect(languageOf('Привіт, як справи?')).toBe('uk');
    expect(languageOf('check the grafana logs')).toBe('en');
    expect(languageOf('1, 2, 3')).toBeUndefined();
  });

  it('dedupes the vocabulary and caps it with a warning', () => {
    const warn = vi.fn();
    expect(sttVocabulary([' grafana ', 'Grafana', 'NanoClaw', '', 'nanoclaw'], { warn })).toEqual([
      'grafana',
      'NanoClaw',
    ]);
    expect(warn).not.toHaveBeenCalled();
    const many = Array.from({ length: 130 }, (_, i) => `term${i}`);
    const capped = sttVocabulary(many, { warn });
    expect(capped).toHaveLength(MAX_VOCABULARY_TERMS);
    expect(capped[0]).toBe('term0');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

function audioFrames(ms: number, value = 0) {
  const samples = (16 * ms) | 0;
  return new AudioFrame(new Int16Array(samples).fill(value), 16_000, 1, samples);
}

describe('GeminiTranscribeSTT', () => {
  const answer = {
    steps: [
      {
        content: [
          { type: 'thought', text: 'x' },
          { type: 'text', text: 'Привіт, grafana' },
        ],
      },
    ],
  };

  it('sends the speech as WAV to the unary model, verbatim, with languages and vocabulary', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(answer));
    const onRequest = vi.fn();
    const unary = new GeminiTranscribeSTT({
      apiKey: 'gk',
      model: 'gemini-3.5-transcribe',
      vocabulary: ['grafana'],
      shouldServe: () => true,
      onRequest,
      fetchImpl,
    });
    const ev = await unary.recognize([audioFrames(100), audioFrames(100)]);
    expect(ev.alternatives?.[0]?.text).toBe('Привіт, grafana');
    expect(ev.alternatives?.[0]?.language).toBe('uk');
    expect(onRequest).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('gk');
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: Array<{ type: string; data: string; mime_type: string }>;
      generation_config: unknown;
    };
    expect(body.model).toBe('gemini-3.5-transcribe');
    expect(body.generation_config).toEqual({
      transcription_config: { language_codes: ['uk-UA', 'en-US'], custom_vocabulary: ['grafana'], mode: 'verbatim' },
    });
    expect(body.input[0]).toMatchObject({ type: 'audio', mime_type: 'audio/wav' });
    const wav = Buffer.from(body.input[0].data, 'base64');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.length).toBe(44 + 2 * 3200);
  });

  it('sends nothing while the streaming transcription works, and reports refusals', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: 'quota' } }, { status: 429 }));
    let serve = false;
    const unary = new GeminiTranscribeSTT({
      apiKey: 'gk',
      model: 'gemini-3.5-transcribe',
      vocabulary: [],
      shouldServe: () => serve,
      fetchImpl,
    });
    expect((await unary.recognize(audioFrames(100))).alternatives?.[0]?.text).toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
    serve = true;
    await expect(unary.recognize(audioFrames(100))).rejects.toThrow('Gemini transcribe: 429 quota');
  });

  it('reads the text parts of an Interactions answer', () => {
    expect(interactionText(answer)).toBe('Привіт, grafana');
    expect(interactionText(null)).toBe('');
  });
});

function fakeWalkieDeps(overrides: Partial<WalkieDeps> = {}) {
  const said: string[] = [];
  const sent: string[] = [];
  const statuses: boolean[] = [];
  const deps: WalkieDeps = {
    send: vi.fn(async (text: string) => {
      sent.push(text);
      return { accepted: true, id: String(sent.length) };
    }),
    say: vi.fn(async (text: string) => {
      said.push(text);
      return true;
    }),
    setThinking: (thinking) => statuses.push(thinking),
    log: { info: () => undefined, warn: () => undefined },
    ...overrides,
  };
  return { deps, said, sent, statuses };
}

describe('Walkie', () => {
  it('sends turns in order and shows thinking until a reply, then speaks it as plain text', async () => {
    vi.useFakeTimers();
    const { deps, said, sent, statuses } = fakeWalkieDeps();
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    const results: unknown[] = [];
    walkie.onTurn('book a table', (r) => results.push(r));
    walkie.onTurn('for two');
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['book a table', 'for two']);
    expect(results).toEqual([{ accepted: true, id: '1' }]);
    expect(statuses).toEqual([false, true]);
    walkie.onReply('**Booked** for [eight](https://x.y).');
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toEqual(['Booked for eight.']);
    expect(statuses.at(-1)).toBe(false);
  });

  it('drops thinking after a while without typing ticks, and holds it while they come', async () => {
    vi.useFakeTimers();
    const { deps, statuses } = fakeWalkieDeps();
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    walkie.onTurn('thanks');
    await vi.advanceTimersByTimeAsync(AWAIT_REPLY_MS - 1000);
    walkie.onThinking();
    await vi.advanceTimersByTimeAsync(5000);
    expect(statuses.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(statuses.at(-1)).toBe(false);
  });

  it('holds a reply while the caller talks and until their turn could still be committed', async () => {
    vi.useFakeTimers();
    const { deps, said } = fakeWalkieDeps();
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    walkie.onCallerSpeaking(true);
    walkie.onReply('First.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(said).toEqual([]);
    walkie.onCallerSpeaking(false);
    await vi.advanceTimersByTimeAsync(SILENCE);
    expect(said).toEqual([]);
    // The committed turn frees the channel at once.
    walkie.onTurn('and another thing');
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toEqual(['First.']);

    // A caller who stops and never gets a turn committed (a cough) frees it after the settle time.
    walkie.onCallerSpeaking(true);
    walkie.onCallerSpeaking(false);
    walkie.onReply('Second.');
    await vi.advanceTimersByTimeAsync(SILENCE + TURN_SETTLE_MS - 10);
    expect(said).toEqual(['First.']);
    await vi.advanceTimersByTimeAsync(20);
    expect(said).toEqual(['First.', 'Second.']);
  });

  it('lets a reply take the channel from a caller who never stops', async () => {
    vi.useFakeTimers();
    const { deps, said } = fakeWalkieDeps();
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    walkie.onCallerSpeaking(true);
    walkie.onReply('Done.');
    await vi.advanceTimersByTimeAsync(SILENCE + MAX_IDLE_WAIT_MS - 10);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(said).toEqual(['Done.']);
  });

  it("says it didn't catch a turn the host refused or the STT lost, in the caller's language, once", async () => {
    const { deps, said } = fakeWalkieDeps({ send: async () => ({ accepted: false, status: 429 }) });
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    walkie.onTurnLost('no transcript');
    walkie.onTurnLost('no transcript');
    await walkie.idle();
    expect(said).toEqual([FAILURE_LINES.turn.uk]);
    walkie.onTurn('what about the logs');
    await walkie.idle();
    expect(said).toEqual([FAILURE_LINES.turn.uk, FAILURE_LINES.turn.en]);
  });

  it('says so when a reply could not be synthesized, and keeps speaking after a failure', async () => {
    const said: string[] = [];
    let calls = 0;
    const { deps } = fakeWalkieDeps({
      say: async (text) => {
        calls++;
        if (calls === 1) return false;
        if (calls === 3) throw new Error('room gone');
        said.push(text);
        return true;
      },
    });
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'en' });
    walkie.onReply('Reply one.');
    await walkie.idle();
    expect(said).toEqual([FAILURE_LINES.reply.en]);
    walkie.onReply('Reply two.');
    walkie.onReply('Reply three.');
    await walkie.idle();
    expect(said).toEqual([FAILURE_LINES.reply.en, 'Reply three.']);
  });

  it('stays silent once closed', async () => {
    const { deps, said, sent } = fakeWalkieDeps();
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    walkie.close();
    walkie.onTurn('hello');
    walkie.onReply('Hi.');
    walkie.onTurnLost('x');
    await walkie.idle();
    expect(sent).toEqual([]);
    expect(said).toEqual([]);
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
});

const META: LiveKitJobMetadata = {
  v: LIVEKIT_PROTOCOL_VERSION,
  callId: 'call-1',
  lineId: 'voice:abc',
  agentName: 'Andy',
  callerName: 'Ethan',
  callerIdentity: 'caller-1',
  vocabulary: ['NanoClaw'],
  sttModel: 'gemini-3.5-transcribe-live',
  sttFallbackModel: 'gemini-3.5-transcribe',
  ttsModel: 'gemini-3.8-flash-tts',
  ttsFallbackModel: 'gemini-3.8-flash-lite-tts',
  ttsVoice: 'Alnilam',
  silenceMs: 2500,
  maxDurationMs: 60_000,
  joinTimeoutMs: 1000,
};

describe('job metadata', () => {
  it('takes only a walkie-talkie call of this version as a call to run', () => {
    expect(() => parseJobMetadata('{}')).toThrow();
    expect(() => parseJobMetadata('not json')).toThrow();
    expect(() => parseJobMetadata(JSON.stringify({ ...META, v: 2 }))).toThrow();
    expect(parseJobMetadata(JSON.stringify(META)).callId).toBe('call-1');
  });

  it('reads enough of any version to answer it', () => {
    expect(readJobHeader(JSON.stringify({ ...META, v: 2 }))).toEqual({
      v: 2,
      callId: 'call-1',
      callerIdentity: 'caller-1',
      agentName: 'Andy',
    });
    expect(() => readJobHeader(JSON.stringify({ v: 2 }))).toThrow();
  });
});

function fakeJob(meta: Record<string, unknown> = { ...META }) {
  const roomHandlers = new Map<string, (p: { identity: string }) => void>();
  const job = {
    job: { metadata: JSON.stringify(meta) },
    room: { on: vi.fn((event: string, fn: (p: { identity: string }) => void) => roomHandlers.set(event, fn)) },
    connect: vi.fn(async () => undefined),
    waitForParticipant: vi.fn(async () => ({ identity: 'caller-1' })),
    deleteRoom: vi.fn(async () => undefined),
    shutdown: vi.fn(),
    addShutdownCallback: vi.fn(),
  };
  return { job, ctx: job as unknown as CallJob, roomHandlers };
}

/** The host over fetch: routes by path, an NDJSON event stream fed by `emit`. */
function fakeHostFetch(joinedStatus = 200, utteranceStatus = 202) {
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
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, auth, body });
    if (url.includes('/events')) return new Response(stream, { status: 200 });
    if (url.endsWith('/joined')) return new Response('{}', { status: joinedStatus });
    if (url.endsWith('/utterance')) return new Response(JSON.stringify({ id: '1' }), { status: utteranceStatus });
    return new Response(null, { status: 204 });
  });
  return { fetchImpl, calls, emit: (e: unknown) => push(JSON.stringify(e)), endStream };
}

function fakeVoice() {
  let events!: CallVoiceEvents;
  const voice = {
    say: vi.fn(async (_text: string) => true),
    setThinking: vi.fn(),
    publishTurn: vi.fn(),
    close: vi.fn(async () => undefined),
  } satisfies CallVoice;
  const createVoice = vi.fn(
    async (_ctx: CallJob, _meta: LiveKitJobMetadata, _settings: VoiceSettings, e: CallVoiceEvents) => {
      events = e;
      return voice;
    },
  );
  return {
    voice,
    createVoice,
    get events() {
      return events;
    },
  };
}

const ENV = {
  GEMINI_API_KEY: 'gk-test',
  LIVEKIT_API_SECRET: 'lk-secret',
  LIVEKIT_HOST_URL: 'http://127.0.0.1:3555',
};
const silentLog = { info: () => undefined, warn: () => undefined };
const deps = (fetchImpl: typeof fetch, createVoice: ReturnType<typeof fakeVoice>['createVoice'], extra = {}) => ({
  env: ENV as Record<string, string | undefined>,
  fetchImpl,
  createVoice,
  markUpdating: vi.fn(async () => undefined),
  log: silentLog,
  ...extra,
});

describe('runCall', () => {
  it('runs a call: caller joins, host says yes, turns go out, replies are spoken, host end closes all', async () => {
    const { job, ctx } = fakeJob({ ...META, hostUrl: 'http://169.254.169.254', secret: 'from-dispatch' });
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));

    expect(job.waitForParticipant).toHaveBeenCalledWith('caller-1');
    expect(v.createVoice).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ callId: 'call-1' }),
      { geminiKey: 'gk-test', record: false },
      v.events,
    );
    // The host address and secret come from the worker's settings, never from the dispatch.
    const secret = liveKitCallSecret('lk-secret', 'call-1');
    for (const call of host.calls) {
      expect(call.url.startsWith('http://127.0.0.1:3555/webhook/voice/livekit/agent/')).toBe(true);
      expect(call.auth).toBe(`Bearer ${secret}`);
    }

    v.events.onTurn('Book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(host.calls.find((c) => c.url.endsWith('/utterance'))?.body).toEqual({
        callId: 'call-1',
        text: 'Book a table',
      }),
    );
    expect(v.voice.setThinking).toHaveBeenCalledWith(true);
    expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 1, status: 'sent', text: 'Book a table' });

    host.emit({ type: 'reply', text: 'Booked for eight.' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked for eight.'));

    host.emit({ type: 'end', reason: 'hangup' });
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('host: hangup'));
    expect(v.voice.close).toHaveBeenCalled();
    expect(job.deleteRoom).toHaveBeenCalled();
    // The host ended it, so the worker does not report back.
    expect(host.calls.some((c) => c.url.endsWith('/ended'))).toBe(false);
  });

  it('speaks the lost-turn line when the host refuses a turn', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch(200, 429);
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    v.events.onTurn('Привіт', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith(FAILURE_LINES.turn.uk));
    expect(v.voice.publishTurn).toHaveBeenCalledWith({
      turn: 1,
      status: 'lost',
      reason: 'rate_limited',
      text: 'Привіт',
    });
    v.events.onTurnLost('stt', { speechMs: 1200 }, { sttModel: 'gemini-3.5-transcribe-live' });
    expect(v.voice.publishTurn).toHaveBeenLastCalledWith({ turn: 2, status: 'lost', reason: 'stt' });
  });

  it('names the host URL when the host is unreachable at join', async () => {
    const { job, ctx } = fakeJob();
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const v = fakeVoice();
    await runCall(ctx, deps(fetchImpl, v.createVoice, { log: { info: () => undefined, warn } }));
    expect(warn).toHaveBeenCalledWith('voice worker: ending the call', {
      callId: 'call-1',
      hostUrl: 'http://127.0.0.1:3555',
      reason: 'host refused the call (unreachable)',
    });
    expect(job.shutdown).toHaveBeenCalledWith('host refused the call (unreachable)');
  });

  it('starts no session when the host refuses the call', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch(409);
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    expect(v.createVoice).not.toHaveBeenCalled();
    expect(host.calls.at(-1)).toMatchObject({ body: { callId: 'call-1', reason: 'host refused the call (409)' } });
    expect(job.deleteRoom).toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('host refused the call (409)');
  });

  it('ends the call when the caller never joins', async () => {
    const { job, ctx } = fakeJob({ ...META, joinTimeoutMs: 20 });
    job.waitForParticipant.mockImplementation(() => new Promise(() => undefined));
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    expect(v.createVoice).not.toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('caller never joined');
  });

  it('refuses to start without the LiveKit secret it derives the host credential from', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice, { env: { ...ENV, LIVEKIT_API_SECRET: undefined } }));
    expect(job.connect).not.toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('LIVEKIT_API_SECRET is not set for the worker');
  });

  it('records each turn with its outcome once the host answered, when recordings are on', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-rec-'));
    try {
      const { ctx } = fakeJob();
      const host = fakeHostFetch();
      const v = fakeVoice();
      await runCall(
        ctx,
        deps(host.fetchImpl, v.createVoice, {
          env: { ...ENV, WALKIE_RECORDINGS_DAYS: '7' },
          recordingsRoot: root,
        }),
      );
      expect(v.createVoice.mock.calls[0][2]).toMatchObject({ record: true });
      const audio = (startedAt: number, sttModel = 'gemini-3.5-transcribe-live'): TurnTake => ({
        audio: {
          pcm: new Int16Array(1600),
          sampleRate: 16_000,
          startedAt,
          endedAt: startedAt + 100,
          speechMs: 80,
          truncated: false,
        },
        sttModel,
      });
      const at = Date.UTC(2026, 9, 2, 12, 0, 0);
      v.events.onTurn('Book a table', audio(at));
      v.events.onTurnLost('empty', { speechMs: 900 }, audio(at + 1000, 'gemini-3.5-transcribe'));
      v.events.onTurnDropped(audio(at + 2000));
      const dir = path.join(root, 'Andy', '2026-10-02');
      await vi.waitFor(() => expect(fs.readdirSync(dir).sort()).toHaveLength(6));
      const first = JSON.parse(fs.readFileSync(path.join(dir, 'call-1-1.json'), 'utf8')) as TurnRecord;
      expect(first).toMatchObject({
        callId: 'call-1',
        lineId: 'voice:abc',
        agent: 'Andy',
        turn: 1,
        startedAt: '2026-10-02T12:00:00.000Z',
        sttModel: 'gemini-3.5-transcribe-live',
        transcript: 'Book a table',
        host: { accepted: true, status: 202, id: '1' },
      });
      const lost = JSON.parse(fs.readFileSync(path.join(dir, 'call-1-2.json'), 'utf8')) as TurnRecord;
      expect(lost).toMatchObject({ turn: 2, transcript: '', reason: 'empty', sttModel: 'gemini-3.5-transcribe' });
      const noise = JSON.parse(fs.readFileSync(path.join(dir, 'call-1-3.json'), 'utf8')) as TurnRecord;
      expect(noise).toMatchObject({ turn: 3, reason: 'noise' });
      expect(fs.readFileSync(path.join(dir, 'call-1-1.wav')).subarray(0, 4).toString()).toBe('RIFF');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('tells the page it is updating when the host speaks another version, then lets the host end it', async () => {
    vi.useFakeTimers();
    const { job, ctx } = fakeJob({ ...META, v: 2 });
    const host = fakeHostFetch();
    const v = fakeVoice();
    const d = deps(host.fetchImpl, v.createVoice);
    const done = runCall(ctx, d);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(d.markUpdating).toHaveBeenCalledWith(ctx);
    expect(v.createVoice).not.toHaveBeenCalled();
    expect(host.calls.at(-1)).toMatchObject({
      url: 'http://127.0.0.1:3555/webhook/voice/livekit/agent/ended',
      body: { callId: 'call-1', reason: `protocol mismatch: host sent v2, worker speaks v${LIVEKIT_PROTOCOL_VERSION}` },
    });
    expect(job.shutdown).toHaveBeenCalled();
  });

  it('reports the end to the host when the host link drops, the caller leaves or the session closes', async () => {
    const first = fakeJob();
    const host = fakeHostFetch();
    await runCall(first.ctx, deps(host.fetchImpl, fakeVoice().createVoice));
    host.endStream();
    await vi.waitFor(() => expect(first.job.shutdown).toHaveBeenCalledWith('host link closed'));
    expect(host.calls.at(-1)).toMatchObject({ body: { reason: 'host link closed' } });

    const second = fakeJob();
    await runCall(second.ctx, deps(fakeHostFetch().fetchImpl, fakeVoice().createVoice));
    second.roomHandlers.get('participantDisconnected')?.({ identity: 'caller-1' });
    await vi.waitFor(() => expect(second.job.shutdown).toHaveBeenCalledWith('caller left'));

    const third = fakeJob();
    const v = fakeVoice();
    await runCall(third.ctx, deps(fakeHostFetch().fetchImpl, v.createVoice));
    v.events.onClosed('session closed: error');
    await vi.waitFor(() => expect(third.job.shutdown).toHaveBeenCalledWith('session closed: error'));
    await flush();
  });
});

describe('turn recordings', () => {
  const frame = (value: number, ms: number) => {
    const samples = (16 * ms) | 0;
    return new AudioFrame(new Int16Array(samples).fill(value), 16_000, 1, samples);
  };

  it('captures a turn from just before the speech to just after it, and starts over', () => {
    let now = 10_000;
    const capture = new TurnCapture(() => now);
    expect(capture.take()).toBeUndefined();
    for (let i = 0; i < 10; i++) capture.push(frame(1, 100)); // a second of quiet: only 300 ms kept
    capture.onSpeaking(true);
    for (let i = 0; i < 5; i++) capture.push(frame(9, 100));
    capture.push(frame(1, 550)); // the VAD ends speech after this much silence
    capture.onSpeaking(false);
    for (let i = 0; i < 25; i++) capture.push(frame(1, 100)); // the silence that ends the turn
    now = 20_000;
    const audio = capture.take()!;
    expect(audio.sampleRate).toBe(16_000);
    expect(audio.pcm.length).toBe(16 * (300 + 500 + 300));
    expect(audio.speechMs).toBe(500);
    expect(audio.startedAt).toBe(10_000 - 300);
    expect(audio.endedAt).toBe(10_000 - 300 + 1100);
    expect(audio.pcm[16 * 300]).toBe(9);
    expect(capture.take()).toBeUndefined();
  });

  it('turns any input rate into 16 kHz', () => {
    const capture = new TurnCapture();
    capture.onSpeaking(true);
    for (let i = 0; i < 10; i++) {
      capture.push(new AudioFrame(new Int16Array(480).fill(5), 48_000, 1, 480));
    }
    const audio = capture.take()!;
    // 100 ms in; the resampler holds a little back until more audio comes.
    expect(audio.pcm.length).toBeGreaterThan(900);
    expect(audio.pcm.length).toBeLessThanOrEqual(1600);
  });

  it('writes owner-only files under agent and day, and prunes old ones with their empty folders', async () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-rec-')), 'voice-recordings');
    try {
      const record: TurnRecord = {
        callId: 'c/../1',
        lineId: 'voice:abc',
        agent: '../Andy Bot',
        turn: 2,
        startedAt: '2026-10-02T12:00:00.000Z',
        endedAt: '2026-10-02T12:00:01.000Z',
        speechMs: 700,
        truncated: false,
        sttModel: 'gemini-3.5-transcribe-live',
        transcript: 'hello',
        host: { accepted: true, id: '4', status: 202 },
      };
      const audio: TurnAudio = {
        pcm: new Int16Array(16_000),
        sampleRate: 16_000,
        startedAt: 0,
        endedAt: 1000,
        speechMs: 700,
        truncated: false,
      };
      const base = await writeTurnRecording(root, record, audio);
      expect(base).toBe(path.join(root, 'Andy-Bot', '2026-10-02', 'c-1-2'));
      expect(fs.statSync(`${base}.wav`).mode & 0o777).toBe(0o600);
      expect(fs.statSync(`${base}.json`).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(base)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(`${base}.wav`).size).toBe(44 + 32_000);
      expect(JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'))).toEqual(record);

      const fresh = await writeTurnRecording(
        root,
        { ...record, turn: 3, startedAt: '2026-10-09T12:00:00.000Z' },
        audio,
      );
      const old = Date.now() / 1000 - 10 * 86_400;
      fs.utimesSync(`${base}.wav`, old, old);
      fs.utimesSync(`${base}.json`, old, old);
      expect(await pruneRecordings(root, 7)).toBe(2);
      expect(fs.existsSync(path.dirname(base))).toBe(false);
      expect(fs.existsSync(`${fresh}.wav`)).toBe(true);
      expect(fs.existsSync(root)).toBe(true);
      expect(await pruneRecordings(path.join(root, 'missing'), 7)).toBe(0);
    } finally {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it('reads the retention setting, off unless a positive whole number of days', () => {
    expect(recordingDays(undefined)).toBe(0);
    expect(recordingDays('')).toBe(0);
    expect(recordingDays('0')).toBe(0);
    expect(recordingDays('-3')).toBe(0);
    expect(recordingDays('1.5')).toBe(0);
    expect(recordingDays(' 14 ')).toBe(14);
    expect(pathSegment('..')).toBe('unnamed');
  });
});
