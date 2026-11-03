import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  MEETING_INPUT_ATTRIBUTE,
  buildBridgePageUrl,
  createRecallMeetBridge,
  mintBridgeToken,
  recallMeetConfigFromEnv,
  type RecallMeetConfig,
} from './meet-recall.js';

const LK_KEY = 'devkey';
const LK_SECRET = 'secret-secret-secret-secret-secret-1234';

function config(fetchImpl: typeof fetch, overrides: Partial<RecallMeetConfig> = {}): RecallMeetConfig {
  return {
    recallApiKey: 'recall-key',
    region: 'eu-central-1',
    pageUrl: 'https://pages.example.com/meet-recall-bridge/index.html',
    livekitUrl: 'wss://lk.example.com',
    livekitApiKey: LK_KEY,
    livekitApiSecret: LK_SECRET,
    fetch: fetchImpl,
    ...overrides,
  };
}

function respond(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(body === undefined ? '' : JSON.stringify(body), { status }),
  );
}

const join = {
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  botName: 'Dan',
  roomName: 'meet-r1',
  sourceIdentity: 'agent-AJ_x',
};

describe('createRecallMeetBridge', () => {
  it('posts the bot with the bridge page as its camera', async () => {
    const fetchMock = respond(201, { id: 'bot-123' });
    const bridge = createRecallMeetBridge(config(fetchMock as unknown as typeof fetch));

    await expect(bridge.join(join)).resolves.toEqual({ botId: 'bot-123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://eu-central-1.recall.ai/api/v1/bot/');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Token recall-key', 'Content-Type': 'application/json' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      meeting_url: join.meetingUrl,
      bot_name: 'Dan',
      variant: { google_meet: 'web_4_core', zoom: 'web_4_core', microsoft_teams: 'web_4_core' },
      recording_config: { video_mixed_mp4: null },
    });
    expect(body.recording_config.transcript).toBeUndefined();
    expect(body.output_media.camera.kind).toBe('webpage');

    const page = new URL(body.output_media.camera.config.url);
    expect(page.origin + page.pathname).toBe('https://pages.example.com/meet-recall-bridge/index.html');
    expect(page.searchParams.get('url')).toBe('wss://lk.example.com');
    expect(page.searchParams.get('source')).toBe('agent-AJ_x');
    expect(page.searchParams.get('name')).toBe('Dan');
    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(page.searchParams.get('token')!);
    expect(claims.sub).toBe('meet-bridge-meet-r1');
    expect(claims.video?.room).toBe('meet-r1');
  });

  it('uses the configured region', async () => {
    const fetchMock = respond(201, { id: 'b' });
    await createRecallMeetBridge(config(fetchMock as unknown as typeof fetch, { region: 'us-west-2' })).join(join);
    expect(fetchMock.mock.calls[0][0]).toBe('https://us-west-2.recall.ai/api/v1/bot/');
  });

  it('leaves through leave_call with the bot id escaped', async () => {
    const fetchMock = respond(200, { id: 'x' });
    await createRecallMeetBridge(config(fetchMock as unknown as typeof fetch)).leave('a/b c');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://eu-central-1.recall.ai/api/v1/bot/a%2Fb%20c/leave_call/');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('surfaces non-2xx responses with the status and a redacted body', async () => {
    const fetchMock = respond(400, { output_media: ['bad url https://p.example/?url=x&token=eyJhbGciOi.secret.sig'] });
    const bridge = createRecallMeetBridge(config(fetchMock as unknown as typeof fetch));
    const err = await bridge.join(join).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('failed with 400');
    expect((err as Error).message).toContain('token=REDACTED');
    expect((err as Error).message).not.toContain('eyJhbGciOi');

    const leaveFetch = respond(404, { detail: 'Not found.' });
    await expect(createRecallMeetBridge(config(leaveFetch as unknown as typeof fetch)).leave('gone')).rejects.toThrow(
      /leave_call\/ failed with 404/,
    );
  });

  it('rejects a 2xx without a bot id', async () => {
    const fetchMock = respond(201, {});
    await expect(createRecallMeetBridge(config(fetchMock as unknown as typeof fetch)).join(join)).rejects.toThrow(
      /no bot id/,
    );
  });

  it('rejects bad config up front', () => {
    const f = respond(201, {}) as unknown as typeof fetch;
    expect(() => createRecallMeetBridge(config(f, { region: 'evil.com/x' as never }))).toThrow(/region/);
    expect(() => createRecallMeetBridge(config(f, { livekitUrl: 'https://lk.example.com' }))).toThrow(/wss/);
    expect(() => createRecallMeetBridge(config(f, { pageUrl: 'not a url' }))).toThrow(/not a URL/);
  });
});

describe('mintBridgeToken', () => {
  it('scopes the token to the room with the meeting-input attribute', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await mintBridgeToken({ livekitApiKey: LK_KEY, livekitApiSecret: LK_SECRET }, 'meet-r1');
    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(token);
    expect(claims.sub).toBe('meet-bridge-meet-r1');
    expect(claims.attributes).toEqual({ [MEETING_INPUT_ATTRIBUTE]: '1' });
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
  it('escapes every parameter and keeps existing ones', () => {
    const out = buildBridgePageUrl('https://pages.example.com/bridge/?v=2', {
      livekitUrl: 'wss://lk.example.com/path?x=1&y=2',
      token: 'a.b+c/d=',
      source: 'agent & co#1',
      name: 'Dan <3',
    });
    expect(out.startsWith('https://pages.example.com/bridge/?v=2&url=')).toBe(true);
    expect(out).not.toContain('#1');
    const parsed = new URL(out);
    expect(parsed.searchParams.get('v')).toBe('2');
    expect(parsed.searchParams.get('url')).toBe('wss://lk.example.com/path?x=1&y=2');
    expect(parsed.searchParams.get('token')).toBe('a.b+c/d=');
    expect(parsed.searchParams.get('source')).toBe('agent & co#1');
    expect(parsed.searchParams.get('name')).toBe('Dan <3');
  });
});

describe('recallMeetConfigFromEnv', () => {
  const full = {
    RECALL_API_KEY: 'k',
    MEET_RECALL_PAGE_URL: 'https://p.example/',
    MEET_RECALL_LIVEKIT_URL: 'wss://lk.example',
    LIVEKIT_API_KEY: 'a',
    LIVEKIT_API_SECRET: 's',
  };

  it('defaults the region to eu-central-1', () => {
    expect(recallMeetConfigFromEnv(full)).toMatchObject({ region: 'eu-central-1', pageUrl: 'https://p.example/' });
    expect(recallMeetConfigFromEnv({ ...full, RECALL_REGION: 'us-east-1' }).region).toBe('us-east-1');
  });

  it('names every missing key', () => {
    expect(() => recallMeetConfigFromEnv({ RECALL_API_KEY: 'k' })).toThrow(
      'meet-recall: missing MEET_RECALL_PAGE_URL, MEET_RECALL_LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET',
    );
  });
});
