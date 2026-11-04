import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from '../log.js';
import {
  buildBridgePageUrl,
  createRecallMeetBridge,
  mintBridgeToken,
  recallMeetConfigFromEnv,
  type RecallMeetConfig,
} from './meet-recall.js';

const LK_KEY = 'devkey';
const LK_SECRET = 'secret-secret-secret-secret-secret-1234';

type FetchMock = ReturnType<typeof vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

function config(fetchImpl: FetchMock, overrides: Partial<RecallMeetConfig> = {}): RecallMeetConfig {
  return {
    recallApiKey: 'recall-key',
    region: 'eu-central-1',
    pageUrl: 'https://pages.example.com/meet-recall-bridge/index.html',
    livekitUrl: 'wss://lk.example.com',
    livekitApiKey: LK_KEY,
    livekitApiSecret: LK_SECRET,
    fetch: fetchImpl as unknown as typeof fetch,
    retryDelayMs: () => 0,
    ...overrides,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

/** Answers each request in turn; the last answer repeats. */
function respond(...answers: Array<Response | Error>): FetchMock {
  let i = 0;
  return vi.fn(async () => {
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
}

const join = { meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Andy', roomName: 'meet-r1' };

describe('createRecallMeetBridge', () => {
  it('posts the bot with the bridge page as its camera and the room in its metadata', async () => {
    const fetchMock = respond(json(201, { id: 'bot-123' }));
    const bridge = createRecallMeetBridge(config(fetchMock));

    await expect(bridge.join(join)).resolves.toEqual({ botId: 'bot-123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://eu-central-1.recall.ai/api/v1/bot/');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Token recall-key', 'Content-Type': 'application/json' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      meeting_url: join.meetingUrl,
      bot_name: 'Andy',
      metadata: { nanoclaw_room: 'meet-r1' },
      variant: { google_meet: 'web_4_core', zoom: 'web_4_core', microsoft_teams: 'web_4_core' },
      recording_config: { video_mixed_mp4: null },
      // The lobby wait plus the longest meeting call: a bot the host never sent away leaves after that.
      automatic_leave: { in_call_not_recording_timeout: 70 * 60 },
    });
    // Recall's own default (2 s) ends the bot, and with it the call, when everyone left.
    expect(body.automatic_leave.everyone_left_timeout).toBeUndefined();
    expect(body.output_media.camera.kind).toBe('webpage');

    const page = new URL(body.output_media.camera.config.url);
    expect(page.origin + page.pathname).toBe('https://pages.example.com/meet-recall-bridge/index.html');
    expect(page.search).toBe('');
    const params = new URLSearchParams(page.hash.slice(1));
    expect(params.get('url')).toBe('wss://lk.example.com');
    expect(params.get('name')).toBe('Andy');
    expect(params.has('source')).toBe(false);
    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(params.get('token')!);
    expect(claims.sub).toBe('meet-bridge-meet-r1');
    expect(claims.video?.room).toBe('meet-r1');
  });

  it('uses the configured region', async () => {
    const fetchMock = respond(json(201, { id: 'b' }));
    await createRecallMeetBridge(config(fetchMock, { region: 'us-west-2' })).join(join);
    expect(fetchMock.mock.calls[0][0]).toBe('https://us-west-2.recall.ai/api/v1/bot/');
  });

  it('creates a bot without a transcription with exactly the body it always sent', async () => {
    const fetchMock = respond(json(201, { id: 'b' }));
    await createRecallMeetBridge(config(fetchMock)).join(join);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      meeting_url: join.meetingUrl,
      bot_name: 'Andy',
      metadata: { nanoclaw_room: 'meet-r1' },
      output_media: { camera: { kind: 'webpage', config: { url: expect.any(String) } } },
      variant: { google_meet: 'web_4_core', zoom: 'web_4_core', microsoft_teams: 'web_4_core' },
      recording_config: { video_mixed_mp4: null },
      automatic_leave: { in_call_not_recording_timeout: 70 * 60 },
    });
  });

  it('adds per-participant low-latency transcription and one websocket for a jev meeting', async () => {
    const fetchMock = respond(json(201, { id: 'b' }));
    const websocketUrl = 'wss://meet.example.com/voice/recall/call-1/?token=t0k3n';
    await createRecallMeetBridge(config(fetchMock)).join({ ...join, transcription: { websocketUrl } });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.recording_config).toEqual({
      video_mixed_mp4: null,
      transcript: {
        provider: { recallai_streaming: { mode: 'prioritize_low_latency', language_code: 'en' } },
        diarization: { use_separate_streams_when_available: true },
      },
      realtime_endpoints: [
        {
          type: 'websocket',
          url: websocketUrl,
          events: [
            'transcript.partial_data',
            'transcript.data',
            'participant_events.speech_on',
            'participant_events.speech_off',
            'participant_events.join',
            'participant_events.leave',
            'participant_events.chat_message',
          ],
        },
      ],
    });
    expect(body.automatic_leave).toEqual({ in_call_not_recording_timeout: 70 * 60 });
  });

  it('refuses a transcription websocket URL Recall would not take, before any request', async () => {
    const fetchMock = respond(json(201, { id: 'b' }));
    const bridge = createRecallMeetBridge(config(fetchMock));
    const withUrl = (websocketUrl: string) => bridge.join({ ...join, transcription: { websocketUrl } });
    await expect(withUrl('ws://meet.example.com/voice/recall/c/?token=t')).rejects.toThrow(/must use wss:/);
    await expect(withUrl('wss://meet.example.com/voice/recall/c?token=t')).rejects.toThrow(/a \/ before its query/);
    await expect(withUrl('not a url')).rejects.toThrow(/is not a URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves through leave_call with the bot id escaped', async () => {
    const fetchMock = respond(json(200, { id: 'x' }));
    await createRecallMeetBridge(config(fetchMock)).leave('a/b c');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://eu-central-1.recall.ai/api/v1/bot/a%2Fb%20c/leave_call/');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('retries a failed leave and logs the final failure without rejecting', async () => {
    const fetchMock = respond(new Error('socket hang up'), json(502, 'bad gateway'), json(200, {}));
    await createRecallMeetBridge(config(fetchMock)).leave('bot-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.mocked(log.error).mockClear();
    const failing = respond(new Error('socket hang up'));
    await expect(createRecallMeetBridge(config(failing)).leave('bot-2')).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith('meet-recall: the bot did not leave its meeting', expect.anything());
  });

  it.each([400, 404, 410])('takes a %i leave as a bot already gone: no retry, no error', async (status) => {
    vi.mocked(log.error).mockClear();
    const gone = respond(json(status, { detail: 'Bot is not in a call.' }));
    await createRecallMeetBridge(config(gone)).leave('gone');
    expect(gone).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([401, 403])('logs a %i leave as an error and does not retry it', async (status) => {
    vi.mocked(log.error).mockClear();
    const denied = respond(json(status, { detail: 'Invalid token.' }));
    await createRecallMeetBridge(config(denied)).leave('bot-1');
    expect(denied).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith('meet-recall: the bot did not leave its meeting', expect.anything());
  });

  it("retries a 408 or 429 leave after Recall's Retry-After, bounded", async () => {
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);
    try {
      const busy = respond(json(429, 'slow down', { 'Retry-After': '2' }), json(408, 'timeout'), json(200, {}));
      await createRecallMeetBridge(config(busy, { retryDelayMs: () => 7 })).leave('bot-1');
      expect(busy).toHaveBeenCalledTimes(3);
      expect(waits).toEqual([2000, 7]);

      waits.length = 0;
      const long = respond(json(429, 'slow down', { 'Retry-After': '3600' }), json(200, {}));
      await createRecallMeetBridge(config(long)).leave('bot-2');
      expect(waits).toEqual([30_000]);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses on a 4xx with the status and a redacted body, and looks for no bot', async () => {
    const fetchMock = respond(
      json(400, { output_media: ['bad url https://p.example/#url=x&token=eyJhbGciOi.secret.sig'] }),
    );
    const err = await createRecallMeetBridge(config(fetchMock))
      .join(join)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('failed with 400');
    expect((err as Error).message).toContain('token=REDACTED');
    expect((err as Error).message).not.toContain('eyJhbGciOi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network error', new Error('ECONNRESET')],
    ['a timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['a server error', json(503, 'unavailable')],
    ['a malformed body', json(201, '<html>')],
    ['a body without an id', json(201, {})],
  ])('after %s on create, finds the room bots by metadata and sends them away', async (_, created) => {
    const fetchMock = respond(
      created as Response | Error,
      json(200, { next: null, results: [{ id: 'bot-a' }, { id: 'bot-b' }] }),
      json(200, {}),
    );
    await expect(createRecallMeetBridge(config(fetchMock)).join(join)).rejects.toThrow();
    const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`);
    expect(calls).toEqual([
      'POST https://eu-central-1.recall.ai/api/v1/bot/',
      'GET https://eu-central-1.recall.ai/api/v1/bot/?metadata__nanoclaw_room=meet-r1',
      'POST https://eu-central-1.recall.ai/api/v1/bot/bot-a/leave_call/',
      'POST https://eu-central-1.recall.ai/api/v1/bot/bot-b/leave_call/',
    ]);
  });

  it('looks for the room bots once more a little later, for a bot Recall was still making', async () => {
    const fetchMock = respond(
      new Error('ECONNRESET'),
      json(200, { next: null, results: [] }),
      json(200, { next: null, results: [{ id: 'bot-late' }] }),
      json(200, {}),
    );
    await expect(createRecallMeetBridge(config(fetchMock, { resweepDelayMs: 20 })).join(join)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`).slice(2)).toEqual([
      'GET https://eu-central-1.recall.ai/api/v1/bot/?metadata__nanoclaw_room=meet-r1',
      'POST https://eu-central-1.recall.ai/api/v1/bot/bot-late/leave_call/',
    ]);
  });

  it('logs a bot list it cannot read instead of taking it as empty', async () => {
    vi.mocked(log.error).mockClear();
    const fetchMock = respond(new Error('ECONNRESET'), json(200, '<html>'));
    await expect(createRecallMeetBridge(config(fetchMock)).join(join)).rejects.toThrow('ECONNRESET');
    expect(log.error).toHaveBeenCalledWith(
      'meet-recall: Recall listed the bots in a form it does not know',
      expect.objectContaining({ roomName: 'meet-r1' }),
    );
  });

  it('still reports the failed create when the bot lookup fails', async () => {
    vi.mocked(log.error).mockClear();
    const fetchMock = respond(new Error('ECONNRESET'), new Error('still down'));
    await expect(createRecallMeetBridge(config(fetchMock)).join(join)).rejects.toThrow('ECONNRESET');
    expect(log.error).toHaveBeenCalledWith(
      'meet-recall: could not look for a bot whose create did not answer',
      expect.objectContaining({ roomName: 'meet-r1' }),
    );
  });

  it('rejects bad config up front', () => {
    const f = respond(json(201, {}));
    expect(() => createRecallMeetBridge(config(f, { region: 'evil.com/x' as never }))).toThrow(/region/);
    expect(() => createRecallMeetBridge(config(f, { livekitUrl: 'https://lk.example.com' }))).toThrow(/wss/);
    expect(() => createRecallMeetBridge(config(f, { livekitUrl: 'ws://lk.example.com' }))).toThrow(/wss/);
    expect(() => createRecallMeetBridge(config(f, { pageUrl: 'http://pages.example.com/' }))).toThrow(/https/);
    expect(() => createRecallMeetBridge(config(f, { pageUrl: 'not a url' }))).toThrow(/not a URL/);
  });
});

describe('mintBridgeToken', () => {
  it('scopes the token to the room, as the meeting, with no attributes', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await mintBridgeToken({ livekitApiKey: LK_KEY, livekitApiSecret: LK_SECRET }, 'meet-r1');
    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(token);
    expect(claims.sub).toBe('meet-bridge-meet-r1');
    expect(claims.name).toBe('Meeting');
    expect(claims.attributes).toBeUndefined();
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: 'meet-r1',
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(claims.video?.canPublishSources?.map(String)).toEqual(['microphone']);
    expect(claims.video?.roomAdmin).toBeFalsy();
    const ttl = (claims.exp ?? 0) - before;
    expect(ttl).toBeGreaterThan(3 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(3 * 3600 + 5);
  });
});

describe('buildBridgePageUrl', () => {
  it('puts every parameter in the hash, escaped, and keeps the query', () => {
    const out = buildBridgePageUrl('https://pages.example.com/bridge/?v=2', {
      livekitUrl: 'wss://lk.example.com/path?x=1&y=2',
      token: 'a.b+c/d=',
      name: 'Andy & co #1',
    });
    const parsed = new URL(out);
    expect(parsed.search).toBe('?v=2');
    const params = new URLSearchParams(parsed.hash.slice(1));
    expect(params.get('url')).toBe('wss://lk.example.com/path?x=1&y=2');
    expect(params.get('token')).toBe('a.b+c/d=');
    expect(params.get('name')).toBe('Andy & co #1');
  });
});

describe('recallMeetConfigFromEnv', () => {
  const livekit = { apiKey: 'a', apiSecret: 's' };
  const full = { RECALL_API_KEY: 'k', MEET_RECALL_PAGE_URL: 'https://p.example/', MEET_RECALL_LIVEKIT_URL: 'wss://lk' };

  it('is off without a Recall key', () => {
    expect(recallMeetConfigFromEnv({}, livekit)).toBeNull();
  });

  it('takes the LiveKit key pair it is given and defaults the region to eu-central-1', () => {
    expect(recallMeetConfigFromEnv(full, livekit)).toMatchObject({
      region: 'eu-central-1',
      pageUrl: 'https://p.example/',
      livekitApiKey: 'a',
      livekitApiSecret: 's',
    });
    expect(recallMeetConfigFromEnv({ ...full, RECALL_REGION: 'us-east-1' }, livekit)?.region).toBe('us-east-1');
  });

  it('names every missing key', () => {
    expect(() => recallMeetConfigFromEnv({ RECALL_API_KEY: 'k' }, livekit)).toThrow(
      'meet-recall: missing MEET_RECALL_PAGE_URL, MEET_RECALL_LIVEKIT_URL',
    );
  });
});
