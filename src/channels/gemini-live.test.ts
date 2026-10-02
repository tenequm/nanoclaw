/**
 * The Gemini Live path of the voice channel at the host boundary: the real
 * adapter behind the real webhook server, hit over HTTP the way the call page
 * does. Faked: Google's token endpoint (a local HTTP server) and the clock.
 * OpenAI is never reached; its routes are only used to show the limits are shared.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundMessage } from './adapter.js';
import { geminiConsultMessageId, parseGeminiConsultMessageId } from './gemini-live.js';
import { createGptLiveAdapter, DELEGATION_TIMEOUT_LINE, lineIdForToken, type GptLiveConfig } from './voice.js';
import { stopWebhookServer } from '../webhook-server.js';

const LINE = lineIdForToken('tok123');
const MIN = 60_000;

interface TokenRequest {
  path: string | undefined;
  apiKey: string | undefined;
  body: Record<string, unknown>;
}

interface FakeGoogle {
  apiBase: string;
  requests: TokenRequest[];
  failNext: number;
  close(): Promise<void>;
}

function startFakeGoogle(): Promise<FakeGoogle> {
  const fake: FakeGoogle = { apiBase: '', requests: [], failNext: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1alpha/auth_tokens') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (fake.failNext) {
        res.writeHead(fake.failNext, { 'Content-Type': 'application/json' });
        fake.failNext = 0;
        res.end(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }));
        return;
      }
      fake.requests.push({
        path: req.url,
        apiKey: req.headers['x-goog-api-key'] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: `auth_tokens/fake${fake.requests.length}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      fake.close = () => new Promise((r) => server.close(() => r()));
      resolve(fake);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface Harness {
  adapter: ChannelAdapter;
  base: string;
  inbound: InboundMessage[];
  clock: { now: number };
  access: { enabled: boolean };
  stop(): Promise<void>;
}

async function startHarness(overrides: Partial<GptLiveConfig>): Promise<Harness> {
  const port = await freePort();
  process.env.WEBHOOK_PORT = String(port);
  const inbound: InboundMessage[] = [];
  // Fixed early in a UTC day so the daily budget never crosses midnight.
  const clock = { now: Date.UTC(2026, 9, 2, 1, 0, 0) };
  const access = { enabled: true };
  const adapter = createGptLiveAdapter({
    apiKey: 'sk-test-key',
    publicUrl: `http://127.0.0.1:${port}`,
    voice: 'marin',
    linkTokens: ['tok123'],
    // Never reached: these tests only hit OpenAI routes that refuse before any upstream call.
    apiBase: 'http://127.0.0.1:9/v1',
    wsBase: 'ws://127.0.0.1:9/v1',
    resolveLine: async (id) =>
      access.enabled
        ? {
            caller: { id, name: 'Ethan' },
            agentGroupId: 'ag-andy',
            agent: { name: 'Andy', personality: 'Dry humour, precise. Greets in Ukrainian.' },
          }
        : null,
    now: () => clock.now,
    requestTimeoutMs: 1000,
    ...overrides,
  });
  await adapter.setup({
    onInbound: (_platformId, _threadId, message) => {
      inbound.push(message);
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  });
  return {
    adapter,
    base: `http://127.0.0.1:${port}/webhook/voice`,
    inbound,
    clock,
    access,
    stop: async () => {
      await adapter.teardown();
      await stopWebhookServer();
    },
  };
}

const post = (url: string, body?: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

interface SetupBody {
  model: string;
  generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } };
  systemInstruction: { parts: Array<{ text: string }> };
  tools: unknown;
  inputAudioTranscription: unknown;
  outputAudioTranscription: unknown;
}

interface TokenResponse {
  token: string;
  callId: string;
  model: string;
  websocketUrl: string;
  setup: Record<string, unknown>;
  scheduling: string | null;
  expiresAt: number;
}

describe('gemini voice path without GEMINI_API_KEY', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({});
  });
  afterAll(async () => {
    await h.stop();
  });

  it('answers 503 on every gemini route and leaves the OpenAI page alone', async () => {
    expect((await fetch(`${h.base}/gemini?t=tok123`)).status).toBe(503);
    expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(503);
    expect((await post(`${h.base}/gemini/consult?t=tok123`, {})).status).toBe(503);
    expect((await post(`${h.base}/gemini/end?t=tok123`, {})).status).toBe(503);
    expect((await fetch(`${h.base}/call?t=tok123`)).status).toBe(200);
  });
});

describe('gemini voice path (fake Google, real webhook server)', () => {
  let h: Harness;
  let google: FakeGoogle;
  let call: TokenResponse;

  beforeAll(async () => {
    google = await startFakeGoogle();
    h = await startHarness({
      gemini: { apiKey: 'gk-test-key', apiBase: google.apiBase },
      delegationTimeoutMs: 300,
    });
  });
  afterAll(async () => {
    await h.stop();
    await google.close();
  });

  it('serves a self-contained call page that may reach only Gemini', async () => {
    const res = await fetch(`${h.base}/gemini?t=tok123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'self' wss://generativelanguage.googleapis.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('worker-src blob:');
    const html = await res.text();
    expect(html).toContain('realtimeInput');
    expect(html).toContain('toolResponse');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('refuses unknown links and revoked callers before minting anything', async () => {
    expect((await post(`${h.base}/gemini/token?t=nope`)).status).toBe(403);
    h.access.enabled = false;
    try {
      expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(403);
    } finally {
      h.access.enabled = true;
    }
    expect(google.requests).toHaveLength(0);
  });

  it('reports a refused Gemini key without echoing it', async () => {
    google.failNext = 400;
    const res = await post(`${h.base}/gemini/token?t=tok123`);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/check the host's Gemini key/);
  });

  it('mints a one-use token locked to the model, prompt, voice and ask_agent', async () => {
    const res = await post(`${h.base}/gemini/token?t=tok123`);
    expect(res.status).toBe(200);
    call = (await res.json()) as TokenResponse;
    expect(call).toMatchObject({
      token: 'auth_tokens/fake1',
      model: 'gemini-3.8-live',
      websocketUrl:
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
      setup: { model: 'models/gemini-3.8-live', generationConfig: { responseModalities: ['AUDIO'] } },
      scheduling: 'WHEN_IDLE',
      expiresAt: h.clock.now + 15 * MIN,
    });
    expect(call.callId).toMatch(/^[0-9a-f-]{36}$/);

    expect(google.requests).toHaveLength(1);
    const { apiKey, body } = google.requests[0];
    expect(apiKey).toBe('gk-test-key');
    expect(body.uses).toBe(1);
    expect(body.expireTime).toBe(new Date(h.clock.now + 15 * MIN).toISOString());
    expect(body.newSessionExpireTime).toBe(new Date(h.clock.now + MIN).toISOString());
    expect(body.fieldMask).toBeUndefined();
    const setup = body.bidiGenerateContentSetup as SetupBody;
    expect(setup.model).toBe('models/gemini-3.8-live');
    expect(setup.generationConfig).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    });
    // gemini-3.8-live closes the session on any thinking config.
    expect(JSON.stringify(body)).not.toMatch(/thinking/i);
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    const instruction = setup.systemInstruction.parts[0].text;
    expect(instruction).toContain('You are Andy');
    expect(instruction).toContain('Greets in Ukrainian');
    expect(instruction).toContain(JSON.stringify({ id: LINE, name: 'Ethan' }));
    expect(instruction).toContain('speak the language the caller speaks');
    expect(instruction).toContain('call ask_agent');
    expect(setup.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({
            name: 'ask_agent',
            behavior: 'NON_BLOCKING',
            parameters: expect.objectContaining({ required: ['request'] }),
          }),
        ],
      },
    ]);
  });

  it('feeds ask_agent to the agent and answers the long-poll with its reply', async () => {
    const pending = post(`${h.base}/gemini/consult?t=tok123`, {
      callId: call.callId,
      functionCallId: 'fc-1',
      request: 'What is on my calendar tomorrow?',
    });
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
    const message = h.inbound[0];
    expect(message.id).toBe(geminiConsultMessageId(call.callId, 'fc-1'));
    expect(parseGeminiConsultMessageId(message.id)).toEqual({ callId: call.callId, functionCallId: 'fc-1' });
    expect(message.content).toMatchObject({
      text: 'What is on my calendar tomorrow?',
      sender: 'Ethan',
      senderId: LINE,
    });
    expect(JSON.stringify(message)).not.toContain('tok123');

    const id = await h.adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Two meetings: standup at nine.' },
      inReplyTo: message.id,
    });
    expect(id).toBe(message.id);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 'Two meetings: standup at nine.' });
  });

  it('answers with the timeout line when the agent is too slow, and drops the late reply', async () => {
    const res = await post(`${h.base}/gemini/consult?t=tok123`, {
      callId: call.callId,
      functionCallId: 'fc-2',
      request: 'Book a table.',
    });
    expect(await res.json()).toEqual({ answer: DELEGATION_TIMEOUT_LINE });
    const late = await h.adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Table booked.' },
      inReplyTo: geminiConsultMessageId(call.callId, 'fc-2'),
    });
    expect(late).toBeUndefined();
  });

  it('rejects malformed consults and consults for another call', async () => {
    expect((await post(`${h.base}/gemini/consult?t=tok123`, { callId: call.callId })).status).toBe(400);
    const res = await post(`${h.base}/gemini/consult?t=tok123`, {
      callId: 'not-this-call',
      functionCallId: 'fc-x',
      request: 'hi',
    });
    expect(res.status).toBe(409);
  });

  it('drops proactive agent messages during a Gemini call', async () => {
    await expect(h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'FYI' } })).resolves.toBeUndefined();
  });

  it('ends the call on /end: a waiting consult is released and its reply dropped', async () => {
    const pending = post(`${h.base}/gemini/consult?t=tok123`, {
      callId: call.callId,
      functionCallId: 'fc-3',
      request: 'Remind me to call Dana.',
    });
    await vi.waitFor(() => expect(h.inbound.some((m) => m.id.endsWith(':fc-3'))).toBe(true));
    // A stale callId does not end the live call.
    expect((await post(`${h.base}/gemini/end?t=tok123`, { callId: 'stale' })).status).toBe(204);
    expect((await post(`${h.base}/gemini/end?t=tok123`, { callId: call.callId })).status).toBe(204);
    expect((await pending).status).toBe(409);
    const dropped = await h.adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Reminder set.' },
      inReplyTo: geminiConsultMessageId(call.callId, 'fc-3'),
    });
    expect(dropped).toBeUndefined();
    await expect(h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'FYI' } })).rejects.toThrow(
      /no active call/,
    );
  });
});

describe('gemini and OpenAI calls share the per-line limits', () => {
  let h: Harness;
  let google: FakeGoogle;

  beforeAll(async () => {
    google = await startFakeGoogle();
    h = await startHarness({
      gemini: { apiKey: 'gk-test-key', apiBase: google.apiBase, model: 'gemini-3.8-live', voice: 'Puck' },
      maxCallsPerHour: 2,
      maxCallMsPerDay: 20 * MIN,
    });
  });
  afterAll(async () => {
    await h.stop();
    await google.close();
  });

  const token = async (): Promise<TokenResponse> => {
    const res = await post(`${h.base}/gemini/token?t=tok123`);
    expect(res.status).toBe(200);
    return (await res.json()) as TokenResponse;
  };

  it('charges a Gemini call on /end and caps the next token by the minutes left', async () => {
    const first = await token();
    h.clock.now += 12 * MIN;
    expect((await post(`${h.base}/gemini/end?t=tok123`, { callId: first.callId })).status).toBe(204);
    const second = await token();
    expect(second.expiresAt).toBe(h.clock.now + 8 * MIN);
    const setup = google.requests[1].body.bidiGenerateContentSetup as SetupBody;
    const voice = setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
    expect(voice).toBe('Puck');
    expect(google.requests[1].body.expireTime).toBe(new Date(h.clock.now + 8 * MIN).toISOString());
  });

  it('counts Gemini starts against the OpenAI hourly cap', async () => {
    const res = await fetch(`${h.base}/sdp?t=tok123`, { method: 'POST', body: 'v=0\r\noffer' });
    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/hourly call limit/);
    expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(429);
  });

  it('counts a running Gemini call against the OpenAI daily minutes', async () => {
    h.clock.now += 61 * MIN;
    const res = await fetch(`${h.base}/sdp?t=tok123`, { method: 'POST', body: 'v=0\r\noffer' });
    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/call minutes for today/);
    expect(google.requests).toHaveLength(2);
  });
});
