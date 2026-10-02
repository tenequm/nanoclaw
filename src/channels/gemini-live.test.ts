/**
 * The Gemini Live path of the voice channel at the host boundary: the real
 * adapter behind the real webhook server, hit over HTTP the way the call page
 * does. Faked: Google's token endpoint (a local HTTP server) and the clock.
 * OpenAI is never reached; its routes are only used to show the limits are shared.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundMessage } from './adapter.js';
import {
  geminiInstructions,
  LANGUAGE_RULE,
  MAX_VOCABULARY_BYTES,
  MAX_VOCABULARY_TERMS,
  sessionConfig,
  VOICE_VOCABULARY_FILE,
  voiceVocabulary,
} from './gpt-live-prompt.js';
import {
  createGptLiveAdapter,
  DELEGATION_TIMEOUT_LINE,
  geminiConsultMessageId,
  isLoopbackAddress,
  lineIdForToken,
  MAX_CONSULTS_PER_MINUTE,
  MAX_OPEN_CONSULTS,
  parseGeminiConsultMessageId,
  type GptLiveConfig,
} from './voice.js';
import { readGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
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
  /** Requests that have arrived, answered or not. */
  received: number;
  /** When set, a request arriving now waits for it before it is answered. */
  hold: Promise<void> | null;
  close(): Promise<void>;
}

function startFakeGoogle(): Promise<FakeGoogle> {
  const fake: FakeGoogle = {
    apiBase: '',
    requests: [],
    failNext: 0,
    received: 0,
    hold: null,
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    fake.received++;
    const held = fake.hold;
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => void Promise.resolve(held).then(() => answer()));
    const answer = () => {
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
    };
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
  port: number;
  base: string;
  inbound: InboundMessage[];
  clock: { now: number };
  /** `delayMs` holds every access check that long, to widen race windows. */
  access: { enabled: boolean; delayMs: number };
  stop(): Promise<void>;
}

async function startHarness(overrides: Partial<GptLiveConfig>): Promise<Harness> {
  const port = await freePort();
  process.env.WEBHOOK_PORT = String(port);
  const inbound: InboundMessage[] = [];
  // Fixed early in a UTC day so the daily budget never crosses midnight.
  const clock = { now: Date.UTC(2026, 9, 2, 1, 0, 0) };
  const access = { enabled: true, delayMs: 0 };
  const adapter = createGptLiveAdapter({
    apiKey: 'sk-test-key',
    publicUrl: `http://127.0.0.1:${port}`,
    voice: 'marin',
    linkTokens: ['tok123'],
    // Never reached: these tests only hit OpenAI routes that refuse before any upstream call.
    apiBase: 'http://127.0.0.1:9/v1',
    wsBase: 'ws://127.0.0.1:9/v1',
    resolveLine: async (id) => {
      if (access.delayMs) await new Promise((r) => setTimeout(r, access.delayMs));
      return access.enabled
        ? {
            caller: { id, name: 'Ethan' },
            agentGroupId: 'ag-andy',
            agent: { name: 'Andy', personality: 'Dry humour, precise. Greets in Ukrainian.' },
          }
        : null;
    },
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
    port,
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
  websocketUrl: string;
  setup: Record<string, unknown>;
  scheduling: string | null;
  durationMs: number;
}

const consultUrl = (h: Harness): string => `${h.base}/gemini/consult?t=tok123`;
const messagesUrl = (h: Harness, callId: string): string =>
  `${h.base}/gemini/messages?t=tok123&callId=${encodeURIComponent(callId)}`;

async function mint(h: Harness): Promise<TokenResponse> {
  const res = await post(`${h.base}/gemini/token?t=tok123`);
  expect(res.status).toBe(200);
  return (await res.json()) as TokenResponse;
}

/** Open ask_agent long-polls and wait until the agent has every one of them. */
async function openConsults(h: Harness, callId: string, ids: string[]): Promise<Array<Promise<Response>>> {
  const pending = ids.map((functionCallId) =>
    post(consultUrl(h), { callId, functionCallId, request: `Question ${functionCallId}` }),
  );
  await vi.waitFor(() => {
    for (const id of ids) expect(h.inbound.some((m) => m.id === geminiConsultMessageId(callId, id))).toBe(true);
  });
  return pending;
}

/** The batch's first inbound, which the agent replies to: concurrent consults reach it in any order. */
const firstForwarded = (h: Harness, callId: string, ids: string[]): string =>
  h.inbound.find((m) => ids.some((id) => m.id === geminiConsultMessageId(callId, id)))!.id;

const reply = (h: Harness, text: string, inReplyTo?: string): Promise<string | undefined> =>
  h.adapter.deliver(LINE, null, { kind: 'chat', content: { text }, inReplyTo });

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
    expect((await fetch(`${h.base}/gemini/messages?t=tok123&callId=x`)).status).toBe(503);
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
    expect(html).toContain("ws.binaryType = 'arraybuffer'");
    expect(html).toContain('const ASK_AGENT = "ask_agent"');
    expect(html).toContain('/gemini/messages');
    expect(html).toContain('s.durationMs');
    expect(html).not.toContain('expiresAt');
    expect(html).toContain('while (this.pos >= this.ratio)');
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
      websocketUrl:
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
      setup: { model: 'models/gemini-3.8-live', generationConfig: { responseModalities: ['AUDIO'] } },
      scheduling: 'WHEN_IDLE',
      // Google drops audio connections at about 10 minutes: below the 15-minute general cap.
      durationMs: 10 * MIN,
    });
    expect(call).not.toHaveProperty('model');
    expect(call).not.toHaveProperty('expiresAt');
    expect(call.callId).toMatch(/^[0-9a-f-]{36}$/);

    expect(google.requests).toHaveLength(1);
    const { apiKey, body } = google.requests[0];
    expect(apiKey).toBe('gk-test-key');
    expect(body.uses).toBe(1);
    expect(body.expireTime).toBe(new Date(h.clock.now + 10 * MIN).toISOString());
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
    expect(instruction).toContain(LANGUAGE_RULE);
    expect(instruction).toContain('call ask_agent');
    expect(instruction).toContain('"Agent update:"');
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

  it('answers with the holding line when the agent is too slow, and queues the late reply for the page', async () => {
    const res = await post(`${h.base}/gemini/consult?t=tok123`, {
      callId: call.callId,
      functionCallId: 'fc-2',
      request: 'Book a table.',
    });
    expect(await res.json()).toEqual({ answer: DELEGATION_TIMEOUT_LINE });
    expect(DELEGATION_TIMEOUT_LINE).not.toMatch(/couldn't|failed/i);
    const late = await reply(h, 'Table booked.', geminiConsultMessageId(call.callId, 'fc-2'));
    expect(late).toMatch(/^gemini-update:/);
    const poll = await fetch(messagesUrl(h, call.callId));
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({ messages: ['Table booked.'] });
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

  it('hands a proactive agent message to the waiting message poll', async () => {
    const poll = fetch(messagesUrl(h, call.callId));
    await new Promise((r) => setTimeout(r, 50));
    await expect(reply(h, 'FYI: Dana called.')).resolves.toMatch(/^gemini-update:/);
    const res = await poll;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: ['FYI: Dana called.'] });
    expect((await fetch(messagesUrl(h, 'not-this-call'))).status).toBe(409);
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
    const warn = vi.spyOn(log, 'warn');
    try {
      const dropped = await reply(h, 'Reminder set.', geminiConsultMessageId(call.callId, 'fc-3'));
      expect(dropped).toBeUndefined();
      expect(warn).toHaveBeenCalledWith('gemini-live: dropping a reply for an ended call', expect.anything());
    } finally {
      warn.mockRestore();
    }
    expect((await fetch(messagesUrl(h, call.callId))).status).toBe(409);
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

  it('uses the configured voice and charges each token its whole lifetime', async () => {
    const first = await mint(h);
    expect(first.durationMs).toBe(10 * MIN);
    h.clock.now += 2 * MIN;
    expect((await post(`${h.base}/gemini/end?t=tok123`, { callId: first.callId })).status).toBe(204);
    // 10 of 20 minutes are gone although the call ran 2: the hangup gives nothing back.
    const second = await mint(h);
    expect(second.durationMs).toBe(10 * MIN);
    const setup = google.requests[1].body.bidiGenerateContentSetup as SetupBody;
    const voice = setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
    expect(voice).toBe('Puck');
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

describe('gemini agent replies, consult bounds and races', () => {
  let h: Harness;
  let google: FakeGoogle;
  let call: TokenResponse;

  beforeAll(async () => {
    google = await startFakeGoogle();
    h = await startHarness({ gemini: { apiKey: 'gk-test-key', apiBase: google.apiBase }, delegationTimeoutMs: 5000 });
    call = await mint(h);
  });
  afterAll(async () => {
    await h.stop();
    await google.close();
  });

  it('answers the consult with an interim reply and queues the real answer for the page', async () => {
    const [pending] = await openConsults(h, call.callId, ['fc-1']);
    const id = geminiConsultMessageId(call.callId, 'fc-1');
    expect(await reply(h, 'One moment, checking the calendar.', id)).toBe(id);
    expect(await (await pending).json()).toEqual({ answer: 'One moment, checking the calendar.' });
    expect(await reply(h, 'Standup at nine, lunch with Dana at one.', id)).toMatch(/^gemini-update:/);
    const res = await fetch(messagesUrl(h, call.callId));
    expect(await res.json()).toEqual({ messages: ['Standup at nine, lunch with Dana at one.'] });
  });

  it('answers every consult of a batched agent turn with its one reply', async () => {
    const [first, second] = await openConsults(h, call.callId, ['fc-2', 'fc-3']);
    // The agent read both in one turn and replied to the first.
    await reply(h, 'Booked the table and reminded Dana.', firstForwarded(h, call.callId, ['fc-2', 'fc-3']));
    expect(await (await first).json()).toEqual({ answer: 'Booked the table and reminded Dana.' });
    expect(await (await second).json()).toEqual({ answer: 'Booked the table and reminded Dana.' });
  });

  it('answers only the consults the agent got from the replied one on, not an earlier turn', async () => {
    const [early] = await openConsults(h, call.callId, ['fc-e']);
    const [later] = await openConsults(h, call.callId, ['fc-l']);
    await reply(h, 'The later one.', geminiConsultMessageId(call.callId, 'fc-l'));
    expect(await (await later).json()).toEqual({ answer: 'The later one.' });
    // The earlier consult still waits for its own reply.
    await reply(h, 'The earlier one.', geminiConsultMessageId(call.callId, 'fc-e'));
    expect(await (await early).json()).toEqual({ answer: 'The earlier one.' });
  });

  it('caps open consults per call and the size of a request', async () => {
    const ids = Array.from({ length: MAX_OPEN_CONSULTS }, (_, i) => `open-${i}`);
    const open = await openConsults(h, call.callId, ids);
    const over = await post(consultUrl(h), { callId: call.callId, functionCallId: 'open-x', request: 'One more' });
    expect(over.status).toBe(429);
    await reply(h, 'All done.', firstForwarded(h, call.callId, ids));
    for (const res of open) expect((await res).status).toBe(200);

    const big = await post(consultUrl(h), { callId: call.callId, functionCallId: 'big', request: 'a'.repeat(4097) });
    expect(big.status).toBe(413);
    expect(await big.text()).toMatch(/ask_agent request is too large \(4 KB max\)/);
    const huge = await post(consultUrl(h), { callId: call.callId, functionCallId: 'huge', pad: 'a'.repeat(70_000) });
    expect(huge.status).toBe(413);
    expect(await huge.text()).toBe('Request body too large');
    const sdp = await fetch(`${h.base}/sdp?t=tok123`, { method: 'POST', body: 'v=0\r\n' + 'a'.repeat(70_000) });
    expect(sdp.status).toBe(413);
    expect(await sdp.text()).toBe('SDP offer too large');
  });

  it('caps consults per call per minute', async () => {
    h.clock.now += MIN + 1;
    let n = 0;
    while (n < MAX_CONSULTS_PER_MINUTE) {
      const ids = Array.from({ length: Math.min(MAX_OPEN_CONSULTS, MAX_CONSULTS_PER_MINUTE - n) }, () => `rate-${n++}`);
      const pending = await openConsults(h, call.callId, ids);
      await reply(h, 'Done.', firstForwarded(h, call.callId, ids));
      for (const res of pending) expect((await res).status).toBe(200);
    }
    const limited = await post(consultUrl(h), { callId: call.callId, functionCallId: 'rate-x', request: 'Again' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    h.clock.now += MIN + 1;
    const [ok] = await openConsults(h, call.callId, ['rate-y']);
    await reply(h, 'Done.', geminiConsultMessageId(call.callId, 'rate-y'));
    expect((await ok).status).toBe(200);
  });

  it('rejects a duplicate function call id at once and forwards nothing for a consult cancelled mid-check', async () => {
    h.access.delayMs = 150;
    try {
      const ctl = new AbortController();
      const cancelled = fetch(consultUrl(h), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: call.callId, functionCallId: 'fc-c', request: 'Cancel me' }),
        signal: ctl.signal,
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 50));
      const duplicate = await post(consultUrl(h), { callId: call.callId, functionCallId: 'fc-c', request: 'Again' });
      expect(duplicate.status).toBe(409);
      ctl.abort();
      await cancelled;
      await new Promise((r) => setTimeout(r, 250));
      expect(h.inbound.some((m) => m.id === geminiConsultMessageId(call.callId, 'fc-c'))).toBe(false);
    } finally {
      h.access.delayMs = 0;
    }
    // The slot was released: the same id works again.
    const [again] = await openConsults(h, call.callId, ['fc-c']);
    await reply(h, 'Done.', geminiConsultMessageId(call.callId, 'fc-c'));
    expect((await again).status).toBe(200);
  });
});

describe('gemini access rechecks', () => {
  let h: Harness;
  let google: FakeGoogle;

  beforeAll(async () => {
    google = await startFakeGoogle();
    h = await startHarness({
      gemini: { apiKey: 'gk-test-key', apiBase: google.apiBase },
      delegationTimeoutMs: 5000,
      accessCheckIntervalMs: 50,
    });
  });
  afterAll(async () => {
    await h.stop();
    await google.close();
  });
  afterEach(() => {
    h.access.enabled = true;
  });

  it('rechecks access before settling a reply and ends the call on loss', async () => {
    const call = await mint(h);
    const [pending] = await openConsults(h, call.callId, ['fc-1']);
    h.access.enabled = false;
    await expect(reply(h, 'Secret answer.', geminiConsultMessageId(call.callId, 'fc-1'))).rejects.toThrow(/revoked/);
    expect((await pending).status).toBe(409);
    h.access.enabled = true;
    const after = await post(consultUrl(h), { callId: call.callId, functionCallId: 'fc-2', request: 'Hi' });
    expect(after.status).toBe(409);
    expect((await fetch(messagesUrl(h, call.callId))).status).toBe(409);
  });

  it('ends the call on the periodic check, which a waiting message poll sees', async () => {
    const call = await mint(h);
    const poll = fetch(messagesUrl(h, call.callId));
    await new Promise((r) => setTimeout(r, 30));
    h.access.enabled = false;
    expect((await poll).status).toBe(409);
    await expect(reply(h, 'FYI')).rejects.toThrow(/no active call/);
  });
});

describe('gemini call length and daily budget', () => {
  let google: FakeGoogle;

  beforeAll(async () => {
    google = await startFakeGoogle();
  });
  afterAll(async () => {
    await google.close();
  });

  it('caps a call at 10 minutes, at GEMINI_LIVE_MAX_CALL_SECONDS, and never above the general cap', async () => {
    for (const [overrides, expected] of [
      [{}, 10 * MIN],
      [{ maxCallDurationMs: 4 * MIN }, 4 * MIN],
      // GEMINI_LIVE_MAX_CALL_SECONDS never lifts a call past the 10 minutes Google allows.
      [{ gemini: { apiKey: 'gk', apiBase: google.apiBase, maxCallDurationMs: 20 * MIN } }, 10 * MIN],
      [{ gemini: { apiKey: 'gk', apiBase: google.apiBase, maxCallDurationMs: 5 * MIN } }, 5 * MIN],
    ] as Array<[Partial<GptLiveConfig>, number]>) {
      const h = await startHarness({ gemini: { apiKey: 'gk', apiBase: google.apiBase }, ...overrides });
      try {
        expect((await mint(h)).durationMs).toBe(expected);
      } finally {
        await h.stop();
      }
    }
  });

  it('reserves the token lifetime at mint, refunds a failed mint, and keeps charges across hangups and replacement', async () => {
    const h = await startHarness({
      gemini: { apiKey: 'gk', apiBase: google.apiBase },
      maxCallsPerHour: 20,
      maxCallMsPerDay: 25 * MIN,
    });
    try {
      const first = await mint(h);
      expect(first.durationMs).toBe(10 * MIN);
      h.clock.now += 2 * MIN;
      expect((await post(`${h.base}/gemini/end?t=tok123`, { callId: first.callId })).status).toBe(204);
      google.failNext = 500;
      expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(502);
      expect((await mint(h)).durationMs).toBe(10 * MIN);
      // Replacing the running call ends the host record but not the minutes its token can still use.
      const third = await mint(h);
      expect(third.durationMs).toBe(5 * MIN);
      const res = await post(`${h.base}/gemini/token?t=tok123`);
      expect(res.status).toBe(429);
      expect(await res.text()).toMatch(/call minutes for today/);
    } finally {
      await h.stop();
    }
  });
});

describe('gemini token mint races', () => {
  let google: FakeGoogle;

  beforeAll(async () => {
    google = await startFakeGoogle();
  });
  afterAll(async () => {
    await google.close();
  });

  const holdGoogle = (): (() => void) => {
    let release!: () => void;
    google.hold = new Promise((r) => (release = r));
    return () => {
      google.hold = null;
      release();
    };
  };

  it('gives the page the token time left after a slow mint, so it hangs up before the token dies', async () => {
    const h = await startHarness({ gemini: { apiKey: 'gk', apiBase: google.apiBase } });
    try {
      const release = holdGoogle();
      const before = google.received;
      const pending = post(`${h.base}/gemini/token?t=tok123`);
      await vi.waitFor(() => expect(google.received).toBe(before + 1));
      h.clock.now += 20_000;
      release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(((await res.json()) as TokenResponse).durationMs).toBe(10 * MIN - 20_000);
    } finally {
      await h.stop();
    }
  });

  it('refunds and registers nothing when the page left during the mint', async () => {
    const h = await startHarness({ gemini: { apiKey: 'gk', apiBase: google.apiBase }, maxCallMsPerDay: 15 * MIN });
    try {
      const release = holdGoogle();
      const before = google.received;
      const controller = new AbortController();
      const pending = fetch(`${h.base}/gemini/token?t=tok123`, { method: 'POST', signal: controller.signal });
      await vi.waitFor(() => expect(google.received).toBe(before + 1));
      controller.abort();
      await expect(pending).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 30));
      release();
      await new Promise((r) => setTimeout(r, 50));
      // The abandoned mint gave its 10 minutes back: the next call gets them all.
      expect((await mint(h)).durationMs).toBe(10 * MIN);
      // And no call was registered for the page that left: nothing waits on it.
      expect(await reply(h, 'proactive')).toMatch(/^gemini-update:/);
    } finally {
      await h.stop();
    }
  });

  it('does not refund a failed mint into the next UTC day', async () => {
    const h = await startHarness({
      gemini: { apiKey: 'gk', apiBase: google.apiBase },
      maxCallMsPerDay: 15 * MIN,
      maxCallsPerHour: 20,
    });
    try {
      h.clock.now = Date.UTC(2026, 9, 2, 23, 59, 0);
      const release = holdGoogle();
      const before = google.received;
      google.failNext = 500;
      const failing = post(`${h.base}/gemini/token?t=tok123`);
      await vi.waitFor(() => expect(google.received).toBe(before + 1));
      // Past midnight, another call is charged on the new day while the first mint still hangs.
      h.clock.now = Date.UTC(2026, 9, 3, 0, 0, 5);
      google.hold = null;
      google.failNext = 0;
      expect((await mint(h)).durationMs).toBe(10 * MIN);
      google.failNext = 500;
      release();
      expect((await failing).status).toBe(502);
      // The new day still carries those 10 minutes: 5 are left.
      expect((await mint(h)).durationMs).toBe(5 * MIN);
    } finally {
      await h.stop();
    }
  });
});

describe('voice routes from a non-loopback peer', () => {
  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

  it('treats only loopback peers as the host front', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.8.100')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.8.100')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it.skipIf(!lanAddress)('refuses them before any token check unless allowed', async () => {
    for (const allowNonLoopback of [false, true]) {
      const h = await startHarness({ allowNonLoopback });
      try {
        const res = await fetch(`http://${lanAddress}:${h.port}/webhook/voice/info?t=tok123`);
        expect(res.status).toBe(allowNonLoopback ? 200 : 403);
        if (!allowNonLoopback) {
          expect(await res.text()).toMatch(/host front only/);
          expect((await fetch(`http://${lanAddress}:${h.port}/webhook/voice/info?t=nope`)).status).toBe(403);
        }
        expect((await fetch(`${h.base}/info?t=tok123`)).status).toBe(200);
      } finally {
        await h.stop();
      }
    }
  });
});

describe('voice prompts lock the language to Ukrainian and English', () => {
  const agent = { name: 'Andy', personality: 'Dry humour.' };
  const caller = { id: LINE, name: 'Ethan' };

  it('states the rule as the model sees it', () => {
    expect(LANGUAGE_RULE).toMatch(/Speak only Ukrainian or English/);
    expect(LANGUAGE_RULE).toMatch(/caller speaks English, answer in English/);
    expect(LANGUAGE_RULE).toMatch(/sounds like another language is misheard Ukrainian/);
    expect(LANGUAGE_RULE).toMatch(/Never switch to a third language/);
    expect(LANGUAGE_RULE).toMatch(/Greet in Ukrainian unless your persona names another language/);
  });

  it('puts it in both the OpenAI session config and the Gemini system instruction', () => {
    for (const prompt of [
      sessionConfig(agent, 'marin', caller).instructions as string,
      geminiInstructions(agent, caller),
    ]) {
      expect(prompt).toContain(LANGUAGE_RULE);
      expect(prompt).not.toMatch(/speak the language the caller speaks/);
    }
  });
});

describe('voice vocabulary', () => {
  const caller = { id: LINE, name: 'Ethan' };

  it('puts the names right after the language rule for every engine, the LiveKit prompt without page updates', () => {
    const agent = { name: 'Andy', vocabulary: voiceVocabulary('Acme, Zephyr', null) };
    const line = 'Names you will hear (spell them exactly this way in transcripts and tool requests): Acme, Zephyr.';
    for (const prompt of [
      sessionConfig(agent, 'marin', caller).instructions as string,
      geminiInstructions(agent, caller),
      geminiInstructions(agent, caller, { agentUpdates: false }),
    ]) {
      expect(prompt).toContain(`${LANGUAGE_RULE} ${line}`);
    }
    expect(geminiInstructions(agent, caller)).toContain('Agent update:');
    expect(geminiInstructions(agent, caller, { agentUpdates: false })).not.toContain('Agent update:');
  });

  it('lists no names when neither the setting nor the file names any', () => {
    expect(voiceVocabulary(undefined, null)).toEqual([]);
    expect(voiceVocabulary(' , ,', '\n  \n')).toEqual([]);
    const agent = { name: 'Andy', vocabulary: voiceVocabulary(undefined, null) };
    expect(geminiInstructions(agent, caller)).not.toContain('Names you will hear');
    expect(sessionConfig(agent, 'marin', caller).instructions).not.toContain('Names you will hear');
  });

  it('merges GPT_LIVE_VOCABULARY with the agent file, trimmed and deduplicated', () => {
    expect(voiceVocabulary(' Acme ,Zephyr,, k8s', 'zephyr\nLiveKit\r\n  Gemini  Live \nAcme')).toEqual([
      'Acme',
      'Zephyr',
      'k8s',
      'LiveKit',
      'Gemini Live',
    ]);
  });

  it('reads the agent file with the persona reader, FIFO- and symlink-safe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-vocab-'));
    try {
      fs.writeFileSync(path.join(dir, VOICE_VOCABULARY_FILE), 'Acme\nk8s\n');
      expect(voiceVocabulary(undefined, readGroupPersona(dir, VOICE_VOCABULARY_FILE))).toEqual(['Acme', 'k8s']);
      fs.rmSync(path.join(dir, VOICE_VOCABULARY_FILE));
      fs.symlinkSync('/etc/hosts', path.join(dir, VOICE_VOCABULARY_FILE));
      expect(voiceVocabulary(undefined, readGroupPersona(dir, VOICE_VOCABULARY_FILE))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`caps the list at ${MAX_VOCABULARY_TERMS} terms and ${MAX_VOCABULARY_BYTES} bytes, and drops overlong terms`, () => {
    const many = Array.from({ length: 100 }, (_, i) => `t${i}`).join(',');
    expect(voiceVocabulary(many, null)).toHaveLength(MAX_VOCABULARY_TERMS);
    const wide = Array.from({ length: 50 }, (_, i) => `${'x'.repeat(40)}${i}`).join(',');
    const capped = voiceVocabulary(wide, null);
    expect(Buffer.byteLength(capped.join(', '))).toBeLessThanOrEqual(MAX_VOCABULARY_BYTES);
    expect(capped.length).toBeLessThan(50);
    expect(voiceVocabulary(`ok,${'y'.repeat(200)}`, null)).toEqual(['ok']);
  });
});
