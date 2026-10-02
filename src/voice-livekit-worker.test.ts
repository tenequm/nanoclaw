/**
 * The walkie-talkie worker: turn detection on VAD windows, the call's
 * gating and reply queue against fake Gemini, host and room, the Gemini
 * request shapes against a fake fetch, and runCall end to end with a fake
 * room. Silero and the real room are not loaded here.
 */
import { initializeLogger } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { liveKitCallSecret, type LiveKitJobMetadata } from './channels/voice-livekit-protocol.js';
import {
  decodeSpeechAudio,
  HostLink,
  HostMonitor,
  parseJobMetadata,
  pcmToWav,
  probeHost,
  runCall,
  speakableText,
  splitForSpeech,
  synthesize,
  transcribe,
  transcriptionPrompt,
  TurnDetector,
  WalkieCall,
  type CallJob,
  type CallMedia,
  type SpeechAudio,
  type WalkieDeps,
  type WalkieState,
} from './voice-livekit-worker.js';

initializeLogger({ pretty: false, level: 'error' });

/** One Silero window at 16 kHz: 512 samples, 32 ms. */
const WINDOW = 512;
const window = (value: number) => new Int16Array(WINDOW).fill(value);
const msOf = (windows: number) => (windows * WINDOW * 1000) / 16_000;
const flush = () => new Promise((r) => setTimeout(r, 5));

/** Feed `n` windows; speech windows carry 1000, silence 1. Returns the turns completed. */
function feed(target: { push(pcm: Int16Array, speech: boolean): unknown }, n: number, speech: boolean) {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const turn = target.push(window(speech ? 1000 : 1), speech);
    if (turn) out.push(turn);
  }
  return out;
}

describe('TurnDetector', () => {
  const detector = (overrides = {}) =>
    new TurnDetector({ sampleRate: 16_000, silenceMs: 2500, preRollMs: 64, postRollMs: 96, ...overrides });

  it('keeps a turn open through pauses shorter than the silence threshold and ends it after', () => {
    const d = detector();
    expect(feed(d, 10, false)).toEqual([]);
    expect(d.active).toBe(false);
    expect(feed(d, 20, true)).toEqual([]);
    expect(d.active).toBe(true);
    // A 1.5 s pause mid-thought: still one turn.
    expect(feed(d, 47, false)).toEqual([]);
    expect(feed(d, 20, true)).toEqual([]);
    // 2.5 s of silence = 78.1 windows; the 79th ends the turn.
    expect(feed(d, 78, false)).toEqual([]);
    const [turn] = feed(d, 1, false) as Array<{ pcm: Int16Array; speechMs: number }>;
    expect(d.active).toBe(false);
    expect(turn.speechMs).toBe(msOf(40));
    // Pre-roll (2 windows) + speech + pause + speech + post-roll (3 windows); the long silence is cut.
    expect(turn.pcm.length).toBe((2 + 20 + 47 + 20 + 3) * WINDOW);
    expect(turn.pcm[0]).toBe(1);
    expect(turn.pcm[2 * WINDOW]).toBe(1000);
  });

  it('drops a turn with less than 400 ms of speech', () => {
    const onDrop = vi.fn();
    const d = detector({ onDrop });
    feed(d, 12, true); // 384 ms
    expect(feed(d, 79, false)).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith(384);
    expect(d.active).toBe(false);
    feed(d, 13, true); // 416 ms
    expect(feed(d, 79, false)).toHaveLength(1);
  });

  it('ends a turn that runs past the longest turn, and forgets everything on reset', () => {
    const d = detector({ maxTurnMs: 1000 });
    const turns = feed(d, 40, true);
    expect(turns).toHaveLength(1);
    feed(d, 5, true);
    expect(d.active).toBe(true);
    d.reset();
    expect(d.active).toBe(false);
    expect(feed(d, 79, false)).toEqual([]);
  });
});

/** A WalkieCall over fakes, with every effect recorded in order. */
function walkieHarness(overrides: Partial<WalkieDeps> = {}) {
  const effects: string[] = [];
  const states: WalkieState[] = [];
  const sent: string[] = [];
  const played: SpeechAudio[] = [];
  let transcript = 'hello there';
  const plays: Array<() => void> = [];
  let autoPlay = true;
  const deps: WalkieDeps = {
    transcribe: vi.fn(async () => {
      effects.push('transcribe');
      return transcript;
    }),
    send: vi.fn(async (text: string) => {
      effects.push(`send:${text}`);
      sent.push(text);
      return true;
    }),
    synthesize: vi.fn(async (text: string) => ({ pcm: new Int16Array([text.length]), sampleRate: 24_000 })),
    play: vi.fn((audio: SpeechAudio) => {
      effects.push(`play:${audio.pcm[0]}`);
      played.push(audio);
      return autoPlay ? Promise.resolve() : new Promise<void>((r) => plays.push(r));
    }),
    caption: vi.fn((role: string, text: string) => effects.push(`caption:${role}:${text}`)),
    setState: (s) => states.push(s),
    log: { info: () => undefined, warn: () => undefined },
    ...overrides,
  };
  const call = new WalkieCall(deps, { silenceMs: 2500, playbackTailMs: 0 });
  const speak = (windows = 20) => {
    for (let i = 0; i < windows; i++) call.onAudio(window(1000), true);
  };
  const silence = (windows = 79) => {
    for (let i = 0; i < windows; i++) call.onAudio(window(1), false);
  };
  return {
    call,
    deps,
    effects,
    states,
    sent,
    played,
    speak,
    silence,
    setTranscript: (t: string) => (transcript = t),
    holdPlayback: () => (autoPlay = false),
    finishPlay: () => plays.shift()?.(),
  };
}

describe('WalkieCall', () => {
  afterEach(() => vi.useRealTimers());

  it('sends a finished turn as its transcript and shows sending, then thinking', async () => {
    const w = walkieHarness();
    expect(w.states).toEqual(['listening']);
    w.speak();
    w.silence(40);
    expect(w.deps.transcribe).not.toHaveBeenCalled();
    w.silence(39);
    await vi.waitFor(() => expect(w.sent).toEqual(['hello there']));
    expect(w.effects).toEqual(['transcribe', 'caption:caller:hello there', 'send:hello there']);
    expect(w.states).toEqual(['listening', 'sending', 'thinking']);
    w.call.close();
  });

  it('drops a turn whose transcript is empty', async () => {
    const w = walkieHarness();
    w.setTranscript('');
    w.speak();
    w.silence();
    await flush();
    expect(w.deps.transcribe).toHaveBeenCalledTimes(1);
    expect(w.deps.send).not.toHaveBeenCalled();
    expect(w.states.at(-1)).toBe('listening');
  });

  it('ignores the caller while a reply plays, and keeps follow-ups while the agent thinks', async () => {
    const w = walkieHarness();
    w.holdPlayback();
    w.speak();
    w.silence();
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    // Still thinking: a follow-up turn is its own message.
    w.setTranscript('and one more thing');
    w.speak();
    w.silence();
    await vi.waitFor(() => expect(w.sent).toEqual(['hello there', 'and one more thing']));

    w.call.onReply('Sure.');
    await vi.waitFor(() => expect(w.deps.play).toHaveBeenCalledTimes(1));
    expect(w.states.at(-1)).toBe('speaking');
    // The caller talks over the reply: nothing of it is kept.
    w.speak(40);
    w.silence();
    w.finishPlay();
    await vi.waitFor(() => expect(w.states.at(-1)).toBe('listening'));
    w.silence();
    await flush();
    expect(w.deps.transcribe).toHaveBeenCalledTimes(2);
  });

  it('holds a reply until the caller finishes the turn in progress', async () => {
    const w = walkieHarness();
    w.speak();
    w.call.onReply('Here it is.');
    await flush();
    expect(w.deps.play).not.toHaveBeenCalled();
    w.silence();
    await vi.waitFor(() => expect(w.deps.play).toHaveBeenCalledTimes(1));
    // The caller's turn went out first, then the reply played.
    expect(w.effects.indexOf('transcribe')).toBeLessThan(w.effects.indexOf('play:11'));
  });

  it('plays replies whole, one after another, chunk by chunk in order', async () => {
    const w = walkieHarness();
    w.holdPlayback();
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here and it is long enough.`).join(
      ' ',
    );
    w.call.onReply(long);
    w.call.onReply('Second reply.');
    await vi.waitFor(() => expect(w.deps.play).toHaveBeenCalledTimes(1));
    const chunks = splitForSpeech(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      w.finishPlay();
      await vi.waitFor(() => expect(w.deps.play).toHaveBeenCalledTimes(i + 1));
    }
    // Never overlapping: the second reply starts only after the first one's last chunk.
    w.finishPlay();
    await vi.waitFor(() => expect(w.deps.play).toHaveBeenCalledTimes(chunks.length + 1));
    expect(w.played.map((a) => a.pcm[0])).toEqual([...chunks.map((c) => c.length), 'Second reply.'.length]);
    expect(w.effects.filter((e) => e.startsWith('caption:agent'))).toEqual([
      `caption:agent:${long}`,
      'caption:agent:Second reply.',
    ]);
    w.finishPlay();
  });

  it('speaks plain text, never the markdown', async () => {
    const w = walkieHarness();
    w.call.onReply('**Done.** See [the doc](https://x.example/doc).');
    await vi.waitFor(() => expect(w.deps.synthesize).toHaveBeenCalled());
    expect(w.deps.synthesize).toHaveBeenCalledWith('Done. See the doc.');
  });

  it('skips a chunk that will not synthesize and plays the rest', async () => {
    let n = 0;
    const w = walkieHarness({
      synthesize: vi.fn(async (text: string) => {
        if (n++ === 0) throw new Error('500');
        return { pcm: new Int16Array([text.length]), sampleRate: 24_000 };
      }),
    });
    w.call.onReply('One.');
    w.call.onReply('Two.');
    await vi.waitFor(() => expect(w.played.map((a) => a.pcm[0])).toEqual([4]));
  });

  it('shows the agent thinking while the host says it works, and listening once that stops', () => {
    vi.useFakeTimers();
    let t = 0;
    const w = walkieHarness({ now: () => t });
    w.call.onThinking();
    expect(w.states.at(-1)).toBe('thinking');
    t = 10_001;
    vi.advanceTimersByTime(10_001);
    expect(w.states.at(-1)).toBe('listening');
    w.call.close();
  });
});

describe('Gemini transcription', () => {
  const okText = (parts: unknown[]) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { status: 200 });

  it('sends the turn inline as 16 kHz WAV with a verbatim prompt and the line vocabulary', async () => {
    const fetchImpl = vi.fn(async () => okText([{ text: 'thinking...', thought: true }, { text: ' Привіт, Stan ' }]));
    const pcm = new Int16Array([1, -2, 3]);
    const text = await transcribe(pcm, {
      apiKey: 'gk-test',
      model: 'gemini-3.8-flash',
      vocabulary: ['NanoClaw', 'Stan'],
      fetchImpl,
    });
    expect(text).toBe('Привіт, Stan');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gk-test');
    expect(url).not.toContain('gk-test');
    const body = JSON.parse(String(init.body)) as {
      contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
      generationConfig: Record<string, unknown>;
    };
    const [prompt, audio] = body.contents[0].parts;
    expect(prompt.text).toBe(transcriptionPrompt(['NanoClaw', 'Stan']));
    expect(prompt.text).toContain('Ukrainian or English');
    expect(prompt.text).toContain('no translation');
    expect(prompt.text).toContain('NanoClaw, Stan');
    expect(audio.inlineData!.mimeType).toBe('audio/wav');
    const wav = Buffer.from(audio.inlineData!.data, 'base64');
    expect(wav.equals(pcmToWav(pcm, 16_000))).toBe(true);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readInt16LE(46)).toBe(-2);
    expect(body.generationConfig).toEqual({ temperature: 0, thinkingConfig: { thinkingLevel: 'low' } });
  });

  it('leaves vocabulary and thinking out when there are none to give', async () => {
    const fetchImpl = vi.fn(async () => okText([{ text: 'hi' }]));
    await transcribe(new Int16Array(4), { apiKey: 'k', model: 'gemini-3.5-transcribe', vocabulary: [], fetchImpl });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      contents: Array<{ parts: Array<{ text?: string }> }>;
      generationConfig: Record<string, unknown>;
    };
    expect(body.contents[0].parts[0].text).not.toContain('Names and terms');
    expect(body.generationConfig).toEqual({ temperature: 0 });
  });

  it('reads a noise-only answer as no speech, retries a server error once, and surfaces a refusal', async () => {
    expect(
      await transcribe(new Int16Array(4), {
        apiKey: 'k',
        model: 'm',
        vocabulary: [],
        fetchImpl: async () => okText([{ text: '[silence]' }]),
      }),
    ).toBe('');
    let calls = 0;
    const flaky = vi.fn(async () => (calls++ === 0 ? new Response('{}', { status: 503 }) : okText([{ text: 'ok' }])));
    expect(await transcribe(new Int16Array(4), { apiKey: 'k', model: 'm', vocabulary: [], fetchImpl: flaky })).toBe(
      'ok',
    );
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 400 }));
    await expect(
      transcribe(new Int16Array(4), { apiKey: 'k', model: 'm', vocabulary: [], fetchImpl: refused }),
    ).rejects.toThrow('400 bad key');
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe('Gemini speech', () => {
  const audioResponse = (data: Buffer, mimeType: string) =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType, data: data.toString('base64') } }] } }],
      }),
      { status: 200 },
    );

  it('asks for audio in the configured voice and decodes raw 24 kHz PCM', async () => {
    const pcm = Buffer.alloc(6);
    pcm.writeInt16LE(5, 0);
    pcm.writeInt16LE(-5, 2);
    const fetchImpl = vi.fn(async () => audioResponse(pcm, 'audio/L16;codec=pcm;rate=24000'));
    const out = await synthesize('Привіт.', {
      apiKey: 'gk',
      model: 'gemini-3.1-flash-tts-preview',
      voice: 'Alnilam',
      fetchImpl,
    });
    expect(Array.from(out.pcm)).toEqual([5, -5, 0]);
    expect(out.sampleRate).toBe(24_000);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-3.1-flash-tts-preview:generateContent');
    expect(JSON.parse(String(init.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Привіт.' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Alnilam' } } },
      },
    });
  });

  it('retries an answer without audio and reads WAV from newer models', async () => {
    let calls = 0;
    const wav = pcmToWav(new Int16Array([7, 8]), 22_050);
    const fetchImpl = vi.fn(async () =>
      calls++ === 0
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }), { status: 200 })
        : audioResponse(wav, 'audio/wav'),
    );
    const out = await synthesize('Hi.', { apiKey: 'gk', model: 'gemini-3.8-flash-tts', voice: 'Kore', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(Array.from(out.pcm)).toEqual([7, 8]);
    expect(out.sampleRate).toBe(22_050);
    expect(decodeSpeechAudio(wav, '').sampleRate).toBe(22_050);
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

  it('cuts long text at sentence ends into TTS-sized chunks', () => {
    const text = 'One two three. Four five six! Seven eight nine? Ten.';
    expect(splitForSpeech(text, 30)).toEqual(['One two three. Four five six!', 'Seven eight nine? Ten.']);
    const runOn = `${'word '.repeat(30).trim()}, ${'more '.repeat(30).trim()}.`;
    const chunks = splitForSpeech(runOn, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(runOn);
    expect(splitForSpeech('')).toEqual([]);
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

  it('rejects job metadata that is not a walkie-talkie call', () => {
    expect(() => parseJobMetadata('{}')).toThrow();
    expect(() => parseJobMetadata('not json')).toThrow();
    expect(() => parseJobMetadata(JSON.stringify({ ...META, v: 1 }))).toThrow();
    expect(parseJobMetadata(JSON.stringify(META)).callId).toBe('call-1');
  });
});

const META: LiveKitJobMetadata = {
  v: 2,
  callId: 'call-1',
  lineId: 'voice:abc',
  agentName: 'Andy',
  callerName: 'Ethan',
  callerIdentity: 'caller-1',
  vocabulary: ['NanoClaw'],
  sttModel: 'gemini-3.8-flash',
  ttsModel: 'gemini-3.1-flash-tts-preview',
  ttsVoice: 'Alnilam',
  silenceMs: 2500,
  maxDurationMs: 60_000,
  joinTimeoutMs: 1000,
};

function fakeJob(meta: Record<string, unknown> = { ...META }) {
  const shutdownCallbacks: Array<() => Promise<void>> = [];
  const job = {
    job: { metadata: JSON.stringify(meta) },
    room: {},
    connect: vi.fn(async () => undefined),
    waitForParticipant: vi.fn(async () => ({ identity: 'caller-1' })),
    deleteRoom: vi.fn(async () => undefined),
    shutdown: vi.fn(),
    addShutdownCallback: vi.fn((cb: () => Promise<void>) => shutdownCallbacks.push(cb)),
  };
  return { job, ctx: job as unknown as CallJob, shutdownCallbacks };
}

/** The host over fetch (routes by path, an NDJSON event stream fed by `emit`) and Gemini behind it. */
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
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (url.includes(':generateContent')) {
      const config = body?.generationConfig as { responseModalities?: string[] } | undefined;
      const part = config?.responseModalities
        ? { inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(960).toString('base64') } }
        : { text: 'Book a table' };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [part] } }] }), { status: 200 });
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, auth, body });
    if (url.includes('/events')) return new Response(stream, { status: 200 });
    if (url.endsWith('/joined')) return new Response('{}', { status: joinedStatus });
    if (url.endsWith('/utterance')) return new Response(JSON.stringify({ id: '1' }), { status: 202 });
    return new Response(null, { status: 204 });
  });
  return { fetchImpl, calls, emit: (e: unknown) => push(JSON.stringify(e)), endStream };
}

function fakeMedia() {
  let handlers!: Parameters<CallMedia['start']>[0];
  const media = {
    start: vi.fn((h: Parameters<CallMedia['start']>[0]) => {
      handlers = h;
    }),
    play: vi.fn(async () => undefined),
    caption: vi.fn(),
    setState: vi.fn(),
    close: vi.fn(async () => undefined),
    get handlers() {
      return handlers;
    },
  };
  return media;
}

const ENV = {
  GEMINI_API_KEY: 'gk-test',
  LIVEKIT_API_SECRET: 'lk-secret',
  LIVEKIT_HOST_URL: 'http://127.0.0.1:3555',
};
const silentLog = { info: () => undefined, warn: () => undefined };

describe('runCall', () => {
  it('runs a call: caller joins, host says yes, turns go out, replies are spoken, host end closes all', async () => {
    const { job, ctx } = fakeJob({ ...META, hostUrl: 'http://169.254.169.254', secret: 'from-dispatch' });
    const host = fakeHostFetch();
    const media = fakeMedia();
    const createMedia = vi.fn(async () => media);
    await runCall(ctx, { env: ENV, fetchImpl: host.fetchImpl, createMedia, log: silentLog });

    expect(job.waitForParticipant).toHaveBeenCalledWith('caller-1');
    expect(createMedia).toHaveBeenCalledWith(ctx, expect.objectContaining({ callId: 'call-1' }), {
      identity: 'caller-1',
    });
    expect(media.setState).toHaveBeenCalledWith('listening');
    // The host address and secret come from the worker's settings, never from the dispatch.
    const secret = liveKitCallSecret('lk-secret', 'call-1');
    for (const call of host.calls) {
      expect(call.url.startsWith('http://127.0.0.1:3555/webhook/voice/livekit/agent/')).toBe(true);
      expect(call.auth).toBe(`Bearer ${secret}`);
    }

    for (let i = 0; i < 20; i++) media.handlers.onWindow(window(1000), true);
    for (let i = 0; i < 79; i++) media.handlers.onWindow(window(1), false);
    await vi.waitFor(() =>
      expect(host.calls.find((c) => c.url.endsWith('/utterance'))?.body).toEqual({
        callId: 'call-1',
        text: 'Book a table',
      }),
    );
    expect(media.caption).toHaveBeenCalledWith('caller', 'Book a table');

    host.emit({ type: 'reply', text: 'Booked for eight.' });
    await vi.waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));
    expect(media.caption).toHaveBeenCalledWith('agent', 'Booked for eight.');
    expect(media.setState).toHaveBeenCalledWith('speaking');

    host.emit({ type: 'end', reason: 'hangup' });
    await vi.waitFor(() => expect(job.shutdown).toHaveBeenCalledWith('host: hangup'));
    expect(media.close).toHaveBeenCalled();
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
    await runCall(ctx, { env: ENV, fetchImpl, createMedia: vi.fn(), log: { info: () => undefined, warn } });
    expect(warn).toHaveBeenCalledWith('voice worker: ending the call', {
      callId: 'call-1',
      hostUrl: 'http://127.0.0.1:3555',
      reason: 'host refused the call (unreachable)',
    });
    expect(job.shutdown).toHaveBeenCalledWith('host refused the call (unreachable)');
  });

  it('publishes nothing when the host refuses the call', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch(409);
    const createMedia = vi.fn(async () => fakeMedia());
    await runCall(ctx, { env: ENV, fetchImpl: host.fetchImpl, createMedia, log: silentLog });
    expect(createMedia).not.toHaveBeenCalled();
    expect(host.calls.at(-1)).toMatchObject({ body: { callId: 'call-1', reason: 'host refused the call (409)' } });
    expect(job.deleteRoom).toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('host refused the call (409)');
  });

  it('ends the call when the caller never joins', async () => {
    const { job, ctx } = fakeJob({ ...META, joinTimeoutMs: 20 });
    job.waitForParticipant.mockImplementation(() => new Promise(() => undefined));
    const host = fakeHostFetch();
    const createMedia = vi.fn(async () => fakeMedia());
    await runCall(ctx, { env: ENV, fetchImpl: host.fetchImpl, createMedia, log: silentLog });
    expect(createMedia).not.toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('caller never joined');
  });

  it('refuses to start without the LiveKit secret it derives the host credential from', async () => {
    const { job, ctx } = fakeJob();
    const host = fakeHostFetch();
    await runCall(ctx, {
      env: { ...ENV, LIVEKIT_API_SECRET: undefined },
      fetchImpl: host.fetchImpl,
      createMedia: vi.fn(),
      log: silentLog,
    });
    expect(job.connect).not.toHaveBeenCalled();
    expect(job.shutdown).toHaveBeenCalledWith('LIVEKIT_API_SECRET is not set for the worker');
  });

  it('reports the end to the host when the host link drops or the caller leaves', async () => {
    const first = fakeJob();
    const host = fakeHostFetch();
    await runCall(first.ctx, {
      env: ENV,
      fetchImpl: host.fetchImpl,
      createMedia: async () => fakeMedia(),
      log: silentLog,
    });
    host.endStream();
    await vi.waitFor(() => expect(first.job.shutdown).toHaveBeenCalledWith('host link closed'));
    expect(host.calls.at(-1)).toMatchObject({ body: { reason: 'host link closed' } });

    const second = fakeJob();
    const media = fakeMedia();
    await runCall(second.ctx, {
      env: ENV,
      fetchImpl: fakeHostFetch().fetchImpl,
      createMedia: async () => media,
      log: silentLog,
    });
    media.handlers.onCallerLeft();
    await vi.waitFor(() => expect(second.job.shutdown).toHaveBeenCalledWith('caller left'));
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
