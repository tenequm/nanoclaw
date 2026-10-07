/**
 * The voice call worker: the turn-taking rules (turn order, reply gating, thinking, failure
 * lines) against fake host and voice, the call's turn state machine (CallTurns) against a fake
 * transcription, review mode, the speech output against fake speech models, the text helpers, and
 * runCall end to end with a fake room. LiveKit, Silero and Gemini themselves are not loaded here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';

import { AgentServer, InferenceRunner, initializeLogger, ServerOptions, VADEventType } from '@livekit/agents';
import { AudioFrame, DisconnectReason } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CALL_COMMAND_WORDS,
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  liveKitHostUrl,
  type CallReviewState,
  type LiveKitJobMetadata,
  type ReviewOp,
  type ReviewRequest,
} from './channels/voice-mode-protocol.js';
import type { Heard } from './voice-mode-gemini-live.js';
import {
  AWAIT_REPLY_MS,
  AudioRing,
  CALLER_REJOIN_MS,
  callerRejoinWaitMs,
  callLanguages,
  CallTurns,
  capSpokenText,
  COMMAND_SETTLE_MS,
  COMMAND_VOCABULARY,
  COMMAND_WORDS_JSON,
  captionMark,
  type CaptionMark,
  CUT_LINES,
  DEFAULT_MAX_SPOKEN_CHARS,
  FAILURE_LINES,
  GeminiSpeech,
  HostLink,
  hostLossReason,
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
  TTS_RECOVERY_DELAY_MS,
  TURN_SETTLE_MS,
  TurnCapture,
  TurnTaking,
  turnText,
  CueFeed,
  cueFrames,
  deEsser,
  lineFilter,
  whistleNotch,
  WHISTLE_NOTCHES,
  ttsNotch,
  ttsDeess,
  TTS_SAMPLE_RATE,
  matchCommand,
  matchWake,
  wakeWordSettings,
  awakeLimits,
  endsLike,
  Outbox,
  loadTypingSound,
  audioLevels,
  CallTelemetry,
  CallerInput,
  LineMeter,
  TURN_EVENT_WAIT_MS,
  type TurnFacts,
  type VadStream,
  type WakeWord,
  type WakeWordEvents,
  TURN_CUE_DELAY_MS,
  wakeNameWords,
  type CueKind,
  readReviewRequest,
  ReviewControl,
  type Recording,
  type ReviewDeps,
  type SpeechModel,
  type Transcription,
  writeTurnRecording,
  workerEnv,
  type CallJob,
  type CallVoice,
  type CallVoiceEvents,
  type TurnAudio,
  type TurnRecord,
  type VoiceModeSettings,
  type SendResult,
  type TurnTakingDeps,
} from './voice-mode-worker.js';

initializeLogger({ pretty: false, level: 'error' });

const flush = () => new Promise((r) => setTimeout(r, 5));
const SILENCE = 2500;
const silentLog = { info: () => undefined, warn: () => undefined };

afterEach(() => {
  vi.useRealTimers();
});

describe('worker settings', () => {
  it('reads an old setting under its new name and warns about it once per process', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-mode-worker-env-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fs.writeFileSync(path.join(root, '.env'), 'VOICE_TTS_VOICE=Kore\n');
      for (let call = 0; call < 3; call++) {
        expect(workerEnv(['VOICE_MODE_TTS_VOICE'], root).VOICE_MODE_TTS_VOICE).toBe('Kore');
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('voice-mode: VOICE_TTS_VOICE is deprecated; use VOICE_MODE_TTS_VOICE');
    } finally {
      warn.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
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

  it('reads VOICE_MODE_MAX_SPOKEN_CHARS, with no cap unless it sets one', () => {
    expect(maxSpokenChars(undefined)).toBe(DEFAULT_MAX_SPOKEN_CHARS);
    expect(DEFAULT_MAX_SPOKEN_CHARS).toBe(0);
    expect(maxSpokenChars(' 400 ')).toBe(400);
    expect(maxSpokenChars('0')).toBe(0);
    expect(maxSpokenChars('-5')).toBe(DEFAULT_MAX_SPOKEN_CHARS);
    expect(maxSpokenChars('lots')).toBe(DEFAULT_MAX_SPOKEN_CHARS);
  });

  it('de-esses the agent speech: flat through the voice band, about 6 dB off a lone sibilant, and off is a passthrough', () => {
    const rate = TTS_SAMPLE_RATE;
    const frame = rate / 50;
    /** One second of tones (Hz to linear amplitude), through one line's filter in 20 ms frames. */
    const run = (tones: Array<[number, number]>, filter = deEsser({ sampleRate: rate })) => {
      const input = new Int16Array(rate);
      for (let i = 0; i < input.length; i++) {
        input[i] = Math.round(
          tones.reduce((sum, [hz, amp]) => sum + amp * Math.sin((2 * Math.PI * hz * i) / rate), 0) * 32767,
        );
      }
      const output = new Int16Array(input.length);
      for (let at = 0; at < input.length; at += frame) output.set(filter(input.subarray(at, at + frame)), at);
      return { input, output };
    };
    // The level after the first 200 ms (the filters and the detector settled), in dB against the input's.
    const gainDb = ({ input, output }: { input: Int16Array; output: Int16Array }) => {
      const rms = (pcm: Int16Array) => {
        let sum = 0;
        for (let i = rate / 5; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        return Math.sqrt(sum / (pcm.length - rate / 5));
      };
      return 20 * Math.log10(rms(output) / rms(input));
    };
    for (const hz of [300, 2_000, 4_500]) expect(Math.abs(gainDb(run([[hz, 0.5]])))).toBeLessThan(0.1);
    // The band is cut by the full 6 dB; what the low band still passes there (LR4) leaves -5.1 dB at
    // 6.5 kHz, -5.8 dB at 8 kHz.
    for (const hz of [6_500, 7_200, 8_000]) {
      const db = gainDb(run([[hz, 0.5]]));
      expect(db).toBeLessThan(-5);
      expect(db).toBeGreaterThan(-6.1);
    }
    // A voice's body with quieter hiss over it is left alone: once the tones are in (the hiss's first
    // millisecond outruns the body's envelope), what the crossover alone gives, to the last bit.
    const voiced = run([
      [300, 0.5],
      [6_500, 0.1],
    ]);
    const uncut = run(
      [
        [300, 0.5],
        [6_500, 0.1],
      ],
      deEsser({ sampleRate: rate, maxDb: 0 }),
    );
    let most = 0;
    for (let i = rate / 2; i < rate; i++) most = Math.max(most, Math.abs(voiced.output[i] - uncut.output[i]));
    expect(most).toBeLessThanOrEqual(1);
    // Off, the line goes out exactly as synthesized.
    const off = run([[7_000, 0.5]], lineFilter({ deess: false, notch: false }));
    expect(off.output).toEqual(off.input);
    expect(ttsDeess(undefined)).toBe(true);
    expect(ttsDeess('1')).toBe(true);
    for (const raw of ['0', 'off', ' OFF ', 'false']) expect(ttsDeess(raw)).toBe(false);

    // The whistle notches: the model's loud whistle tones go, the voice stays.
    const notch = () => whistleNotch(rate);
    for (const [hz] of WHISTLE_NOTCHES.slice(0, 3)) expect(gainDb(run([[hz, 0.5]], notch()))).toBeLessThan(-30);
    for (const [hz] of WHISTLE_NOTCHES.slice(3)) expect(gainDb(run([[hz, 0.5]], notch()))).toBeLessThan(-15);
    for (const hz of [150, 300, 1_000, 2_000, 3_500, 5_000, 6_000]) {
      expect(Math.abs(gainDb(run([[hz, 0.5]], notch())))).toBeLessThan(0.1);
    }
    // Between the notches a voice's hiss passes nearly whole.
    for (const hz of [7_700, 8_600, 9_600, 11_500]) expect(gainDb(run([[hz, 0.5]], notch()))).toBeGreaterThan(-2);
    // Fed in 20 ms frames it is the same filter as over the whole line at once.
    const whole = run([
      [300, 0.3],
      [8_118, 0.3],
    ]);
    expect(
      run(
        [
          [300, 0.3],
          [8_118, 0.3],
        ],
        notch(),
      ).output,
    ).toEqual(notch()(whole.input));
    expect(ttsNotch(undefined)).toBe(true);
    expect(ttsNotch('off')).toBe(false);
  });

  it('reads the language of a transcript from its script', () => {
    expect(languageOf('Привіт, як справи?', true)).toBe('uk');
    expect(languageOf('Привіт, як справи?', false)).toBe('en');
    expect(languageOf('check the grafana logs', true)).toBe('en');
    expect(languageOf('1, 2, 3', true)).toBeUndefined();
  });

  it('starts the worker lines in the first configured language and hears Ukrainian only when it is configured', () => {
    expect(callLanguages(undefined)).toEqual({ codes: ['uk-UA', 'en-US'], initial: 'uk', ukrainian: true });
    expect(callLanguages(['uk-UA', 'en-US'])).toEqual({ codes: ['uk-UA', 'en-US'], initial: 'uk', ukrainian: true });
    expect(callLanguages(['en-US'])).toEqual({ codes: ['en-US'], initial: 'en', ukrainian: false });
    expect(callLanguages(['en-GB', 'uk'])).toEqual({ codes: ['en-GB', 'uk'], initial: 'en', ukrainian: true });
    expect(callLanguages(['de-DE'])).toEqual({ codes: ['de-DE'], initial: 'en', ukrainian: false });
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
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:3001/webhook/voice-mode/livekit/agent/events?call=c1');
    expect(events).toEqual([{ type: 'reply', text: 'hi' }, { type: 'ping' }, { type: 'end', reason: 'hangup' }]);
  });
});

const META: LiveKitJobMetadata = {
  v: LIVEKIT_PROTOCOL_VERSION,
  callId: 'call-1',
  lineId: 'voice-mode:abc',
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

interface FakeParticipant {
  identity: string;
  sid?: string;
  disconnectReason?: DisconnectReason;
}

/** The caller hanging up: its client leaves the room. */
const HANG_UP: FakeParticipant = { identity: 'caller-1', disconnectReason: DisconnectReason.CLIENT_INITIATED };

function fakeJob(meta: Record<string, unknown> = { ...META }) {
  const roomHandlers = new Map<string, (p: FakeParticipant) => void>();
  const job = {
    job: { metadata: JSON.stringify(meta) },
    room: {
      on: vi.fn((event: string, fn: (p: FakeParticipant) => void) => roomHandlers.set(event, fn)),
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

const heard = (interim: string, final?: string, failed = false): Heard => ({
  ...(final !== undefined ? { final } : {}),
  interim,
  finals: final ? 1 : 0,
  failed,
  finalizeMs: 0,
});

/** A transcription whose activities end with the results the test queued (heard('') when none). */
function fakeTranscription() {
  const t = {
    /** Pre-roll length of each activity begun. */
    begins: [] as number[],
    pushed: 0,
    ended: 0,
    results: [] as Heard[],
    /** While set, end() waits for `release()`. */
    hold: false,
    waiting: [] as Array<() => void>,
    prepared: true,
    prepare: vi.fn(async () => t.prepared),
    begin: vi.fn((pre: Int16Array) => void t.begins.push(pre.length)),
    push: vi.fn((pcm: Int16Array) => void (t.pushed += pcm.length)),
    end: vi.fn((): Promise<Heard> => {
      t.ended++;
      const result = t.results.shift() ?? heard('');
      if (!t.hold) return Promise.resolve(result);
      return new Promise((resolve) => t.waiting.push(() => resolve(result)));
    }),
    close: vi.fn(),
    release: () => {
      for (const go of t.waiting.splice(0)) go();
    },
  };
  return t satisfies Transcription;
}

/** The room as runCall sees it, with a fake transcription behind the call's turns. */
function fakeVoice() {
  let events!: CallVoiceEvents;
  let handle!: (op: ReviewOp, payload: string, callerIdentity: string) => Promise<string>;
  const transcription = fakeTranscription();
  const states: CallReviewState[] = [];
  let gen = 0;
  let position = 0;
  const voice = {
    /** Plays at once: waits for the caller as the room's does, then speaks. */
    say: vi.fn(async (_text: string, ready?: () => Promise<void>) => {
      await ready?.();
      events.onAgentSpeaking?.(true);
      events.onAgentSpeaking?.(false);
      return true;
    }),
    setThinking: vi.fn(),
    publishTurn: vi.fn(),
    publishReply: vi.fn(),
    publishDropped: vi.fn(),
    publishUnheard: vi.fn(),
    setPending: vi.fn(),
    caption: vi.fn(),
    playCue: vi.fn(async (_kind: CueKind) => undefined),
    review: {
      publishReview: vi.fn((state: CallReviewState) => void states.push(state)),
      serve: vi.fn((h: typeof handle) => {
        handle = h;
        // The page sends its settings first; these tests run hands-free unless they say otherwise.
        void h('settings', JSON.stringify({ gen: ++gen, wake: false, pauseSends: false, cues: true }), 'caller-1');
      }),
    },
    close: vi.fn(async () => undefined),
  } satisfies CallVoice;
  const createVoice = vi.fn(
    async (_ctx: CallJob, _meta: LiveKitJobMetadata, _settings: VoiceModeSettings, e: CallVoiceEvents) => {
      events = e;
      return voice;
    },
  );
  const audio = (ms: number) => {
    const samples = Math.round(ms * 16);
    events.onAudio(new Int16Array(samples).fill(100));
    position += samples;
  };
  const v = {
    voice,
    createVoice,
    transcription,
    states,
    /** The call's interim text, as the transcription reports it. */
    interim: (_text: string) => undefined as void,
    get events() {
      return events;
    },
    /** The caller's audio so far, as the call counts it. */
    get position() {
      return position;
    },
    /** One RPC from the caller's page. */
    rpc: async (op: ReviewOp, fields: Partial<ReviewRequest> = {}) =>
      JSON.parse(await handle(op, JSON.stringify({ gen: ++gen, ...fields }), 'caller-1')) as Record<string, unknown>,
    audio,
    /**
     * One stretch of speech (`speechMs`), then the closing silence: the turn's activity ends with `text`
     * (as its final, unless `final` says otherwise, or its transcription failed).
     */
    turn: async (text: string, o: { speechMs?: number; final?: string; failed?: boolean } = {}) => {
      await flush();
      transcription.results.push(heard(text, o.final ?? (text || undefined), o.failed));
      const start = position;
      audio(o.speechMs ?? 1000);
      const end = position;
      audio(SILENCE);
      events.onSpeech(true, start);
      events.onSpeech(false, end);
      await flush();
    },
  };
  return v;
}

const ENV = {
  GEMINI_API_KEY: 'gk-test',
  LIVEKIT_API_SECRET: 'lk-secret',
  LIVEKIT_HOST_URL: 'http://127.0.0.1:3555',
};
const deps = (
  fetchImpl: typeof fetch,
  createVoice: ReturnType<typeof fakeVoice>['createVoice'],
  extra: Record<string, unknown> = {},
  transcription: Transcription = fakeTranscription(),
) => ({
  env: ENV as Record<string, string | undefined>,
  fetchImpl,
  createVoice,
  transcriber: () => transcription,
  markUpdating: vi.fn(async () => undefined),
  log: silentLog,
  ...extra,
});
/** deps() for a fakeVoice: its own transcription behind the call. */
const callDeps = (fetchImpl: typeof fetch, v: ReturnType<typeof fakeVoice>, extra: Record<string, unknown> = {}) => ({
  ...deps(fetchImpl, v.createVoice, extra, v.transcription),
  transcriber: (options: { onInterim(text: string): void }) => {
    v.interim = (text) => options.onInterim(text);
    return v.transcription;
  },
});

describe('runCall', () => {
  it('runs a call: caller joins, host says yes, turns go out, replies are spoken, host end closes all', async () => {
    const { job, ctx } = fakeJob({ ...META, hostUrl: 'http://169.254.169.254', secret: 'from-dispatch' });
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));

    expect(job.waitForParticipant).toHaveBeenCalledWith('caller-1');
    expect(v.createVoice).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ callId: 'call-1' }),
      { geminiKey: 'gk-test', deess: true, notch: true, spoke: expect.any(Function) },
      v.events,
    );
    // The host address and secret come from the worker's settings, never from the dispatch.
    const secret = liveKitCallSecret('lk-secret', 'call-1');
    for (const call of host.calls) {
      expect(call.url.startsWith('http://127.0.0.1:3555/webhook/voice-mode/livekit/agent/')).toBe(true);
      expect(call.auth).toBe(`Bearer ${secret}`);
    }

    await v.turn('Book a table');
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
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked for eight.', expect.any(Function)));
    // It answers no turn: a message nobody asked for, and the page is told so first.
    expect(v.voice.publishReply).toHaveBeenCalledWith({ reply: 1, unprompted: true });
    // review.serve carries the agent's first `listening` with the review attributes: the call is
    // served before any state, caption or line of it can reach the page.
    expect(v.voice.review.serve).toHaveBeenCalledTimes(1);
    const served = v.voice.review.serve.mock.invocationCallOrder[0];
    for (const later of [
      v.voice.say,
      v.voice.setThinking,
      v.voice.publishTurn,
      v.voice.publishReply,
      v.voice.caption,
    ]) {
      for (const order of later.mock.invocationCallOrder) expect(order).toBeGreaterThan(served);
    }

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
    await runCall(ctx, callDeps(host.fetchImpl, v));
    // A noise is turn 1 here (it is recorded), so the host's first turn is this worker's second.
    await v.turn('', { speechMs: 200 });
    await v.turn('Book a table');
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
    await runCall(ctx, callDeps(host.fetchImpl, v));
    const thinking = () => v.voice.setThinking.mock.calls.at(-1)?.[0];
    // Typing with no turn waiting for its answer says nothing.
    host.emit({ type: 'thinking' });
    await new Promise((r) => setTimeout(r, 20));
    expect(v.voice.setThinking).not.toHaveBeenCalled();

    await v.turn('Book a table');
    await vi.waitFor(() => expect(thinking()).toBe(true));
    host.emit({ type: 'reply', text: 'Booked.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked.', expect.any(Function)));
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

  it('tells the page once per turn that the agent picked it up, never before the host took it or after its answer', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    const working = () => v.voice.publishTurn.mock.calls.filter(([s]) => s.status === 'working').map(([s]) => s);
    // No turn yet: the agent working on something else says nothing about this call's turns.
    host.emit({ type: 'working' });
    await vi.waitFor(() => expect(v.voice.setThinking).toHaveBeenCalledWith(true));
    expect(working()).toEqual([]);

    await v.turn('Book a table');
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 1, status: 'sent', text: 'Book a table' }),
    );
    host.emit({ type: 'working' });
    host.emit({ type: 'working' });
    await vi.waitFor(() => expect(working()).toEqual([{ turn: 1, status: 'working' }]));
    host.emit({ type: 'reply', text: 'Booked.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked.', expect.any(Function)));

    // Turn 2 (the fake host names it '1' too) is answered before any pickup is heard: no late "working".
    await v.turn('And a taxi');
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 2, status: 'sent', text: 'And a taxi' }),
    );
    host.emit({ type: 'reply', text: 'Taxi on its way.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Taxi on its way.', expect.any(Function)));
    host.emit({ type: 'working' });
    // A message naming no turn (unprompted, or a chat reply) also answers it: no "working" after it.
    await v.turn('One more');
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 3, status: 'sent', text: 'One more' }),
    );
    host.emit({ type: 'reply', text: 'Your taxi is here.', turn: null });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Your taxi is here.', expect.any(Function)));
    host.emit({ type: 'working' });
    // Turn 4 is picked up while its answer is still to come.
    await v.turn('Thanks');
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
    await runCall(ctx, callDeps(fetchImpl, v));
    const working = () => v.voice.publishTurn.mock.calls.filter(([s]) => s.status === 'working').map(([s]) => s);
    await v.turn('Book a table');
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 1, status: 'sent', text: 'Book a table' }),
    );
    await v.turn('For two');
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
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await v.turn('Привіт');
    await vi.waitFor(() =>
      expect(v.voice.say).toHaveBeenCalledWith(FAILURE_LINES.rate_limited.uk, expect.any(Function)),
    );
    expect(v.voice.publishTurn).toHaveBeenCalledWith({
      turn: 1,
      status: 'lost',
      reason: 'rate_limited',
      text: 'Привіт',
    });
    await v.turn('', { speechMs: 1200, failed: true });
    expect(v.voice.publishTurn).toHaveBeenLastCalledWith({ turn: 2, status: 'lost', reason: 'stt' });
  });

  it('marks a timed-out turn sent once the host says it was stored after all, and points at the chat once there is one', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch(200, 504);
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await v.turn('Book a table');
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({
        turn: 1,
        status: 'lost',
        reason: 'timeout',
        text: 'Book a table',
      }),
    );
    await vi.waitFor(() =>
      expect(v.voice.say).toHaveBeenCalledWith(FAILURE_LINES.timeout_no_chat.en, expect.any(Function)),
    );
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
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked.', expect.any(Function)));
    expect(v.voice.publishReply).toHaveBeenLastCalledWith(expect.objectContaining({ turn: 1, part: 1 }));

    host.emit({ type: 'chat', chat: true });
    await v.turn('And a taxi');
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith(FAILURE_LINES.timeout.en, expect.any(Function)));
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
    await runCall(ctx, callDeps(fetchImpl, v));
    await v.turn('Book a table');
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith({ turn: 1, status: 'sent', text: 'Book a table' }),
    );
    const posts = host.calls.filter((c) => c.url.endsWith('/utterance'));
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual(posts[0].body);

    failures = [new DOMException('The operation was aborted due to timeout', 'TimeoutError')];
    await v.turn('And a taxi');
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
    await runCall(ctx, callDeps(fetchImpl, v, { log: { info: () => undefined, warn } }));
    expect(warn).toHaveBeenCalledWith('voice-mode worker: ending the call', {
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
    await runCall(ctx, callDeps(host.fetchImpl, v));
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
    await runCall(ctx, callDeps(host.fetchImpl, v));
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
    await runCall(ctx, callDeps(host.fetchImpl, v));
    expect(v.createVoice).not.toHaveBeenCalled();
    expect(host.calls.at(-1)?.url.endsWith('/ended')).toBe(true);
    expect(job.deleteRoom).toHaveBeenCalled();
  });

  it('takes a local http origin only: the host serves the worker on loopback, in plain HTTP', () => {
    expect(liveKitHostUrl({})).toBe('http://127.0.0.1:3000');
    expect(liveKitHostUrl({ WEBHOOK_PORT: '3555' })).toBe('http://127.0.0.1:3555');
    expect(liveKitHostUrl({ LIVEKIT_HOST_URL: 'http://localhost:3000/' })).toBe('http://localhost:3000');
    expect(liveKitHostUrl({ LIVEKIT_HOST_URL: 'http://[::1]:3000' })).toBe('http://[::1]:3000');
    for (const bad of [
      // A local TLS proxy would add X-Forwarded-For, which the worker routes refuse.
      'https://[::1]:3000',
      'https://127.0.0.1:3443',
      'http://192.168.1.5:3000',
      'http://127.0.0.2:3000',
      'https://voice.example.com',
      'ws://127.0.0.1:3000',
      'nonsense',
      'http://user:hunter2@127.0.0.1:3000',
    ]) {
      expect(() => liveKitHostUrl({ LIVEKIT_HOST_URL: bad })).toThrow('LIVEKIT_HOST_URL must be a local');
    }
    expect(() => liveKitHostUrl({ WEBHOOK_PORT: 'abc' })).toThrow('LIVEKIT_HOST_URL must be a local');
    // The diagnostic names the origin, never the credentials in it.
    expect(() => liveKitHostUrl({ LIVEKIT_HOST_URL: 'https://user:hunter2@voice.example.com/x?k=v' })).toThrow(
      /got https:\/\/voice\.example\.com with credentials\)/,
    );
    try {
      liveKitHostUrl({ LIVEKIT_HOST_URL: 'https://user:hunter2@voice.example.com/x?k=v' });
    } catch (err) {
      expect(String(err)).not.toMatch(/hunter2|user|k=v/);
    }
  });

  it('ends the job without a word to a host that is not local', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    const warn = vi.fn();
    await runCall(
      ctx,
      callDeps(host.fetchImpl, v, {
        env: { ...ENV, LIVEKIT_HOST_URL: 'https://user:hunter2@remote.example.invalid' },
        log: { info: () => undefined, warn },
      }),
    );
    expect(host.calls).toEqual([]);
    expect(job.connect).not.toHaveBeenCalled();
    expect(v.createVoice).not.toHaveBeenCalled();
    expect(job.deleteRoom).toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith(expect.stringContaining('LIVEKIT_HOST_URL must be a local'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
  });

  it("speaks an English-only call's first failure notice in English, and a default call's in Ukrainian", async () => {
    for (const [languages, line] of [
      [['en-US'], FAILURE_LINES.turn.en],
      [undefined, FAILURE_LINES.turn.uk],
    ] as const) {
      const { ctx } = fakeJob(languages ? { ...META, languages } : { ...META });
      const host = fakeHostFetch();
      const v = fakeVoice();
      const transcriber = vi.fn((_options: { languageCodes: readonly string[] }) => v.transcription);
      await runCall(ctx, { ...callDeps(host.fetchImpl, v), transcriber });
      expect(transcriber.mock.calls[0][0].languageCodes).toEqual(languages ?? ['uk-UA', 'en-US']);
      await v.turn('', { speechMs: 1200, failed: true });
      await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith(line, expect.any(Function)));
      expect(v.voice.say).toHaveBeenCalledTimes(1);
      host.endStream();
    }
  });

  it('refuses to start without the LiveKit secret it derives the host credential from', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v, { env: { ...ENV, LIVEKIT_API_SECRET: undefined } }));
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
        callDeps(host.fetchImpl, v, { env: { ...ENV, VOICE_MODE_RECORDINGS_DAYS: '7' }, recordingsRoot: root }),
      );
      await v.turn('Book a table');
      await v.turn('', { speechMs: 900 });
      await v.turn('', { speechMs: 200 });
      const dir = path.join(root, 'Andy', new Date().toISOString().slice(0, 10));
      await vi.waitFor(() => expect(fs.readdirSync(dir).sort()).toHaveLength(6));
      const first = JSON.parse(fs.readFileSync(path.join(dir, 'call-1-1.json'), 'utf8')) as TurnRecord;
      expect(first).toMatchObject({
        callId: 'call-1',
        lineId: 'voice-mode:abc',
        agent: 'Andy',
        turn: 1,
        sttModel: 'gemini-3.5-transcribe-live',
        transcript: 'Book a table',
        speechMs: 1000,
        host: { accepted: true, status: 202, id: '1' },
      });
      const lost = JSON.parse(fs.readFileSync(path.join(dir, 'call-1-2.json'), 'utf8')) as TurnRecord;
      expect(lost).toMatchObject({ turn: 2, transcript: '', reason: 'empty' });
      const noise = JSON.parse(fs.readFileSync(path.join(dir, 'call-1-3.json'), 'utf8')) as TurnRecord;
      expect(noise).toMatchObject({ turn: 3, reason: 'noise' });
      const wav = fs.readFileSync(path.join(dir, 'call-1-1.wav'));
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      // The speech (the call opened with it: no audio before it) and a pad after it, not the closing silence.
      expect(wav.length - 44).toBe(2 * 16 * (1000 + 300));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('tells the page it is updating when the host speaks another version, then lets the host end it', async () => {
    vi.useFakeTimers();
    const { job, ctx } = fakeJob({ ...META, v: 2 });
    const host = fakeHostFetch();
    const v = fakeVoice();
    const d = callDeps(host.fetchImpl, v);
    const done = runCall(ctx, d);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(d.markUpdating).toHaveBeenCalledWith(ctx);
    expect(v.createVoice).not.toHaveBeenCalled();
    expect(host.calls.at(-1)).toMatchObject({
      url: 'http://127.0.0.1:3555/webhook/voice-mode/livekit/agent/ended',
      body: { callId: 'call-1', reason: `protocol mismatch: host sent v2, worker speaks v${LIVEKIT_PROTOCOL_VERSION}` },
    });
    expect(job.shutdown).toHaveBeenCalled();
  });

  it("keeps the call through the caller's full reconnect: a new instance under the same identity", async () => {
    const { job, ctx, roomHandlers } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await vi.waitFor(() => expect(v.states.length).toBeGreaterThan(0));
    const published = v.states.length;
    vi.useFakeTimers();
    // The server removes the old instance, then the new one joins.
    roomHandlers.get('participantDisconnected')?.({
      identity: 'caller-1',
      sid: 'PA_old',
      disconnectReason: DisconnectReason.DUPLICATE_IDENTITY,
    });
    roomHandlers.get('participantConnected')?.({ identity: 'caller-1', sid: 'PA_new' });
    // Or the SDK drops the old one itself, with no reason, as the new one's update arrives.
    roomHandlers.get('participantDisconnected')?.({ identity: 'caller-1', sid: 'PA_new' });
    roomHandlers.get('participantConnected')?.({ identity: 'caller-1', sid: 'PA_newer' });
    await vi.advanceTimersByTimeAsync(CALLER_REJOIN_MS * 2);
    expect(job.shutdown).not.toHaveBeenCalled();
    expect(host.calls.some((c) => c.url.endsWith('/ended'))).toBe(false);
    // The new instance hears the review state it missed.
    expect(v.states.length).toBeGreaterThan(published);
    vi.useRealTimers();
    // A hang-up still ends it at once.
    roomHandlers.get('participantDisconnected')?.(HANG_UP);
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('caller left'));
  });

  it('ends the call when a replaced caller never rejoins', async () => {
    const { job, ctx, roomHandlers } = fakeJob();
    const host = fakeHostFetch();
    await runCall(ctx, callDeps(host.fetchImpl, fakeVoice()));
    vi.useFakeTimers();
    roomHandlers.get('participantDisconnected')?.({
      identity: 'caller-1',
      disconnectReason: DisconnectReason.DUPLICATE_IDENTITY,
    });
    await vi.advanceTimersByTimeAsync(CALLER_REJOIN_MS - 100);
    expect(job.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('caller left'));
  });

  it('waits for a rejoin only when the caller was replaced or left for no reason', () => {
    expect(callerRejoinWaitMs(DisconnectReason.DUPLICATE_IDENTITY)).toBe(CALLER_REJOIN_MS);
    expect(callerRejoinWaitMs(undefined)).toBe(CALLER_REJOIN_MS);
    expect(callerRejoinWaitMs(DisconnectReason.CLIENT_INITIATED)).toBe(0);
    expect(callerRejoinWaitMs(DisconnectReason.ROOM_DELETED)).toBe(0);
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
    second.roomHandlers.get('participantDisconnected')?.(HANG_UP);
    await vi.waitFor(() => expect(second.job.shutdown).toHaveBeenCalledWith('caller left'));

    const third = fakeJob();
    const v = fakeVoice();
    await runCall(third.ctx, deps(fakeHostFetch().fetchImpl, v.createVoice));
    v.events.onClosed('vad failed');
    await vi.waitFor(() => expect(third.job.shutdown).toHaveBeenCalledWith('vad failed'));
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
    await runCall(ctx, callDeps(fetchImpl as typeof fetch, v));
    await vi.waitFor(() => expect(link).toBeDefined());
    v.events.onClosed('vad failed');
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('vad failed'));
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
      url: 'http://127.0.0.1:3555/webhook/voice-mode/livekit/agent/ended',
      body: { callId: 'call-1', reason: 'job shutdown', restart: true },
    });
    expect(job.shutdown).toHaveBeenCalledWith('job shutdown');
  });
});

describe('reply recordings', () => {
  it('a call with recordings on writes each spoken line as it was played, next to the turns, and reports it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rec-'));
    try {
      const { ctx } = fakeJob();
      const host = fakeHostFetch();
      const v = fakeVoice();
      const info = vi.fn();
      await runCall(
        ctx,
        callDeps(host.fetchImpl, v, {
          env: { ...ENV, VOICE_MODE_RECORDINGS_DAYS: '7' },
          recordingsRoot: root,
          log: { info, warn: () => undefined },
        }),
      );
      const settings = v.createVoice.mock.calls[0][2];
      expect(settings.recordReplies).toBe(true);
      const pcm = Int16Array.from({ length: 24_000 }, (_, i) => (i % 2 ? 16384 : -16384));
      const line = {
        outcome: 'spoken' as const,
        model: 'gemini-3.8-flash-lite-tts',
        fallback: false,
        firstAudioMs: 900,
        heldMs: 0,
        durationMs: 1000,
        ...audioLevels(pcm),
      };
      settings.spoke?.(line, pcm);
      const file = path.join(root, 'Andy', new Date().toISOString().slice(0, 10), 'call-1-reply-1.wav');
      await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
      const wav = fs.readFileSync(file);
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect(wav.length - 44).toBe(2 * 24_000);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(info).toHaveBeenCalledWith('voice-mode.reply', {
        callId: 'call-1',
        reply: 1,
        kind: 'reply',
        outcome: 'spoken',
        model: 'gemini-3.8-flash-lite-tts',
        fallback: false,
        firstAudioMs: 900,
        heldMs: 0,
        durationMs: 1000,
        peakDb: -6,
        rmsDb: -6,
        recorded: true,
      });
      host.endStream();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records nothing with recordings off', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    expect(v.createVoice.mock.calls[0][2].recordReplies).toBeUndefined();
    expect(audioLevels(new Int16Array(10))).toEqual({ peakDb: -Infinity, rmsDb: -Infinity });
    host.endStream();
  });
});

describe('turn recordings', () => {
  it('writes owner-only files under agent and day, and prunes old ones with their empty folders', async () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rec-')), 'voice-recordings');
    try {
      const record: TurnRecord = {
        callId: 'c/../1',
        lineId: 'voice-mode:abc',
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

/** Review mode over a fake call-turns: recordings resolve with what the test gives `stop`. */
function reviewControl(overrides: Partial<ReviewDeps> = {}) {
  const states: CallReviewState[] = [];
  let stop: (r: Recording | null) => void = () => undefined;
  const voice = {
    turnOpen: false,
    prepared: true,
    recording: false,
    prepare: vi.fn(async () => voice.prepared),
    setReviewing: vi.fn(async (_on: boolean): Promise<Recording | null> => null),
    record: vi.fn(() => void (voice.recording = true)),
    stopRecording: vi.fn(
      () =>
        new Promise<Recording | null>((resolve) => {
          voice.recording = false;
          stop = resolve;
        }),
    ),
    dropRecording: vi.fn(() => void (voice.recording = false)),
    publishReview: vi.fn((state: CallReviewState) => void states.push(state)),
  };
  const posted: Array<{ text: string; draft: number }> = [];
  const capture: boolean[] = [];
  const cues: CueKind[] = [];
  const control = new ReviewControl({
    voice,
    post: vi.fn((text: string, draft: number) => {
      posted.push({ text, draft });
      return posted.length;
    }),
    lastPosted: () => posted.length,
    setCaptureOpen: (open) => void capture.push(open),
    resetCaller: vi.fn(),
    cue: (kind) => void cues.push(kind),
    sttModel: 'model',
    log: silentLog,
    ...overrides,
  });
  let gen = 0;
  const op = (name: ReviewOp, fields: Partial<ReviewRequest> = {}) => control.handle(name, { gen: ++gen, ...fields });
  const take = { sttModel: 'model' };
  return {
    control,
    voice,
    states,
    posted,
    capture,
    cues,
    op,
    draft: () => states.at(-1)?.draft,
    /** The recording's text arrives. */
    stop: async (text: string, failed = false) => {
      stop({ text, failed, take });
      await flush();
    },
  };
}

describe('review mode', () => {
  it('talk sets the transcription up before it answers; done freezes the text without posting; send posts exactly it', async () => {
    const r = reviewControl();
    expect(await r.op('mode', { mode: 'review' })).toMatchObject({ ok: true });
    expect(await r.op('talk')).toMatchObject({ ok: true, draft: 1 });
    expect(r.states.some((s) => s.preparing)).toBe(true);
    expect(r.voice.prepare).toHaveBeenCalledBefore(r.voice.record);
    expect(r.states.at(-1)).not.toHaveProperty('preparing');
    expect(r.draft()).toMatchObject({ id: 1, state: 'recording' });
    expect(r.cues).toEqual(['listening']);
    expect(await r.op('done', { draft: 1 })).toMatchObject({ ok: true });
    expect(r.draft()).toMatchObject({ state: 'finishing' });
    await r.stop('Remind me to zulu. Zulu.');
    expect(r.draft()).toMatchObject({ state: 'ready', text: 'Remind me to zulu. Zulu.' });
    expect(r.posted).toEqual([]);
    expect(r.cues).toEqual(['listening', 'draft']);
    expect(await r.op('send', { draft: 1 })).toMatchObject({ ok: true, turn: 1 });
    expect(r.posted).toEqual([{ text: 'Remind me to zulu. Zulu.', draft: 1 }]);
    expect(r.draft()).toBeNull();
    expect(await r.op('send', { draft: 1 })).toMatchObject({ ok: false, error: 'stale' });
  });

  it('talk stays off when the transcription cannot be set up, or the agent started speaking meanwhile', async () => {
    const r = reviewControl();
    await r.op('mode', { mode: 'review' });
    r.voice.prepared = false;
    expect(await r.op('talk')).toMatchObject({ ok: false, error: 'closed' });
    expect(r.voice.record).not.toHaveBeenCalled();
    r.voice.prepared = true;
    r.control.onAgentSpeaking(true);
    expect(await r.op('talk')).toMatchObject({ ok: false, error: 'agent_speaking' });
  });

  it('empty, failed and oversize drafts; a draft whose text never comes fails after four seconds', async () => {
    const r = reviewControl();
    await r.op('mode', { mode: 'review' });
    await r.op('talk');
    await r.op('done', { draft: 1 });
    await r.stop('');
    expect(r.draft()).toMatchObject({ state: 'empty' });
    await r.op('talk');
    await r.op('done', { draft: 2 });
    await r.stop('', true);
    expect(r.draft()).toMatchObject({ state: 'failed' });
    await r.op('discard', { draft: 2 });
    await r.op('talk');
    await r.op('done', { draft: 3 });
    await r.stop('слово '.repeat(1000));
    expect(r.draft()).toMatchObject({ state: 'ready', tooLong: true });
    expect(await r.op('send', { draft: 3 })).toMatchObject({ ok: false, error: 'unsendable' });
    await r.op('discard', { draft: 3 });
    vi.useFakeTimers();
    await r.op('talk');
    await r.op('done', { draft: 4 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(r.draft()).toMatchObject({ id: 4, state: 'failed' });
  });

  it('a discard during finishing wins: the late text never shows and nothing is posted', async () => {
    const r = reviewControl();
    await r.op('mode', { mode: 'review' });
    await r.op('talk');
    await r.op('done', { draft: 1 });
    await r.op('discard', { draft: 1 });
    await r.stop('too late');
    expect(r.draft()).toBeNull();
    expect(r.posted).toEqual([]);
  });

  it('switching mid-turn makes the open words a draft, unsent; back to auto waits for it', async () => {
    const r = reviewControl();
    r.voice.turnOpen = true;
    let give!: (rec: Recording | null) => void;
    r.voice.setReviewing.mockImplementation(async (on: boolean) => (on ? new Promise((res) => (give = res)) : null));
    expect(await r.op('mode', { mode: 'review' })).toMatchObject({ ok: true });
    expect(r.draft()).toMatchObject({ state: 'finishing', reason: 'switch' });
    expect(await r.op('mode', { mode: 'auto' })).toMatchObject({ ok: false, error: 'finishing' });
    give({ text: 'Book a table', failed: false, take: { sttModel: 'model' } });
    await flush();
    expect(r.draft()).toMatchObject({ state: 'ready', text: 'Book a table', reason: 'switch' });
    expect(r.posted).toEqual([]);
    await r.op('discard', { draft: 1 });
    expect(await r.op('mode', { mode: 'auto' })).toMatchObject({ ok: true });
  });

  it('names a turn auto mode already sent, and a switch with nothing heard leaves no draft', async () => {
    const r = reviewControl({ lastPosted: () => 3 });
    expect(await r.op('mode', { mode: 'review', afterTurn: 2 })).toMatchObject({ ok: true, submitted: 3 });
    expect(r.draft()).toBeNull();
  });

  it('a reply taking the channel stops a recording into a draft', async () => {
    const r = reviewControl();
    await r.op('mode', { mode: 'review' });
    await r.op('talk');
    r.control.beforeAgentSpeaks();
    expect(r.draft()).toMatchObject({ state: 'finishing', reason: 'agent' });
    expect(r.capture).toEqual([true, false]);
    await r.stop('Book a table');
    expect(r.draft()).toMatchObject({ state: 'ready', reason: 'agent' });
  });

  it('refuses everything once the call ended, and reads only well-formed requests', async () => {
    const r = reviewControl();
    r.control.close();
    expect(await r.op('talk')).toMatchObject({ ok: false, error: 'closed' });
    expect(readReviewRequest('{"gen":3,"draft":2,"mode":"review","wake":true,"x":1}')).toEqual({
      gen: 3,
      draft: 2,
      mode: 'review',
      wake: true,
    });
    expect(readReviewRequest('{"gen":4,"typing":false,"cues":true}')).toEqual({ gen: 4, typing: false, cues: true });
    expect(readReviewRequest('{"gen":5,"typing":"no"}')).toEqual({ gen: 5 });
    expect(readReviewRequest('{"draft":2}')).toBeNull();
    expect(readReviewRequest('nope')).toBeNull();
  });
});

/** A speech model whose lines the test decides: audio chunks, then maybe an error. */
function fakeSpeech(
  plan: (text: string, call: number) => { chunks?: number; error?: Error & { retryable?: boolean } },
) {
  let calls = 0;
  const said: string[] = [];
  const model: SpeechModel = {
    synthesize(text: string, _conn?: unknown, abortSignal?: AbortSignal) {
      said.push(text);
      // As the plugin's ChunkedStream does: a one-shot listener on the signal it is given, never removed.
      abortSignal?.addEventListener('abort', () => undefined, { once: true });
      const { chunks = 0, error } = plan(text, ++calls);
      const stream = {
        error: undefined as Error | undefined,
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < chunks; i++)
            yield { frame: new AudioFrame(new Int16Array(480).fill(i + 1), 24_000, 1, 480) };
          if (error) stream.error = error;
        },
      };
      return stream;
    },
    on: () => undefined,
  };
  return { model, said };
}

describe('speech output', () => {
  const speak = async (speech: GeminiSpeech, text: string) => {
    const chunks: Int16Array[] = [];
    for await (const pcm of speech.speak(text, new AbortController().signal)) chunks.push(pcm);
    return chunks.length;
  };
  const retryable = (message: string) => Object.assign(new Error(message), { retryable: true });

  it('speaks with the first model, emoji left out; an empty line makes no request', async () => {
    const primary = fakeSpeech(() => ({ chunks: 3 }));
    const speech = new GeminiSpeech({
      apiKey: 'k',
      model: 'a',
      fallbackModel: 'b',
      voice: 'v',
      log: silentLog,
      create: () => primary.model,
    });
    expect(await speak(speech, 'Booked 🎉 for eight.')).toBe(3);
    expect(primary.said).toEqual(['Booked  for eight.']);
    expect(await speak(speech, '🎉')).toBe(0);
    expect(primary.said).toHaveLength(1);
  });

  it('fails over before any audio, skips the failed model for a while, then tries it again', async () => {
    let now = 0;
    const primary = fakeSpeech((_t, n) => (n === 1 ? { error: new Error('quota') } : { chunks: 1 }));
    const fallback = fakeSpeech(() => ({ chunks: 2 }));
    const speech = new GeminiSpeech({
      apiKey: 'k',
      model: 'a',
      fallbackModel: 'b',
      voice: 'v',
      log: silentLog,
      now: () => now,
      create: (m) => (m === 'a' ? primary.model : fallback.model),
    });
    expect(await speak(speech, 'One.')).toBe(2);
    expect(await speak(speech, 'Two.')).toBe(2);
    expect(primary.said).toEqual(['One.']);
    now += TTS_RECOVERY_DELAY_MS;
    expect(await speak(speech, 'Three.')).toBe(1);
    expect(primary.said).toEqual(['One.', 'Three.']);
    expect(fallback.said).toEqual(['One.', 'Two.']);
  });

  it('tries a transient failure once more on the same model; never after audio started', async () => {
    vi.useFakeTimers();
    const primary = fakeSpeech((_t, n) => (n === 1 ? { error: retryable('busy') } : { chunks: 1 }));
    const speech = new GeminiSpeech({
      apiKey: 'k',
      model: 'a',
      fallbackModel: '',
      voice: 'v',
      log: silentLog,
      create: () => primary.model,
    });
    const done = speak(speech, 'One.');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(1);
    expect(primary.said).toEqual(['One.', 'One.']);
    vi.useRealTimers();

    const partial = fakeSpeech(() => ({ chunks: 2, error: retryable('cut') }));
    const fallback = fakeSpeech(() => ({ chunks: 2 }));
    const second = new GeminiSpeech({
      apiKey: 'k',
      model: 'a',
      fallbackModel: 'b',
      voice: 'v',
      log: silentLog,
      create: (m) => (m === 'a' ? partial.model : fallback.model),
    });
    await expect(speak(second, 'Long line.')).rejects.toThrow('cut');
    expect(partial.said).toEqual(['Long line.']);
    expect(fallback.said).toEqual([]);
  });

  it('a model that stalls before audio is closed and the fallback speaks; finished requests leave no listener on the call signal', async () => {
    vi.useFakeTimers();
    let closed = 0;
    const stalled: SpeechModel = {
      synthesize: () => ({
        error: undefined,
        close: () => void closed++,
        async *[Symbol.asyncIterator]() {
          await new Promise(() => undefined);
          yield* [];
        },
      }),
      on: () => undefined,
    };
    const fallback = fakeSpeech(() => ({ chunks: 2 }));
    const speech = new GeminiSpeech({
      apiKey: 'k',
      model: 'a',
      fallbackModel: 'b',
      voice: 'v',
      log: silentLog,
      create: (m) => (m === 'a' ? stalled : fallback.model),
    });
    const call = new AbortController();
    const chunks: Int16Array[] = [];
    const done = (async () => {
      for await (const pcm of speech.speak('One.', call.signal)) chunks.push(pcm);
    })();
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(closed).toBe(1);
    expect(chunks).toHaveLength(2);
    expect(fallback.said).toEqual(['One.']);
    for (let i = 0; i < 5; i++) for await (const _ of speech.speak('Again.', call.signal));
    expect(getEventListeners(call.signal, 'abort')).toHaveLength(0);
  });

  it('throws when no model speaks', async () => {
    const down = fakeSpeech(() => ({ error: new Error('down') }));
    const speech = new GeminiSpeech({
      apiKey: 'k',
      model: 'a',
      fallbackModel: 'b',
      voice: 'v',
      log: silentLog,
      create: () => down.model,
    });
    await expect(speak(speech, 'One.')).rejects.toThrow('down');
    expect(down.said).toEqual(['One.', 'One.']);
  });
});

describe('spoken command matching', () => {
  it('announces the one list it matches and gives the transcription', () => {
    expect(JSON.parse(COMMAND_WORDS_JSON)).toEqual(CALL_COMMAND_WORDS);
    expect(COMMAND_VOCABULARY).toEqual([...CALL_COMMAND_WORDS.send, ...CALL_COMMAND_WORDS.discard].map((w) => w.say));
    for (const command of ['send', 'discard'] as const) {
      for (const { say, ownSentence } of CALL_COMMAND_WORDS[command]) {
        const spoken = `${say[0].toUpperCase()}${say.slice(1)}.`;
        expect(matchCommand(spoken), say).toEqual({ command, rest: '', ...(ownSentence ? { ownSentence } : {}) });
        expect(matchCommand(`Book a table. ${spoken}`), say).toMatchObject({ command, rest: 'Book a table.' });
        // Inside a sentence only the ownSentence words are words.
        expect(matchCommand(`Book a table ${say}`) === null, say).toBe(!!ownSentence);
      }
    }
  });

  it("marks a caption's command with the words before it", () => {
    expect(captionMark('Book a table for two. Zulu.', 'send')).toEqual({
      command: 'send',
      words: 'Book a table for two.',
    });
    expect(captionMark('book a table, zulu', 'send')).toEqual({ command: 'send', words: 'book a table' });
    expect(captionMark('Скільки буде? Прийом.', 'send')).toEqual({ command: 'send', words: 'Скільки буде?' });
    expect(captionMark('Zulu.', 'send')).toEqual({ command: 'send', words: '' });
    expect(captionMark('Book it. Scratch that.', 'discard')).toEqual({ command: 'discard', words: 'Book it.' });
    // A final that left the command out: all of it is words.
    expect(captionMark('Book a table.', 'discard')).toEqual({ command: 'discard', words: 'Book a table.' });
    for (const [text, command] of [
      ['Book a table for two. Zulu.', 'send'],
      ['Скільки буде? Прийом.', 'send'],
      ['Book it, copy that.', 'send'],
    ] as const) {
      const { words } = captionMark(text, command);
      expect(text.startsWith(words), text).toBe(true);
    }
  });

  it('finds a command only at the end of an utterance, with what was said before it', () => {
    expect(matchCommand('Book a table for two. Zulu.')).toEqual({ command: 'send', rest: 'Book a table for two.' });
    // The comma before the command goes, and the words keep their period.
    expect(matchCommand('book a table, zulu')).toEqual({ command: 'send', rest: 'book a table.' });
    expect(matchCommand('ZULU!')).toEqual({ command: 'send', rest: '' });
    expect(matchCommand('Зулу.')).toEqual({ command: 'send', rest: '' });
    // Mid-sentence it is words.
    expect(matchCommand('Zulu, call Anna tomorrow')).toBeNull();
    // `over` and `send it` are no commands any more.
    expect(matchCommand('Book a table. Over.')).toBeNull();
    expect(matchCommand('Book a table. Send it.')).toBeNull();
    expect(matchCommand('Book a table. Send.')).toBeNull();
    expect(matchCommand('Book a table, sendit')).toBeNull();
    // Plain `zulu` needs no sentence of its own: the price of hands-free.
    expect(matchCommand('Book a table zulu')).toEqual({ command: 'send', rest: 'Book a table.' });
  });

  it('takes copy and copy that only as their own sentence in a final, and the Ukrainian прийом anywhere', () => {
    const rest = (text: string, interim = false) => {
      const m = matchCommand(text, interim);
      return m?.command === 'send' ? m.rest : null;
    };
    expect(rest('Book a table. Copy.')).toBe('Book a table.');
    expect(rest('Copy')).toBe('');
    expect(rest('Book a table, copy that.')).toBe('Book a table.');
    expect(rest('Is it ready? Copy.')).toBe('Is it ready?');
    expect(rest('Book a table - copy that')).toBe('Book a table.');
    expect(rest('send me a copy')).toBeNull();
    expect(rest('rewrite the landing page copy')).toBeNull();
    expect(rest('can you copy that?')).toBeNull();
    // A trailing "?" takes nothing away from a command.
    expect(rest('Is it ready? Copy?')).toBe('Is it ready?');
    expect(rest('Book a table. Copy?')).toBe('Book a table.');
    expect(rest('Zulu?')).toBe('');
    expect(rest('Прийом?')).toBe('');
    // Interim text has no punctuation to tell: it nominates, and the final decides.
    expect(rest('rewrite the landing page copy', true)).toBe('rewrite the landing page.');
    expect(rest('Скільки зараз часу? Прийом.')).toBe('Скільки зараз часу?');
    expect(rest('Скільки зараз часу прийом')).toBe('Скільки зараз часу.');
    expect(rest('Прийом')).toBe('');
    expect(rest('zulu again')).toBeNull();
  });

  it('knows the discard phrases, longest first, and only at the end', () => {
    expect(matchCommand('Call the plumber. Discard this turn.')).toEqual({
      command: 'discard',
      rest: 'Call the plumber.',
    });
    expect(matchCommand('call the plumber discard turn')).toEqual({ command: 'discard', rest: 'call the plumber.' });
    expect(matchCommand('No wait - scratch that!')).toEqual({ command: 'discard', rest: 'No wait.' });
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

describe('turn text', () => {
  it('takes the final, unless it collapsed to a short last phrase or never came: then the last interim', () => {
    expect(turnText(heard('Book a table for two. Zulu.', 'Book a table for two. Zulu.'))).toEqual({
      text: 'Book a table for two. Zulu.',
      source: 'final',
    });
    expect(turnText(heard('Book a table for two. Zulu.', 'Zulu.'))).toEqual({
      text: 'Book a table for two. Zulu.',
      source: 'collapse_interim',
    });
    expect(turnText(heard('А ти можеш відповідати? Прийом.', 'прийом'))).toEqual({
      text: 'А ти можеш відповідати? Прийом.',
      source: 'collapse_interim',
    });
    // A short turn whose final is as long as its interim is the final.
    expect(turnText(heard('Yes, zulu.', 'Yes. Zulu.'))).toEqual({ text: 'Yes. Zulu.', source: 'final' });
    // A longer final is never replaced, however long the interim.
    expect(turnText(heard('Book a table for two at eight please', 'Book a table for two.'))).toEqual({
      text: 'Book a table for two.',
      source: 'final',
    });
    expect(turnText(heard('Book a table'))).toEqual({ text: 'Book a table', source: 'no_final_interim' });
    expect(turnText(heard(''))).toEqual({ text: '', source: 'none' });
  });
});

describe('audio ring and turn capture', () => {
  it('keeps the last seconds by stream position, across the wrap', () => {
    const ring = new AudioRing();
    const total = 16_000 * 12;
    for (let i = 0; i < total; i += 1600) ring.push(Int16Array.from({ length: 1600 }, (_, j) => (i + j) % 30000));
    expect(ring.position).toBe(total);
    const last = ring.since(total - 3);
    expect([...last]).toEqual([(total - 3) % 30000, (total - 2) % 30000, (total - 1) % 30000]);
    // Older than the ring keeps: from its oldest sample.
    expect(ring.since(0).length).toBe(16_000 * 10);
    expect(ring.since(total).length).toBe(0);
  });

  it('records a turn from its pre-roll, trimmed where asked, capped, and only once', () => {
    let now = 10_000;
    const capture = new TurnCapture(() => now);
    expect(capture.take(0)).toBeUndefined();
    capture.start(new Int16Array(16 * 500).fill(1));
    capture.push(new Int16Array(16 * 1000).fill(9));
    now = 12_000;
    const audio = capture.take(1000, 16 * 1200)!;
    expect(audio.pcm.length).toBe(16 * 1200);
    expect(audio.pcm[16 * 500]).toBe(9);
    expect(audio).toMatchObject({
      sampleRate: 16_000,
      startedAt: 9_500,
      endedAt: 10_700,
      speechMs: 1000,
      truncated: false,
    });
    expect(capture.take(0)).toBeUndefined();
    capture.start(new Int16Array(0));
    for (let i = 0; i < 130; i++) capture.push(new Int16Array(16_000));
    expect(capture.take(0)?.truncated).toBe(true);
  });
});

/** CallTurns against a fake transcription, on fake timers; the audio and the clock move together. */
function turnsHarness(
  o: {
    wake?: boolean;
    pauseSends?: boolean;
    wakeWord?: string;
    limits?: { startMs: number; idleMs: number };
    record?: boolean;
  } = {},
) {
  vi.useFakeTimers();
  const t = fakeTranscription();
  const out = {
    sent: [] as string[],
    lost: [] as string[],
    noise: 0,
    drops: [] as Array<[string, string]>,
    lone: [] as Array<{ command: string; segment: number }>,
    cues: [] as CueKind[],
    captions: [] as Array<[number, string, boolean]>,
    marks: [] as Array<[number, string, boolean, CaptionMark]>,
    countdown: [] as string[],
    holds: [] as boolean[],
    noTurn: 0,
    unheard: 0,
    takes: [] as Array<TurnAudio | undefined>,
    facts: [] as Array<TurnFacts | undefined>,
    ended: [] as Array<[TurnFacts, string, string]>,
    logs: [] as string[],
  };
  const turns = new CallTurns(
    {
      transcriber: t,
      send: (text, take) => {
        out.sent.push(text);
        out.takes.push(take.audio);
        out.facts.push(take.facts);
      },
      ended: (facts, outcome, reason) => void out.ended.push([facts, outcome, reason]),
      lost: (reason) => void out.lost.push(reason),
      noise: () => void out.noise++,
      drop: (reason, text, lone) => {
        out.drops.push([reason, text]);
        if (lone) out.lone.push(lone);
      },
      cue: (kind) => void out.cues.push(kind),
      caption: (segment, text, final, mark) => {
        out.captions.push([segment, text, final]);
        if (mark) out.marks.push([segment, text, final, mark]);
      },
      countdown: {
        stopped: (at) => void out.countdown.push(`stopped ${Date.now() - at}`),
        clear: () => void out.countdown.push('clear'),
      },
      changed: () => undefined,
      hold: (open) => void out.holds.push(open),
      noTurn: () => void out.noTurn++,
      unheard: () => void out.unheard++,
      log: { info: (msg: string) => void out.logs.push(msg), warn: () => undefined },
    },
    { silenceMs: SILENCE, names: ['Andy'], limits: o.limits, record: o.record, sttModel: 'model' },
  );
  turns.configure(o.wake ?? false, o.pauseSends ?? false);
  if (o.wakeWord) turns.useWakeWord(o.wakeWord);
  let position = 0;
  /** `ms` of audio, in 20 ms frames, with the clock. */
  const pass = async (ms: number, level = 0) => {
    for (let at = 0; at < ms; at += 20) {
      turns.audio(new Int16Array(320).fill(level));
      position += 320;
      await vi.advanceTimersByTimeAsync(20);
    }
  };
  /** The caller speaks `ms`; the VAD reports the start then, and the end 550 ms into the silence after. */
  const talk = async (ms: number) => {
    const start = position;
    await pass(Math.min(ms, 100), 500);
    turns.onSpeech(true, start);
    await pass(Math.max(0, ms - 100), 500);
    const end = position;
    await pass(550);
    turns.onSpeech(false, end);
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    turns,
    t,
    out,
    pass,
    talk,
    get position() {
      return position;
    },
    interim: async (text: string) => {
      turns.onInterim(text);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe('CallTurns, hands-free', () => {
  it('opens a turn at the speech with a pre-roll and sends it after the closing silence, counted from the speech end', async () => {
    const h = turnsHarness();
    await h.pass(2000);
    h.t.results.push(heard('Book a table for two', 'Book a table for two.'));
    await h.talk(1000);
    // The pre-roll (500 ms) and the speech heard so far when the VAD reported it (100 ms).
    expect(h.t.begins).toEqual([16 * 600]);
    expect(h.out.holds).toEqual([true]);
    expect(h.out.countdown.at(-1)).toBe('stopped 560');
    await h.pass(SILENCE - 600);
    expect(h.t.ended).toBe(0);
    await h.pass(100);
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual(['Book a table for two.']);
    expect(h.out.holds).toEqual([true, false]);
    expect(h.out.captions.at(-1)).toEqual([1, 'Book a table for two.', true]);
  });

  it('keeps a thinking pause in the same turn: one activity, one text', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('з купівлею нового столу', 'З купівлею, не знаю, нового столу.'));
    await h.talk(1000);
    await h.pass(1500);
    await h.talk(800);
    await h.pass(SILENCE);
    expect(h.t.begins).toHaveLength(1);
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual(['З купівлею, не знаю, нового столу.']);
  });

  it('a command in two interims in a row, with the caller silent, ends the turn; the final confirms and is stripped', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('Book a table for two. Zulu.', 'Zulu.'));
    await h.talk(1500);
    await h.interim('Book a table for two. Zulu.');
    expect(h.t.ended).toBe(0);
    await h.interim('Book a table for two. Zulu.');
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual(['Book a table for two.']);
    // Each caption says the command it ends in: the interims as heard, the sent final as only its words.
    expect(h.out.marks).toEqual([
      [1, 'Book a table for two. Zulu.', false, { command: 'send', words: 'Book a table for two.' }],
      [1, 'Book a table for two. Zulu.', false, { command: 'send', words: 'Book a table for two.' }],
      [1, 'Book a table for two.', true, { command: 'send', words: 'Book a table for two.' }],
    ]);
  });

  it('holds a command while the caller still talks; new words make it words', async () => {
    const h = turnsHarness();
    await h.pass(100, 500);
    h.turns.onSpeech(true, 0);
    await h.interim('Book a table. Zulu.');
    await h.interim('Book a table. Zulu.');
    expect(h.t.ended).toBe(0);
    await h.interim('Book a table. Zulu to Anna');
    h.turns.onSpeech(false, h.position);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.t.ended).toBe(0);
    // The same suffix stable again once they stopped: it acts.
    h.t.results.push(heard('Book a table. Zulu to Anna. Zulu.', 'Book a table. Zulu to Anna. Zulu.'));
    await h.interim('Book a table. Zulu to Anna. Zulu.');
    await h.interim('Book a table. Zulu to Anna. Zulu.');
    expect(h.out.sent).toEqual(['Book a table. Zulu to Anna.']);
  });

  it('a command the final does not end with was words: the turn goes on, carrying them, from where it ended', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('Book a table, zulu', 'Book a table, zulu to Anna tomorrow.'));
    await h.talk(1500);
    await h.interim('Book a table, zulu');
    await h.interim('Book a table, zulu');
    expect(h.t.ended).toBe(1);
    // A successor activity from where the first ended: no pre-roll twice.
    expect(h.t.begins).toEqual([16 * 100, 0]);
    expect(h.out.sent).toEqual([]);
    h.t.results.push(heard('And for eight.', 'And for eight.'));
    await h.talk(800);
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['Book a table, zulu to Anna tomorrow. And for eight.']);
  });

  it('a final that leaves the command out but ends where the interim text did still confirms it', async () => {
    const h = turnsHarness();
    h.t.results.push(
      heard('перевір мій список, що саме там треба купити? Прийом.', 'Перевір мій список, і що саме там треба купити?'),
    );
    await h.talk(1500);
    await h.interim('перевір мій список, що саме там треба купити? Прийом.');
    await h.interim('перевір мій список, що саме там треба купити? Прийом.');
    expect(h.out.sent).toEqual(['Перевір мій список, і що саме там треба купити?']);
    expect(h.t.begins).toHaveLength(1);
  });

  it('a pause after a command the final left out still applies it: a discard never sends', async () => {
    const h = turnsHarness();
    h.t.results.push(
      heard(
        'а можеш мені нагадати коли ми почали з проєктом Бета? Scratch that.',
        'А можеш мені нагадати, коли ми почали з Бета проектом?',
      ),
    );
    await h.talk(2000);
    await h.interim('а можеш мені нагадати коли ми почали з проєктом Бета?');
    await h.interim('а можеш мені нагадати коли ми почали з проєктом Бета? Scratch that.');
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual([]);
    expect(h.out.drops).toEqual([['discarded', 'А можеш мені нагадати, коли ми почали з Бета проектом?']]);
    // An interim command the final does not end like is not taken: the final's words win.
    h.t.results.push(heard('Remind me to zulu.', 'Remind me to zulu to Anna tomorrow.'));
    await h.talk(1500);
    await h.interim('Remind me to zulu.');
    // The settled interim ends the activity; the final's words go on, and its own closing silence sends them.
    await h.pass(COMMAND_SETTLE_MS + SILENCE);
    expect(h.out.sent).toEqual(['Remind me to zulu to Anna tomorrow.']);
  });

  it('a command a final asks as a question still acts', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('is the table booked zulu', 'Is the table booked? Zulu?'));
    await h.talk(1500);
    await h.interim('is the table booked zulu');
    await h.interim('is the table booked zulu');
    expect(h.out.sent).toEqual(['Is the table booked?']);
    expect(h.out.logs).toEqual([]);
  });

  it('a copy the final has inside a sentence stays words, and is logged as a near-miss', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('can you copy that', 'Can you copy that?'));
    await h.talk(1500);
    await h.interim('can you copy that');
    await h.interim('can you copy that');
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual([]);
    expect(h.out.logs[0]).toBe('voice-mode.command near-miss word=copy-that reason=no-boundary');
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['Can you copy that?']);
  });

  it('reads where a final ends by sound, across spellings and scripts', () => {
    expect(endsLike('коли ми почали з Бета проектом?', 'коли ми почали з проєктом Бета?')).toBe(true);
    expect(endsLike('що саме там треба купити?', 'і сказати, що саме там треба купити?')).toBe(true);
    expect(endsLike('Zulu to Anna tomorrow.', 'Remind me to')).toBe(false);
    expect(endsLike('Yes.', 'Yes')).toBe(false);
  });

  it('speech while a command is being confirmed continues the turn: the command was words', async () => {
    const h = turnsHarness();
    h.t.hold = true;
    h.t.results.push(heard('Remind me to zulu', 'Remind me to zulu.'));
    await h.talk(1500);
    await h.interim('Remind me to zulu');
    await h.interim('Remind me to zulu');
    expect(h.t.ended).toBe(1);
    h.t.results.push(heard('to Anna tomorrow.', 'to Anna tomorrow.'));
    await h.talk(800);
    h.t.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out.sent).toEqual([]);
    h.t.hold = false;
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['Remind me to zulu. to Anna tomorrow.']);
  });

  it('a pause sends a turn whose final has a command the interims missed, without it; a discard drops it', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('Скільки буде два плюс три?', 'Скільки буде два плюс три? Прийом.'));
    await h.talk(1500);
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['Скільки буде два плюс три?']);
    h.t.results.push(
      heard('Remind me to call the plumber. Scratch that.', 'Remind me to call the plumber. Scratch that.'),
    );
    await h.talk(1500);
    await h.pass(SILENCE);
    expect(h.out.sent).toHaveLength(1);
    expect(h.out.drops).toEqual([['discarded', 'Remind me to call the plumber. Scratch that.']]);
    expect(h.out.cues).toEqual(['discard']);
    // No interim showed either command; the finals carry what the worker did with them.
    expect(h.out.marks).toEqual([
      [1, 'Скільки буде два плюс три?', true, { command: 'send', words: 'Скільки буде два плюс три?' }],
      [
        2,
        'Remind me to call the plumber. Scratch that.',
        true,
        { command: 'discard', words: 'Remind me to call the plumber.' },
      ],
    ]);
    expect(h.out.lone).toEqual([]);
  });

  it('a command one interim showed and the next and the final left out still discards at the pause, with no countdown', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('Remind me to call the plumber.', 'Remind me to call the plumber.'));
    await h.talk(1500);
    expect(h.out.countdown.at(-1)).toMatch(/^stopped/);
    await h.interim('Remind me to call the plumber. Scratch that.');
    // A command is pending: the countdown goes, so nothing looks like it is being sent.
    expect(h.out.countdown.at(-1)).toBe('clear');
    await h.interim('Remind me to call the plumber.');
    expect(h.out.countdown.at(-1)).toBe('clear');
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual([]);
    expect(h.out.drops).toEqual([['discarded', 'Remind me to call the plumber.']]);
    expect(h.out.cues).toEqual(['discard']);
    // New words after the command, or the same words said again, make it words.
    h.t.results.push(
      heard(
        'Remind me to call mom. Scratch that. Remind me to call mom tomorrow.',
        'Remind me to call mom. Scratch that. Remind me to call mom tomorrow.',
      ),
    );
    await h.talk(1500);
    await h.interim('Remind me to call mom. Scratch that.');
    await h.talk(1500);
    await h.interim('Remind me to call mom. Scratch that. Remind me to call mom tomorrow.');
    expect(h.out.countdown.at(-1)).toMatch(/^stopped/);
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['Remind me to call mom. Scratch that. Remind me to call mom tomorrow.']);
  });

  it('a sent turn shows what the agent got: no spoken command in its caption, the period kept', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('Answer in one word, zulu.', 'Answer in one word, zulu.'));
    await h.talk(1500);
    await h.interim('Answer in one word, zulu.');
    await h.interim('Answer in one word, zulu.');
    expect(h.out.sent).toEqual(['Answer in one word.']);
    expect(h.out.captions.at(-1)).toEqual([1, 'Answer in one word.', true]);
  });

  it('a command alone sends nothing, asked or not', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('Zulu.', 'Zulu.'));
    await h.talk(600);
    await h.interim('Zulu.');
    await h.interim('Zulu.');
    expect(h.out.drops).toEqual([['command', 'Zulu.']]);
    expect(h.out.lone).toEqual([{ command: 'send', segment: 1 }]);
    expect(h.out.marks.at(-1)).toEqual([1, 'Zulu.', true, { command: 'send', words: '' }]);
    expect(h.out.cues).toEqual(['nope']);
    h.t.results.push(heard('Zulu?', 'Zulu?'));
    await h.talk(800);
    await h.interim('Zulu?');
    await h.interim('Zulu?');
    expect(h.out.drops).toEqual([
      ['command', 'Zulu.'],
      ['command', 'Zulu?'],
    ]);
    expect(h.out.sent).toEqual([]);
  });

  it('noise, a turn heard as nothing, and a failed transcription; interim text is never lost', async () => {
    const h = turnsHarness();
    await h.talk(300);
    await h.pass(SILENCE);
    expect(h.out.noise).toBe(1);
    await h.talk(1500);
    await h.pass(SILENCE);
    expect(h.out.lost).toEqual(['empty']);
    h.t.results.push(heard('', undefined, true));
    await h.talk(1500);
    await h.pass(SILENCE);
    expect(h.out.lost).toEqual(['empty', 'stt']);
    h.t.results.push(heard('Book a table', undefined, true));
    await h.talk(1500);
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['Book a table']);
  });

  it('under the agent line: no turn opens, the caller is unheard, and the turn hears silence', async () => {
    const h = turnsHarness();
    h.turns.onAgentSpeaking(true);
    await h.talk(1000);
    expect(h.out.unheard).toBe(1);
    expect(h.t.begins).toEqual([]);
    h.turns.onAgentSpeaking(false);
    // A reply that waited its longest takes the channel from an open turn: it goes out as it is.
    h.t.results.push(heard('Book a table', 'Book a table'));
    await h.pass(100, 500);
    h.turns.onSpeech(true, h.position - 1600);
    await h.pass(500, 500);
    const pushedBefore = h.t.pushed;
    h.turns.onAgentSpeaking(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out.sent).toEqual(['Book a table']);
    expect(h.t.pushed).toBe(pushedBefore);
  });

  it('records each turn when asked: its pre-roll and speech, cut a pad after its last speech', async () => {
    const h = turnsHarness({ record: true });
    await h.pass(2000);
    h.t.results.push(heard('Book a table', 'Book a table'));
    await h.talk(1000);
    await h.pass(SILENCE);
    expect(h.out.takes[0]?.pcm.length).toBe(16 * (500 + 1000 + 300));
    expect(h.out.takes[0]?.speechMs).toBe(1000);
  });
});

describe('CallTurns, wake', () => {
  it('nothing is transcribed before the wake word; the turn starts where it was spotted; only send sends', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(3000);
    await h.talk(1500);
    expect(h.t.begins).toEqual([]);
    expect(h.turns.spotting).toBe(true);
    const end = h.position;
    h.turns.onWake(end);
    // No audio from before the detection: the phrase (which ends there) is not in the turn.
    expect(h.t.begins).toEqual([0]);
    expect(h.out.cues).toEqual(['wake']);
    expect(h.turns.state).toMatchObject({ on: true, waiting: false, heard: 1, phrase: 'Hey LiveKit', cut: true });
    h.t.results.push(heard('Book a table for two. Zulu.', 'Zulu.'));
    await h.talk(1500);
    await h.pass(SILENCE + 500);
    expect(h.t.ended).toBe(0);
    await h.interim('Book a table for two. Zulu.');
    await h.interim('Book a table for two. Zulu.');
    // The text is not searched for the phrase: words like it after the wake stay words.
    expect(h.out.sent).toEqual(['Book a table for two.']);
    expect(h.turns.state.waiting).toBe(true);
  });

  it('an interim copy ends the activity, but a final with it inside a sentence sends nothing and keeps the turn', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(500);
    h.turns.onWake(h.position);
    // The final ends like the interim text before its copy: only the guard keeps it from sending.
    h.t.results.push(heard('copy the file then copy', 'Copy the file then copy'));
    await h.talk(1500);
    await h.interim('copy the file then copy');
    await h.interim('copy the file then copy');
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual([]);
    expect(h.out.logs).toEqual(['voice-mode.command near-miss word=copy reason=no-boundary']);
    expect(h.turns.state.waiting).toBe(false);
    h.t.results.push(heard('Book a table. Copy.', 'Book a table. Copy.'));
    await h.talk(1200);
    await h.interim('Book a table. Copy.');
    await h.interim('Book a table. Copy.');
    expect(h.out.sent).toEqual(['Copy the file then copy Book a table.']);
    expect(h.turns.state.waiting).toBe(true);
  });

  it('a copy the interim text ended with and the final left out sends nothing: the turn goes on', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(500);
    h.turns.onWake(h.position);
    h.t.results.push(heard('rewrite the landing page copy', 'Rewrite the landing page'));
    await h.talk(1500);
    await h.interim('rewrite the landing page copy');
    await h.interim('rewrite the landing page copy');
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual([]);
    expect(h.out.logs).toEqual([]);
    expect(h.turns.state.waiting).toBe(false);
    // A dropped zulu still stands, as a dropped прийом always has.
    h.t.results.push(heard('and the pricing zulu', 'And the pricing'));
    await h.talk(1200);
    await h.interim('and the pricing zulu');
    await h.interim('and the pricing zulu');
    expect(h.out.sent).toEqual(['Rewrite the landing page and the pricing.']);
  });

  it('a copy only the interim text has sends nothing, even when the short final collapsed to the interim', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(500);
    h.turns.onWake(h.position);
    // Three words: turnText takes the interim text, which has the copy as its own sentence.
    h.t.results.push(heard('Book a table. Copy.', 'Book a table'));
    await h.talk(1500);
    await h.interim('Book a table. Copy.');
    await h.interim('Book a table. Copy.');
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual([]);
    expect(h.turns.state.waiting).toBe(false);
  });

  it('a copy only the interim text has sends nothing when no final came', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(500);
    h.turns.onWake(h.position);
    h.t.results.push(heard('Book a table. Copy.'));
    await h.talk(1500);
    await h.interim('Book a table. Copy.');
    await h.interim('Book a table. Copy.');
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual([]);
    expect(h.turns.state.waiting).toBe(false);
  });

  it('a final that collapsed to its copy still sends the interim text before it', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(500);
    h.turns.onWake(h.position);
    h.t.results.push(heard('Book a table for two. Copy.', 'Copy.'));
    await h.talk(1500);
    await h.interim('Book a table for two. Copy.');
    await h.interim('Book a table for two. Copy.');
    expect(h.out.sent).toEqual(['Book a table for two.']);
    expect(h.turns.state.waiting).toBe(true);
  });

  it('a pause sends too with pauseSends; a detection from an earlier wait opens nothing', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit', pauseSends: true });
    await h.pass(3000);
    const old = h.position;
    h.turns.configure(true, true);
    h.turns.configure(false, true);
    h.turns.configure(true, true);
    h.turns.onWake(old);
    expect(h.t.begins).toEqual([]);
    await h.pass(100);
    h.turns.onWake(h.position);
    h.t.results.push(heard('what time is it', 'What time is it?'));
    await h.talk(1000);
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['What time is it?']);
  });

  it('goes back to waiting with the sleep cue: nothing said, then words held; a final ending in zulu still sends', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit', limits: { startMs: 8_000, idleMs: 20_000 } });
    await h.pass(100);
    h.turns.onWake(h.position);
    await h.pass(8_000);
    expect(h.out.cues).toEqual(['wake', 'sleep']);
    expect(h.turns.state).toMatchObject({ waiting: true, slept: 1 });
    await h.pass(100);
    h.turns.onWake(h.position);
    h.t.results.push(heard('Remind me to buy bread', 'Remind me to buy bread.'));
    await h.talk(1000);
    await h.interim('Remind me to buy bread');
    await h.pass(19_000);
    expect(h.out.cues).toHaveLength(3);
    await h.pass(1_100);
    expect(h.out.drops).toEqual([['asleep', 'Remind me to buy bread.']]);
    await h.pass(100);
    h.turns.onWake(h.position);
    h.t.results.push(heard('Remind me to buy milk', 'Remind me to buy milk. Zulu.'));
    await h.talk(1000);
    await h.interim('Remind me to buy milk');
    await h.pass(20_100);
    expect(h.out.sent).toEqual(['Remind me to buy milk.']);
  });

  it('words held after the wake go back to waiting on time, however many interims repeat them', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit', limits: { startMs: 8_000, idleMs: 20_000 } });
    await h.pass(100);
    h.turns.onWake(h.position);
    h.t.results.push(heard('Remind me to stretch later.', 'Remind me to stretch later.'));
    await h.talk(1000);
    await h.interim('Remind me to stretch later.');
    for (let i = 0; i < 4; i++) {
      await h.pass(5_000);
      await h.interim('Remind me to stretch later.');
    }
    await h.pass(300);
    expect(h.out.drops).toEqual([['asleep', 'Remind me to stretch later.']]);
    expect(h.out.cues).toEqual(['wake', 'sleep']);
  });

  it('a scratch that the interims showed once discards when the woken turn goes back to waiting', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit', limits: { startMs: 8_000, idleMs: 20_000 } });
    await h.pass(100);
    h.turns.onWake(h.position);
    h.t.results.push(heard('Remind me to buy some bread.', 'Remind me to buy some bread.'));
    await h.talk(1500);
    await h.interim('Remind me to buy some bread. Scratch that.');
    await h.interim('Remind me to buy some bread.');
    await h.pass(20_100);
    expect(h.out.sent).toEqual([]);
    expect(h.out.drops).toEqual([['discarded', 'Remind me to buy some bread.']]);
    expect(h.out.cues).toEqual(['wake', 'discard']);
  });

  it('the wake phrase again in an open turn: never in its text, and a discard before it drops only those words', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(100);
    h.turns.onWake(h.position);
    // No interim showed the discard: the second wake phrase and the send are what the caller relies on.
    h.t.results.push(
      heard(
        'Remind me to buy some bread. Hey Andy. What is the capital of Germany? Zulu.',
        'Remind me to buy some bread, scratch that. Hey Andy. What is the capital of Germany? Zulu.',
      ),
    );
    await h.talk(1500);
    await h.interim('Remind me to buy some bread.');
    await h.pass(10_000);
    await h.talk(2000);
    await h.interim('Remind me to buy some bread. Hey Andy. What is the capital of Germany? Zulu.');
    await h.interim('Remind me to buy some bread. Hey Andy. What is the capital of Germany? Zulu.');
    expect(h.out.drops).toEqual([['discarded', 'Remind me to buy some bread, scratch that.']]);
    expect(h.out.sent).toEqual(['What is the capital of Germany?']);
    expect(h.out.cues).toEqual(['wake', 'discard']);
    expect(h.out.captions.at(-1)).toEqual([1, 'Remind me to buy some bread, scratch that.', true]);
    // Without a discard the words before it stay; the phrase (here the acoustic one's own name) goes.
    await h.pass(100);
    h.turns.onWake(h.position);
    h.t.results.push(
      heard(
        'Remind me to stretch. Hey LiveKit, and buy bread. Zulu.',
        'Remind me to stretch. Hey LiveKit, and buy bread. Zulu.',
      ),
    );
    await h.talk(2000);
    await h.interim('Remind me to stretch. Hey LiveKit, and buy bread. Zulu.');
    await h.interim('Remind me to stretch. Hey LiveKit, and buy bread. Zulu.');
    expect(h.out.sent.at(-1)).toBe('Remind me to stretch. and buy bread.');
  });

  it('a discard right after the wake word takes it back', async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(100);
    h.turns.onWake(h.position);
    h.t.results.push(heard('Scratch that.', 'Scratch that.'));
    await h.talk(700);
    await h.interim('Scratch that.');
    await h.interim('Scratch that.');
    expect(h.out.drops).toEqual([['discarded', 'Scratch that.']]);
    expect(h.out.cues).toEqual(['wake', 'discard']);
    expect(h.turns.state.waiting).toBe(true);
  });

  it('without a spotter, hey <agent> in the transcript opens the turn; speech without it is dropped as ignored', async () => {
    const h = turnsHarness({ wake: true });
    h.t.results.push(heard('So the weekend plan is settled.', 'So the weekend plan is settled.'));
    await h.talk(1500);
    expect(h.t.begins).toHaveLength(1);
    expect(h.out.holds).toEqual([]);
    await h.pass(SILENCE);
    expect(h.out.drops).toEqual([['unaddressed', 'So the weekend plan is settled.']]);
    h.t.results.push(heard('OK. Hi Andy, what time is it? Zulu.', 'OK. Hi Andy, what time is it? Zulu.'));
    await h.talk(2000);
    await h.interim('OK. Hi Andy, what time is it? Zulu.');
    expect(h.out.cues).toEqual(['wake']);
    expect(h.out.drops.at(-1)).toEqual(['unaddressed', 'OK.']);
    await h.interim('OK. Hi Andy, what time is it? Zulu.');
    expect(h.out.sent).toEqual(['what time is it?']);
  });

  it('turning the wake switch on drops an open hands-free turn; off keeps a woken one and lets the pause send it', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('half a thought', 'half a thought'));
    await h.talk(1000);
    h.turns.configure(true, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out.drops).toEqual([['unaddressed', 'half a thought']]);
    h.turns.useWakeWord('Hey LiveKit');
    await h.pass(100);
    h.turns.onWake(h.position);
    h.t.results.push(heard('Book a table', 'Book a table'));
    await h.talk(1000);
    h.turns.configure(false, false);
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['Book a table']);
  });
});

/** Review mode over a real CallTurns (turnsHarness): what the page sees and what was posted. */
function reviewOverTurns(h: ReturnType<typeof turnsHarness>) {
  const states: CallReviewState[] = [];
  const posted: string[] = [];
  const control = new ReviewControl({
    voice: {
      get turnOpen() {
        return h.turns.turnOpen;
      },
      setReviewing: (on) => h.turns.setReviewing(on),
      prepare: () => h.turns.prepare(),
      record: () => h.turns.record(),
      stopRecording: () => h.turns.stopRecording(),
      dropRecording: () => h.turns.dropRecording(),
      publishReview: (state) => void states.push(state),
    },
    post: (text) => posted.push(text),
    lastPosted: () => posted.length,
    setCaptureOpen: () => undefined,
    resetCaller: () => undefined,
    sttModel: 'model',
    log: silentLog,
  });
  let gen = 0;
  return {
    control,
    states,
    posted,
    op: (op: ReviewOp, f: Partial<ReviewRequest> = {}) => control.handle(op, { gen: ++gen, ...f }),
  };
}

describe('CallTurns, a command in one interim that settles', () => {
  const woken = async () => {
    const h = turnsHarness({ wake: true, wakeWord: 'Hey LiveKit' });
    await h.pass(500);
    h.turns.onWake(h.position);
    return h;
  };

  it('one interim ending in zulu, then silence, ends the activity after the settle time and sends', async () => {
    const h = await woken();
    h.t.results.push(heard('Book a table for two. Zulu.', 'Book a table for two. Zulu.'));
    await h.talk(1500);
    await h.interim('Book a table for two. Zulu.');
    await h.pass(COMMAND_SETTLE_MS - 20);
    expect(h.t.ended).toBe(0);
    await h.pass(20);
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual(['Book a table for two.']);
    expect(h.out.facts[0]?.endedBy).toBe('send');
    expect(h.turns.state.waiting).toBe(true);
  });

  it('a copy as its own sentence sends the same way', async () => {
    const h = await woken();
    const said = 'Rewrite the landing page copy for the pricing section. Copy.';
    h.t.results.push(heard(said, said));
    await h.talk(3000);
    await h.interim('Rewrite the landing page copy for the pricing section.');
    await h.pass(1500);
    await h.talk(500);
    await h.interim(said);
    await h.pass(COMMAND_SETTLE_MS);
    expect(h.out.sent).toEqual(['Rewrite the landing page copy for the pricing section.']);
    expect(h.out.facts[0]?.endedBy).toBe('send');
  });

  it('settles while the caller still talks and acts once they stop', async () => {
    const h = await woken();
    h.t.results.push(heard('Book a table. Zulu.', 'Book a table. Zulu.'));
    await h.pass(100, 500);
    h.turns.onSpeech(true, h.position - 1600);
    await h.interim('Book a table. Zulu.');
    await h.pass(COMMAND_SETTLE_MS + 100, 500);
    expect(h.t.ended).toBe(0);
    h.turns.onSpeech(false, h.position);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out.sent).toEqual(['Book a table.']);
  });

  it('new text within the settle time cancels it', async () => {
    const h = await woken();
    await h.talk(1500);
    await h.interim('Book a table. Zulu.');
    await h.pass(COMMAND_SETTLE_MS / 2);
    await h.interim('Book a table. Zulu to Anna');
    await h.pass(COMMAND_SETTLE_MS * 2);
    expect(h.t.ended).toBe(0);
  });

  it('two interims in a row still act at once', async () => {
    const h = await woken();
    h.t.results.push(heard('Book a table. Zulu.', 'Book a table. Zulu.'));
    await h.talk(1500);
    await h.interim('Book a table.');
    await h.interim('Book a table. Zulu.');
    expect(h.t.ended).toBe(0);
    await h.interim('Book a table. Zulu.');
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual(['Book a table.']);
  });

  it('never fires for a turn that already ended', async () => {
    const h = await woken();
    h.t.results.push(heard('Book a table. Zulu.', 'Book a table. Zulu.'));
    await h.talk(1500);
    await h.interim('Book a table. Zulu.');
    const draft = h.turns.setReviewing(true);
    await h.pass(COMMAND_SETTLE_MS * 2);
    expect(await draft).toMatchObject({ text: 'Book a table. Zulu.' });
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual([]);

    const g = await woken();
    await g.talk(1500);
    await g.interim('Book a table. Zulu.');
    g.turns.close();
    await g.pass(COMMAND_SETTLE_MS * 2);
    expect(g.t.ended).toBe(0);
    expect(g.out.sent).toEqual([]);
  });

  it('a discard phrase settles the same way', async () => {
    const h = await woken();
    const said = 'Remind me to call the plumber. Scratch that.';
    h.t.results.push(heard(said, said));
    await h.talk(2000);
    await h.interim(said);
    await h.pass(COMMAND_SETTLE_MS);
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual([]);
    expect(h.out.drops).toEqual([['discarded', said]]);
  });

  it('a settled copy whose final has no boundary sends nothing and keeps the turn', async () => {
    const h = await woken();
    h.t.results.push(heard('copy the file then copy', 'Copy the file then copy'));
    await h.talk(1500);
    await h.interim('copy the file then copy');
    await h.pass(COMMAND_SETTLE_MS);
    expect(h.t.ended).toBe(1);
    expect(h.out.sent).toEqual([]);
    expect(h.out.logs).toEqual(['voice-mode.command near-miss word=copy reason=no-boundary']);
    expect(h.turns.state.waiting).toBe(false);
  });
});

describe('CallTurns, finalizing turns and the switch to Manual', () => {
  it('a switch while a pause-ended turn finalizes makes it the draft, never a POST', async () => {
    const h = turnsHarness();
    const r = reviewOverTurns(h);
    h.t.hold = true;
    h.t.results.push(heard('Book a table.', 'Book a table.'));
    await h.talk(1000);
    await h.pass(SILENCE);
    expect(h.t.ended).toBe(1);
    expect(await r.op('mode', { mode: 'review' })).toMatchObject({ ok: true });
    expect(r.states.at(-1)?.draft).toMatchObject({ state: 'finishing', reason: 'switch' });
    h.t.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out.sent).toEqual([]);
    expect(r.states.at(-1)?.draft).toMatchObject({ state: 'ready', text: 'Book a table.', reason: 'switch' });
  });

  it('a switch while a spoken command is confirmed keeps the words as the draft', async () => {
    const h = turnsHarness();
    const r = reviewOverTurns(h);
    h.t.hold = true;
    h.t.results.push(heard('Book a table. Zulu.', 'Book a table. Zulu.'));
    await h.talk(1000);
    await h.interim('Book a table. Zulu.');
    await h.interim('Book a table. Zulu.');
    expect(h.turns.turnOpen).toBe(true);
    await r.op('mode', { mode: 'review' });
    h.t.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out.sent).toEqual([]);
    expect(r.posted).toEqual([]);
    expect(r.states.at(-1)?.draft).toMatchObject({ state: 'ready', text: 'Book a table. Zulu.' });
  });

  it('speech after a command waits for the earlier words: one turn, in order, sent once', async () => {
    const h = turnsHarness();
    h.t.hold = true;
    h.t.results.push(heard('Remind me to zulu', 'Remind me to zulu.'));
    await h.talk(1500);
    await h.interim('Remind me to zulu');
    await h.interim('Remind me to zulu');
    expect(h.t.ended).toBe(1);
    // The caller goes on and confirms another send while the first part is still being finalized.
    h.t.hold = false;
    h.t.results.push(heard('to Anna tomorrow. Zulu.', 'to Anna tomorrow. Zulu.'));
    await h.talk(1500);
    await h.interim('to Anna tomorrow. Zulu.');
    await h.interim('to Anna tomorrow. Zulu.');
    expect(h.t.ended).toBe(2);
    expect(h.out.sent).toEqual([]);
    h.t.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out.sent).toEqual(['Remind me to zulu. to Anna tomorrow.']);
    expect(h.turns.turnOpen).toBe(false);
    await h.pass(SILENCE + 500);
    expect(h.t.begins).toHaveLength(2);
  });
});

describe('CallTurns, review', () => {
  it('an open auto turn becomes the switch draft; a recording is words, commands included', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('Book a table', 'Book a table'));
    await h.talk(1000);
    expect(h.turns.turnOpen).toBe(true);
    const switched = await h.turns.setReviewing(true);
    expect(switched).toMatchObject({ text: 'Book a table', failed: false });
    expect(h.out.sent).toEqual([]);
    expect(await h.turns.prepare()).toBe(true);
    h.turns.record();
    h.t.results.push(heard('Remind me to zulu. Zulu.', 'Zulu.'));
    await h.talk(1500);
    await h.interim('Remind me to zulu. Zulu.');
    await h.interim('Remind me to zulu. Zulu.');
    await h.pass(SILENCE + 500);
    expect(h.t.ended).toBe(1);
    expect(await h.turns.stopRecording()).toMatchObject({ text: 'Remind me to zulu. Zulu.' });
    expect(h.out.sent).toEqual([]);
  });

  it('a switch while a command is being confirmed takes that turn as the draft, unsent', async () => {
    const h = turnsHarness();
    h.t.hold = true;
    h.t.results.push(heard('Book a table. Zulu.', 'Book a table. Zulu.'));
    await h.talk(1000);
    await h.interim('Book a table. Zulu.');
    await h.interim('Book a table. Zulu.');
    const switched = h.turns.setReviewing(true);
    h.t.release();
    expect(await switched).toMatchObject({ text: 'Book a table. Zulu.' });
    expect(h.out.sent).toEqual([]);
  });
});

describe('cue audio', () => {
  it('is 20 ms frames of 48 kHz mono: 150-250 ms of tone held near its level, with soft edges', () => {
    for (const kind of ['listening', 'wake', 'sent', 'discard', 'turn', 'nope', 'draft', 'sleep'] as const) {
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

  it('loops the typing sound under no cue: a cue takes its place, and the noise floor is back once it stops', async () => {
    const typing = await loadTypingSound();
    expect(typing.length).toBeGreaterThan(50);
    for (const f of typing.slice(0, 3))
      expect([f.sampleRate, f.channels, f.samplesPerChannel]).toEqual([48_000, 1, 960]);
    // Quiet: well under the cues' level.
    let peak = 0;
    for (const f of typing) for (const v of f.data) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(100);
    expect(peak).toBeLessThan(0.15 * 32767);
    expect(await loadTypingSound()).toBe(typing);

    const taken: AudioFrame[] = [];
    const sink = { captureFrame: async (frame: AudioFrame) => void taken.push(frame) };
    const feed = new CueFeed(sink);
    feed.setBed(typing);
    await vi.waitFor(() => expect(taken.length).toBeGreaterThan(3));
    const start = taken.findIndex((f) => f === typing[0]);
    expect(taken.slice(start, start + 3)).toEqual(typing.slice(0, 3));
    const cue = cueFrames('sent');
    await feed.play(cue);
    const cueAt = taken.indexOf(cue[0]);
    // The cue alone, never mixed with the typing, then the typing goes on.
    expect(taken.slice(cueAt, cueAt + cue.length)).toEqual(cue);
    feed.setBed(undefined);
    const off = taken.length;
    await vi.waitFor(() => expect(taken.length).toBeGreaterThan(off + 2));
    expect(typing).not.toContain(taken.at(-1));
    feed.stop();
    await feed.running;
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

describe('room output and the caller input', () => {
  it('publishes in order, replaces a waiting interim with a newer one, and moves past a stuck publication', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const sent: string[] = [];
    const outbox = new Outbox({ warn: (msg: string) => void warnings.push(msg) });
    let release!: () => void;
    outbox.post('first', () => new Promise<void>((r) => (release = () => (sent.push('first'), r()))));
    outbox.post('interim', async () => void sent.push('interim 1'), 'caption 1');
    outbox.post('interim', async () => void sent.push('interim 2'), 'caption 1');
    outbox.post('final', async () => void sent.push('final'));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['first', 'interim 2', 'final']);
    // The first agent state after a join that never resolves: the call goes on, later updates flow.
    outbox.post('the agent state', () => new Promise(() => undefined), 'attribute lk.agent.state');
    outbox.post('status', async () => void sent.push('status'));
    outbox.post('a native throw', () => {
      throw new Error('closed');
    });
    outbox.post('the agent state', async () => void sent.push('state listening'), 'attribute lk.agent.state');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual(['first', 'interim 2', 'final', 'status', 'state listening']);
    expect(warnings.some((w) => w.includes('slow'))).toBe(true);
    expect(warnings.some((w) => w.includes('could not publish a native throw'))).toBe(true);
    // A room that takes nothing for a while drops superseded updates first, and never stops the queue.
    const full = new Outbox({ warn: (msg: string) => void warnings.push(msg) }, 60_000, 3);
    const order: string[] = [];
    full.post('stuck', () => new Promise(() => undefined));
    full.post('label', async () => void order.push('label'));
    full.post('interim', async () => void order.push('interim'), 'caption 2');
    full.post('final', async () => void order.push('final'));
    full.post('status', async () => void order.push('status'));
    expect(warnings.at(-1)).toContain('dropped interim');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(order).toEqual(['label', 'final', 'status']);
    vi.useRealTimers();
  });

  it('a microphone track that ends mid-speech ends the speech; the next track gets a fresh VAD on the same positions', async () => {
    const streams: Array<{ push: (ev: unknown) => void; frames: number; closed: boolean }> = [];
    const newVad = () => {
      const events: unknown[] = [];
      let wake: (() => void) | undefined;
      const entry = { push: (ev: unknown) => (events.push(ev), wake?.()), frames: 0, closed: false };
      streams.push(entry);
      return {
        pushFrame: () => void entry.frames++,
        close: () => ((entry.closed = true), wake?.()),
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (events.length) yield events.shift() as never;
            else if (entry.closed) return;
            else await new Promise<void>((r) => (wake = r));
          }
        },
      } as unknown as VadStream;
    };
    const speech: Array<[boolean, number]> = [];
    const input = new CallerInput(
      newVad,
      { onAudio: () => undefined, onSpeech: (on, at) => void speech.push([on, at]), onClosed: () => undefined },
      { error: () => undefined },
    );
    const frame = () => input.frame(new AudioFrame(new Int16Array(320), 16_000, 1, 320));
    for (let i = 0; i < 50; i++) frame();
    streams[0].push({
      type: VADEventType.START_OF_SPEECH,
      samplesIndex: 16_000,
      speechDuration: 200,
      silenceDuration: 0,
    });
    await flush();
    expect(speech).toEqual([[true, 16_000 - 3_200]]);
    input.ended();
    expect(speech).toEqual([
      [true, 12_800],
      [false, 16_000],
    ]);
    // The old VAD's late events are ignored; the new track's positions continue the call's.
    streams[0].push({
      type: VADEventType.END_OF_SPEECH,
      samplesIndex: 30_000,
      speechDuration: 0,
      silenceDuration: 600,
    });
    for (let i = 0; i < 50; i++) frame();
    streams[1].push({
      type: VADEventType.START_OF_SPEECH,
      samplesIndex: 8_000,
      speechDuration: 100,
      silenceDuration: 0,
    });
    await flush();
    expect(streams[0].closed).toBe(true);
    expect(speech.at(-1)).toEqual([true, 16_000 + 8_000 - 1_600]);
    expect(speech).toHaveLength(3);
  });
});

describe('commands, cues and review in a call', () => {
  const utterances = (host: ReturnType<typeof fakeHostFetch>) =>
    host.calls.filter((c) => c.url.endsWith('/utterance')).map((c) => c.body?.text);
  const played = (v: ReturnType<typeof fakeVoice>) => v.voice.playCue.mock.calls.map(([kind]) => kind);

  it('hears the names and the commands: they are the transcription vocabulary', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    const make = vi.fn(() => v.transcription);
    await runCall(ctx, { ...callDeps(host.fetchImpl, v), transcriber: make });
    expect(make).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.5-transcribe-live',
        languageCodes: ['uk-UA', 'en-US'],
        sampleRate: 16_000,
        vocabulary: ['NanoClaw', ...COMMAND_VOCABULARY],
      }),
    );
    host.endStream();
  });

  it('plays listening once the page sent its settings, sent on a turn, none over speech; cues=0 plays nothing', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await vi.waitFor(() => expect(played(v)).toEqual(['listening']));
    await v.turn('Book a table');
    await vi.waitFor(() => expect(played(v)).toEqual(['listening', 'sent']));
    host.emit({ type: 'reply', text: 'Booked.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith('Booked.', expect.any(Function)));
    await vi.waitFor(() => expect(played(v)).toEqual(['listening', 'sent', 'turn']));
    await v.rpc('settings', { cues: false });
    await v.turn('And a taxi');
    await vi.waitFor(() => expect(utterances(host)).toHaveLength(2));
    await flush();
    expect(played(v)).toEqual(['listening', 'sent', 'turn']);
    host.endStream();
  });

  it('a command said alone names itself and its caption line', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await v.turn('Scratch that.');
    await vi.waitFor(() =>
      expect(v.voice.publishDropped).toHaveBeenCalledWith({
        dropped: 'command',
        text: 'Scratch that.',
        command: 'discard',
        segment: expect.stringMatching(/^SG_turn_\d+$/),
      }),
    );
    const segment = v.voice.publishDropped.mock.calls.at(-1)?.[0].segment as string;
    expect(v.voice.caption).toHaveBeenCalledWith(Number(segment.slice('SG_turn_'.length)), 'Scratch that.', true, {
      command: 'discard',
      words: '',
    });
    host.endStream();
  });

  it('a spoken discard posts nothing, marks the words dropped and plays the discard cue', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await v.turn('Remind me to call the plumber. Scratch that.');
    await vi.waitFor(() =>
      expect(v.voice.publishDropped).toHaveBeenCalledWith({
        dropped: 'discarded',
        text: 'Remind me to call the plumber. Scratch that.',
      }),
    );
    await vi.waitFor(() => expect(played(v)).toContain('discard'));
    expect(utterances(host)).toEqual([]);
    host.endStream();
  });

  it('starts wake-gated until the page says otherwise: speech before the wake phrase is ignored', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    v.voice.review.serve.mockImplementation(() => undefined);
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await v.turn('So the weekend plan is settled.');
    await vi.waitFor(() =>
      expect(v.voice.publishDropped).toHaveBeenCalledWith({
        dropped: 'unaddressed',
        text: 'So the weekend plan is settled.',
      }),
    );
    expect(utterances(host)).toEqual([]);
    host.endStream();
  });

  it('types while the agent works: stops as it speaks, and with cues off', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    const typing: boolean[] = [];
    Object.assign(v.voice, { setTyping: vi.fn((on: boolean) => void typing.push(on)) });
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await v.turn('Book a table');
    await vi.waitFor(() => expect(typing).toEqual([true]));
    v.events.onAgentSpeaking?.(true);
    expect(typing).toEqual([true, false]);
    v.events.onAgentSpeaking?.(false);
    host.emit({ type: 'working' });
    await vi.waitFor(() => expect(typing).toEqual([true, false, true]));
    await v.rpc('settings', { cues: false });
    expect(typing).toEqual([true, false, true, false]);
    host.endStream();
  });

  it("the page's typing switch: off, no typing while the agent works; off mid-work stops it at once", async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    const typing: boolean[] = [];
    Object.assign(v.voice, { setTyping: vi.fn((on: boolean) => void typing.push(on)) });
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await v.rpc('settings', { typing: false });
    await v.turn('Book a table');
    host.emit({ type: 'working' });
    await flush();
    expect(typing).toEqual([]);
    // Back on while the agent still works: it types; off again, it stops right there.
    await v.rpc('settings', { typing: true });
    expect(typing).toEqual([true]);
    await v.rpc('settings', { typing: false });
    expect(typing).toEqual([true, false]);
    // Settings that leave the switch out keep it as it is.
    await v.rpc('settings', { wake: false });
    expect(typing).toEqual([true, false]);
    host.endStream();
  });

  it('speech while a line plays is reported unheard and opens no turn', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    let finish: (() => void) | undefined;
    v.voice.say.mockImplementation(async (_text: string, ready?: () => Promise<void>) => {
      await ready?.();
      v.events.onAgentSpeaking?.(true);
      await new Promise<void>((resolve) => (finish = resolve));
      v.events.onAgentSpeaking?.(false);
      return true;
    });
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await flush();
    host.emit({ type: 'reply', text: 'A long story.', turn: null });
    await vi.waitFor(() => expect(finish).toBeDefined());
    v.events.onSpeech(true, 0);
    expect(v.voice.publishUnheard).toHaveBeenCalledTimes(1);
    v.events.onSpeech(false, 0);
    expect(v.transcription.begins).toEqual([]);
    finish?.();
    host.endStream();
  });

  it('speech while a reply is synthesized is a turn: the reply waits for it, and no sentence of three is lost', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    let synthesized: (() => void) | undefined;
    const played: string[] = [];
    v.voice.say.mockImplementation(async (text: string, ready?: () => Promise<void>) => {
      await new Promise<void>((resolve) => (synthesized = resolve));
      await ready?.();
      v.events.onAgentSpeaking?.(true);
      played.push(text);
      v.events.onAgentSpeaking?.(false);
      return true;
    });
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await flush();
    // Three sentences with 3 s thinking pauses: the 2.5 s closing silence sends each as it ends.
    await v.turn('The first sentence.');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['The first sentence.']));
    host.emit({ type: 'reply', text: 'Noted.', turn: '1' });
    await vi.waitFor(() => expect(synthesized).toBeDefined());
    v.audio(500);
    // The second sentence starts while the reply is synthesized: heard, never "not heard".
    v.transcription.results.push(heard('The second sentence.', 'The second sentence.'));
    const start = v.position;
    v.audio(100);
    v.events.onSpeech(true, start);
    expect(v.transcription.begins).toHaveLength(2);
    synthesized?.();
    await flush();
    expect(played).toEqual([]);
    v.audio(900);
    const end = v.position;
    v.audio(SILENCE);
    v.events.onSpeech(false, end);
    await vi.waitFor(() => expect(utterances(host)).toEqual(['The first sentence.', 'The second sentence.']));
    // Its turn sent, the reply plays.
    await vi.waitFor(() => expect(played).toEqual(['Noted.']));
    v.audio(500);
    await v.turn('The third sentence.');
    await vi.waitFor(() =>
      expect(utterances(host)).toEqual(['The first sentence.', 'The second sentence.', 'The third sentence.']),
    );
    expect(v.voice.publishUnheard).not.toHaveBeenCalled();
    host.endStream();
  });

  it('a reply nobody heard shows as text, says why, and plays no your-turn cue', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    v.voice.say.mockImplementation(async (text: string) => !text.startsWith('It is sunny'));
    await runCall(ctx, callDeps(host.fetchImpl, v));
    await vi.waitFor(() => expect(played(v)).toEqual(['listening']));
    host.emit({ type: 'reply', text: 'It is sunny.', turn: null });
    await vi.waitFor(() =>
      expect(v.voice.publishReply).toHaveBeenCalledWith(
        expect.objectContaining({ unspoken: true, text: 'It is sunny.' }),
      ),
    );
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalledWith(FAILURE_LINES.reply.uk, expect.any(Function)));
    await new Promise((r) => setTimeout(r, TURN_CUE_DELAY_MS + 50));
    expect(played(v)).toEqual(['listening', 'turn']);
    host.endStream();
  });

  it('review in a call: talk records, done posts nothing, send posts the frozen text once', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    expect(await v.rpc('mode', { mode: 'review' })).toMatchObject({ ok: true });
    expect(await v.rpc('talk')).toMatchObject({ ok: true, draft: 1 });
    expect(v.transcription.prepare).toHaveBeenCalled();
    expect(v.transcription.begins).toHaveLength(1);
    v.transcription.results.push(heard('Book a table. Zulu.', 'Book a table. Zulu.'));
    v.audio(1500);
    expect(await v.rpc('done', { draft: 1 })).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(v.states.at(-1)?.draft).toMatchObject({ state: 'ready', text: 'Book a table. Zulu.' }),
    );
    expect(utterances(host)).toEqual([]);
    expect(await v.rpc('send', { draft: 1 })).toMatchObject({ ok: true, turn: 1 });
    await vi.waitFor(() => expect(utterances(host)).toEqual(['Book a table. Zulu.']));
    expect(v.voice.publishTurn).toHaveBeenCalledWith({
      turn: 1,
      status: 'sending',
      text: 'Book a table. Zulu.',
      draft: 1,
    });
    host.endStream();
  });

  it('answers only the caller', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    await runCall(ctx, callDeps(host.fetchImpl, v));
    const handle = v.voice.review.serve.mock.calls[0][0];
    await expect(handle('talk', JSON.stringify({ gen: 9 }), 'someone-else')).rejects.toThrow();
    host.endStream();
  });
});

describe('acoustic wake word in a call', () => {
  const utterances = (host: ReturnType<typeof fakeHostFetch>) =>
    host.calls.filter((c) => c.url.endsWith('/utterance')).map((c) => c.body?.text);
  function fakeWakeWord(load: 'ok' | 'later' = 'ok') {
    let events!: WakeWordEvents;
    let fail: (err: Error) => void = () => undefined;
    const listening: boolean[] = [];
    let pushed = 0;
    const wake = {
      phrase: 'Hey LiveKit',
      threshold: 0.68,
      ready: load === 'ok' ? Promise.resolve() : new Promise<void>((_, reject) => (fail = reject)),
      listen: vi.fn((on: boolean) => void listening.push(on)),
      push: vi.fn((pcm: Int16Array) => void (pushed += pcm.length)),
      summary: { scored: 0, skipped: 0, meanMs: 0, maxMs: 0, detections: 0, maxScore: 0 },
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
      listening,
      fail: (err: Error) => fail(err),
      get pushed() {
        return pushed;
      },
      get events() {
        return events;
      },
    };
  }

  it('a detection opens the turn where it was spotted; audio is scored only while waiting', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    const w = fakeWakeWord();
    await runCall(ctx, { ...callDeps(host.fetchImpl, v), wakeWord: w.make });
    await v.rpc('settings', { wake: true });
    await vi.waitFor(() =>
      expect(v.states.at(-1)?.wake).toMatchObject({ on: true, waiting: true, phrase: 'Hey LiveKit' }),
    );
    v.audio(3000);
    expect(w.listening.at(-1)).toBe(true);
    expect(v.transcription.begins).toEqual([]);
    // The spotter's own positions: it was pushed all of this call's audio since it started.
    w.events.onDetect(0.9, { start: w.pushed - 32_000, end: w.pushed });
    expect(v.transcription.begins).toEqual([0]);
    await vi.waitFor(() => expect(v.voice.playCue.mock.calls.map(([k]) => k)).toContain('wake'));
    v.audio(20);
    expect(w.listening.at(-1)).toBe(false);
    v.transcription.results.push(heard('What is the time? Zulu.', 'Zulu.'));
    v.events.onSpeech(true, 0);
    v.audio(1000);
    v.events.onSpeech(false, 0);
    v.interim('What is the time? Zulu.');
    v.interim('What is the time? Zulu.');
    await vi.waitFor(() => expect(utterances(host)).toEqual(['What is the time?']));
    host.endStream();
  });

  it('the job shuts down only once the spotter thread stopped: a process leaving mid-inference aborts', async () => {
    const { ctx, job, roomHandlers } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    const w = fakeWakeWord();
    let stopped!: () => void;
    w.wake.close.mockImplementation(() => new Promise<undefined>((resolve) => (stopped = () => resolve(undefined))));
    await runCall(ctx, { ...callDeps(host.fetchImpl, v), wakeWord: w.make });
    await vi.waitFor(() => expect(v.states.some((s) => s.wake?.phrase === 'Hey LiveKit')).toBe(true));
    roomHandlers.get('participantDisconnected')?.(HANG_UP);
    await vi.waitFor(() => expect(w.wake.close).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(job.shutdown).not.toHaveBeenCalled();
    stopped();
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('caller left'));
  });

  it('names the phrase while the model loads, and falls back to the transcript name when it does not', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    const w = fakeWakeWord('later');
    await runCall(ctx, { ...callDeps(host.fetchImpl, v), wakeWord: w.make });
    await vi.waitFor(() => expect(v.states.some((s) => s.wake?.phrase === 'Hey LiveKit')).toBe(true));
    w.fail(new Error('wake word model not found: x'));
    await vi.waitFor(() => expect(v.states.at(-1)?.wake).not.toHaveProperty('phrase'));
    host.endStream();
  });
});

describe('acoustic wake word', () => {
  it('reads the model, threshold and phrase from the settings', () => {
    expect(wakeWordSettings({})).toEqual({
      classifier: expect.stringMatching(/hey_livekit\.onnx$/),
      threshold: 0.68,
      phrase: 'Hey LiveKit',
    });
    expect(wakeWordSettings({ VOICE_MODE_WAKE_MODEL: 'off' })).toBeNull();
    expect(
      wakeWordSettings({
        VOICE_MODE_WAKE_MODEL: 'data/models/hey_jarvis.onnx',
        VOICE_MODE_WAKE_PHRASE: ' Hey  Jarvis ',
      }),
    ).toEqual({
      classifier: path.resolve('data/models/hey_jarvis.onnx'),
      threshold: 0.5,
      phrase: 'Hey Jarvis',
    });
    expect(wakeWordSettings({ VOICE_MODE_WAKE_THRESHOLD: '0.8' })?.threshold).toBe(0.8);
    expect(wakeWordSettings({ VOICE_MODE_WAKE_THRESHOLD: '7' })?.threshold).toBe(0.68);
  });

  it('reads its limits from the settings, in seconds; 0 is never', () => {
    expect(awakeLimits({})).toEqual({ startMs: 8_000, idleMs: 20_000 });
    expect(awakeLimits({ VOICE_MODE_WAKE_START_SECONDS: '5', VOICE_MODE_WAKE_IDLE_SECONDS: '0' })).toEqual({
      startMs: 5_000,
      idleMs: 0,
    });
    expect(awakeLimits({ VOICE_MODE_WAKE_START_SECONDS: 'soon', VOICE_MODE_WAKE_IDLE_SECONDS: '-1' })).toEqual({
      startMs: 8_000,
      idleMs: 20_000,
    });
  });
});

describe('wide events', () => {
  it('a turn reports its mode, text source and stage timings from the speech end, never its words', async () => {
    const h = turnsHarness();
    h.t.results.push(heard('Book a table for two', 'Book a table for two.'));
    await h.talk(1000);
    // talk() reports the speech end 560 ms (whole 20 ms frames) into the silence.
    const speechEnd = Date.now() - 560;
    await h.pass(SILENCE);
    expect(h.out.sent).toEqual(['Book a table for two.']);
    const facts = h.out.facts[0];
    expect(facts).toMatchObject({
      segment: 1,
      mode: 'handsfree',
      endedBy: 'pause',
      source: 'final',
      finals: 1,
      words: 5,
      activityEndMs: SILENCE,
      finalMs: SILENCE,
    });
    expect(facts?.speechEndAt).toBe(speechEnd);
    expect(JSON.stringify(facts)).not.toContain('table');

    // A spoken discard comes to nothing: reported as discarded by the command.
    h.t.results.push(
      heard('Remind me to call the plumber. Scratch that.', 'Remind me to call the plumber. Scratch that.'),
    );
    await h.talk(1500);
    await h.pass(SILENCE);
    expect(h.out.ended.map(([f, outcome, reason]) => [f.segment, outcome, reason])).toEqual([
      [2, 'discarded', 'command'],
    ]);
  });

  it('a woken turn says so, and the words before the wake phrase are unaddressed', async () => {
    const h = turnsHarness({ wake: true, pauseSends: true });
    h.t.results.push(heard('Just thinking aloud', 'Just thinking aloud.'));
    await h.talk(1000);
    await h.pass(SILENCE);
    expect(h.out.ended.map(([f, outcome, reason]) => [f.mode, outcome, reason])).toEqual([
      ['wake', 'unaddressed', 'no_wake'],
    ]);
  });

  it('a sent turn waits for its reply to play; the call event counts what happened', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const telemetry = new CallTelemetry({ info });
    const facts: TurnFacts = {
      segment: 1,
      mode: 'handsfree',
      endedBy: 'pause',
      source: 'final',
      finals: 1,
      words: 3,
      speechMs: 900,
      speechEndAt: Date.now(),
      activityEndMs: 2500,
      finalMs: 2700,
    };
    vi.advanceTimersByTime(2900);
    telemetry.turn({ facts, outcome: 'sent', turn: 1, hostAt: Date.now(), hostStatus: 202 });
    telemetry.turn({ facts: { ...facts, segment: 2 }, outcome: 'empty', reason: 'noise', turn: 2 });
    // Not out yet: its reply has not played.
    expect(info.mock.calls.map(([, f]) => f.turn)).toEqual([2]);
    vi.advanceTimersByTime(4100);
    telemetry.replyStarted(1);
    expect(info).toHaveBeenLastCalledWith('voice-mode.turn', {
      turn: 1,
      segment: 1,
      mode: 'handsfree',
      endedBy: 'pause',
      source: 'final',
      finals: 1,
      words: 3,
      speechMs: 900,
      activityEndMs: 2500,
      finalMs: 2700,
      outcome: 'sent',
      hostMs: 2900,
      hostStatus: 202,
      replyMs: 7000,
    });
    // Another sent turn whose reply never comes goes out on its own after a while, without replyMs.
    telemetry.turn({ facts, outcome: 'sent', turn: 3, hostAt: Date.now() });
    vi.advanceTimersByTime(TURN_EVENT_WAIT_MS);
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ turn: 3, outcome: 'sent' });
    expect(info.mock.calls.at(-1)?.[1]).not.toHaveProperty('replyMs');
    // A Manual draft says so, whatever its activity was.
    telemetry.turn({ facts, outcome: 'discarded', reason: 'review', draft: 4 });
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ draft: 4, mode: 'manual', outcome: 'discarded' });

    telemetry.reply({
      reply: 1,
      kind: 'reply',
      turn: 1,
      part: 1,
      outcome: 'spoken',
      fallback: false,
      durationMs: 1,
      peakDb: -1,
      rmsDb: -2,
    });
    telemetry.reply({
      reply: 2,
      kind: 'notice',
      outcome: 'failed',
      fallback: false,
      durationMs: 0,
      peakDb: -1,
      rmsDb: -2,
    });
    telemetry.turn({ facts, outcome: 'sent', turn: 5, hostAt: Date.now() });
    telemetry.ended('caller left', { wakes: 2 });
    telemetry.ended('twice');
    const events = info.mock.calls.map(([msg]) => msg);
    // The waiting turn goes out before the call's event, and the call's event goes out once.
    expect(events.slice(-2)).toEqual(['voice-mode.turn', 'voice-mode.call']);
    expect(info.mock.calls.at(-1)?.[1]).toEqual({
      reason: 'caller left',
      durationMs: 2900 + 4100 + TURN_EVENT_WAIT_MS,
      turnsSent: 3,
      turnsDiscarded: 1,
      turnsEmpty: 1,
      turnsLost: 0,
      turnsUnaddressed: 0,
      repliesSpoken: 1,
      repliesPartial: 0,
      repliesFailed: 1,
      wakes: 2,
    });
  });

  it('a spoken line reports its model, fallback, latency, length and levels', () => {
    let now = 1000;
    const meter = new LineMeter(() => now);
    expect(meter.done({ model: 'a', primary: 'a', failed: false, cut: false })).toBeNull();
    now = 1800;
    meter.audio();
    now = 2000;
    meter.audio();
    meter.playing();
    meter.frame(Int16Array.from({ length: 24_000 }, (_, i) => (i % 2 ? 16384 : -16384)));
    expect(meter.done({ model: 'b', primary: 'a', failed: false, cut: false })).toEqual({
      outcome: 'spoken',
      model: 'b',
      fallback: true,
      firstAudioMs: 800,
      heldMs: 200,
      durationMs: 1000,
      peakDb: -6,
      rmsDb: -6,
    });
    expect(meter.done({ model: 'a', primary: 'a', failed: true, cut: false })?.outcome).toBe('partial');
    expect(meter.done({ model: 'a', primary: 'a', failed: false, cut: true })?.outcome).toBe('partial');
    expect(new LineMeter().done({ model: 'a', primary: 'a', failed: true, cut: false })).toEqual({
      outcome: 'failed',
      fallback: false,
      durationMs: 0,
      peakDb: -Infinity,
      rmsDb: -Infinity,
    });
  });

  it('in a call: the turn, its reply and the call each log one event', async () => {
    const { ctx } = fakeJob();
    const host = fakeHostFetch();
    const v = fakeVoice();
    const info = vi.fn();
    await runCall(ctx, callDeps(host.fetchImpl, v, { log: { info, warn: () => undefined } }));
    const settings = v.createVoice.mock.calls[0][2];
    v.voice.say.mockImplementation(async (_text: string, ready?: () => Promise<void>) => {
      await ready?.();
      v.events.onAgentSpeaking?.(true);
      settings.spoke?.({ outcome: 'spoken', model: 'tts', fallback: false, durationMs: 800, peakDb: -3, rmsDb: -20 });
      v.events.onAgentSpeaking?.(false);
      return true;
    });
    await v.turn('Book a table');
    await vi.waitFor(() =>
      expect(v.voice.publishTurn).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' })),
    );
    host.emit({ type: 'reply', text: 'Booked.', turn: '1' });
    await vi.waitFor(() => expect(v.voice.say).toHaveBeenCalled());
    host.emit({ type: 'end', reason: 'caller hung up' });
    await vi.waitFor(() => expect(info.mock.calls.some(([msg]) => msg === 'voice-mode.call')).toBe(true));
    const event = (msg: string) => info.mock.calls.filter(([m]) => m === msg).map(([, f]) => f);
    expect(event('voice-mode.turn')).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        turn: 1,
        mode: 'handsfree',
        outcome: 'sent',
        source: 'final',
        hostStatus: 202,
        hostMs: expect.any(Number),
        replyMs: expect.any(Number),
      }),
    ]);
    expect(event('voice-mode.reply')).toEqual([
      {
        callId: 'call-1',
        reply: 1,
        kind: 'reply',
        turn: 1,
        part: 1,
        outcome: 'spoken',
        model: 'tts',
        fallback: false,
        durationMs: 800,
        peakDb: -3,
        rmsDb: -20,
      },
    ]);
    expect(event('voice-mode.call')).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        reason: 'host: caller hung up',
        turnsSent: 1,
        repliesSpoken: 1,
        wakes: 0,
      }),
    ]);
    // No words of the caller or the agent in any event.
    expect(JSON.stringify(info.mock.calls.filter(([m]) => String(m).startsWith('voice.')))).not.toMatch(/table|Booked/);
  });
});
