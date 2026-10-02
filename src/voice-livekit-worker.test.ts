/**
 * The walkie-talkie worker: the walkie rules (turn order, reply gating, thinking, failure
 * lines) against fake host and voice, the unary Gemini transcription against a fake fetch, the
 * text helpers, and runCall end to end with a fake room and session. The LiveKit session,
 * Silero and Gemini themselves are not loaded here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  APIConnectionError,
  APIStatusError,
  initializeLogger,
  normalizeLanguage,
  stt,
  tokenize,
  tts,
  type APIConnectOptions,
  type VAD,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  type LiveKitJobMetadata,
} from './channels/voice-livekit-protocol.js';
import {
  AWAIT_REPLY_MS,
  capSpokenText,
  CUT_LINES,
  DEFAULT_MAX_SPOKEN_CHARS,
  FAILURE_LINES,
  GeminiTranscribeSTT,
  HostLink,
  hostLossReason,
  interactionText,
  languageOf,
  MAX_IDLE_WAIT_MS,
  maxSpokenChars,
  parseJobMetadata,
  PacedTTS,
  pathSegment,
  pruneRecordings,
  readJobHeader,
  recordingDays,
  REPLY_CHUNKS,
  runCall,
  SendCountdown,
  speakableText,
  TTS_CONCURRENCY,
  TtsFallback,
  TURN_SETTLE_MS,
  TurnCapture,
  Walkie,
  walkieSession,
  writeTurnRecording,
  type CallJob,
  type CallVoice,
  type CallVoiceEvents,
  type TurnAudio,
  type TurnRecord,
  type TurnTake,
  type SendResult,
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
    const stream = new tokenize.basic.SentenceTokenizer(REPLY_CHUNKS).stream();
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
    expect(hostLossReason({ accepted: false, status: 422 })).toBe('rejected');
    expect(hostLossReason({ accepted: false, status: 500 })).toBe('rejected');
    expect(hostLossReason({ accepted: false, status: 504 })).toBe('timeout');
    expect(hostLossReason({ accepted: false, error: 'The operation was aborted due to timeout' })).toBe('timeout');
  });

  it('cuts long spoken text at the last sentence end within the cap and says the rest is in the chat', () => {
    const rest = CUT_LINES.chat;
    expect(capSpokenText('Short. Fine.', 20, 'en', true)).toBe('Short. Fine.');
    expect(capSpokenText('x'.repeat(5000), 0, 'en', true)).toBe('x'.repeat(5000));
    const text = 'First one here. Second sentence is right here! Third goes past the cap.';
    expect(capSpokenText(text, 50, 'en', true)).toBe(`First one here. Second sentence is right here! ${rest.en}`);
    // A sentence end that would need the character past the cap does not count.
    expect(capSpokenText('Aaaa bbbb. Cccc dddd.', 10, 'uk', true)).toBe(`Aaaa bbbb. ${rest.uk}`);
    expect(capSpokenText('Aaaa bbbb. Cccc dddd.', 9, 'uk', true)).toBe(`Aaaa… ${rest.uk}`);
    // Decimals are not sentence ends; with none before the cap the cut is at a word, never inside one.
    expect(capSpokenText('Version 2.4 of the release, with many words', 30, 'en', true)).toBe(
      `Version 2.4 of the release… ${rest.en}`,
    );
    expect(capSpokenText('Слово слово слово слово', 13, 'uk', true)).toBe(`Слово слово… ${rest.uk}`);
    expect(capSpokenText('a'.repeat(30), 10, 'en', true)).toBe(rest.en);
    expect(rest).toEqual({ uk: 'Решта - у чаті.', en: 'The rest is in the chat.' });
  });

  it('cuts at a word instead of a sentence end that would drop most of the budget', () => {
    const long = `Ок. ${'дуже довге речення '.repeat(60)}`;
    const spoken = capSpokenText(long, 800, 'uk', true);
    expect(spoken).toMatch(/^Ок\. дуже довге речення .*\S… Решта - у чаті\.$/);
    expect(spoken.length).toBeGreaterThan(780);
    // Past 60% of the cap, the sentence end still wins.
    expect(capSpokenText('Aaaa bbbb ccc. Dddd eeee ffff gggg.', 20, 'en', true)).toBe(
      `Aaaa bbbb ccc. ${CUT_LINES.chat.en}`,
    );
    expect(capSpokenText('Aaaa. Bbbb cccc dddd eeee ffff gggg.', 20, 'en', true)).toBe(
      `Aaaa. Bbbb cccc dddd… ${CUT_LINES.chat.en}`,
    );
  });

  it('closes a cut without pointing at a chat when the call has none', () => {
    expect(capSpokenText('Aaaa bbbb. Cccc dddd.', 10, 'en', false)).toBe(`Aaaa bbbb. ${CUT_LINES.no_chat.en}`);
    expect(capSpokenText('Слово слово слово слово', 13, 'uk', false)).toBe(`Слово слово… ${CUT_LINES.no_chat.uk}`);
    expect(CUT_LINES.no_chat).toEqual({ uk: 'Скорочую.', en: "I've cut it short." });
  });

  it('reads WALKIE_MAX_SPOKEN_CHARS, with 0 for no cap', () => {
    expect(maxSpokenChars(undefined)).toBe(DEFAULT_MAX_SPOKEN_CHARS);
    expect(DEFAULT_MAX_SPOKEN_CHARS).toBe(800);
    expect(maxSpokenChars(' 400 ')).toBe(400);
    expect(maxSpokenChars('0')).toBe(0);
    expect(maxSpokenChars('-5')).toBe(DEFAULT_MAX_SPOKEN_CHARS);
    expect(maxSpokenChars('lots')).toBe(DEFAULT_MAX_SPOKEN_CHARS);
  });

  it('reads the language of a transcript from its script', () => {
    expect(languageOf('Привіт, як справи?')).toBe('uk');
    expect(languageOf('check the grafana logs')).toBe('en');
    expect(languageOf('1, 2, 3')).toBeUndefined();
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

  it('sends nothing while the streaming transcription works, reports refusals, and backs off when rate limited', async () => {
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
    expect((await unary.recognize(audioFrames(100))).alternatives?.[0]?.text).toBe('');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it("caps every spoken message, closing in the caller's latest language", async () => {
    vi.useFakeTimers();
    const { deps, said } = fakeWalkieDeps();
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk', maxSpokenChars: 20 });
    walkie.onTurn('what is new');
    await vi.advanceTimersByTimeAsync(SILENCE + TURN_SETTLE_MS);
    walkie.onReply('Two things now. A **third** one that is long.');
    walkie.onReply('Fits.');
    await vi.advanceTimersByTimeAsync(1);
    // No `chat` event yet: the call talks on the voice line, where no chat holds the rest.
    expect(said).toEqual([`Two things now. ${CUT_LINES.no_chat.en}`, 'Fits.']);
    walkie.onChat(true);
    walkie.onReply('Two things now. A third one that is long.');
    await vi.advanceTimersByTimeAsync(1);
    expect(said.at(-1)).toBe(`Two things now. ${CUT_LINES.chat.en}`);
    const uncapped = new Walkie(deps, { silenceMs: SILENCE, language: 'uk', maxSpokenChars: 0 });
    uncapped.onReply('Two things. A third one that is long.');
    await vi.advanceTimersByTimeAsync(1);
    expect(said.at(-1)).toBe('Two things. A third one that is long.');
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

  it("says it didn't catch a turn the STT lost, in the caller's language, once", async () => {
    const { deps, said } = fakeWalkieDeps();
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    walkie.onTurnLost('empty');
    walkie.onTurnLost('empty');
    await walkie.idle();
    expect(said).toEqual([FAILURE_LINES.turn.uk]);
    walkie.onTurnLost('stt');
    await walkie.idle();
    expect(said).toEqual([FAILURE_LINES.turn.uk, FAILURE_LINES.turn.uk]);
  });

  it("never asks to repeat a turn the host refused or did not confirm, in the caller's language", async () => {
    const answers: SendResult[] = [
      { accepted: false, status: 429 },
      { accepted: false, status: 422 },
      { accepted: false, status: 504 },
      { accepted: false, error: 'The operation was aborted due to timeout' },
      { accepted: false, status: 504 },
    ];
    const { deps, said } = fakeWalkieDeps({ send: async () => answers.shift() ?? { accepted: true } });
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    for (const text of ['what about the logs', 'and the disk', 'а диск', 'і пам’ять']) {
      walkie.onTurn(text);
      await walkie.idle();
    }
    walkie.onChat(true);
    walkie.onTurn('а мережа');
    await walkie.idle();
    expect(said).toEqual([
      FAILURE_LINES.rate_limited.en,
      FAILURE_LINES.rejected.en,
      // On the voice line no chat shows the turn, so the line does not send the caller to one.
      FAILURE_LINES.timeout_no_chat.uk,
      FAILURE_LINES.timeout_no_chat.uk,
      FAILURE_LINES.timeout.uk,
    ]);
    expect(FAILURE_LINES.timeout).toEqual({
      uk: 'Не впевнений, що це дійшло - перевір чат.',
      en: 'Not sure that got through - check the chat.',
    });
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

  it('describes each line before it is spoken: the turn it answers, unprompted, or its own notice', async () => {
    vi.useFakeTimers();
    const announced: unknown[] = [];
    const { deps, said } = fakeWalkieDeps({
      announce: (info) => announced.push({ ...info, before: said.length }),
    });
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'en' });
    walkie.onReply('One.', 3);
    walkie.onReply('Two.', 3);
    walkie.onReply('Three.', null);
    await walkie.idle();
    walkie.onTurnLost('stt');
    await walkie.idle();
    expect(said).toEqual(['One.', 'Two.', 'Three.', FAILURE_LINES.turn.en]);
    expect(announced).toEqual([
      // Queued together, so each but the last knows another line follows it.
      { reply: 1, turn: 3, part: 1, more: true, before: 0 },
      { reply: 2, turn: 3, part: 2, more: true, before: 1 },
      { reply: 3, unprompted: true, before: 2 },
      { reply: 4, notice: true, before: 3 },
    ]);
  });

  it('stays silent once closed', async () => {
    const { deps, said, sent } = fakeWalkieDeps();
    const walkie = new Walkie(deps, { silenceMs: SILENCE, language: 'uk' });
    walkie.close();
    walkie.onTurn('hello');
    walkie.onReply('Hi.');
    walkie.onTurnLost('empty');
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
    room: {
      on: vi.fn((event: string, fn: (p: { identity: string }) => void) => roomHandlers.set(event, fn)),
      remoteParticipants: new Map([['caller-1', {}]]),
    },
    connect: vi.fn(async () => undefined),
    waitForParticipant: vi.fn(async () => ({ identity: 'caller-1' })),
    deleteRoom: vi.fn(async () => undefined),
    shutdown: vi.fn(),
    addShutdownCallback: vi.fn(),
  };
  return { job, ctx: job as unknown as CallJob, roomHandlers, room: job.room };
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
    publishReply: vi.fn(),
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
        turnKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    expect(v.voice.setThinking).toHaveBeenCalledWith(true);
    expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 1, status: 'sent', text: 'Book a table' });

    host.emit({ type: 'reply', text: 'Booked for eight.', turn: null });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked for eight.'));
    // It answers no turn: a message nobody asked for, and the page is told so first.
    expect(v.voice.publishReply).toHaveBeenCalledWith({ reply: 1, unprompted: true });

    host.emit({ type: 'end', reason: 'hangup' });
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('host: hangup'));
    expect(v.voice.close).toHaveBeenCalled();
    expect(job.deleteRoom).toHaveBeenCalled();
    // The host ended it, so the worker does not report back.
    expect(host.calls.some((c) => c.url.endsWith('/ended'))).toBe(false);
  });

  it('tells the page which of its turns a reply answers, by the host id each sent turn got', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    // A noise is turn 1 here (it is recorded), so the host's first turn is this worker's second.
    v.events.onTurnDropped({ sttModel: 'gemini-3.5-transcribe-live' });
    v.events.onTurn('Book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 2, status: 'sent', text: 'Book a table' }),
    );
    host.emit({ type: 'reply', text: 'Checking.', turn: '1' });
    host.emit({ type: 'reply', text: 'Booked.', turn: '1' });
    host.emit({ type: 'reply', text: 'Answer to a turn this worker never sent.', turn: '9' });
    host.emit({ type: 'reply', text: 'From a host that names no turns.' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledTimes(4));
    expect(v.voice.publishReply.mock.calls.map(([{ more: _more, ...info }]) => info)).toEqual([
      { reply: 1, turn: 2, part: 1 },
      { reply: 2, turn: 2, part: 2 },
      // Not known here, so not labelled at all: never a guessed link.
      { reply: 3 },
      { reply: 4 },
    ]);
    host.endStream();
  });

  it('speaks the lost-turn line when the host refuses a turn', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch(200, 429);
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    v.events.onTurn('Привіт', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith(FAILURE_LINES.rate_limited.uk));
    expect(v.voice.publishTurn).toHaveBeenCalledWith({
      turn: 1,
      status: 'lost',
      reason: 'rate_limited',
      text: 'Привіт',
    });
    v.events.onTurnLost('stt', { speechMs: 1200 }, { sttModel: 'gemini-3.5-transcribe-live' });
    expect(v.voice.publishTurn).toHaveBeenLastCalledWith({ turn: 2, status: 'lost', reason: 'stt' });
  });

  it('marks a timed-out turn sent once the host says it was stored after all, and points at the chat once there is one', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch(200, 504);
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    v.events.onTurn('Book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({
        turn: 1,
        status: 'lost',
        reason: 'timeout',
        text: 'Book a table',
      }),
    );
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith(FAILURE_LINES.timeout_no_chat.en));
    const turnKey = host.calls.find((c) => c.url.endsWith('/utterance'))?.body?.turnKey;
    // Another worker's key, or one already settled, changes nothing.
    host.emit({ type: 'turn-stored', turnKey: 'not-ours', id: '7' });
    host.emit({ type: 'turn-stored', turnKey, id: '1' });
    host.emit({ type: 'turn-stored', turnKey, id: '1' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenLastCalledWith({ turn: 1, status: 'sent', text: 'Book a table' }),
    );
    expect(v.voice.publishTurn).toHaveBeenCalledTimes(2);
    // The late turn's answer is labelled with it.
    host.emit({ type: 'reply', text: 'Booked.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked.'));
    expect(v.voice.publishReply).toHaveBeenLastCalledWith(expect.objectContaining({ turn: 1, part: 1 }));

    host.emit({ type: 'chat', chat: true });
    v.events.onTurn('And a taxi', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith(FAILURE_LINES.timeout.en));
    host.endStream();
  });

  it('posts a turn once more under the same key when the connection drops, but not after a timeout', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    let failures = [new TypeError('fetch failed')] as Error[];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const failure = String(input).endsWith('/utterance') && failures.shift();
      if (failure) {
        host.calls.push({ url: String(input), auth: undefined, body: JSON.parse(String(init?.body)) });
        throw failure;
      }
      return host.fetchImpl(input, init);
    });
    const v = fakeVoice();
    await runCall(ctx, deps(fetchImpl, v.createVoice));
    v.events.onTurn('Book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 1, status: 'sent', text: 'Book a table' }),
    );
    const posts = host.calls.filter((c) => c.url.endsWith('/utterance'));
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual(posts[0].body);

    failures = [new DOMException('The operation was aborted due to timeout', 'TimeoutError')];
    v.events.onTurn('And a taxi', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({
        turn: 2,
        status: 'lost',
        reason: 'timeout',
        text: 'And a taxi',
      }),
    );
    expect(host.calls.filter((c) => c.url.endsWith('/utterance'))).toHaveLength(3);
    // A different turn, a different key.
    expect(host.calls.at(-1)?.body?.turnKey).not.toBe(posts[0].body?.turnKey);
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

  it('ends the call when the caller left while it was being set up', async () => {
    const { job, ctx, room } = fakeJob();
    room.remoteParticipants.clear();
    const host = fakeHostFetch();
    await runCall(ctx, deps(host.fetchImpl, fakeVoice().createVoice));
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('caller left'));
    expect(host.calls.some((c) => c.url.endsWith('/ended'))).toBe(true);
  });

  it('ends a job of this version that is not a whole walkie-talkie call, and tells the host', async () => {
    const { job, ctx } = fakeJob({ ...META, agentName: '' });
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    expect(v.createVoice).not.toHaveBeenCalled();
    expect(host.calls.at(-1)?.url.endsWith('/ended')).toBe(true);
    expect(job.deleteRoom).toHaveBeenCalled();
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

  it('keeps the host link open until the host answered that the call ended', async () => {
    // Closed first, the host ends the call on its own and answers at once, before the room says why.
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch();
    let link: AbortSignal | undefined;
    let openWhenEnded: boolean | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/events')) link = init?.signal ?? undefined;
      if (url.endsWith('/ended')) openWhenEnded = !!link && !link.aborted;
      return host.fetchImpl(input, init);
    });
    const v = fakeVoice();
    await runCall(ctx, deps(fetchImpl as typeof fetch, v.createVoice));
    await vi.waitFor(() => expect(link).toBeDefined());
    v.events.onClosed('session closed: error');
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('session closed: error'));
    expect(openWhenEnded).toBe(true);
    expect(link?.aborted).toBe(true);
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

/** A streaming STT whose streams the test fails, feeds or closes. */
class ControlledSTT extends stt.STT {
  readonly streams: ControlledStream[] = [];
  constructor(readonly label: string) {
    super({ streaming: true, interimResults: false });
  }
  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('not used');
  }
  stream(options?: { connOptions?: APIConnectOptions }): ControlledStream {
    const stream = new ControlledStream(this, options?.connOptions);
    this.streams.push(stream);
    return stream;
  }
}

class ControlledStream extends stt.SpeechStream {
  label = 'controlled';
  private finish!: (err?: Error) => void;
  private readonly done = new Promise<Error | undefined>((resolve) => (this.finish = resolve));
  constructor(owner: stt.STT, connOptions?: APIConnectOptions) {
    super(owner, undefined, connOptions);
  }
  say(text: string): void {
    this.queue.put({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text, language: normalizeLanguage('en'), startTime: 0, endTime: 1, confidence: 1 }],
    });
  }
  fail(): void {
    this.finish(new APIConnectionError({ message: 'down' }));
  }
  protected async run(): Promise<void> {
    void (async () => {
      for await (const _ of this.input);
      this.finish();
    })();
    this.abortSignal.addEventListener('abort', () => this.finish(), { once: true });
    const err = await this.done;
    if (err) throw err;
  }
}

/** A TTS that counts the syntheses running at once; text that `fails` fails for good. */
class CountingTTS extends tts.TTS {
  label = 'counting';
  running = 0;
  maxRunning = 0;
  readonly started: string[] = [];
  constructor(readonly fails: (text: string) => boolean = () => false) {
    super(24_000, 1, { streaming: false });
  }
  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new CountingStream(this, text, connOptions, abortSignal);
  }
  stream(): tts.SynthesizeStream {
    throw new Error('not used');
  }
}

class CountingStream extends tts.ChunkedStream {
  label = 'counting';
  constructor(
    private readonly owner: CountingTTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, owner, connOptions, abortSignal);
  }
  protected async run(): Promise<void> {
    const owner = this.owner;
    owner.started.push(this.inputText);
    owner.maxRunning = Math.max(owner.maxRunning, ++owner.running);
    try {
      await new Promise((r) => setTimeout(r, 10));
      if (owner.fails(this.inputText)) {
        throw new APIStatusError({ message: 'refused', options: { statusCode: 400, retryable: false } });
      }
      const frame = new AudioFrame(new Int16Array(240), 24_000, 1, 240);
      this.queue.put({ requestId: 'r', segmentId: 's', frame, final: true });
    } finally {
      owner.running--;
    }
  }
}

describe('speech and transcription adapters', () => {
  it('synthesizes at most the playing chunk and the next at once, in order, and passes failures on', async () => {
    const inner = new CountingTTS((text) => text === 'c');
    const paced = new PacedTTS(inner, TTS_CONCURRENCY);
    const errors: unknown[] = [];
    paced.on('error', (err) => errors.push(err));
    const streams = ['a', 'b', 'c', 'd', 'e'].map((text) => paced.synthesize(text));
    const frames = await Promise.all(
      streams.map(async (s) => {
        let samples = 0;
        for await (const audio of s) samples += audio.frame.samplesPerChannel;
        return samples;
      }),
    );
    expect(inner.started).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(inner.maxRunning).toBe(2);
    expect(frames).toEqual([240, 240, 0, 240, 240]);
    expect(streams[2].error).toBeDefined();
    expect(errors).toHaveLength(1);
  });

  it('keeps one recovery probe going for a speech model that is down, however many requests skip it', async () => {
    const down = new CountingTTS(() => true);
    const adapter = new TtsFallback({
      ttsInstances: [down, new CountingTTS()],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 100,
    });
    const probes = () => down.started.filter((text) => text.startsWith('Hello world')).length;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      for (let i = 0; i < 20; i++) {
        for await (const _ of adapter.synthesize(`reply ${i}`));
        await pause(30);
      }
      const before = probes();
      await pause(1100);
      // One chain probes about every 110 ms; LiveKit's own adapter forks one per skipping request.
      expect(probes() - before).toBeLessThanOrEqual(12);
    } finally {
      await adapter.close();
    }
    const closed = probes();
    await pause(300);
    expect(probes()).toBe(closed);
  });

  it('hands the transcription back without stopping it: a failed stream ends so the session opens a new one', async () => {
    const vad = {} as VAD;
    const events: CallVoiceEvents = {
      onTurn: () => undefined,
      onCallerSpeaking: () => undefined,
      onTurnLost: () => undefined,
      onTurnDropped: () => undefined,
      onClosed: () => undefined,
    };
    const { session } = walkieSession(
      META,
      { geminiKey: 'gk-test', record: false },
      { vad, fallbackVad: vad },
      events,
      { ...silentLog, error: () => undefined },
    );
    const primary = new ControlledSTT('primary');
    const fallback = new ControlledSTT('fallback');
    const adapter = new stt.FallbackAdapter({ sttInstances: [primary, fallback] });
    adapter.on('error', () => undefined);
    const parent = adapter.stream({ connOptions: session.connOptions.sttConnOptions });
    const feed = setInterval(() => {
      try {
        parent.pushFrame(new AudioFrame(new Int16Array(160), 16_000, 1, 160));
      } catch {
        clearInterval(feed);
      }
    }, 5);
    try {
      await vi.waitFor(() => expect(primary.streams).toHaveLength(1));
      primary.streams[0].fail();
      await vi.waitFor(() => expect(fallback.streams).toHaveLength(1));
      // The adapter's probe hears the streaming model again; the walkie hands back at a pause.
      await vi.waitFor(() => expect(primary.streams).toHaveLength(2));
      primary.streams[1].say('back');
      await vi.waitFor(() => expect(adapter.status[0].available).toBe(true));
      fallback.streams[0].close();
      for await (const _ of parent);
      expect(parent.terminalError).toBeDefined();
    } finally {
      clearInterval(feed);
      await adapter.close();
    }
  });
});

describe('SendCountdown', () => {
  it('says how far into the closing silence a stopped caller is, one wait at a time, and clears once', () => {
    let now = 10_000;
    const published: string[] = [];
    const countdown = new SendCountdown(
      (value) => published.push(value),
      2500,
      () => now,
    );
    countdown.clear();
    expect(published).toEqual([]);
    countdown.stopped(now - 600);
    now += 4000;
    countdown.clear();
    countdown.clear();
    // Reported late, it is never past the whole silence.
    countdown.stopped(now - 9000);
    expect(published).toEqual(['1:600:2500', '', '2:2500:2500']);
    countdown.clear();
  });

  it('clears itself once the turn is overdue, so a turn that never commits does not leave it up', () => {
    vi.useFakeTimers();
    const published: string[] = [];
    const countdown = new SendCountdown((value) => published.push(value), 2500);
    countdown.stopped(Date.now() - 500);
    vi.advanceTimersByTime(2000 + TURN_SETTLE_MS - 1);
    expect(published).toEqual(['1:500:2500']);
    vi.advanceTimersByTime(1);
    expect(published).toEqual(['1:500:2500', '']);
    vi.useRealTimers();
  });
});
