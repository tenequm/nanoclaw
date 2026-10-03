/**
 * The voice call worker: the turn-taking rules (turn order, reply gating, thinking, failure
 * lines) against fake host and voice, the unary Gemini transcription against a fake fetch, the
 * text helpers, and runCall end to end with a fake room and session. The LiveKit session,
 * Silero and Gemini themselves are not loaded here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentServer,
  APIConnectionError,
  APIStatusError,
  InferenceRunner,
  initializeLogger,
  normalizeLanguage,
  ServerOptions,
  stt,
  tts,
  voice as agentsVoice,
  type APIConnectOptions,
  type VAD,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  type CallReviewState,
  type LiveKitJobMetadata,
  type ReviewOp,
  type ReviewRequest,
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
  pathSegment,
  pruneRecordings,
  readJobHeader,
  recordingDays,
  runCall,
  SendCountdown,
  skipLocalTurnDetectorProcess,
  speakableText,
  TtsFallback,
  TURN_SETTLE_MS,
  TurnCapture,
  TurnTaking,
  callSession,
  setTtsDown,
  ttsDownSince,
  TTS_DOWN_MEMORY_MS,
  CueFeed,
  cueFrames,
  matchCommand,
  matchWake,
  matchWakeText,
  matchSpottedCommand,
  spotterSettings,
  type SpotterRole,
  awakeLimits,
  ReplayBuffer,
  type WakeWord,
  type WakeWordEvents,
  READY_CUE_WAIT_MS,
  SpokenCommands,
  TURN_CUE_DELAY_MS,
  wakeNameWords,
  type CueKind,
  CLEAR_SETTLE_MS,
  FLUSH_QUIET_MS,
  FLUSH_TIMEOUT_MS,
  readReviewRequest,
  ReadyingGeminiSTT,
  ReviewControl,
  STT_READY_TIMEOUT_MS,
  type ReviewDeps,
  wholeReplySpeech,
  writeTurnRecording,
  type CallJob,
  type CallVoice,
  type CallVoiceEvents,
  type TurnAudio,
  type TurnRecord,
  type TurnTake,
  type SendResult,
  type VoiceSettings,
  type TurnTakingDeps,
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

  it('reaches the TTS whole, in one request, decimals and abbreviations as written', async () => {
    const inner = new CountingTTS();
    const stream = wholeReplySpeech(inner).stream();
    const text = `Version 2.4 costs 3.50 dollars, e.g. cheap. ${'Then more words follow here. '.repeat(25)}`.trim();
    // The session hands a reply over in pieces; none of them may start a request of its own.
    for (const piece of text.match(/[\s\S]{1,60}/g)!) stream.pushText(piece);
    stream.endInput();
    let samples = 0;
    for await (const ev of stream) if (ev !== tts.SynthesizeStream.END_OF_STREAM) samples += ev.frame.samplesPerChannel;
    expect(text.length).toBeGreaterThan(700);
    expect(inner.started).toEqual([text]);
    expect(samples).toBe(240);
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

  it('reads VOICE_MAX_SPOKEN_CHARS, with no cap unless it sets one', () => {
    expect(maxSpokenChars(undefined)).toBe(DEFAULT_MAX_SPOKEN_CHARS);
    expect(DEFAULT_MAX_SPOKEN_CHARS).toBe(0);
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

function fakeTurnTakingDeps(overrides: Partial<TurnTakingDeps> = {}) {
  const said: string[] = [];
  const sent: string[] = [];
  const statuses: boolean[] = [];
  const deps: TurnTakingDeps = {
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

describe('TurnTaking', () => {
  it('sends turns in order and shows thinking until a reply, then speaks it as plain text', async () => {
    vi.useFakeTimers();
    const { deps, said, sent, statuses } = fakeTurnTakingDeps();
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk' });
    const results: unknown[] = [];
    turnTaking.onTurn('book a table', (r) => results.push(r));
    turnTaking.onTurn('for two');
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['book a table', 'for two']);
    expect(results).toEqual([{ accepted: true, id: '1' }]);
    expect(statuses).toEqual([false, true]);
    turnTaking.onReply('**Booked** for [eight](https://x.y).');
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toEqual(['Booked for eight.']);
    expect(statuses.at(-1)).toBe(false);
  });

  it("caps every spoken message, closing in the caller's latest language", async () => {
    vi.useFakeTimers();
    const { deps, said } = fakeTurnTakingDeps();
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk', maxSpokenChars: 20 });
    turnTaking.onTurn('what is new');
    await vi.advanceTimersByTimeAsync(SILENCE + TURN_SETTLE_MS);
    turnTaking.onReply('Two things now. A **third** one that is long.');
    turnTaking.onReply('Fits.');
    await vi.advanceTimersByTimeAsync(1);
    // No `chat` event yet: the call talks on the voice line, where no chat holds the rest.
    expect(said).toEqual([`Two things now. ${CUT_LINES.no_chat.en}`, 'Fits.']);
    turnTaking.onChat(true);
    turnTaking.onReply('Two things now. A third one that is long.');
    await vi.advanceTimersByTimeAsync(1);
    expect(said.at(-1)).toBe(`Two things now. ${CUT_LINES.chat.en}`);
    const uncapped = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk', maxSpokenChars: 0 });
    uncapped.onReply('Two things. A third one that is long.');
    await vi.advanceTimersByTimeAsync(1);
    expect(said.at(-1)).toBe('Two things. A third one that is long.');
  });

  it('drops thinking after a while without typing ticks, and holds it while they come', async () => {
    vi.useFakeTimers();
    const { deps, statuses } = fakeTurnTakingDeps();
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk' });
    turnTaking.onTurn('thanks');
    await vi.advanceTimersByTimeAsync(AWAIT_REPLY_MS - 1000);
    turnTaking.onThinking();
    await vi.advanceTimersByTimeAsync(5000);
    expect(statuses.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(statuses.at(-1)).toBe(false);
  });

  it('holds a reply while the caller talks and until their turn could still be committed', async () => {
    vi.useFakeTimers();
    const { deps, said } = fakeTurnTakingDeps();
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk' });
    turnTaking.onCallerSpeaking(true);
    turnTaking.onReply('First.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(said).toEqual([]);
    turnTaking.onCallerSpeaking(false);
    await vi.advanceTimersByTimeAsync(SILENCE);
    expect(said).toEqual([]);
    // The committed turn frees the channel at once.
    turnTaking.onTurn('and another thing');
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toEqual(['First.']);

    // A caller who stops and never gets a turn committed (a cough) frees it after the settle time.
    turnTaking.onCallerSpeaking(true);
    turnTaking.onCallerSpeaking(false);
    turnTaking.onReply('Second.');
    await vi.advanceTimersByTimeAsync(SILENCE + TURN_SETTLE_MS - 10);
    expect(said).toEqual(['First.']);
    await vi.advanceTimersByTimeAsync(20);
    expect(said).toEqual(['First.', 'Second.']);
  });

  it('frees the channel at once when the caller speech came to no turn', async () => {
    vi.useFakeTimers();
    const { deps, said } = fakeTurnTakingDeps();
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk' });
    turnTaking.onCallerSpeaking(true);
    turnTaking.onReply('First.');
    turnTaking.onCallerSpeaking(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(said).toEqual([]);
    // Words before the wake phrase, a discard, noise: nothing will be committed.
    turnTaking.releaseTurn();
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toEqual(['First.']);
  });

  it('lets a reply take the channel from a caller who never stops', async () => {
    vi.useFakeTimers();
    const { deps, said } = fakeTurnTakingDeps();
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk' });
    turnTaking.onCallerSpeaking(true);
    turnTaking.onReply('Done.');
    await vi.advanceTimersByTimeAsync(SILENCE + MAX_IDLE_WAIT_MS - 10);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(said).toEqual(['Done.']);
  });

  it("says it didn't catch a turn the STT lost, in the caller's language, once", async () => {
    const { deps, said } = fakeTurnTakingDeps();
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk' });
    turnTaking.onTurnLost('empty');
    turnTaking.onTurnLost('empty');
    await turnTaking.idle();
    expect(said).toEqual([FAILURE_LINES.turn.uk]);
    turnTaking.onTurnLost('stt');
    await turnTaking.idle();
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
    const { deps, said } = fakeTurnTakingDeps({ send: async () => answers.shift() ?? { accepted: true } });
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk' });
    for (const text of ['what about the logs', 'and the disk', 'а диск', 'і пам’ять']) {
      turnTaking.onTurn(text);
      await turnTaking.idle();
    }
    turnTaking.onChat(true);
    turnTaking.onTurn('а мережа');
    await turnTaking.idle();
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
    const { deps } = fakeTurnTakingDeps({
      say: async (text) => {
        calls++;
        if (calls === 1) return false;
        if (calls === 3) throw new Error('room gone');
        said.push(text);
        return true;
      },
    });
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'en' });
    turnTaking.onReply('Reply one.');
    await turnTaking.idle();
    expect(said).toEqual([FAILURE_LINES.reply.en]);
    turnTaking.onReply('Reply two.');
    turnTaking.onReply('Reply three.');
    await turnTaking.idle();
    expect(said).toEqual([FAILURE_LINES.reply.en, 'Reply three.']);
  });

  it('a reply the speech model failed on goes to the page as text, and no line was heard: no hand-over', async () => {
    const announced: unknown[] = [];
    const handOvers: boolean[] = [];
    let ok = false;
    const { deps } = fakeTurnTakingDeps({
      say: async () => ok,
      announce: (info) => announced.push(info),
      spokenAll: (spoken) => handOvers.push(spoken),
    });
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'en' });
    turnTaking.onReply('Booked for **eight**.', 2);
    await turnTaking.idle();
    expect(announced).toEqual([
      { reply: 1, turn: 2, part: 1 },
      { reply: 1, turn: 2, part: 1, unspoken: true, text: 'Booked for eight.' },
      // The spoken failure line failed too.
      { reply: 2, notice: true },
    ]);
    expect(handOvers).toEqual([false]);
    ok = true;
    turnTaking.onReply('Done.');
    await turnTaking.idle();
    expect(handOvers).toEqual([false, true]);
  });

  it('a line queued while another plays says so again on the playing line: another follows', async () => {
    const announced: unknown[] = [];
    let finish!: () => void;
    const { deps } = fakeTurnTakingDeps({
      announce: (info) => announced.push(info),
      say: vi.fn(async (text: string) => {
        if (text === 'One.') await new Promise<void>((r) => (finish = r));
        return true;
      }),
    });
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'en' });
    turnTaking.onReply('One.', 1);
    await flush();
    expect(announced).toEqual([{ reply: 1, turn: 1, part: 1 }]);
    turnTaking.onReply('Two.', 1);
    expect(announced.at(-1)).toEqual({ reply: 1, turn: 1, part: 1, more: true });
    finish();
    await turnTaking.idle();
    expect(announced.at(-1)).toEqual({ reply: 2, turn: 1, part: 2 });
    // Nothing plays now: a new line labels only itself.
    turnTaking.onReply('Three.', 1);
    await turnTaking.idle();
    expect(announced).toHaveLength(4);
  });

  it('describes each line before it is spoken: the turn it answers, unprompted, or its own notice', async () => {
    vi.useFakeTimers();
    const announced: unknown[] = [];
    const { deps, said } = fakeTurnTakingDeps({
      announce: (info) => announced.push({ ...info, before: said.length }),
    });
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'en' });
    turnTaking.onReply('One.', 3);
    turnTaking.onReply('Two.', 3);
    turnTaking.onReply('Three.', null);
    await turnTaking.idle();
    turnTaking.onTurnLost('stt');
    await turnTaking.idle();
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
    const { deps, said, sent } = fakeTurnTakingDeps();
    const turnTaking = new TurnTaking(deps, { silenceMs: SILENCE, language: 'uk' });
    turnTaking.close();
    turnTaking.onTurn('hello');
    turnTaking.onReply('Hi.');
    turnTaking.onTurnLost('empty');
    await turnTaking.idle();
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

describe('local turn detector process', () => {
  it('leaves agents-js no inference runner to fork a process for', () => {
    skipLocalTurnDetectorProcess();
    new AgentServer(
      new ServerOptions({
        agent: 'unused',
        wsURL: 'ws://127.0.0.1:9',
        apiKey: 'key',
        apiSecret: 'secret',
        simulation: true,
      }),
    );
    expect(Object.keys(InferenceRunner.registeredRunners)).toEqual([]);
  });
});

describe('job metadata', () => {
  it('takes only a voice call of this version as a call to run', () => {
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
      { geminiKey: 'gk-test', record: false, ttsStateFile: expect.stringMatching(/voice-tts-state\.json$/) },
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
    // The page hears the turn closed before the host answers, then that the agent has it.
    expect(v.voice.publishTurn.mock.calls.map(([status]) => status)).toEqual([
      { turn: 1, status: 'sending' },
      { turn: 1, status: 'sent', text: 'Book a table' },
    ]);

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

  it('working shows while a turn awaits its reply and until the reply is heard, not for typing after it', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    let speak!: () => void;
    v.voice.say.mockImplementation(() => new Promise<boolean>((resolve) => (speak = () => resolve(true))));
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    const thinking = () => v.voice.setThinking.mock.calls.at(-1)?.[0];
    // Typing with no turn waiting for its answer says nothing.
    host.emit({ type: 'thinking' });
    await new Promise((r) => setTimeout(r, 20));
    expect(v.voice.setThinking).not.toHaveBeenCalled();

    v.events.onTurn('Book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() => expect(thinking()).toBe(true));
    host.emit({ type: 'reply', text: 'Booked.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked.'));
    // The reply's speech is still being made: the page keeps "working" until its audio plays.
    expect(thinking()).toBe(true);
    v.events.onAgentSpeaking?.(true);
    expect(thinking()).toBe(true);
    // A moment into its audio (the page has the speaking state by then) it lets go.
    await vi.waitFor(() => expect(thinking()).toBe(false));
    speak();
    v.events.onAgentSpeaking?.(false);
    // The agent's typing after its answer: no "working" with nothing coming.
    host.emit({ type: 'thinking' });
    await new Promise((r) => setTimeout(r, 20));
    expect(thinking()).toBe(false);
    host.endStream();
  });

  it('a turn the session commits while a final is still on its way waits for it (a late discard drops it)', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    const utterances = () => host.calls.filter((c) => c.url.endsWith('/utterance')).map((c) => c.body?.text);
    const take = { sttModel: 'gemini-3.5-transcribe-live' };

    v.events.onCallerSpeaking(true);
    v.events.onTranscript?.('Remind me to call the plumber.', true, 1);
    v.events.onTranscript?.('Scratch', false, 1);
    v.events.onCallerSpeaking(false);
    v.events.onTurn('Remind me to call the plumber.', take);
    await new Promise((r) => setTimeout(r, 30));
    expect(utterances()).toEqual([]);
    v.events.onTranscript?.('Scratch that.', true, 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(utterances()).toEqual([]);

    // A late final with more words: they are in the turn, and not in the next one.
    v.events.onCallerSpeaking(true);
    v.events.onTranscript?.('Скільки буде сім помножити на вісім?', true, 1);
    v.events.onCallerSpeaking(true);
    v.events.onCallerSpeaking(false);
    v.events.onTurn('Скільки буде сім помножити на вісім?', take);
    v.events.onTranscript?.('Одним словом.', true, 1);
    await vi.waitFor(() => expect(utterances()).toEqual(['Скільки буде сім помножити на вісім? Одним словом.']));
    v.events.onCallerSpeaking(true);
    v.events.onTranscript?.('And the weather?', true, 1);
    v.events.onCallerSpeaking(false);
    v.events.onTurn('Одним словом. And the weather?', take);
    await vi.waitFor(() => expect(utterances()).toHaveLength(2));
    expect(utterances()[1]).toBe('And the weather?');
    host.endStream();
  });

  it('a turn waits at most 2 s for a late final, then goes out as the session had it', async () => {
    vi.useFakeTimers();
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    v.events.onCallerSpeaking(true);
    v.events.onTranscript?.('Book a table', true, 1);
    v.events.onTranscript?.('for', false, 1);
    v.events.onCallerSpeaking(false);
    v.events.onTurn('Book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(host.calls.filter((c) => c.url.endsWith('/utterance'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(host.calls.filter((c) => c.url.endsWith('/utterance')).map((c) => c.body?.text)).toEqual(['Book a table']),
    );
    host.endStream();
  });

  it('tells the page once per turn that the agent picked it up, never before the host took it or after its answer', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    const working = () => v.voice.publishTurn.mock.calls.filter(([s]) => s.status === 'working').map(([s]) => s);
    // No turn yet: the agent working on something else says nothing about this call's turns.
    host.emit({ type: 'working' });
    await vi.waitFor(() => expect(v.voice.setThinking).toHaveBeenCalledWith(true));
    expect(working()).toEqual([]);

    v.events.onTurn('Book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 1, status: 'sent', text: 'Book a table' }),
    );
    host.emit({ type: 'working' });
    host.emit({ type: 'working' });
    await vi.waitFor(() => expect(working()).toEqual([{ turn: 1, status: 'working' }]));
    host.emit({ type: 'reply', text: 'Booked.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked.'));

    // Turn 2 (the fake host names it '1' too) is answered before any pickup is heard: no late "working".
    v.events.onTurn('And a taxi', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 2, status: 'sent', text: 'And a taxi' }),
    );
    host.emit({ type: 'reply', text: 'Taxi on its way.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Taxi on its way.'));
    host.emit({ type: 'working' });
    // A message naming no turn (unprompted, or a chat reply) also answers it: no "working" after it.
    v.events.onTurn('One more', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 3, status: 'sent', text: 'One more' }),
    );
    host.emit({ type: 'reply', text: 'Your taxi is here.', turn: null });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Your taxi is here.'));
    host.emit({ type: 'working' });
    // Turn 4 is picked up while its answer is still to come.
    v.events.onTurn('Thanks', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 4, status: 'sent', text: 'Thanks' }),
    );
    host.emit({ type: 'working' });
    await vi.waitFor(() =>
      expect(working()).toEqual([
        { turn: 1, status: 'working' },
        { turn: 4, status: 'working' },
      ]),
    );
    host.endStream();
  });

  it('holds a pickup while a newer turn waits for the host, so it is never read as that one', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let utterances = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/utterance') && ++utterances === 2) await held;
      return host.fetchImpl(input, init);
    });
    const v = fakeVoice();
    await runCall(ctx, deps(fetchImpl, v.createVoice));
    const working = () => v.voice.publishTurn.mock.calls.filter(([s]) => s.status === 'working').map(([s]) => s);
    v.events.onTurn('Book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 1, status: 'sent', text: 'Book a table' }),
    );
    v.events.onTurn('For two', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() => expect(utterances).toBe(2));
    host.emit({ type: 'working' });
    await vi.waitFor(() => expect(v.voice.setThinking).toHaveBeenCalledWith(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(working()).toEqual([]);
    release();
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 2, status: 'sent', text: 'For two' }),
    );
    host.emit({ type: 'working' });
    await vi.waitFor(() => expect(working()).toEqual([{ turn: 2, status: 'working' }]));
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
    // sending, lost (timeout), then sent once stored.
    expect(v.voice.publishTurn).toHaveBeenCalledTimes(3);
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

  it('ends a job of this version that is not a whole voice call, and tells the host', async () => {
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rec-'));
    try {
      const { ctx } = fakeJob();
      const host = fakeHostFetch();
      const v = fakeVoice();
      await runCall(
        ctx,
        deps(host.fetchImpl, v.createVoice, {
          env: { ...ENV, VOICE_RECORDINGS_DAYS: '7' },
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
    expect(host.calls.at(-1)?.body).not.toHaveProperty('restart');

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

  it('tells the host a call ended by the worker shutting down is a restart', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch();
    await runCall(ctx, deps(host.fetchImpl, fakeVoice().createVoice));
    const onShutdown = job.addShutdownCallback.mock.calls[0][0] as () => Promise<void>;
    await onShutdown();
    expect(host.calls.at(-1)).toMatchObject({
      url: 'http://127.0.0.1:3555/webhook/voice/livekit/agent/ended',
      body: { callId: 'call-1', reason: 'job shutdown', restart: true },
    });
    expect(job.shutdown).toHaveBeenCalledWith('job shutdown');
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
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rec-')), 'voice-recordings');
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
    const { session } = callSession(META, { geminiKey: 'gk-test', record: false }, { vad, fallbackVad: vad }, events, {
      ...silentLog,
      error: () => undefined,
    });
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
      // The adapter's probe hears the streaming model again; the call hands back at a pause.
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

/** Review mode's session controls, recorded; transcripts are fed through `heard`. */
function fakeReviewVoice() {
  const states: CallReviewState[] = [];
  let stream = 1;
  const voice = {
    manual: false,
    input: true,
    flushing: false,
    clears: 0,
    minMs: 0,
    /** Hold each restarted transcription's readiness until `ready()`; at once otherwise. */
    hold: false,
    holds: [] as Array<() => void>,
    setManualTurns: vi.fn((manual: boolean) => void (voice.manual = manual)),
    setInput: vi.fn((enabled: boolean) => void (voice.input = enabled)),
    setFlushing: vi.fn((on: boolean) => void (voice.flushing = on)),
    clearTurn: vi.fn(() => {
      voice.clears++;
      const ready = voice.hold ? new Promise<void>((resolve) => voice.holds.push(resolve)) : Promise.resolve();
      return { stream: ++stream, ready };
    }),
    flushMinMs: () => voice.minMs,
    takeTurn: vi.fn((): TurnTake => ({ sttModel: 'gemini-3.5-transcribe-live' })),
    publishReview: vi.fn((state: CallReviewState) => void states.push(state)),
  };
  return {
    voice,
    states,
    get stream() {
      return stream;
    },
    get last() {
      return states.at(-1)!;
    },
  };
}

function reviewControl(overrides: Partial<ReviewDeps> = {}) {
  const r = fakeReviewVoice();
  const posted: Array<{ text: string; draft: number }> = [];
  const capture: boolean[] = [];
  const control = new ReviewControl({
    voice: r.voice,
    post: vi.fn((text: string, draft: number) => {
      posted.push({ text, draft });
      return posted.length;
    }),
    lastPosted: () => posted.length,
    setCaptureOpen: (open) => capture.push(open),
    resetCaller: vi.fn(),
    log: { info: () => undefined, warn: () => undefined },
    ...overrides,
  });
  let gen = 0;
  const op = (name: ReviewOp, fields: Partial<ReviewRequest> = {}) => control.handle(name, { gen: ++gen, ...fields });
  /** The draft the page is looking at. */
  const draft = () => r.last.draft;
  /** A transcript from the session's transcription, on its current stream unless named. */
  const heard = (text: string, final: boolean, stream = r.stream) => control.onTranscript(text, final, stream);
  return { control, r, posted, capture, op, draft, heard };
}

/** Lets the flush poll run until the quiet time has passed. */
const settle = () => vi.advanceTimersByTimeAsync(FLUSH_QUIET_MS + 200);

describe('review mode', () => {
  it('talk opens the input, done flushes and freezes the final text, send posts exactly that text', async () => {
    vi.useFakeTimers();
    const { r, posted, capture, op, draft, heard } = reviewControl();
    expect(await op('mode', { mode: 'review', afterTurn: 0 })).toMatchObject({ ok: true });
    expect(r.voice.manual).toBe(true);
    expect(r.voice.input).toBe(false);
    expect(draft()).toBeNull();

    const talk = await op('talk');
    expect(talk).toMatchObject({ ok: true, draft: 1 });
    expect(r.voice.input).toBe(true);
    expect(capture).toEqual([true]);
    expect(draft()).toEqual({ id: 1, state: 'recording', text: '' });

    heard('Book a', false);
    heard('Book a table for two.', true);
    heard('At eight', false);
    expect(await op('done', { draft: 1 })).toMatchObject({ ok: true });
    expect(r.voice.input).toBe(false);
    expect(r.voice.flushing).toBe(true);
    expect(draft()).toMatchObject({ id: 1, state: 'finishing' });
    // The flush's silence lets the transcription finalize the last words.
    await vi.advanceTimersByTimeAsync(200);
    heard('At eight, please.', true);
    expect(draft()?.state).toBe('finishing');
    await settle();
    expect(r.voice.flushing).toBe(false);
    expect(draft()).toEqual({ id: 1, state: 'ready', text: 'Book a table for two. At eight, please.' });
    // The session's own turn is cleared, so nothing of it is ever committed by the session.
    expect(r.voice.clears).toBe(1);
    expect(posted).toEqual([]);

    expect(await op('send', { draft: 1 })).toMatchObject({ ok: true, turn: 1 });
    expect(posted).toEqual([{ text: 'Book a table for two. At eight, please.', draft: 1 }]);
    expect(draft()).toBeNull();
    // A repeated send is stale: never a second post.
    expect(await op('send', { draft: 1 })).toMatchObject({ ok: false, error: 'stale' });
    expect(posted).toHaveLength(1);
  });

  it('drops a transcript that arrives after a discard, and keeps the next recording clean', async () => {
    vi.useFakeTimers();
    const { r, posted, op, draft, heard } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    heard('Cancel my', false);
    const oldStream = r.stream;
    const discarding = op('discard', { draft: 1 });
    // The clear holds the next operation until the restarted transcription settles.
    const talking = op('talk');
    let talked = false;
    void talking.then(() => (talked = true));
    await vi.advanceTimersByTimeAsync(CLEAR_SETTLE_MS - 10);
    expect(talked).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await discarding).toMatchObject({ ok: true });
    expect(await talking).toMatchObject({ ok: true, draft: 2 });
    // The old stream's late final for the discarded words is dropped.
    heard('Cancel my subscription.', true, oldStream);
    heard('Keep it.', true);
    await op('done', { draft: 2 });
    await settle();
    expect(draft()).toEqual({ id: 2, state: 'ready', text: 'Keep it.' });
    expect(posted).toEqual([]);
    // A stale id for an earlier draft changes nothing.
    expect(await op('send', { draft: 1 })).toMatchObject({ ok: false, error: 'stale' });
    expect(await op('discard', { draft: 1 })).toMatchObject({ ok: false, error: 'stale' });
    expect(draft()?.id).toBe(2);
  });

  it('a discard during the flush wins: the late text never reappears and nothing is sent', async () => {
    vi.useFakeTimers();
    const { r, posted, op, draft, heard } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    heard('Delete the', false);
    await op('done', { draft: 1 });
    const discarding = op('discard', { draft: 1 });
    await vi.advanceTimersByTimeAsync(CLEAR_SETTLE_MS);
    expect(await discarding).toMatchObject({ ok: true });
    expect(draft()).toBeNull();
    heard('Delete the files.', true);
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS + 100);
    expect(draft()).toBeNull();
    expect(r.voice.flushing).toBe(false);
    expect(r.states.every((s) => s.draft?.text !== 'Delete the files.')).toBe(true);
    expect(posted).toEqual([]);
  });

  it('holds talk after a freeze until the restarted transcription takes audio, and says so in the state', async () => {
    vi.useFakeTimers();
    const { r, op, draft, heard } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    heard('Book a table.', true);
    r.voice.hold = true;
    await op('done', { draft: 1 });
    await settle();
    expect(draft()).toMatchObject({ id: 1, state: 'ready' });
    expect(r.last.preparing).toBe(true);
    await op('send', { draft: 1 });
    expect(r.last).toMatchObject({ draft: null, preparing: true });
    let talked = false;
    const talking = op('talk').then((reply) => {
      talked = true;
      return reply;
    });
    // The wait runs from the clear at the freeze, a settle ago.
    await vi.advanceTimersByTimeAsync(STT_READY_TIMEOUT_MS / 2);
    // The microphone opens on talk's answer: nothing the caller says can reach a stream not yet set up.
    expect(talked).toBe(false);
    expect(r.voice.input).toBe(false);
    r.voice.holds.shift()!();
    expect(await talking).toMatchObject({ ok: true, draft: 2 });
    expect(r.voice.input).toBe(true);
    const recording = r.states.findIndex((s) => s.draft?.id === 2);
    expect(r.states[recording - 1]).toMatchObject({ draft: null });
    expect(r.states[recording - 1].preparing).toBeUndefined();
    expect(r.last.preparing).toBeUndefined();
  });

  it('lets talk through when the restarted transcription never reports ready, and logs it', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const { r, op, draft } = reviewControl({ log: { info: () => undefined, warn } });
    await op('mode', { mode: 'review' });
    await op('talk');
    r.voice.hold = true;
    await op('done', { draft: 1 });
    await settle();
    expect(draft()).toMatchObject({ id: 1, state: 'empty' });
    const talking = op('talk');
    await vi.advanceTimersByTimeAsync(STT_READY_TIMEOUT_MS);
    expect(await talking).toMatchObject({ ok: true, draft: 2 });
    expect(warn).toHaveBeenCalledWith('voice worker: the restarted transcription did not report ready in time');
    expect(r.last.preparing).toBeUndefined();
  });

  it('refuses a talk that waited for the transcription when the agent started speaking meanwhile', async () => {
    vi.useFakeTimers();
    const { control, r, op } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    r.voice.hold = true;
    await op('done', { draft: 1 });
    await settle();
    const talking = op('talk');
    await vi.advanceTimersByTimeAsync(100);
    control.onAgentSpeaking(true);
    r.voice.holds.shift()!();
    expect(await talking).toMatchObject({ ok: false, error: 'agent_speaking' });
    expect(r.voice.input).toBe(false);
  });

  it('says nothing was heard, lets talk retry from there, and never posts an empty draft', async () => {
    vi.useFakeTimers();
    const { op, draft, posted } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    await op('done', { draft: 1 });
    await settle();
    expect(draft()).toEqual({ id: 1, state: 'empty', text: '' });
    expect(await op('send', { draft: 1 })).toMatchObject({ ok: false, error: 'unsendable' });
    expect(await op('talk')).toMatchObject({ ok: true, draft: 2 });
    expect(posted).toEqual([]);
  });

  it('marks an oversize draft too long by its UTF-8 bytes and refuses to send it', async () => {
    vi.useFakeTimers();
    const { op, draft, posted, heard } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    // 4200 Cyrillic letters: under 8 K characters, over 8 KB.
    heard('я'.repeat(4200), true);
    await op('done', { draft: 1 });
    await settle();
    expect(draft()).toMatchObject({ state: 'ready', tooLong: true });
    expect(draft()?.text).toHaveLength(4200);
    expect(await op('send', { draft: 1 })).toMatchObject({ ok: false, error: 'unsendable' });
    expect(posted).toEqual([]);
  });

  it('leaves words the transcription never finalized unverified, and a failed transcription unsendable', async () => {
    vi.useFakeTimers();
    const { control, op, draft, heard } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    heard('Send it to', true);
    heard('the whole', false);
    await op('done', { draft: 1 });
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS + 100);
    expect(draft()).toEqual({ id: 1, state: 'failed', text: 'Send it to the whole' });
    expect(await op('send', { draft: 1 })).toMatchObject({ ok: false, error: 'unsendable' });
    await op('discard', { draft: 1 });
    await vi.advanceTimersByTimeAsync(CLEAR_SETTLE_MS);

    await op('talk');
    heard('Hello.', true);
    control.onSttError();
    await op('done', { draft: 2 });
    await settle();
    expect(draft()).toMatchObject({ id: 2, state: 'failed', text: 'Hello.' });
  });

  it('auto to review mid-utterance: the auto commit is cancelled and the words become one draft, unsent', async () => {
    vi.useFakeTimers();
    const { control, r, posted, op, draft, heard } = reviewControl();
    // Auto mode hears a turn in progress: a final, more speech under way.
    heard('Remind me', true);
    control.onCallerSpeaking(true);
    heard('tomorrow at', false);
    expect(await op('mode', { mode: 'review', afterTurn: 0 })).toEqual({ gen: 1, ok: true, seq: 1 });
    // Manual turns cancel the pending auto commit; the input stops.
    expect(r.voice.manual).toBe(true);
    expect(r.voice.input).toBe(false);
    expect(draft()).toMatchObject({ id: 1, state: 'finishing', reason: 'switch' });
    heard('tomorrow at nine.', true);
    await settle();
    expect(draft()).toEqual({ id: 1, state: 'ready', text: 'Remind me tomorrow at nine.', reason: 'switch' });
    expect(posted).toEqual([]);
    // Back to auto is refused while the draft is open: no send, no discard, no deferred switch.
    expect(await op('mode', { mode: 'auto' })).toMatchObject({ ok: false, error: 'draft_open' });
    expect(r.last.mode).toBe('review');
  });

  it('auto to review after the auto commit won: names the submitted turn and opens no duplicate draft', async () => {
    vi.useFakeTimers();
    let lastPosted = 0;
    const { control, op, draft, heard } = reviewControl({ lastPosted: () => lastPosted });
    heard('Book a table.', true);
    // The auto commit fires before the page's request lands.
    lastPosted = 3;
    control.onAutoTurnClosed();
    expect(await op('mode', { mode: 'review', afterTurn: 2 })).toMatchObject({ ok: true, submitted: 3 });
    expect(draft()).toBeNull();
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS + 100);
    expect(draft()).toBeNull();
    // Already seen by the page: nothing to report.
    await op('mode', { mode: 'auto' });
    expect(await op('mode', { mode: 'review', afterTurn: 3 })).not.toHaveProperty('submitted');
  });

  it('switching modes never posts, and back to auto waits for the draft and keeps the mic off', async () => {
    vi.useFakeTimers();
    const { r, posted, op, draft, heard } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    heard('Hi.', true);
    expect(await op('mode', { mode: 'auto' })).toMatchObject({ ok: false, error: 'recording' });
    await op('done', { draft: 1 });
    expect(await op('mode', { mode: 'auto' })).toMatchObject({ ok: false, error: 'finishing' });
    await settle();
    expect(await op('mode', { mode: 'auto' })).toMatchObject({ ok: false, error: 'draft_open' });
    await op('discard', { draft: 1 });
    expect(await op('mode', { mode: 'auto' })).toMatchObject({ ok: true });
    expect(r.voice.manual).toBe(false);
    // The worker hears again; the page keeps its microphone muted until the caller unmutes.
    expect(r.voice.input).toBe(true);
    expect(draft()).toBeNull();
    expect(await op('talk')).toMatchObject({ ok: false, error: 'not_review' });
    expect(posted).toEqual([]);
    // The same mode again only re-reads the state (after a reconnect).
    const before = r.states.length;
    expect(await op('mode', { mode: 'auto' })).toMatchObject({ ok: true });
    // A request naming no mode re-reads too, and never switches.
    expect(await op('mode')).toMatchObject({ ok: true });
    expect(r.states).toHaveLength(before + 2);
    expect(r.last.mode).toBe('auto');
  });

  it('a reply taking the channel stops the recording into a draft, and talk waits for the agent', async () => {
    vi.useFakeTimers();
    const { control, r, capture, op, draft, posted, heard } = reviewControl();
    await op('mode', { mode: 'review' });
    await op('talk');
    heard('Order the', true);
    control.beforeAgentSpeaks();
    expect(r.voice.input).toBe(false);
    expect(capture).toEqual([true, false]);
    expect(draft()).toMatchObject({ state: 'finishing', reason: 'agent' });
    control.onAgentSpeaking(true);
    await settle();
    expect(draft()).toEqual({ id: 1, state: 'ready', text: 'Order the', reason: 'agent' });
    // Done after the fact asks for nothing more; the capture never resumes by itself.
    expect(await op('done', { draft: 1 })).toMatchObject({ ok: true });
    expect(r.voice.input).toBe(false);
    // A draft open while the agent speaks can still be sent: a follow-up.
    expect(await op('send', { draft: 1 })).toMatchObject({ ok: true });
    expect(await op('talk')).toMatchObject({ ok: false, error: 'agent_speaking' });
    control.onAgentSpeaking(false);
    expect(await op('talk')).toMatchObject({ ok: true });
    expect(posted).toEqual([{ text: 'Order the', draft: 1 }]);
  });

  it('refuses everything once the call ended', async () => {
    const { control, op, posted } = reviewControl();
    control.close();
    expect(await op('mode', { mode: 'review' })).toMatchObject({ ok: false, error: 'closed' });
    expect(posted).toEqual([]);
  });

  it('reads only well-formed review requests', () => {
    expect(readReviewRequest('{"gen":3,"draft":2}')).toEqual({ gen: 3, draft: 2 });
    expect(readReviewRequest('{"gen":1,"mode":"review","afterTurn":4}')).toEqual({
      gen: 1,
      mode: 'review',
      afterTurn: 4,
    });
    expect(readReviewRequest('{"gen":1,"mode":"walkie"}')).toEqual({ gen: 1 });
    expect(readReviewRequest('{"draft":2}')).toBeNull();
    expect(readReviewRequest('nope')).toBeNull();
  });
});

describe('review mode in a call', () => {
  /** fakeVoice with review controls; `rpc` calls what the worker serves, as the page would. */
  function reviewCall() {
    const v = fakeVoice();
    const r = fakeReviewVoice();
    let handle!: (op: ReviewOp, payload: string, callerIdentity: string) => Promise<string>;
    const serve = vi.fn((h: typeof handle) => void (handle = h));
    Object.assign(v.voice, { review: { ...r.voice, serve } });
    let gen = 0;
    const rpc = async (op: ReviewOp, fields: Partial<ReviewRequest> = {}, caller = 'caller-1') =>
      JSON.parse(await handle(op, JSON.stringify({ gen: ++gen, ...fields }), caller)) as Record<string, unknown>;
    return { v, r, serve, rpc };
  }

  it('posts exactly the sent draft through the turn path, and an auto commit that lost the race posts nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const { v, r, serve, rpc } = reviewCall();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    expect(serve).toHaveBeenCalledOnce();

    // Auto mode first: a turn in progress, then the switch; the session's commit lands after it.
    v.events.onTranscript?.('Call the', true, 1);
    expect(await rpc('mode', { mode: 'review', afterTurn: 0 })).toMatchObject({ ok: true });
    v.events.onTurn('Call the', { sttModel: 'gemini-3.5-transcribe-live' });
    expect(v.events.reviewing?.()).toBe(true);
    v.events.onTranscript?.('plumber.', true, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.last.draft).toEqual({ id: 1, state: 'ready', text: 'Call the plumber.', reason: 'switch' });
    expect(host.calls.some((c) => c.url.endsWith('/utterance'))).toBe(false);

    expect(await rpc('send', { draft: 1 })).toMatchObject({ ok: true, turn: 1 });
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(host.calls.filter((c) => c.url.endsWith('/utterance')).map((c) => c.body?.text)).toEqual([
        'Call the plumber.',
      ]),
    );
    // The page shows the sent draft's own text as the turn, then the agent's confirmation.
    await vi.waitFor(() =>
      expect(v.voice.publishTurn.mock.calls.map(([status]) => status)).toEqual([
        { turn: 1, status: 'sending', text: 'Call the plumber.', draft: 1 },
        { turn: 1, status: 'sent', text: 'Call the plumber.' },
      ]),
    );
    // Nothing on a pause in review: a lost or dropped auto turn is not reported either.
    v.events.onTurnLost('empty', {}, { sttModel: 'gemini-3.5-transcribe-live' });
    v.events.onTurnDropped({ sttModel: 'gemini-3.5-transcribe-live' });
    expect(v.voice.publishTurn).toHaveBeenCalledTimes(2);
    host.endStream();
  });

  it('answers only the caller, and a reply that waited out a recording stops it into a draft', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const { v, r, rpc } = reviewCall();
    await runCall(ctx, deps(host.fetchImpl, v.createVoice));
    await expect(rpc('mode', { mode: 'review' }, 'someone-else')).rejects.toThrow();
    await rpc('mode', { mode: 'review' });
    expect(await rpc('talk')).toMatchObject({ ok: true, draft: 1 });
    v.events.onTranscript?.('Wait, also', true, 1);
    host.emit({ type: 'reply', text: 'Booked.', turn: null });
    // The reply holds while the caller records, for a while.
    await vi.advanceTimersByTimeAsync(META.silenceMs + MAX_IDLE_WAIT_MS - 100);
    expect(v.voice.say).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(v.voice.say).toHaveBeenCalledWith('Booked.');
    expect(r.voice.input).toBe(false);
    expect(r.states.some((st) => st.draft?.state === 'finishing' && st.draft.reason === 'agent')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.last.draft).toEqual({ id: 1, state: 'ready', text: 'Wait, also', reason: 'agent' });
    expect(host.calls.some((c) => c.url.endsWith('/utterance'))).toBe(false);
    host.endStream();
  });
});

describe('ReadyingGeminiSTT', () => {
  it('tells, once per stream and by opening order, when a stream it opened first reads its input', async () => {
    const inputs: Array<{ next: () => Promise<unknown> }> = [];
    const opened = vi.spyOn(google.beta.GeminiSTT.prototype, 'stream').mockImplementation(() => {
      const input = { next: async () => ({ done: true, value: undefined }) };
      inputs.push(input);
      return { input } as unknown as stt.SpeechStream;
    });
    try {
      const reading: number[] = [];
      const transcription = new ReadyingGeminiSTT({ apiKey: 'gk-test' }, (n) => reading.push(n));
      const first = inputs.length;
      transcription.stream();
      transcription.stream();
      expect(transcription.streamsOpened).toBe(2);
      expect(reading).toEqual([]);
      const [a, b] = inputs.slice(first);
      await b.next();
      await b.next();
      await a.next();
      expect(reading).toEqual([2, 1]);
    } finally {
      opened.mockRestore();
    }
  });
});

describe('review mode in the session', () => {
  it('feeds the flush silence straight to the transcription, and numbers each stream it hears', async () => {
    const heard: Array<[string, boolean, number]> = [];
    const events: CallVoiceEvents = {
      onTurn: () => undefined,
      onCallerSpeaking: () => undefined,
      onTurnLost: () => undefined,
      onTurnDropped: () => undefined,
      onClosed: () => undefined,
      onTranscript: (text, final, stream) => void heard.push([text, final, stream]),
    };
    const vad = {} as VAD;
    const { agent, review, session } = callSession(META, { geminiKey: 'gk-test', record: false }, { vad }, events, {
      ...silentLog,
      error: () => undefined,
    });
    // The session's own STT node: it reports what audio reached it and transcribes on cue.
    const reached: number[] = [];
    const node = vi.spyOn(agentsVoice.Agent.prototype, 'sttNode').mockImplementation(async (audio) => {
      const frames = audio as ReadableStream<AudioFrame>;
      return new ReadableStream<stt.SpeechEvent>({
        async start(controller) {
          for await (const frame of frames) {
            reached.push(frame.samplesPerChannel);
            const said = (frame.data[0] ?? 0) === 7 ? 'hello' : '';
            if (said) {
              controller.enqueue({
                type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                alternatives: [
                  { text: said, language: normalizeLanguage('en'), startTime: 0, endTime: 0, confidence: 1 },
                ],
              });
            }
          }
          controller.close();
        },
      });
    });
    try {
      let push!: (frame: AudioFrame) => void;
      let endAudio!: () => void;
      const audio = new ReadableStream<AudioFrame>({
        start(c) {
          push = (f) => c.enqueue(f);
          endAudio = () => c.close();
        },
      });
      const events1 = (await agent.sttNode(audio, {} as never)) as ReadableStream<stt.SpeechEvent>;
      const reader = events1.getReader();
      const caller = new Int16Array(160).fill(7);
      push(new AudioFrame(caller, 16_000, 1, 160));
      await reader.read();
      expect(heard).toEqual([['hello', true, 1]]);
      // With the input off nothing arrives from the room; the flush still feeds 100 ms chunks.
      review.setFlushing(true);
      await vi.waitFor(() => expect(reached.filter((n) => n === 1600).length).toBeGreaterThanOrEqual(2));
      review.setFlushing(false);
      const fed = reached.length;
      await new Promise((r) => setTimeout(r, 250));
      expect(reached).toHaveLength(fed);
      endAudio();
      // A session that is not running cannot clear: the stream that runs stays the current one.
      const notCleared = review.clearTurn();
      expect(notCleared.stream).toBe(1);
      await notCleared.ready;
      // A clear restarts the transcription, which is the next stream.
      const clear = vi.spyOn(session, 'clearUserTurn').mockImplementation(() => undefined);
      expect(review.clearTurn().stream).toBe(2);
      expect(clear).toHaveBeenCalledOnce();
    } finally {
      node.mockRestore();
    }
  });

  it('a clear is ready once a transcription stream opened after it reads its audio, not one opened before', async () => {
    const events: CallVoiceEvents = {
      onTurn: () => undefined,
      onCallerSpeaking: () => undefined,
      onTurnLost: () => undefined,
      onTurnDropped: () => undefined,
      onClosed: () => undefined,
    };
    const { review, session } = callSession(META, { geminiKey: 'gk-test', record: false }, { vad: {} as VAD }, events, {
      ...silentLog,
      error: () => undefined,
    });
    // Gemini itself is not loaded: each stream is its input queue, read as its send loop would.
    const inputs: Array<{ next: () => Promise<unknown> }> = [];
    const opened = vi.spyOn(google.beta.GeminiSTT.prototype, 'stream').mockImplementation(() => {
      const input = { next: async () => ({ done: true, value: undefined }) };
      inputs.push(input);
      return { input } as unknown as stt.SpeechStream;
    });
    vi.spyOn(session, 'clearUserTurn').mockImplementation(() => undefined);
    try {
      const transcription = session.stt as stt.STT;
      transcription.stream();
      const { ready } = review.clearTurn();
      let isReady = false;
      void ready.then(() => (isReady = true));
      // The stream from before the clear reading says nothing about the restarted one.
      await inputs[0].next();
      await flush();
      expect(isReady).toBe(false);
      // The restarted stream exists but is still connecting: Gemini reads nothing before setup.
      transcription.stream();
      await flush();
      expect(isReady).toBe(false);
      await inputs[1].next();
      await flush();
      expect(isReady).toBe(true);
    } finally {
      opened.mockRestore();
    }
  });
});

describe('spoken command matching', () => {
  it('finds a command only at the end of an utterance, with what was said before it', () => {
    expect(matchCommand('Book a table for two. Send it.')).toEqual({ command: 'send', rest: 'Book a table for two.' });
    expect(matchCommand('book a table, send it')).toEqual({ command: 'send', rest: 'book a table' });
    expect(matchCommand('SEND IT!')).toEqual({ command: 'send', rest: '' });
    // Mid-sentence it is words, and so is a longer word ending in it.
    expect(matchCommand('Send it to Anna tomorrow')).toBeNull();
    expect(matchCommand('It was godsend')).toBeNull();
    // `over` is no command any more: a Ukrainian speaker's `over` is transcribed as anything.
    expect(matchCommand('Book a table. Over.')).toBeNull();
    // A sentence that really ends in it sends: the price of hands-free.
    expect(matchCommand("I'll send it.")).toEqual({ command: 'send', rest: "I'll" });
  });

  it('hears send it as a Ukrainian speaker gets it transcribed, and the Ukrainian прийом', () => {
    const rest = (text: string) => {
      const m = matchCommand(text);
      return m?.command === 'send' ? m.rest : null;
    };
    expect(rest('Забронюй столик. Сенд іт.')).toBe('Забронюй столик.');
    expect(rest('Забронюй столик, сендіт')).toBe('Забронюй столик');
    expect(rest('Сендип.')).toBe('');
    expect(rest('Book a table, sendit')).toBe('Book a table');
    expect(rest('Book a table. Sent it.')).toBe('Book a table.');
    expect(rest('Book a table, send eat')).toBe('Book a table');
    // The transcription may cut it to its first word.
    expect(rest('Скільки я читав сьогодні? Send.')).toBe('Скільки я читав сьогодні?');
    expect(rest('Скільки я читав сьогодні? Прийом.')).toBe('Скільки я читав сьогодні?');
    expect(rest('Прийом')).toBe('');
    expect(rest('send it again')).toBeNull();
  });

  it('knows the discard phrases, longest first, and only at the end', () => {
    expect(matchCommand('Call the plumber. Discard this turn.')).toEqual({
      command: 'discard',
      rest: 'Call the plumber.',
    });
    expect(matchCommand('call the plumber discard turn')).toEqual({ command: 'discard', rest: 'call the plumber' });
    expect(matchCommand('No wait - scratch that!')).toEqual({ command: 'discard', rest: 'No wait' });
    expect(matchCommand('Scratch that.')).toEqual({ command: 'discard', rest: '' });
    expect(matchCommand('scratch that idea and call the plumber')).toBeNull();
  });

  it('finds the wake phrase by the agent name or its vocabulary spellings, across scripts and punctuation', () => {
    const names = wakeNameWords(['Andy', 'Енді', 'Nano Claw', 'Al']);
    const after = (text: string) => {
      const found = matchWake(text, names);
      return found && text.slice(found.end);
    };
    expect(after('Hey, Andy. What is on today?')).toBe('. What is on today?');
    // It starts at its hey, glued or not.
    expect(matchWake('So I said hey Andy', names)).toEqual({ start: 10, end: 18 });
    expect(matchWake('Ok. Heyandy, go', wakeNameWords(['Andy']))).toEqual({ start: 4, end: 11 });
    expect(after('hey andy')).toBe('');
    expect(after('Гей, Енді, що там?')).toBe(', що там?');
    expect(after('Хей Енді')).toBe('');
    // A spelling that sounds alike counts; one that sounds different does not.
    expect(after('Хей Енди')).toBe('');
    expect(after('hey Endy, go')).toBe(', go');
    expect(after('Hey, and then what?')).toBeNull();
    expect(after('Hey Andrew')).toBeNull();
    // The name alone, or hey alone, is not the phrase.
    expect(after('Andy, what is on today?')).toBeNull();
    expect(after('Hey there')).toBeNull();
    // A name of two words is the two words; the text before the phrase is not part of it.
    expect(after('So I said hey Nano Claw, start')).toBe(', start');
    expect(after('hey nano')).toBeNull();
    // A name under three letters counts only as spelled.
    expect(after('hey Al, go')).toBe(', go');
    expect(after('hey all, go')).toBeNull();
  });

  it('takes hi and хай for hey, a Ukrainian vocative, and hey glued to the name', () => {
    const ben = wakeNameWords(['Ben']);
    const sam = wakeNameWords(['Sam']);
    const after = (text: string, names = ben) => {
      const found = matchWake(text, names);
      return found && text.slice(found.end);
    };
    expect(after('Hi Ben, what time is it?')).toBe(', what time is it?');
    expect(after('Хай Бен')).toBe('');
    expect(after('Hai Ben')).toBe('');
    expect(after('Гей, Бене, що там?')).toBe(', що там?');
    expect(after('Гей, Семе', sam)).toBe('');
    expect(after('Heyben, go')).toBe(', go');
    // Not every word that starts like hey: `hidden` is no `hi Den`.
    expect(after('It was hidden', wakeNameWords(['Den']))).toBeNull();
    expect(after('Hey Bena')).toBeNull();
    // The vocative ending only counts in Cyrillic: `Hey, bone` is not `Hey, Ben`.
    expect(after('Hey, bone')).toBeNull();
  });
});

function commandsHarness(names = ['Andy'], now?: () => number, limits?: { startMs: number; idleMs: number }) {
  const sent: string[] = [];
  const cues: CueKind[] = [];
  const dropped: Array<[string, string]> = [];
  const heard: Array<[string, boolean]> = [];
  let cuts = 0;
  let changes = 0;
  const commands = new SpokenCommands(
    names,
    {
      send: (text) => sent.push(text),
      cue: (kind) => cues.push(kind),
      drop: (reason, text) => dropped.push([reason, text]),
      heard: (text, final) => heard.push([text, final]),
      cut: () => cuts++,
      changed: () => changes++,
    },
    now,
    limits,
  );
  /** One stretch of speech: the caller talks, the final arrives, then they stop. */
  const say = (text: string) => {
    commands.onCallerSpeaking(true);
    commands.onCallerSpeaking(false);
    commands.onTranscript(text, true);
  };
  return {
    commands,
    sent,
    cues,
    dropped,
    heard,
    say,
    get cuts() {
      return cuts;
    },
    get changes() {
      return changes;
    },
  };
}

describe('SpokenCommands', () => {
  it('auto as before: a pause sends the session text, unless a command cut the turn', () => {
    const h = commandsHarness();
    h.say('Book a table');
    expect(h.commands.pausesSend).toBe(true);
    expect(h.commands.onPause('Book a table')).toBe('Book a table');
    expect(h.sent).toEqual([]);
    expect(h.cues).toEqual([]);
  });

  it('send it sends now without the word, and the pause after it sends nothing more', () => {
    const h = commandsHarness();
    h.say('Book a table');
    h.say('for two. Send it.');
    expect(h.sent).toEqual(['Book a table for two.']);
    expect(h.cues).toEqual([]);
    // The session still holds the words; its pause commits them, and they already went.
    expect(h.commands.onPause('Book a table for two. Send it.')).toBeNull();
    // Words after it are the next turn: the pause sends them alone.
    h.say('And a taxi');
    expect(h.commands.onPause('And a taxi')).toBe('And a taxi');
  });

  it('a command with nothing to act on only says nope', () => {
    const h = commandsHarness();
    h.say('Send it.');
    // The session commits the word on its pause: it is no turn either.
    expect(h.commands.onPause('Send it.')).toBeNull();
    h.say('Scratch that.');
    expect(h.commands.onPause('Scratch that.')).toBeNull();
    expect(h.sent).toEqual([]);
    // The page marks those lines: nothing to send.
    expect(h.dropped).toEqual([
      ['command', 'Send it.'],
      ['command', 'Scratch that.'],
    ]);
    expect(h.cues).toEqual(['nope', 'nope']);
    // The next words are a turn as usual.
    h.say('Book a table');
    expect(h.commands.onPause('Book a table')).toBe('Book a table');
  });

  it('start over mid-sentence sends nothing; the turn goes on its pause with every word', () => {
    const h = commandsHarness();
    h.say("Let's start over with the plan");
    expect(h.sent).toEqual([]);
    expect(h.commands.onPause("Let's start over with the plan")).toBe("Let's start over with the plan");
  });

  it('a final ending in send it while the caller still talks waits: new words make it words, a pause sends it', () => {
    const h = commandsHarness();
    h.commands.onCallerSpeaking(true);
    h.commands.onTranscript("We'll send it", true);
    h.commands.onTranscript('tomorrow', false);
    h.commands.onCallerSpeaking(false);
    h.commands.onTranscript('tomorrow morning.', true);
    expect(h.sent).toEqual([]);
    expect(h.heard.filter(([, final]) => final).map(([t]) => t)).toEqual(["We'll send it", 'tomorrow morning.']);

    h.commands.onPause('');
    h.commands.onCallerSpeaking(true);
    h.commands.onTranscript('Call the plumber, send it', true);
    expect(h.sent).toEqual([]);
    h.commands.onCallerSpeaking(false);
    expect(h.sent).toEqual(['Call the plumber']);
  });

  it('a discard drops the open turn: nothing is sent, now or on the pause', () => {
    const h = commandsHarness();
    h.say('Call the plumber');
    h.say('no wait, scratch that.');
    expect(h.cues).toEqual(['discard']);
    expect(h.dropped).toEqual([['discarded', 'Call the plumber no wait, scratch that.']]);
    expect(h.commands.onPause('Call the plumber no wait, scratch that.')).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('with the wake switch on nothing is kept before the wake phrase, and after it only send it sends', () => {
    const h = commandsHarness(['Andy', 'Енді']);
    h.commands.configure(true, false);
    expect(h.commands.state).toEqual({ on: true, pauseSends: false, waiting: true });
    expect(h.commands.pausesSend).toBe(false);
    h.say('So what did you think of the film?');
    expect(h.dropped).toEqual([['unaddressed', 'So what did you think of the film?']]);
    expect(h.commands.onPause('So what did you think of the film?')).toBeNull();
    expect(h.heard).toEqual([]);

    h.say('Anyway. Хей, Енді, what is on my calendar');
    expect(h.cues).toEqual(['wake']);
    // The words before the phrase in that final are marked, not silently lost.
    expect(h.dropped.at(-1)).toEqual(['unaddressed', 'Anyway.']);
    expect(h.commands.state.waiting).toBe(false);
    expect(h.commands.holdsReplies).toBe(true);
    // Pauses never send after the wake phrase.
    expect(h.commands.onPause('Anyway. Хей, Енді, what is on my calendar')).toBeNull();
    h.say('for tomorrow? Send it.');
    expect(h.sent).toEqual(['what is on my calendar for tomorrow?']);
    expect(h.cues).toEqual(['wake']);
    // Back to waiting for the wake phrase.
    expect(h.commands.state.waiting).toBe(true);
    h.say('and the weather, send it');
    expect(h.sent).toHaveLength(1);
    expect(h.cues).toEqual(['wake']);
  });

  it('a command alone while waiting for the wake phrase says nope; the wake phrase counts as heard', () => {
    const h = commandsHarness();
    h.commands.configure(true, false);
    h.say('Send it.');
    expect(h.cues).toEqual(['nope']);
    expect(h.dropped).toEqual([['command', 'Send it.']]);
    h.say('book a table, send it');
    expect(h.dropped.at(-1)).toEqual(['unaddressed', 'book a table, send it']);
    expect(h.commands.state.heard).toBeUndefined();
    h.say('Hey Andy, book a table, send it');
    expect(h.sent).toEqual(['book a table']);
    expect(h.commands.state).toEqual({ on: true, pauseSends: false, waiting: true, heard: 1 });
    h.say('Hey Andy');
    expect(h.commands.state).toMatchObject({ waiting: false, heard: 2 });
  });

  it('the wake phrase and the command can share one utterance', () => {
    const h = commandsHarness();
    h.commands.configure(true, false);
    h.say('Hey Andy, call the plumber. Send it.');
    expect(h.cues).toEqual(['wake']);
    expect(h.sent).toEqual(['call the plumber.']);
    h.say('hey andy send it');
    expect(h.cues).toEqual(['wake', 'wake', 'nope']);
    // Nope keeps the wake: the turn is still open.
    expect(h.commands.state.waiting).toBe(false);
  });

  it('a discard after the wake phrase goes back to waiting, even with nothing said yet', () => {
    const h = commandsHarness();
    h.commands.configure(true, false);
    h.say('Hey Andy');
    h.say('scratch that');
    expect(h.cues).toEqual(['wake', 'discard']);
    expect(h.commands.state.waiting).toBe(true);
    h.say('Hey Andy, book it');
    h.say('discard this turn');
    expect(h.dropped.at(-1)).toEqual(['discarded', 'book it discard this turn']);
    expect(h.sent).toEqual([]);
  });

  it('the second switch lets the pause send after the wake phrase too', () => {
    const h = commandsHarness();
    h.commands.configure(true, true);
    expect(h.commands.pausesSend).toBe(false);
    h.say('hey Andy, book a table');
    expect(h.commands.pausesSend).toBe(true);
    expect(h.commands.holdsReplies).toBe(false);
    expect(h.commands.onPause('hey Andy, book a table')).toBe('book a table');
    expect(h.commands.state.waiting).toBe(true);
    // A pause with nothing after the wake phrase sends nothing and keeps listening.
    h.say('hey Andy');
    expect(h.commands.onPause('hey Andy')).toBeNull();
    expect(h.commands.state.waiting).toBe(false);
  });

  it('turning the switch on drops the open words; turning it off keeps what came after the wake phrase', () => {
    const h = commandsHarness();
    h.say('Book a table');
    h.commands.configure(true, false);
    expect(h.commands.onPause('Book a table')).toBeNull();
    h.say('hey Andy, book a table');
    h.commands.configure(false, false);
    expect(h.commands.state).toEqual({ on: false, pauseSends: false, waiting: false, heard: 1 });
    expect(h.commands.onPause('hey Andy, book a table')).toBe('book a table');
  });
});

describe('speech model memory across calls', () => {
  it('remembers a failed model for a while, forgets it when it is back, and never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-state-'));
    const file = path.join(dir, 'sub', 'state.json');
    try {
      expect(ttsDownSince(file, 'tts-a')).toBeNull();
      setTtsDown(file, 'tts-a', true, 1_000);
      expect(ttsDownSince(file, 'tts-a', 2_000)).toBe(1_000);
      expect(ttsDownSince(file, 'tts-b', 2_000)).toBeNull();
      expect(ttsDownSince(file, 'tts-a', 1_000 + TTS_DOWN_MEMORY_MS)).toBeNull();
      setTtsDown(file, 'tts-a', false, 3_000);
      expect(ttsDownSince(file, 'tts-a', 3_000)).toBeNull();
      fs.writeFileSync(file, 'not json');
      expect(ttsDownSince(file, 'tts-a')).toBeNull();
      setTtsDown(path.join(file, 'not-a-dir', 'x.json'), 'tts-a', true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cue audio', () => {
  it('is 20 ms frames of 48 kHz mono: 150-250 ms of tone held near its level, with soft edges', () => {
    for (const kind of ['listening', 'wake', 'sent', 'discard', 'turn', 'nope', 'draft'] as const) {
      const frames = cueFrames(kind);
      for (const f of frames) expect([f.sampleRate, f.channels, f.samplesPerChannel]).toEqual([48_000, 1, 960]);
      const pcm = Int16Array.from(frames.flatMap((f) => [...f.data]));
      const ms = pcm.length / 48;
      expect(ms).toBeGreaterThanOrEqual(150);
      expect(ms).toBeLessThanOrEqual(260);
      // 5 ms windows: most of the cue holds within 6 dB of its loudest window; a decay to a click would not.
      const rms: number[] = [];
      for (let i = 0; i + 240 <= pcm.length; i += 240) {
        let sum = 0;
        for (let j = i; j < i + 240; j++) sum += pcm[j] * pcm[j];
        rms.push(Math.sqrt(sum / 240));
      }
      const loudest = Math.max(...rms);
      expect(rms.filter((r) => r >= loudest / 2).length / rms.length).toBeGreaterThan(0.75);
      expect(loudest).toBeGreaterThan(0.06 * 32767);
      expect(Math.max(...pcm.map(Math.abs))).toBeLessThanOrEqual(0.2 * 32767);
      // No click at either end.
      expect(Math.abs(pcm[0])).toBeLessThan(200);
      expect(Math.abs(pcm[pcm.length - 1])).toBeLessThan(200);
    }
    expect(cueFrames('sent')).toBe(cueFrames('sent'));
  });

  it('feeds the track a faint noise floor, a cue as soon as it is asked for, and says when the track took it', async () => {
    const taken: AudioFrame[] = [];
    let release!: () => void;
    let gate = Promise.resolve();
    const sink = {
      captureFrame: async (frame: AudioFrame) => {
        taken.push(frame);
        await gate;
      },
    };
    gate = new Promise((r) => (release = r));
    const feed = new CueFeed(sink);
    await flush();
    // The source is full: the feed waits on it, one noise frame in.
    expect(taken).toHaveLength(1);
    const noise = taken[0].data;
    expect(Math.max(...noise.map(Math.abs))).toBeGreaterThan(0);
    expect(Math.max(...noise.map(Math.abs))).toBeLessThanOrEqual(2);
    let played = false;
    const cue = cueFrames('sent');
    void feed.play(cue).then(() => (played = true));
    gate = Promise.resolve();
    release();
    await vi.waitFor(() => expect(played).toBe(true));
    // Right after the frame that was waiting: the whole cue, in order.
    expect(taken.slice(1, 1 + cue.length)).toEqual(cue);
    feed.stop();
    await feed.running;
    // Stopped: a cue asked for now resolves at once.
    await feed.play(cue);
  });

  it('ends on a failing source and lets every cue waiting on it go', async () => {
    let fail!: (err: Error) => void;
    const errors: unknown[] = [];
    const feed = new CueFeed({ captureFrame: () => new Promise((_, reject) => (fail = reject)) }, (err) =>
      errors.push(err),
    );
    await flush();
    const waiting = feed.play(cueFrames('sent'));
    fail(new Error('source closed'));
    await waiting;
    await feed.running;
    expect(errors).toHaveLength(1);
    await feed.play(cueFrames('sent'));
  });
});

describe('spoken commands and cues in a call', () => {
  function commandCall() {
    const v = fakeVoice();
    const r = fakeReviewVoice();
    let handle!: (op: ReviewOp, payload: string, callerIdentity: string) => Promise<string>;
    const played: CueKind[] = [];
    const dropped: unknown[] = [];
    Object.assign(v.voice, {
      review: { ...r.voice, serve: (h: typeof handle) => void (handle = h) },
      playCue: vi.fn(async (kind: CueKind) => void played.push(kind)),
      publishDropped: vi.fn((d: unknown) => void dropped.push(d)),
    });
    let gen = 0;
    const rpc = async (op: ReviewOp, fields: Partial<ReviewRequest> = {}) =>
      JSON.parse(await handle(op, JSON.stringify({ gen: ++gen, ...fields }), 'caller-1')) as Record<string, unknown>;
    /** One stretch of the caller's speech, as the session reports it: speaking, stopped, then the final. */
    const say = (text: string) => {
      v.events.onCallerSpeaking(true);
      v.events.onCallerSpeaking(false);
      v.events.onTranscript?.(text, true, 1);
    };
    return { v, r, rpc, played, dropped, say };
  }
  const utterances = (host: ReturnType<typeof fakeHostFetch>) =>
    host.calls.filter((c) => c.url.endsWith('/utterance')).map((c) => c.body?.text);

  it('plays the listening cue once the page said it wants cues, then sent on send it; none over speech', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = commandCall();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    expect(await c.rpc('settings', { wake: false, pauseSends: false, cues: true })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(c.played).toEqual(['listening']));
    expect(c.r.last.wake).toEqual({ on: false, pauseSends: false, waiting: false });

    c.say('Book a table for two. Send it.');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['Book a table for two.']));
    await vi.waitFor(() => expect(c.played).toEqual(['listening', 'sent']));
    // The session's own pause commits the same words later: nothing more goes out.
    c.v.events.onTurn('Book a table for two. Send it.', { sttModel: 'gemini-3.5-transcribe-live' });
    await flush();
    expect(utterances(host)).toHaveLength(1);

    // While the agent speaks, no cue: the caller is not heard then anyway.
    c.v.events.onAgentSpeaking?.(true);
    c.v.events.onTurn('Another turn', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() => expect(utterances(host)).toHaveLength(2));
    await flush();
    expect(c.played).toEqual(['listening', 'sent']);
    host.endStream();
  });

  it('a spoken discard posts nothing, marks the words dropped and plays the discard cue', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = commandCall();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    await c.rpc('settings', { cues: true });
    c.say('Call the plumber');
    c.say('scratch that');
    c.v.events.onTurn('Call the plumber scratch that', { sttModel: 'gemini-3.5-transcribe-live' });
    await vi.waitFor(() => expect(c.played).toEqual(['listening', 'discard']));
    expect(c.dropped).toEqual([{ dropped: 'discarded', text: 'Call the plumber scratch that' }]);
    expect(utterances(host)).toEqual([]);
    expect(c.v.voice.publishTurn).not.toHaveBeenCalled();
    host.endStream();
  });

  it('wake on: speech before the wake phrase goes nowhere, send it sends, a follow-up while the agent works', async () => {
    const { ctx } = fakeJob({ ...META, wakeNames: ['Енді'] });
    const host = fakeHostFetch();
    const c = commandCall();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
    expect(c.r.last.wake).toEqual({ on: true, pauseSends: false, waiting: true });
    expect(c.v.events.pausesSend?.()).toBe(false);

    c.say('So that is the plan.');
    c.v.events.onTurn('So that is the plan.', { sttModel: 'gemini-3.5-transcribe-live' });
    // Unaddressed noise is not a lost turn either.
    c.v.events.onTurnLost('empty', {}, { sttModel: 'gemini-3.5-transcribe-live' });
    await flush();
    expect(utterances(host)).toEqual([]);
    expect(c.v.voice.publishTurn).not.toHaveBeenCalled();
    expect(c.v.voice.say).not.toHaveBeenCalled();
    expect(c.dropped).toEqual([{ dropped: 'unaddressed', text: 'So that is the plan.' }]);

    c.say('Гей Енді, book a table');
    expect(c.r.last.wake?.waiting).toBe(false);
    c.v.events.onTurn('Гей Енді, book a table', { sttModel: 'gemini-3.5-transcribe-live' });
    c.say('for two, send it');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['book a table for two']));
    expect(c.r.last.wake?.waiting).toBe(true);

    // The agent works on it; a follow-up goes out as its own turn.
    host.emit({ type: 'thinking' });
    c.say('Hey Andy, and a taxi. Send it.');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['book a table for two', 'and a taxi.']));
    await vi.waitFor(() => expect(c.played).toEqual(['listening', 'wake', 'sent', 'wake', 'sent']));
    host.endStream();
  });

  it('plays your-turn once a reply is spoken and nothing else is queued; cues off plays nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = commandCall();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    // A call with no page asking: the listening cue comes after a wait.
    await vi.advanceTimersByTimeAsync(READY_CUE_WAIT_MS);
    expect(c.played).toEqual(['listening']);
    host.emit({ type: 'reply', text: 'Booked.', turn: null });
    await vi.advanceTimersByTimeAsync(TURN_CUE_DELAY_MS - 50);
    expect(c.v.voice.say).toHaveBeenCalledWith('Booked.');
    expect(c.played).toEqual(['listening']);
    await vi.advanceTimersByTimeAsync(100);
    expect(c.played).toEqual(['listening', 'turn']);

    // A first part of a reply while the agent keeps working: silence, no your-turn.
    host.emit({ type: 'reply', text: 'One moment.', turn: null });
    await vi.advanceTimersByTimeAsync(1);
    host.emit({ type: 'thinking' });
    await vi.advanceTimersByTimeAsync(TURN_CUE_DELAY_MS + 100);
    expect(c.v.voice.say).toHaveBeenCalledWith('One moment.');
    expect(c.played).toEqual(['listening', 'turn']);

    await c.rpc('settings', { cues: false });
    host.emit({ type: 'reply', text: 'Done.', turn: null });
    c.say('Thanks, send it.');
    await vi.advanceTimersByTimeAsync(TURN_CUE_DELAY_MS + 100);
    expect(c.played).toEqual(['listening', 'turn']);
    host.endStream();
  });

  it('a reply nobody heard (the speech model failed) shows as text and plays no your-turn cue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = commandCall();
    c.v.voice.say.mockResolvedValue(false);
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    await c.rpc('settings', { cues: true });
    host.emit({ type: 'reply', text: 'Booked for eight.', turn: null });
    await vi.advanceTimersByTimeAsync(TURN_CUE_DELAY_MS + 100);
    expect(c.v.voice.publishReply).toHaveBeenCalledWith({
      reply: 1,
      unprompted: true,
      unspoken: true,
      text: 'Booked for eight.',
    });
    expect(c.played).toEqual(['listening']);
    host.endStream();
  });

  it('speech under the agent is reported unheard; a command alone clears the countdown', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = commandCall();
    const unheard = vi.fn();
    const clearPending = vi.fn();
    Object.assign(c.v.voice, { publishUnheard: unheard, clearPending });
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    c.v.events.onUnheardSpeech?.();
    expect(unheard).toHaveBeenCalledTimes(1);
    c.say('Send it.');
    await vi.waitFor(() => expect(c.dropped).toEqual([{ dropped: 'command', text: 'Send it.' }]));
    expect(clearPending).toHaveBeenCalledTimes(1);
    expect(utterances(host)).toEqual([]);
    host.endStream();
  });

  it('speech before the wake phrase does not hold a waiting reply for the settle time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = commandCall();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
    c.v.events.onCallerSpeaking(true);
    host.emit({ type: 'reply', text: 'Booked.', turn: null });
    await vi.advanceTimersByTimeAsync(100);
    c.v.events.onCallerSpeaking(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(c.v.voice.say).not.toHaveBeenCalledWith('Booked.');
    c.v.events.onTranscript?.('So what did you think of the film?', true, 1);
    await vi.advanceTimersByTimeAsync(50);
    expect(c.v.voice.say).toHaveBeenCalledWith('Booked.');
    host.endStream();
  });

  it('replies that end close together are one hand-over: one your-turn cue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = commandCall();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    await c.rpc('settings', { cues: true });
    host.emit({ type: 'reply', text: 'Booked.', turn: null });
    await vi.advanceTimersByTimeAsync(TURN_CUE_DELAY_MS + 100);
    host.emit({ type: 'reply', text: 'And the taxi too.', turn: null });
    await vi.advanceTimersByTimeAsync(TURN_CUE_DELAY_MS + 100);
    expect(c.v.voice.say).toHaveBeenCalledTimes(2);
    expect(c.played).toEqual(['listening', 'turn']);
    // A later reply is a new hand-over.
    await vi.advanceTimersByTimeAsync(5_000);
    host.emit({ type: 'reply', text: 'Also, it may rain.', turn: null });
    await vi.advanceTimersByTimeAsync(TURN_CUE_DELAY_MS + 100);
    expect(c.played).toEqual(['listening', 'turn', 'turn']);
    host.endStream();
  });

  it('review mode: talk plays listening, a ready draft its own cue; spoken commands stand aside', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = commandCall();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice));
    await c.rpc('settings', { wake: true, cues: true });
    await c.rpc('mode', { mode: 'review' });
    expect(c.v.events.pausesSend?.()).toBe(false);
    expect(await c.rpc('talk')).toMatchObject({ ok: true, draft: 1 });
    c.v.events.onTranscript?.('Book a table, send it', true, 1);
    await c.rpc('done', { draft: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.r.last.draft).toMatchObject({ state: 'ready', text: 'Book a table, send it' });
    expect(c.played).toEqual(['listening', 'listening', 'draft']);
    expect(utterances(host)).toEqual([]);
    host.endStream();
  });
});

describe('the countdown in the session', () => {
  it('shows only when a pause would send the turn', () => {
    let pauses = true;
    const pending: string[] = [];
    const events: CallVoiceEvents = {
      onTurn: () => undefined,
      onCallerSpeaking: () => undefined,
      onTurnLost: () => undefined,
      onTurnDropped: () => undefined,
      onClosed: () => undefined,
      pausesSend: () => pauses,
    };
    const { session } = callSession(
      META,
      { geminiKey: 'gk-test', record: false },
      { vad: {} as VAD },
      events,
      { ...silentLog, error: () => undefined },
      (value) => pending.push(value),
    );
    const speak = () => {
      session.emit(agentsVoice.AgentSessionEventTypes.UserStateChanged, {
        type: 'user_state_changed',
        oldState: 'listening',
        newState: 'speaking',
        createdAt: Date.now(),
      });
      session.emit(agentsVoice.AgentSessionEventTypes.UserStateChanged, {
        type: 'user_state_changed',
        oldState: 'speaking',
        newState: 'listening',
        createdAt: Date.now() + 1000,
      });
    };
    const shown = () => pending.filter(Boolean);
    speak();
    expect(shown()).toEqual(['1:0:2500']);
    pauses = false;
    speak();
    // Speaking again clears the last one; no new one counts down.
    expect(shown()).toEqual(['1:0:2500']);
    expect(pending.at(-1)).toBe('');
  });

  it('clears on request, and says when the caller starts speaking under the agent', () => {
    const pending: string[] = [];
    let unheard = 0;
    const events: CallVoiceEvents = {
      onTurn: () => undefined,
      onCallerSpeaking: () => undefined,
      onTurnLost: () => undefined,
      onTurnDropped: () => undefined,
      onClosed: () => undefined,
      onUnheardSpeech: () => unheard++,
    };
    const { session, clearPending } = callSession(
      META,
      { geminiKey: 'gk-test', record: false },
      { vad: {} as VAD },
      events,
      { ...silentLog, error: () => undefined },
      (value) => pending.push(value),
    );
    const user = (oldState: 'listening' | 'speaking', newState: 'listening' | 'speaking') =>
      session.emit(agentsVoice.AgentSessionEventTypes.UserStateChanged, {
        type: 'user_state_changed',
        oldState,
        newState,
        createdAt: Date.now(),
      });
    user('listening', 'speaking');
    user('speaking', 'listening');
    expect(pending).toHaveLength(1);
    clearPending();
    expect(pending.at(-1)).toBe('');
    expect(unheard).toBe(0);
    session.emit(agentsVoice.AgentSessionEventTypes.AgentStateChanged, {
      type: 'agent_state_changed',
      oldState: 'listening',
      newState: 'speaking',
      createdAt: Date.now(),
    });
    user('listening', 'speaking');
    expect(unheard).toBe(1);
  });
});

describe('acoustic wake word', () => {
  it('finds the spotted phrase however the transcription spelled it', () => {
    const at = (text: string) => {
      const found = matchWakeText(text, 'hey livekit');
      return found && [text.slice(0, found.start), text.slice(found.end)];
    };
    expect(at('Hey, LiveKit, what time is it?')).toEqual(['', ', what time is it?']);
    expect(at('So that is settled. Hey Live Kit what time')).toEqual(['So that is settled. ', ' what time']);
    expect(at('hey live kid. Book a table')).toEqual(['', '. Book a table']);
    expect(at('Гей, Лайвкіт, котра година?')).toEqual(['', ', котра година?']);
    expect(at('Hi Lifekit')).toEqual(['', '']);
    // The name without a hey before it is the phrase too: the audio already said it was spoken.
    expect(at('LiveKit, book a table')).toEqual(['', ', book a table']);
    // Opening with hey, the words after it may be further off: the audio decided already.
    expect(at('Hey, little kid, remind me to buy milk')).toEqual(['', ', remind me to buy milk']);
    expect(at("Hey, you've got. What is the capital of France?")).toEqual(['', '. What is the capital of France?']);
    expect(at('Hey, look at it')).toEqual(['', ' it']);
    expect(at('Hey, what is the capital of France?')).toBeNull();
    expect(at('Hey, call me back')).toBeNull();
    expect(at('So, hey, little kid')).toBeNull();
    expect(at('we live in a kit house')).toBeNull();
    // Another model's phrase, by its file name.
    expect(matchWakeText('Hey Jarvis, lights', 'hey jarvis')).toEqual({ start: 0, end: 10 });
  });

  it("reads each role's model and threshold from the settings", () => {
    const wake = { name: 'wake', model: expect.stringMatching(/hey_livekit\.onnx$/), threshold: 0.68 };
    expect(spotterSettings({})).toEqual([wake]);
    expect(spotterSettings({ VOICE_WAKE_MODEL: 'off' })).toEqual([]);
    expect(spotterSettings({ VOICE_WAKE_MODEL: '/m/hey_jarvis.onnx' })).toEqual([
      { name: 'wake', model: '/m/hey_jarvis.onnx', threshold: 0.5 },
    ]);
    expect(spotterSettings({ VOICE_WAKE_THRESHOLD: '0.8' })[0].threshold).toBe(0.8);
    expect(spotterSettings({ VOICE_WAKE_THRESHOLD: '7' })[0].threshold).toBe(0.68);
    expect(
      spotterSettings({
        VOICE_WAKE_MODEL: 'none',
        VOICE_SEND_MODEL: '/m/send_it.onnx',
        VOICE_SEND_THRESHOLD: '0.9',
        VOICE_DISCARD_MODEL: 'models/scratch_that.onnx',
      }),
    ).toEqual([
      { name: 'send', model: '/m/send_it.onnx', threshold: 0.9 },
      { name: 'discard', model: path.resolve('models/scratch_that.onnx'), threshold: 0.5 },
    ]);
    expect(spotterSettings({ VOICE_SEND_MODEL: '/m/send_it.onnx', VOICE_DISCARD_MODEL: 'off' })).toEqual([
      wake,
      { name: 'send', model: '/m/send_it.onnx', threshold: 0.5 },
    ]);
  });

  function spotted() {
    let clock = 1_000_000;
    const h = commandsHarness(['Andy'], () => clock);
    h.commands.configure(true, false);
    h.commands.useWakeWord('hey livekit');
    return {
      ...h,
      tick: (ms: number) => void (clock += ms),
    };
  }

  it('the spotted wake word opens the turn; the transcript name does not; the phrase and what came before are dropped', () => {
    const h = spotted();
    expect(h.commands.state).toEqual({ on: true, pauseSends: false, waiting: true, phrase: 'hey livekit' });
    expect(h.commands.spotting).toBe(true);
    h.say('Hey Andy, book a table.');
    expect(h.commands.waiting).toBe(true);
    // Held a moment: a wake word spotted just after it may make it the turn.
    expect(h.dropped).toEqual([]);

    h.commands.onWakeWord();
    // It has no `hey livekit`: ignored after all.
    expect(h.dropped).toEqual([['unaddressed', 'Hey Andy, book a table.']]);
    expect(h.commands.waiting).toBe(false);
    expect(h.commands.spotting).toBe(false);
    expect(h.cues).toEqual(['wake']);
    h.commands.onTranscript('So that is settled. Hey LiveKit, book', false);
    expect(h.heard.at(-1)).toEqual(['book', false]);
    h.say('So that is settled. Hey LiveKit, book a table');
    expect(h.dropped.at(-1)).toEqual(['unaddressed', 'So that is settled.']);
    // After the first final with the phrase, the name is a word again.
    h.say('at the LiveKit cafe. Send it.');
    expect(h.sent).toEqual(['book a table at the LiveKit cafe.']);
    expect(h.commands.waiting).toBe(true);
  });

  it('a final with only the phrase ends its interim text and keeps nothing', () => {
    const h = spotted();
    h.commands.onWakeWord();
    h.commands.onTranscript('Hey LiveKit', false);
    h.say('Hey, LiveKit.');
    expect(h.heard).toEqual([
      ['', false],
      ['', true],
    ]);
    h.say('What time is it? Send it.');
    expect(h.sent).toEqual(['What time is it?']);
  });

  it('a final that came just before the wake word, with its phrase, is the turn after all', () => {
    const h = spotted();
    h.say('Hey LiveKit, what time is it');
    h.tick(1_500);
    h.commands.onWakeWord();
    expect(h.heard).toEqual([['what time is it', true]]);
    // Never reported as ignored: the page leaves the line open for the turn.
    expect(h.dropped).toEqual([]);
    h.say('Send it.');
    expect(h.sent).toEqual(['what time is it']);

    // Too long before, or without the phrase: it stays unaddressed.
    h.say('Hey LiveKit, call mum');
    h.tick(5_000);
    h.commands.onWakeWord();
    expect(h.dropped).toEqual([['unaddressed', 'Hey LiveKit, call mum']]);
    h.say('Send it.');
    expect(h.sent).toEqual(['what time is it']);
    expect(h.cues.at(-1)).toBe('nope');
  });

  it('a late final loses only its words before the phrase, and a near miss is not the phrase', () => {
    const h = spotted();
    h.say('So that is settled. Hey LiveKit, book a table');
    h.commands.onWakeWord();
    expect(h.dropped).toEqual([['unaddressed', 'So that is settled.']]);
    h.say('Send it.');
    expect(h.sent).toEqual(['book a table']);

    // Ordinary words that only sound near the name are not taken into the turn.
    h.say('Hey, look at it. Delete the old files');
    h.commands.onWakeWord();
    expect(h.dropped.at(-1)).toEqual(['unaddressed', 'Hey, look at it. Delete the old files']);
    expect(h.heard.filter(([text]) => text.includes('Delete'))).toEqual([]);
  });

  it('reports a held final as unaddressed once no wake word came for it, or when a newer one arrives', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = spotted();
    h.say('So what did you think of the film?');
    h.say('Anyway.');
    expect(h.dropped).toEqual([['unaddressed', 'So what did you think of the film?']]);
    vi.advanceTimersByTime(2_900);
    expect(h.dropped).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(h.dropped.at(-1)).toEqual(['unaddressed', 'Anyway.']);
    // Switching the wake off reports what it held at once.
    h.say('Never mind.');
    h.commands.configure(false, false);
    expect(h.dropped.at(-1)).toEqual(['unaddressed', 'Never mind.']);
  });

  it('looks for the phrase in two finals at most; a later one keeps every word', () => {
    const h = spotted();
    h.commands.onWakeWord();
    h.say('Book a table');
    h.say('for two');
    h.say('near LiveKit HQ. Send it.');
    expect(h.sent).toEqual(['Book a table for two near LiveKit HQ.']);
  });

  it('a wake word heard after the turn opened only loses its phrase', () => {
    const h = spotted();
    h.commands.onWakeWord();
    h.say('Book a table');
    h.commands.onWakeWord();
    expect(h.cues).toEqual(['wake']);
    h.say('for two, hey LiveKit, at eight. Send it.');
    expect(h.sent).toEqual(['Book a table for two at eight.']);
    expect(h.dropped).toEqual([]);
  });

  it('does nothing with the wake switch off, and goes back to the transcript name without the model', () => {
    const h = spotted();
    h.commands.configure(false, false);
    h.commands.onWakeWord();
    expect(h.cues).toEqual([]);
    h.commands.configure(true, false);
    h.commands.useWakeWord(undefined);
    expect(h.commands.state).toEqual({ on: true, pauseSends: false, waiting: true });
    h.say('Hey Andy, book a table. Send it.');
    expect(h.sent).toEqual(['book a table.']);
  });
});

describe('spotted commands', () => {
  it('finds a spotted command however the transcription heard it, and whether it ends the text', () => {
    const at = (text: string, phrase = 'send it') => {
      const found = matchSpottedCommand(text, phrase);
      return found && [text.slice(0, found.start), found.last];
    };
    expect(at('Book a table for two, sent in.')).toEqual(['Book a table for two, ', true]);
    expect(at('Book a table. Send it.')).toEqual(['Book a table. ', true]);
    expect(at('Book a table, sandy')).toEqual(['Book a table, ', true]);
    expect(at('Сенд іт')).toEqual(['', true]);
    expect(at('send it to Anna tomorrow')).toEqual(['', false]);
    // Other words that share its consonants without its first one are words.
    expect(at('I will not, and then into it')).toBeNull();
    expect(at('Book a table')).toBeNull();
    expect(at('No wait, scratched at.', 'scratch that')).toEqual(['No wait, ', true]);
    expect(at('No wait, catch that', 'scratch that')).toEqual(['No wait, ', true]);
    expect(at('Call the plumber', 'scratch that')).toBeNull();
  });

  it('a short wake name matches with any vowel: hey Den is hey dan', () => {
    const at = (text: string) => {
      const found = matchWakeText(text, 'hey dan');
      return found && [text.slice(0, found.start), text.slice(found.end)];
    };
    expect(at('Hey Den, book a table')).toEqual(['', ', book a table']);
    expect(at('Гей, Ден, котра година?')).toEqual(['', ', котра година?']);
    expect(at('Hey Dan.')).toEqual(['', '.']);
    expect(at('Hey, then what?')).toBeNull();
  });

  function open() {
    let clock = 1_000_000;
    const h = commandsHarness(['Andy'], () => clock);
    h.commands.configure(true, false);
    h.say('Hey Andy');
    expect(h.cues).toEqual(['wake']);
    return { ...h, tick: (ms: number) => void (clock += ms) };
  }

  it('acts on the next final that ends in its words, however misheard', () => {
    const h = open();
    h.say('Book a table');
    h.commands.onCommandWord('send', 'send it');
    h.say('for two, sent in.');
    expect(h.sent).toEqual(['Book a table for two']);
    expect(h.commands.waiting).toBe(true);

    h.say('Hey Andy');
    h.say('Call the plumber');
    h.commands.onCommandWord('discard', 'scratch that');
    h.say('no wait, scratched at.');
    expect(h.dropped.at(-1)).toEqual(['discarded', 'Call the plumber no wait, scratched at.']);
    expect(h.cues.at(-1)).toBe('discard');
    expect(h.commands.waiting).toBe(true);
  });

  it('the transcript command acts once; a final that goes on past the words makes them words', () => {
    const h = open();
    h.commands.onCommandWord('send', 'send it');
    h.say('Book a table. Send it.');
    expect(h.sent).toEqual(['Book a table.']);

    h.say('Hey Andy');
    h.commands.onCommandWord('send', 'send it');
    h.say('Send it to Anna tomorrow');
    expect(h.sent).toEqual(['Book a table.']);
    expect(h.commands.onPause('')).toBeNull();
    // A final with none of its words keeps it waiting; the next one that ends in them acts.
    h.commands.onCommandWord('send', 'send it');
    h.say('and to Bob');
    h.say('sandy');
    expect(h.sent).toEqual(['Book a table.', 'Send it to Anna tomorrow and to Bob']);
  });

  it('a final just before it may have been the one', () => {
    const h = open();
    h.say('Book a table, sandy');
    h.tick(800);
    h.commands.onCommandWord('send', 'send it');
    expect(h.sent).toEqual(['Book a table']);

    // Too long before: it waits for a final of its own.
    h.say('Hey Andy');
    h.say('Call mum, sandy');
    h.tick(5_000);
    h.commands.onCommandWord('send', 'send it');
    expect(h.sent).toEqual(['Book a table']);
  });

  it('with no final in time it acts on what the turn holds, unless the caller still talks', () => {
    vi.useFakeTimers();
    const h = open();
    h.say('Book a table');
    h.commands.onCommandWord('send', 'send it');
    vi.advanceTimersByTime(2_900);
    expect(h.sent).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(h.sent).toEqual(['Book a table']);

    h.say('Hey Andy');
    h.say('Call the plumber');
    h.commands.onCommandWord('send', 'send it');
    h.commands.onCallerSpeaking(true);
    vi.advanceTimersByTime(3_100);
    expect(h.sent).toEqual(['Book a table']);
    h.commands.onCallerSpeaking(false);
  });

  it('does nothing while waiting for the wake phrase, and a switch drops what waits', () => {
    vi.useFakeTimers();
    let clock = 0;
    const h = commandsHarness(['Andy'], () => clock);
    h.commands.configure(true, false);
    h.commands.onCommandWord('send', 'send it');
    h.say('Book a table, sandy');
    expect(h.sent).toEqual([]);
    expect(h.commands.listensForCommands).toBe(false);
    h.say('Hey Andy');
    expect(h.commands.listensForCommands).toBe(true);
    h.say('Book a table');
    clock += 10_000;
    h.commands.onCommandWord('send', 'send it');
    h.commands.configure(false, false);
    vi.advanceTimersByTime(5_000);
    expect(h.sent).toEqual([]);
  });
});

describe('awake limits and the wake cut', () => {
  function awake(limits = { startMs: 8_000, idleMs: 20_000 }) {
    vi.useFakeTimers();
    const h = commandsHarness(['Andy'], undefined, limits);
    h.commands.configure(true, false);
    h.commands.useWakeWord('hey livekit');
    return h;
  }

  it('reads its limits from the settings, in seconds; 0 is never', () => {
    expect(awakeLimits({})).toEqual({ startMs: 8_000, idleMs: 20_000 });
    expect(awakeLimits({ VOICE_WAKE_START_SECONDS: '5', VOICE_WAKE_IDLE_SECONDS: '0' })).toEqual({
      startMs: 5_000,
      idleMs: 0,
    });
    expect(awakeLimits({ VOICE_WAKE_START_SECONDS: 'soon', VOICE_WAKE_IDLE_SECONDS: '-1' })).toEqual({
      startMs: 8_000,
      idleMs: 20_000,
    });
  });

  it('nothing said after the wake phrase: back to waiting with the sleep cue, nothing sent', () => {
    const h = awake();
    h.commands.onWakeWord(true);
    expect(h.commands.waiting).toBe(false);
    vi.advanceTimersByTime(7_900);
    expect(h.commands.waiting).toBe(false);
    vi.advanceTimersByTime(200);
    expect(h.commands.waiting).toBe(true);
    expect(h.cues).toEqual(['wake', 'sleep']);
    expect(h.commands.state).toMatchObject({ waiting: true, heard: 1, slept: 1 });
    expect(h.dropped).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('words held, then silence: they are dropped as asleep; speech keeps the turn open', () => {
    const h = awake();
    h.commands.onWakeWord(true);
    h.commands.onCallerSpeaking(true);
    vi.advanceTimersByTime(30_000);
    expect(h.commands.waiting).toBe(false);
    h.commands.onCallerSpeaking(false);
    h.commands.onTranscript('Send it or not send it?', true);
    vi.advanceTimersByTime(19_000);
    h.say('Hmm, let me think.');
    vi.advanceTimersByTime(19_000);
    expect(h.commands.waiting).toBe(false);
    vi.advanceTimersByTime(1_100);
    expect(h.commands.waiting).toBe(true);
    expect(h.dropped).toEqual([['asleep', 'Send it or not send it? Hmm, let me think.']]);
    expect(h.cues).toEqual(['wake', 'sleep']);
    expect(h.sent).toEqual([]);
    // Nothing waits after a send.
    h.commands.onWakeWord(true);
    h.say('Book a table. Send it.');
    expect(h.sent).toEqual(['Book a table.']);
    vi.advanceTimersByTime(60_000);
    expect(h.cues).toEqual(['wake', 'sleep', 'wake']);
  });

  it('0 turns a limit off', () => {
    const h = awake({ startMs: 0, idleMs: 0 });
    h.commands.onWakeWord(true);
    vi.advanceTimersByTime(120_000);
    expect(h.commands.waiting).toBe(false);
  });

  it('a cut wake searches no text for the phrase, and reports a held final as ignored at once', () => {
    const h = awake();
    h.say('So that is settled.');
    expect(h.dropped).toEqual([]);
    h.commands.onWakeWord(true);
    expect(h.dropped).toEqual([['unaddressed', 'So that is settled.']]);
    // A name in the turn stays: nothing is stripped.
    h.say('LiveKit docs, open them. Send it.');
    expect(h.sent).toEqual(['LiveKit docs, open them.']);
  });

  it('a question that ends in the send words asks, it does not send', () => {
    expect(matchCommand('Send it or not send it?')).toBeNull();
    expect(matchCommand('Should I send it?')).toBeNull();
    expect(matchCommand('Is that it? Send it.')).toEqual({ command: 'send', rest: 'Is that it?' });
    expect(matchCommand('Scratch that?')).toBeNull();
  });

  it('the replay buffer gives a restarted stream the input since the cut, the cut frame trimmed', () => {
    const buf = new ReplayBuffer();
    const frame = (n: number, value: number) => new AudioFrame(new Int16Array(n).fill(value), 16_000, 1, n);
    for (let i = 1; i <= 5; i++) buf.keep(frame(320, i)); // 5 x 20 ms
    expect(buf.take()).toEqual([]);
    buf.cut(30);
    // Taken after the cut, before the new stream starts: given back too.
    buf.keep(frame(320, 6));
    const replay = buf.take();
    expect(replay.map((f) => f.samplesPerChannel)).toEqual([160, 320, 320]);
    expect(replay.map((f) => f.data[0])).toEqual([4, 5, 6]);
    expect(buf.take()).toEqual([]);
    // Only the last 10 s are kept.
    for (let i = 0; i < 1_000; i++) buf.keep(frame(320, 7));
    buf.cut(60_000);
    expect(buf.take().reduce((ms, f) => ms + f.samplesPerChannel / 16, 0)).toBe(10_000);
  });
});

describe('acoustic wake word in a call', () => {
  function fakeWakeWord(
    load: 'ok' | 'fail' = 'ok',
    phrases: Partial<Record<SpotterRole, string>> = { wake: 'hey livekit' },
  ) {
    let events!: WakeWordEvents;
    const pushed: number[] = [];
    const listening: string[] = [];
    const wake = {
      phrases,
      thresholds: { wake: 0.68 },
      failed: {},
      ready: load === 'ok' ? Promise.resolve() : Promise.reject(new Error('wake word model not found: x')),
      listen: vi.fn((roles: readonly SpotterRole[]) => void listening.push(roles.join('+'))),
      push: vi.fn((pcm: Int16Array) => void pushed.push(pcm.length)),
      summary: { scored: 0, skipped: 0, meanMs: 0, maxMs: 0, detections: {}, maxScore: {} },
      utilization: 0,
      close: vi.fn(async () => undefined),
    } satisfies WakeWord;
    wake.ready.catch(() => undefined);
    const make = vi.fn((e: WakeWordEvents) => {
      events = e;
      return wake;
    });
    return {
      wake,
      make,
      pushed,
      listening,
      get events() {
        return events;
      },
    };
  }
  function wakeCall() {
    const v = fakeVoice();
    const r = fakeReviewVoice();
    let handle!: (op: ReviewOp, payload: string, callerIdentity: string) => Promise<string>;
    const played: CueKind[] = [];
    const dropped: unknown[] = [];
    Object.assign(v.voice, {
      review: { ...r.voice, serve: (h: typeof handle) => void (handle = h) },
      playCue: vi.fn(async (kind: CueKind) => void played.push(kind)),
      publishDropped: vi.fn((d: unknown) => void dropped.push(d)),
    });
    const rpc = async (op: ReviewOp, fields: Partial<ReviewRequest> = {}) =>
      JSON.parse(await handle(op, JSON.stringify({ gen: 1, ...fields }), 'caller-1')) as Record<string, unknown>;
    const say = (text: string) => {
      v.events.onCallerSpeaking(true);
      v.events.onCallerSpeaking(false);
      v.events.onTranscript?.(text, true, 1);
    };
    const frame = (samples = 160, rate = 16_000) =>
      v.events.onAudio?.(new AudioFrame(new Int16Array(samples), rate, 1, samples));
    return { v, r, rpc, played, dropped, say, frame };
  }
  const utterances = (host: ReturnType<typeof fakeHostFetch>) =>
    host.calls.filter((c) => c.url.endsWith('/utterance')).map((c) => c.body?.text);

  it('a detection opens the turn like the wake phrase; the page hears the phrase; audio is scored only while waiting', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = wakeCall();
    const w = fakeWakeWord();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice, { wakeWord: w.make }));
    await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
    await vi.waitFor(() =>
      expect(c.r.last.wake).toEqual({ on: true, pauseSends: false, waiting: true, phrase: 'hey livekit' }),
    );

    c.frame();
    c.frame(160, 48_000);
    expect(w.pushed).toEqual([160]);
    expect(w.listening.at(-1)).toBe('wake');
    c.v.events.onAgentSpeaking?.(true);
    c.frame();
    expect(w.listening.at(-1)).toBe('');
    c.v.events.onAgentSpeaking?.(false);

    c.say('Hey Andy, so the plan is set.');
    expect(c.dropped).toEqual([]);
    w.events.onDetect('wake', 0.97, 0);
    expect(c.dropped).toEqual([{ dropped: 'unaddressed', text: 'Hey Andy, so the plan is set.' }]);
    expect(c.r.last.wake?.waiting).toBe(false);
    // The open turn listens for the commands instead.
    c.frame();
    expect(w.listening.at(-1)).toBe('send+discard');
    c.say('Hey, LiveKit. Book a table for two. Send it.');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['Book a table for two.']));
    await vi.waitFor(() => expect(c.played).toEqual(['listening', 'wake', 'sent']));
    expect(c.r.last.wake?.waiting).toBe(true);
    c.frame();
    expect(w.listening.at(-1)).toBe('wake');
    host.endStream();
    await vi.waitFor(() => expect(w.wake.close).toHaveBeenCalled());
  });

  it('a detection restarts the transcription at the phrase: the turn is only what came after it', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = wakeCall();
    const w = fakeWakeWord();
    let stream = 1;
    const cut = vi.fn((_afterMs: number) => ++stream);
    Object.assign(c.v.voice, { cutTranscription: cut });
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice, { wakeWord: w.make }));
    await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
    await vi.waitFor(() => expect(c.r.last.wake?.phrase).toBe('hey livekit'));
    c.say('So the plan is set.');

    // 4000 samples after the window with the phrase: 250 ms of audio the new stream hears again.
    w.events.onDetect('wake', 0.9, 4_000);
    expect(cut).toHaveBeenCalledWith(250);
    expect(c.dropped).toEqual([{ dropped: 'unaddressed', text: 'So the plan is set.' }]);
    expect(c.r.last.wake).toMatchObject({ waiting: false, heard: 1, cut: true });
    // The old stream's late words (the phrase) are past: never part of the turn.
    c.v.events.onTranscript?.('Hey Lively', false, 1);
    c.v.events.onTranscript?.('Hey Lively kit, book', true, 1);
    c.v.events.onCallerSpeaking(true);
    c.v.events.onCallerSpeaking(false);
    c.v.events.onTranscript?.('Book a table for two. Send it.', true, 2);
    await vi.waitFor(() => expect(utterances(host)).toEqual(['Book a table for two.']));

    // Without a restart (it failed), the phrase is taken out of the text as before.
    cut.mockReturnValueOnce(undefined as unknown as number);
    w.events.onDetect('wake', 0.9, 0);
    expect(c.r.last.wake).toMatchObject({ waiting: false, heard: 2 });
    expect(c.r.last.wake?.cut).toBeUndefined();
    c.v.events.onCallerSpeaking(true);
    c.v.events.onCallerSpeaking(false);
    c.v.events.onTranscript?.('Hey, LiveKit. What time is it? Send it.', true, 3);
    await vi.waitFor(() => expect(utterances(host)).toEqual(['Book a table for two.', 'What time is it?']));
    host.endStream();
  });

  it('speech with no transcript yet in an open turn is not lost: late words join the turn', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = wakeCall();
    const w = fakeWakeWord();
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice, { wakeWord: w.make }));
    await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
    await vi.waitFor(() => expect(c.r.last.wake?.phrase).toBe('hey livekit'));
    w.events.onDetect('wake', 0.9, 0);
    c.v.events.onTurnLost('empty', { speechMs: 900 }, { sttModel: 'gemini-3.5-transcribe-live' });
    expect(c.v.voice.publishTurn).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'lost' }));
    c.say('Can I discard this message somehow?');
    c.say('Send it.');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['Can I discard this message somehow?']));
    host.endStream();
  });

  it('names the phrase while the model loads, and takes it back if it fails', async () => {
    const { ctx } = fakeJob();
    const c = wakeCall();
    let fail!: (err: Error) => void;
    const w = fakeWakeWord();
    Object.assign(w.wake, { ready: new Promise<void>((_, reject) => (fail = reject)) });
    w.wake.ready.catch(() => undefined);
    await runCall(ctx, deps(fakeHostFetch().fetchImpl, c.v.createVoice, { wakeWord: w.make }));
    await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
    expect(c.r.last.wake).toEqual({ on: true, pauseSends: false, waiting: true, phrase: 'hey livekit' });
    c.frame();
    expect(w.pushed).toEqual([]);
    fail(new Error('wake word model not found: x'));
    await vi.waitFor(() => expect(c.r.last.wake).toEqual({ on: true, pauseSends: false, waiting: true }));
  });

  it('falls back to the transcript name when the model does not load, or stops', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = wakeCall();
    const w = fakeWakeWord('fail');
    const warn = vi.fn();
    await runCall(
      ctx,
      deps(host.fetchImpl, c.v.createVoice, { wakeWord: w.make, log: { info: () => undefined, warn } }),
    );
    await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no wake word model'), expect.anything()),
    );
    expect(c.r.last.wake).toEqual({ on: true, pauseSends: false, waiting: true });
    c.frame();
    expect(w.pushed).toEqual([]);
    c.say('Hey Andy, book a table. Send it.');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['book a table.']));
    host.endStream();

    const second = fakeJob();
    const c2 = wakeCall();
    const w2 = fakeWakeWord();
    await runCall(second.ctx, deps(fakeHostFetch().fetchImpl, c2.v.createVoice, { wakeWord: w2.make }));
    await c2.rpc('settings', { wake: true, pauseSends: false, cues: true });
    await vi.waitFor(() => expect(c2.r.last.wake?.phrase).toBe('hey livekit'));
    w2.events.onError('thread exited');
    expect(c2.r.last.wake).toEqual({ on: true, pauseSends: false, waiting: true });
  });

  it('spotted commands send and discard the open turn the wake word opened', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const c = wakeCall();
    const w = fakeWakeWord('ok', { wake: 'hey dan', send: 'send it', discard: 'scratch that' });
    await runCall(ctx, deps(host.fetchImpl, c.v.createVoice, { wakeWord: w.make }));
    await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
    await vi.waitFor(() => expect(c.r.last.wake?.phrase).toBe('hey dan'));
    c.frame();
    expect(w.listening.at(-1)).toBe('wake');

    w.events.onDetect('wake', 0.9, 0);
    c.frame();
    expect(w.listening.at(-1)).toBe('send+discard');
    c.v.events.onAgentSpeaking?.(true);
    c.frame();
    expect(w.listening.at(-1)).toBe('');
    c.v.events.onAgentSpeaking?.(false);
    c.say('Hey Den, book a table for two');
    w.events.onDetect('send', 0.8, 0);
    c.say('sent in.');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['book a table for two']));
    expect(c.r.last.wake?.waiting).toBe(true);

    w.events.onDetect('wake', 0.9, 0);
    c.say('Call the plumber');
    w.events.onDetect('discard', 0.8, 0);
    c.say('scratch that.');
    await vi.waitFor(() => expect(c.played).toEqual(['listening', 'wake', 'sent', 'wake', 'discard']));
    expect(utterances(host)).toEqual(['book a table for two']);
    // While waiting, a spotted command does nothing.
    w.events.onDetect('send', 0.8, 0);
    c.say('Book a table, send it.');
    expect(utterances(host)).toEqual(['book a table for two']);
    host.endStream();
  });

  it('a real spotter on real audio: the wake word opens the turn, other speech does not', async () => {
    const wav = (name: string) => {
      const buf = fs.readFileSync(new URL(`./voice-wakeword-fixtures/${name}`, import.meta.url));
      const data = buf.indexOf('data', 12);
      return new Int16Array(
        buf.buffer.slice(buf.byteOffset + data + 8, buf.byteOffset + data + 8 + buf.readUInt32LE(data + 4)),
      );
    };
    const { WakeWordSpotter, DEFAULT_WAKE_MODEL } = await import('./voice-wakeword.js');
    const run = async (audio: Int16Array) => {
      const { ctx } = fakeJob();
      const host = fakeHostFetch();
      const c = wakeCall();
      let spotter!: InstanceType<typeof WakeWordSpotter>;
      await runCall(
        ctx,
        deps(host.fetchImpl, c.v.createVoice, {
          wakeWord: (events: WakeWordEvents) =>
            (spotter = new WakeWordSpotter<SpotterRole>({
              classifiers: [{ name: 'wake', model: DEFAULT_WAKE_MODEL, threshold: 0.68 }],
              ...events,
            })),
        }),
      );
      await c.rpc('settings', { wake: true, pauseSends: false, cues: true });
      await vi.waitFor(() => expect(c.r.last.wake?.phrase).toBe('hey livekit'));
      await spotter.ready;
      // 20 ms frames, as the room delivers them, each 80 ms waiting for its score.
      for (let at = 0; at < audio.length; at += 320) {
        c.v.events.onAudio?.(new AudioFrame(audio.slice(at, at + 320), 16_000, 1, Math.min(320, audio.length - at)));
        while ((spotter as unknown as { inflight: boolean }).inflight) await new Promise((r) => setTimeout(r, 1));
      }
      const waiting = c.r.last.wake?.waiting;
      const summary = spotter.summary;
      host.endStream();
      return { waiting, summary, played: c.played };
    };
    const silence = new Int16Array(16_000);
    const positive = wav('positive.wav');
    const yes = await run(Int16Array.from([...silence, ...silence, ...positive, ...silence]));
    expect(yes.waiting).toBe(false);
    expect(yes.summary.detections).toEqual({ wake: 1 });
    await vi.waitFor(() => expect(yes.played).toContain('wake'));
    // The same voice and level, played backwards: no wake word.
    const no = await run(Int16Array.from([...silence, ...silence, ...positive.slice().reverse(), ...silence]));
    expect(no.summary.scored).toBeGreaterThan(20);
    expect(no.summary.maxScore.wake).toBeLessThan(0.68);
    expect(no.waiting).toBe(true);
  });
});
