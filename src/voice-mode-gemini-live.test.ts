/**
 * The Gemini Live transcriber against a fake WebSocket: the setup and activity protocol, the
 * finalization rules, one socket per activity, and hand-overs when a socket closes or goes away.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVITY_MAX_MS,
  CONNECT_TIMEOUT_MS,
  FINAL_GRACE_MS,
  FINAL_TIMEOUT_MS,
  GeminiLiveTranscriber,
  type Heard,
  type LiveSocket,
  stripVocabularyEcho,
} from './voice-mode-gemini-live.js';
import { CALL_COMMAND_WORDS } from './channels/voice-mode-protocol.js';

afterEach(() => {
  vi.useRealTimers();
});

interface Sent {
  setup?: unknown;
  realtimeInput?: { activityStart?: object; activityEnd?: object; audio?: { data: string; mimeType: string } };
}

class FakeSocket implements LiveSocket {
  sent: Sent[] = [];
  closed?: number;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }
  close(code = 1000): void {
    if (this.closed !== undefined) return;
    this.closed = code;
    this.onclose?.({ code, reason: '' });
  }
  /** The server: open, then setup complete. */
  ready(): void {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
  }
  say(content: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ serverContent: content }) });
  }
  interim(text: string): void {
    this.say({ interimInputTranscription: { text } });
  }
  final(text: string): void {
    this.say({ inputTranscription: { text } });
  }
  drop(code: number, reason: string): void {
    this.closed = code;
    this.onclose?.({ code, reason });
  }
  /** What went out after the setup, as kinds: start, audio:<samples>, end. */
  get kinds(): string[] {
    return this.sent.slice(1).map((m) => {
      const input = m.realtimeInput ?? {};
      if (input.activityStart) return 'start';
      if (input.activityEnd) return 'end';
      if (input.audio) return `audio:${Buffer.from(input.audio.data, 'base64').length / 2}`;
      return JSON.stringify(m);
    });
  }
}

function harness(vocabulary = ['Andy', 'send it', 'прийом'], debug = false) {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const interims: string[] = [];
  const warn = vi.fn();
  const info = vi.fn();
  const t = new GeminiLiveTranscriber({
    apiKey: 'secret-key',
    model: 'gemini-3.5-transcribe-live',
    vocabulary,
    languageCodes: ['uk-UA', 'en-US'],
    sampleRate: 16_000,
    onInterim: (text) => void interims.push(text),
    log: { info, warn },
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...(debug ? { debug } : {}),
  });
  const result = (p: Promise<Heard>) => {
    let out: Heard | undefined;
    void p.then((h) => (out = h));
    return () => out;
  };
  return { t, sockets, interims, warn, info, result, tick: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
}

const pcm = (ms: number) => new Int16Array(16 * ms).fill(7);

describe('GeminiLiveTranscriber', () => {
  it('closing settles every ended activity at once: its final if one came, its interim text if not, one still connecting too', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('Book a table. Zulu.');
    const first = h.result(h.t.end());
    await h.tick(0);
    h.sockets[0].final('Book a table, please. Zulu.');
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[1].ready();
    await h.tick(0);
    h.sockets[1].interim('And a taxi. Zulu.');
    const second = h.result(h.t.end());
    // A third whose socket is still being set up.
    h.t.begin(pcm(100));
    const third = h.result(h.t.end());
    await h.tick(0);
    expect([first(), second(), third()]).toEqual([undefined, undefined, undefined]);
    h.t.close();
    await h.tick(0);
    expect(first()).toMatchObject({ final: 'Book a table, please. Zulu.', finals: 1 });
    expect(second()).toMatchObject({ interim: 'And a taxi. Zulu.', finals: 0 });
    expect(second()?.final).toBeUndefined();
    expect(third()).toMatchObject({ interim: '', finals: 0 });
  });

  it('logs the raw messages and what was forwarded only with debug on', async () => {
    const debugLines = (info: ReturnType<typeof vi.fn>) =>
      info.mock.calls.filter(([msg]) => String(msg).startsWith('voice-mode.transcript-debug'));
    for (const debug of [false, true]) {
      const h = harness(undefined, debug);
      h.t.begin(pcm(100));
      await h.tick(0);
      h.sockets[0].ready();
      await h.tick(0);
      h.sockets[0].interim(' Copy.');
      expect(h.interims).toEqual(['Copy.']);
      const lines = debugLines(h.info);
      if (!debug) {
        expect(lines).toEqual([]);
        continue;
      }
      expect(lines).toContainEqual([
        'voice-mode.transcript-debug raw',
        expect.objectContaining({ act: 1, sid: 1, role: 'current', interim: ' Copy.' }),
      ]);
      expect(lines).toContainEqual([
        'voice-mode.transcript-debug forward',
        expect.objectContaining({ kind: 'interim', text: 'Copy.', same: false }),
      ]);
      expect(lines.map(([msg]) => msg)).toContain('voice-mode.transcript-debug activityStart');
    }
  });

  it('sets up a manual-activity transcription, sends nothing before setupComplete, then the activity in 100 ms chunks', async () => {
    const h = harness();
    h.t.push(pcm(100));
    expect(h.sockets).toHaveLength(0);
    h.t.begin(pcm(500));
    await h.tick(0);
    expect(h.sockets).toHaveLength(1);
    const s = h.sockets[0];
    expect(s.url).toContain('BidiGenerateContent?key=secret-key');
    h.t.push(pcm(60));
    s.onopen?.();
    expect(s.sent).toEqual([
      {
        setup: {
          model: 'models/gemini-3.5-transcribe-live',
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: {
            languageCodes: ['uk-UA', 'en-US'],
            customVocabulary: ['Andy', 'send it', 'прийом'],
            mode: 'VERBATIM',
          },
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
      },
    ]);
    s.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
    await h.tick(0);
    // activityStart, then the queued pre-roll and audio (560 ms: five 100 ms chunks, 60 ms left in the next).
    expect(s.kinds).toEqual(['start', 'audio:1600', 'audio:1600', 'audio:1600', 'audio:1600', 'audio:1600']);
    expect(s.sent[1].realtimeInput?.audio).toBeUndefined();
    expect(s.sent[2].realtimeInput?.audio?.mimeType).toBe('audio/pcm;rate=16000');
    h.t.push(pcm(40));
    expect(s.kinds.at(-1)).toBe('audio:1600');
    const done = h.result(h.t.end());
    expect(s.kinds.at(-1)).toBe('end');
    expect(s.kinds).not.toContain('{"realtimeInput":{"audioStreamEnd":true}}');
    s.interim('ignored after the end');
    s.final('Book a table.');
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toMatchObject({ final: 'Book a table.', finals: 1, failed: false, finalizeMs: FINAL_GRACE_MS });
    // The socket is retired with its activity.
    expect(s.closed).toBe(1000);
  });

  it('reports the growing interim text; later finals within the grace join; a turnComplete after a final ends at once', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('Book');
    h.sockets[0].interim('Book a table for two');
    expect(h.interims).toEqual(['Book', 'Book a table for two']);
    const done = h.result(h.t.end());
    h.sockets[0].final('Book a table');
    await h.tick(FINAL_GRACE_MS - 50);
    h.sockets[0].final('for two.');
    await h.tick(FINAL_GRACE_MS - 50);
    expect(done()).toBeUndefined();
    await h.tick(50);
    expect(done()).toMatchObject({ final: 'Book a table for two.', interim: 'Book a table for two', finals: 2 });

    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[1].ready();
    await h.tick(0);
    const second = h.result(h.t.end());
    h.sockets[1].say({ inputTranscription: { text: 'Yes.' }, turnComplete: true });
    await h.tick(0);
    expect(second()).toMatchObject({ final: 'Yes.', finals: 1 });
  });

  it('never passes on its own vocabulary echoed back as the caller words, in an interim or a final', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('Book a table');
    // Echo-only: the last interim stands, so the caption does not flash the list.
    h.sockets[0].interim("'Andy', 'send it', 'прийом'");
    h.sockets[0].interim("Book a table for two. 'Andy', 'send it', 'при");
    expect(h.interims).toEqual(['Book a table', 'Book a table for two.']);
    expect(h.info.mock.calls.map((c) => c[1])).toEqual([
      { kind: 'interim', words: 4, kept: 0 },
      { kind: 'interim', words: 9, kept: 5 },
    ]);
    const done = h.result(h.t.end());
    h.sockets[0].final("'Andy', 'send it'");
    await h.tick(FINAL_GRACE_MS);
    // A final that was only the echo heard no words: the interim text is the turn's.
    expect(done()).toMatchObject({ final: '', interim: 'Book a table for two.', finals: 1 });
  });

  it('passes a trailing command said as its own sentence on to the interim text', async () => {
    const commands = [...CALL_COMMAND_WORDS.send, ...CALL_COMMAND_WORDS.discard].map((w) => w.say);
    const h = harness(['Dan', 'Stan', ...commands]);
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    const words = 'Rewrite the landing page copy for the pricing section.';
    const said = [words, `${words} Copy.`, `${words} Copy that.`, `${words}, copy`, 'What is three plus four? Zulu.'];
    for (const text of said) h.sockets[0].interim(text);
    expect(h.interims).toEqual(said);
    expect(h.info).not.toHaveBeenCalled();
  });

  it('tells a vocabulary echo from words that quote or list some of it', () => {
    const vocabulary = [
      'Ava',
      'Max',
      'Nova',
      'Concierge',
      'send it',
      'прийом',
      'scratch that',
      'discard turn',
      'discard this turn',
    ];
    const echo =
      "'Ava', 'Max', 'Nova', 'Concierge', 'send it', 'прийом', 'scratch that', 'discard turn', 'discard this";
    expect(stripVocabularyEcho(echo, vocabulary)).toBe('');
    expect(stripVocabularyEcho(`Remind me to stretch later. Hey Ava. ${echo}`, vocabulary)).toBe(
      'Remind me to stretch later. Hey Ava.',
    );
    expect(stripVocabularyEcho('“Ava”, “Max”, “Nova”, “discard this turn”.', vocabulary)).toBe('');
    expect(stripVocabularyEcho('Ava, Max, Nova, send it', vocabulary)).toBe('');
    // A caller's own words stay, quotes, apostrophes and names included.
    for (const said of [
      "Tell Ava I'll send it, don't wait.",
      "Name the files 'draft' and 'final', then send it.",
      "Say 'Ava' to wake him.",
      'Ava, Max and Nova are coming. Send it.',
      'Ava, Max, call me.',
    ]) {
      expect(stripVocabularyEcho(said, vocabulary)).toBe(said);
    }
  });

  it('with no final, the interim text stands after the cap', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('Book a table');
    const done = h.result(h.t.end());
    await h.tick(FINAL_TIMEOUT_MS - 1);
    expect(done()).toBeUndefined();
    await h.tick(1);
    expect(done()).toEqual({ interim: 'Book a table', finals: 0, failed: false, finalizeMs: FINAL_TIMEOUT_MS });
  });

  it('gives every activity its own socket: a late final of one never reaches the next', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    const first = h.result(h.t.end());
    h.t.begin(pcm(100));
    await h.tick(0);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].ready();
    await h.tick(0);
    h.sockets[0].final('First turn.');
    h.sockets[1].interim('Second');
    await h.tick(FINAL_GRACE_MS);
    expect(first()).toMatchObject({ final: 'First turn.' });
    const second = h.result(h.t.end());
    h.sockets[1].final('Second turn.');
    await h.tick(FINAL_GRACE_MS);
    expect(second()).toMatchObject({ final: 'Second turn.', interim: 'Second' });
  });

  it('a prepared socket takes the next activity; a socket that never sets up is tried three times, then the turn fails', async () => {
    const h = harness();
    const ready = h.t.prepare();
    await h.tick(0);
    h.sockets[0].ready();
    expect(await ready).toBe(true);
    h.t.begin(new Int16Array(0));
    await h.tick(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].kinds).toEqual(['start']);
    const done = h.result(h.t.end());
    h.sockets[0].final('Hi.');
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toMatchObject({ final: 'Hi.' });

    h.t.begin(pcm(100));
    const failed = h.result(h.t.end());
    await h.tick(CONNECT_TIMEOUT_MS * 3 + 2_000);
    expect(h.sockets).toHaveLength(4);
    expect(failed()).toMatchObject({ interim: '', failed: true });
    expect(h.warn).toHaveBeenCalledWith(
      'voice-mode worker: the transcription is unavailable; the turn has no text from here',
    );
  });

  it('a socket that closes mid-turn keeps its words and the turn goes on in a fresh one; the key never reaches a log', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('Book a table');
    h.sockets[0].drop(1011, 'internal error at ...?key=secret-key&alt=json');
    h.t.push(pcm(200));
    await h.tick(0);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].ready();
    await h.tick(0);
    expect(h.sockets[1].kinds).toEqual(['start', 'audio:1600', 'audio:1600']);
    h.sockets[1].interim('for two');
    expect(h.interims.at(-1)).toBe('Book a table for two');
    const done = h.result(h.t.end());
    h.sockets[1].final('for two.');
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toMatchObject({ final: 'Book a table for two.', interim: 'Book a table for two' });
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('secret-key');
  });

  it('a socket told to go away hands the turn to a fresh one; the old part keeps its place', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('Book a table');
    h.sockets[0].onmessage?.({ data: JSON.stringify({ goAway: { timeLeft: '1s' } }) });
    h.t.push(pcm(100));
    expect(h.sockets[0].kinds.at(-1)).toBe('end');
    await h.tick(0);
    h.sockets[1].ready();
    await h.tick(0);
    expect(h.sockets[1].kinds[0]).toBe('start');
    h.sockets[1].interim('for two');
    h.sockets[0].final('Book a table');
    await h.tick(FINAL_GRACE_MS);
    expect(h.sockets[0].closed).toBe(1000);
    const done = h.result(h.t.end());
    h.sockets[1].final('for two.');
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toMatchObject({ final: 'Book a table for two.' });
  });

  it('an activity nearing the server cap goes on in a fresh one: the old part keeps its place, the final joins both', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('The first part of a long turn');
    await h.tick(ACTIVITY_MAX_MS - 1_000);
    h.t.push(pcm(100));
    expect(h.sockets).toHaveLength(1);
    await h.tick(1_000);
    h.t.push(pcm(100));
    // The old activity ended where its audio did; the new one takes the audio from here on.
    expect(h.sockets[0].kinds.slice(-2)).toEqual(['audio:1600', 'end']);
    expect(h.info).toHaveBeenCalledWith('voice-mode worker: the transcription moves to a fresh socket mid-turn', {
      why: 'cap',
      ageMs: ACTIVITY_MAX_MS,
    });
    await h.tick(0);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].ready();
    await h.tick(0);
    expect(h.sockets[1].kinds).toEqual(['start', 'audio:1600']);
    h.sockets[1].interim('and the rest of it. Zulu.');
    expect(h.interims.at(-1)).toBe('The first part of a long turn and the rest of it. Zulu.');
    h.sockets[0].final('The first part of a long turn.');
    await h.tick(FINAL_GRACE_MS);
    expect(h.sockets[0].closed).toBe(1000);
    const done = h.result(h.t.end());
    h.sockets[1].final('And the rest of it. Zulu.');
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toMatchObject({
      final: 'The first part of a long turn. And the rest of it. Zulu.',
      finals: 1,
      rotations: 1,
    });
    // The fresh activity has its own clock: no second hand-over before another ACTIVITY_MAX_MS.
    expect(h.sockets).toHaveLength(2);
  });

  it('a server that finishes the activity before its activityEnd hands it over at once; words after it still arrive', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(ACTIVITY_MAX_MS / 2);
    h.sockets[0].interim('Book a table for two');
    h.sockets[0].final('Book a table for two.');
    h.sockets[0].say({ generationComplete: true });
    expect(h.sockets[0].kinds.at(-1)).toBe('end');
    expect(h.info).toHaveBeenCalledWith(
      'voice-mode worker: the transcription moves to a fresh socket mid-turn',
      expect.objectContaining({ why: 'server-done' }),
    );
    h.t.push(pcm(100));
    await h.tick(0);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].ready();
    await h.tick(0);
    expect(h.sockets[1].kinds).toEqual(['start', 'audio:1600']);
    h.sockets[1].interim('Zulu.');
    expect(h.interims.at(-1)).toBe('Book a table for two. Zulu.');
    await h.tick(FINAL_GRACE_MS);
    const done = h.result(h.t.end());
    h.sockets[1].final('Zulu.');
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toMatchObject({ final: 'Book a table for two. Zulu.', rotations: 1 });
  });

  it('a server that finishes the activity long before its cap could be the reason: logged once, no hand-over', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(ACTIVITY_MAX_MS / 2 - 1_000);
    h.sockets[0].interim('Book a table');
    h.sockets[0].say({ turnComplete: true });
    h.sockets[0].say({ generationComplete: true });
    expect(h.sockets[0].kinds.at(-1)).not.toBe('end');
    expect(h.warn).toHaveBeenCalledExactlyOnceWith(
      'voice-mode worker: the transcription finished an activity early; it goes on',
      { ageMs: ACTIVITY_MAX_MS / 2 - 1_000 },
    );
    h.t.push(pcm(100));
    await h.tick(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.info).not.toHaveBeenCalledWith(
      'voice-mode worker: the transcription moves to a fresh socket mid-turn',
      expect.anything(),
    );
    h.sockets[0].interim('Book a table for two');
    const done = h.result(h.t.end());
    h.sockets[0].final('Book a table for two.');
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toMatchObject({ final: 'Book a table for two.' });
    expect(done()?.rotations).toBeUndefined();
  });

  it('generationComplete after the activityEnd settles the activity as before: no hand-over', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('Book a table');
    const done = h.result(h.t.end());
    await h.tick(0);
    h.sockets[0].final('Book a table.');
    h.sockets[0].say({ generationComplete: true });
    await h.tick(0);
    expect(done()).toEqual({
      final: 'Book a table.',
      interim: 'Book a table',
      finals: 1,
      failed: false,
      finalizeMs: 0,
    });
    expect(h.sockets).toHaveLength(1);
    expect(h.info).not.toHaveBeenCalledWith(
      'voice-mode worker: the transcription moves to a fresh socket mid-turn',
      expect.anything(),
    );
  });

  it('a full send buffer holds the audio without blocking, sends it when it drains, and the end waits for all of it', async () => {
    const h = harness();
    h.t.begin(new Int16Array(0));
    await h.tick(0);
    const s = h.sockets[0];
    s.ready();
    await h.tick(0);
    h.t.push(pcm(100));
    expect(s.kinds).toEqual(['start', 'audio:1600']);
    s.bufferedAmount = 300_000;
    // Frames while the buffer is full return at once and wait in the queue.
    for (let i = 0; i < 10; i++) h.t.push(pcm(10));
    h.t.push(pcm(50));
    const done = h.result(h.t.end());
    await h.tick(200);
    expect(s.kinds).toEqual(['start', 'audio:1600']);
    s.bufferedAmount = 0;
    await h.tick(60);
    // All 150 ms, the partial chunk included, then the end.
    expect(s.kinds).toEqual(['start', 'audio:1600', 'audio:1600', 'audio:800', 'end']);
    s.final('Book a table.');
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toMatchObject({ final: 'Book a table.', failed: false });
  });

  it('a socket whose send buffer stays full is replaced, and the held audio goes to the fresh one', async () => {
    const h = harness();
    h.t.begin(new Int16Array(0));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].bufferedAmount = 300_000;
    h.t.push(pcm(100));
    await h.tick(5_100);
    h.t.push(pcm(100));
    await h.tick(0);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[0].kinds.at(-1)).toBe('end');
    h.sockets[1].ready();
    await h.tick(0);
    expect(h.sockets[1].kinds).toEqual(['start', 'audio:1600', 'audio:1600']);
  });

  it('a final inside the activity keeps the last interim for the turn text, and needs only the grace after the end', async () => {
    const h = harness();
    h.t.begin(pcm(100));
    await h.tick(0);
    h.sockets[0].ready();
    await h.tick(0);
    h.sockets[0].interim('Please book a table for six. Send it.');
    h.sockets[0].final('Send it.');
    expect(h.interims.at(-1)).toBe('Send it.');
    const done = h.result(h.t.end());
    await h.tick(FINAL_GRACE_MS);
    expect(done()).toEqual({
      final: 'Send it.',
      interim: 'Please book a table for six. Send it.',
      finals: 1,
      failed: false,
      finalizeMs: FINAL_GRACE_MS,
    });
  });

  it('a failed prepare is not kept: the next one tries again', async () => {
    const h = harness();
    const first = h.t.prepare();
    await h.tick(CONNECT_TIMEOUT_MS * 3 + 2_000);
    expect(await first).toBe(false);
    expect(h.sockets).toHaveLength(3);
    const second = h.t.prepare();
    await h.tick(0);
    expect(h.sockets).toHaveLength(4);
    h.sockets[3].ready();
    expect(await second).toBe(true);
  });
});
