/**
 * Jev ambient wake-gate: the decision layer.
 *
 * Jev itself is mocked at the fetch boundary and the session mailbox at the
 * open-read-close helper, so every branch of the verdict — thresholds, vetoes,
 * the three free levers, fail-silent, shadow mode, config hot-reload — is
 * exercised without a network call or a real session DB.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the config mock's getter can be flipped mid-file (the factory runs
// before any `let` in this module body).
const env = vi.hoisted(() => ({ apiKey: 'test-key' }));

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-jev-gate',
    TIMEZONE: 'UTC',
    get JEV_API_KEY() {
      return env.apiKey;
    },
  };
});

const findSessionForAgent = vi.fn();
vi.mock('../../db/sessions.js', () => ({
  findSessionForAgent: (...args: unknown[]) => findSessionForAgent(...args),
}));

type MailboxRow = { timestamp: string; kind: string; content: string };
const mailboxRows = vi.hoisted(() => ({ inbound: [] as unknown[], outbound: [] as unknown[] }));
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: async (
    _agentGroupId: string,
    _sessionId: string,
    action: (mailbox: {
      getInboundHistory: (limit: number) => unknown[];
      getOutboundHistory: (limit: number) => unknown[];
    }) => unknown,
  ) => action({ getInboundHistory: () => mailboxRows.inbound, getOutboundHistory: () => mailboxRows.outbound }),
}));

import { DEFAULT_THRESHOLDS, resetGateConfigCache, runJevGate, WAKE_MARKER } from './index.js';
import { consecutiveBotWakes, lastWakeAt, parseAuthor, wakesToday, type GateHistoryRow } from './history.js';
import { decide } from './jev.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-jev-gate';
const AGENT_GROUP = 'ag-jev';

/** Write the config file. `reset` false leaves the mtime cache alone (hot-reload test). */
function writeConfig(entry: Record<string, unknown> = {}, reset = true): void {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_DIR, 'jev-gate.json'),
    JSON.stringify({
      [AGENT_GROUP]: {
        enabled: true,
        mode: 'live',
        daily_cap: 0,
        cooldown_minutes: 0,
        max_consecutive_bot: 0,
        ...entry,
      },
    }),
  );
  if (reset) resetGateConfigCache();
}

function agent(): MessagingGroupAgent {
  return {
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: AGENT_GROUP,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    threads: 0,
    created_at: new Date().toISOString(),
  };
}

function mg(): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:-100',
    instance: 'telegram',
    name: 'Pondarium',
    is_group: 1,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
}

function event(text = 'anyone know how the wake gate works?', author: Record<string, unknown> = {}): InboundEvent {
  return {
    channelType: 'telegram',
    platformId: 'telegram:-100',
    threadId: null,
    message: {
      id: 'm1',
      kind: 'chat',
      content: JSON.stringify({
        text,
        sender: 'Alex',
        senderId: 'telegram:1',
        senderName: 'Alex',
        author: { userId: 'telegram:1', fullName: 'Alex', userName: 'alex', ...author },
        attachments: [],
      }),
      timestamp: new Date().toISOString(),
    },
  };
}

/** Stub Jev with the given Nouls (unnamed questions answer 0). Returns the fetch mock. */
function nouls(scores: Record<string, number>) {
  const answers: Record<string, unknown> = {};
  for (const [id, noul] of Object.entries({
    direct_invitation: 0,
    unresolved: 0,
    already_answered: 0,
    human_pingpong: 0,
    ...scores,
  })) {
    answers[id] = { type: 'noul', noul };
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-latest', answers }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function gate(ev: InboundEvent = event()) {
  const out = await runJevGate({ agent: agent(), mg: mg(), event: ev, threadId: null });
  return out && { silence: out.silence, annotation: out.annotation, content: out.event.message.content };
}

function inboundRow(text: string, minutesAgo: number, author: Record<string, unknown> = {}): MailboxRow {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    kind: 'chat',
    content: JSON.stringify({ text, sender: 'Alex', author: { userId: 'telegram:1', userName: 'alex', ...author } }),
  };
}

const WOKE = '[jev: reply · value=0.90 · veto=0.00]';

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  resetGateConfigCache();
  env.apiKey = 'test-key';
  mailboxRows.inbound = [];
  mailboxRows.outbound = [];
  findSessionForAgent.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('gate config', () => {
  it('is off when the file is missing — the router keeps its upstream behavior', async () => {
    const fetchMock = nouls({ direct_invitation: 1 });
    expect(await gate()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is off when the file has no entry for this wiring', async () => {
    fs.writeFileSync(path.join(TEST_DIR, 'jev-gate.json'), JSON.stringify({ 'other-group': { enabled: true } }));
    resetGateConfigCache();
    nouls({ direct_invitation: 1 });
    expect(await gate()).toBeNull();
  });

  it('is off when the entry is present but disabled', async () => {
    writeConfig({ enabled: false });
    nouls({ direct_invitation: 1 });
    expect(await gate()).toBeNull();
  });

  it('is off when the file is unparseable (never fails open)', async () => {
    fs.writeFileSync(path.join(TEST_DIR, 'jev-gate.json'), '{ not json');
    resetGateConfigCache();
    nouls({ direct_invitation: 1 });
    expect(await gate()).toBeNull();
  });

  it('picks up an edit without a restart or a cache reset', async () => {
    writeConfig({ enabled: false });
    nouls({ direct_invitation: 0.9 });
    expect(await gate()).toBeNull();

    writeConfig({ enabled: true }, false);
    expect((await gate())?.silence).toBe(false);
  });
});

describe('verdicts', () => {
  beforeEach(() => writeConfig());

  it('wakes on a direct invitation', async () => {
    nouls({ direct_invitation: 0.9 });
    const out = await gate();
    expect(out?.silence).toBe(false);
    expect(out?.annotation).toBe(WOKE);
    expect(out?.content).toContain(WAKE_MARKER);
  });

  it('wakes on an unresolved question even with no invitation', async () => {
    nouls({ direct_invitation: 0.1, unresolved: 0.8 });
    expect((await gate())?.silence).toBe(false);
  });

  it('stays silent when both wake signals are below their thresholds', async () => {
    nouls({ direct_invitation: 0.5, unresolved: 0.4 });
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: silent · value=0.50 · veto=0.00 · below_threshold]');
  });

  it('honors a raised threshold from config', async () => {
    writeConfig({ thresholds: { direct_invitation: 0.95 } });
    nouls({ direct_invitation: 0.91 });
    expect((await gate())?.silence).toBe(true);
  });

  it('vetoes a strong invitation that was already answered', async () => {
    nouls({ direct_invitation: 0.95, already_answered: 0.8 });
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: silent · value=0.95 · veto=0.80 · already_answered]');
  });

  it('vetoes a human back-and-forth', async () => {
    nouls({ unresolved: 0.9, human_pingpong: 0.85 });
    expect((await gate())?.annotation).toContain('human_pingpong');
  });
});

describe('fail-silent', () => {
  beforeEach(() => writeConfig());

  it('silences on a timeout', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: error timeout]');
  });

  it('silences on a non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: error http_503]');
  });

  it('silences on a body with a missing answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ answers: { unresolved: { noul: 0.9 } } }) }),
    );
    expect((await gate())?.annotation).toBe('[jev: error missing_direct_invitation]');
  });

  it('silences with no API key, without calling Jev', async () => {
    env.apiKey = '';
    const fetchMock = nouls({ direct_invitation: 0.99 });
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: error no_key]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never marks an error as a wake, so it cannot be counted against the cap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('econnreset')));
    expect((await gate())?.content).not.toContain(WAKE_MARKER);
  });
});

describe('shadow mode', () => {
  it('judges and annotates but never silences', async () => {
    writeConfig({ mode: 'shadow' });
    nouls({ direct_invitation: 0.1 });
    const out = await gate();
    expect(out?.silence).toBe(false);
    expect(out?.annotation).toBe('[jev: shadow-silent · value=0.10 · veto=0.00 · below_threshold]');
  });

  it('does not let a shadow wake look like a granted one to the cap derivation', async () => {
    writeConfig({ mode: 'shadow' });
    nouls({ direct_invitation: 0.99 });
    const out = await gate();
    expect(out?.annotation).toBe('[jev: shadow-reply · value=0.99 · veto=0.00]');
    expect(out?.content).not.toContain(WAKE_MARKER);
  });

  it('does not silence on a Jev error either', async () => {
    writeConfig({ mode: 'shadow' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    expect((await gate())?.silence).toBe(false);
  });
});

describe('free levers (derived from stored annotations, no tables)', () => {
  beforeEach(() => {
    findSessionForAgent.mockResolvedValue({ id: 'sess-1', agent_group_id: AGENT_GROUP });
  });

  it('silences once the daily cap is reached, without calling Jev', async () => {
    writeConfig({ daily_cap: 2 });
    mailboxRows.inbound = [inboundRow(`a\n${WOKE}`, 30), inboundRow(`b\n${WOKE}`, 20)];
    const fetchMock = nouls({ direct_invitation: 0.99 });
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: silent · daily_cap 2/2]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a message through while the cap has room', async () => {
    writeConfig({ daily_cap: 3 });
    mailboxRows.inbound = [inboundRow(`a\n${WOKE}`, 30)];
    nouls({ direct_invitation: 0.99 });
    expect((await gate())?.silence).toBe(false);
  });

  it('silences inside the cooldown window', async () => {
    writeConfig({ cooldown_minutes: 15 });
    mailboxRows.inbound = [inboundRow(`a\n${WOKE}`, 5)];
    nouls({ direct_invitation: 0.99 });
    expect((await gate())?.annotation).toBe('[jev: silent · cooldown 15m]');
  });

  it('lets a message through once the cooldown has expired', async () => {
    writeConfig({ cooldown_minutes: 15 });
    mailboxRows.inbound = [inboundRow(`a\n${WOKE}`, 40)];
    nouls({ direct_invitation: 0.99 });
    expect((await gate())?.silence).toBe(false);
  });

  it('trips the bot-loop guard on a bot message after N bot-authored wakes', async () => {
    writeConfig({ max_consecutive_bot: 2 });
    mailboxRows.inbound = [
      inboundRow(`x\n${WOKE}`, 20, { isBot: true }),
      inboundRow(`y\n${WOKE}`, 10, { isBot: true }),
    ];
    nouls({ direct_invitation: 0.99 });
    const out = await gate(event('and another thing', { isBot: true }));
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: silent · bot_loop_guard 2]');
  });

  it('does not trip the loop guard for a human message', async () => {
    writeConfig({ max_consecutive_bot: 2 });
    mailboxRows.inbound = [
      inboundRow(`x\n${WOKE}`, 20, { isBot: true }),
      inboundRow(`y\n${WOKE}`, 10, { isBot: true }),
    ];
    nouls({ direct_invitation: 0.99 });
    expect((await gate())?.silence).toBe(false);
  });

  it('sends the rubric and the recent history to Jev as state', async () => {
    writeConfig();
    mailboxRows.inbound = [inboundRow('what broke the deploy?', 5)];
    mailboxRows.outbound = [
      {
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        kind: 'chat',
        content: JSON.stringify({ text: 'the runner image' }),
      },
    ];
    const fetchMock = nouls({ direct_invitation: 0.99 });
    await gate();

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body) as { state: string; model: string; questions: Record<string, { type: string }> };
    expect(body.model).toBe('jev-latest');
    expect(Object.keys(body.questions).sort()).toEqual([
      'already_answered',
      'direct_invitation',
      'human_pingpong',
      'unresolved',
    ]);
    expect(body.questions.direct_invitation.type).toBe('noul');
    expect(body.state).toContain('Alex: what broke the deploy?');
    expect(body.state).toContain('Dan (the assistant): the runner image');
    expect(body.state).toContain('NEW MESSAGE:');
  });

  it('judges on the message alone when the wiring has no session yet', async () => {
    findSessionForAgent.mockResolvedValue(undefined);
    writeConfig();
    const fetchMock = nouls({ direct_invitation: 0.99 });
    expect((await gate())?.silence).toBe(false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { state: string };
    expect(body.state).toContain('(no prior messages)');
  });
});

describe('derivation helpers', () => {
  function row(over: Partial<GateHistoryRow>): GateHistoryRow {
    return {
      timestamp: new Date().toISOString(),
      direction: 'in',
      text: '',
      sender: 'Alex',
      isBot: false,
      jevWake: false,
      ...over,
    };
  }

  it('counts only today, only inbound, only gate wakes', () => {
    const rows = [
      row({ timestamp: '2026-09-19T23:00:00Z', jevWake: true }),
      row({ timestamp: '2026-09-20T01:00:00Z', jevWake: true }),
      row({ timestamp: '2026-09-20T02:00:00Z', jevWake: false }),
      row({ timestamp: '2026-09-20T03:00:00Z', direction: 'out', jevWake: true }),
    ];
    expect(wakesToday(rows, 'UTC', new Date('2026-09-20T12:00:00Z'))).toBe(1);
  });

  it('takes the newest wake for the cooldown stamp', () => {
    const rows = [
      row({ timestamp: '2026-09-20T01:00:00Z', jevWake: true }),
      row({ timestamp: '2026-09-20T05:00:00Z', jevWake: true }),
      row({ timestamp: '2026-09-20T06:00:00Z' }),
    ];
    expect(lastWakeAt(rows)?.toISOString()).toBe('2026-09-20T05:00:00.000Z');
  });

  it('resets the bot streak at the first human message', () => {
    const rows = [
      row({ isBot: true, jevWake: true }),
      row({ isBot: false }),
      row({ isBot: true, jevWake: true }),
      row({ isBot: true, jevWake: true }),
    ];
    expect(consecutiveBotWakes(rows)).toBe(2);
  });

  it('reads isBot from author, falling back to a bot-suffixed username', () => {
    expect(parseAuthor(JSON.stringify({ text: 'hi', author: { isBot: true, userName: 'alex' } })).isBot).toBe(true);
    expect(parseAuthor(JSON.stringify({ text: 'hi', author: { userName: 'LeviBot' } })).isBot).toBe(true);
    expect(parseAuthor(JSON.stringify({ text: 'hi', author: { isBot: false, userName: 'LeviBot' } })).isBot).toBe(
      false,
    );
    expect(parseAuthor(JSON.stringify({ text: 'hi', author: { userName: 'alex' } })).isBot).toBe(false);
    expect(parseAuthor('not json at all').text).toBe('not json at all');
  });

  it('decides from scores and thresholds alone', () => {
    const base = { direct_invitation: 0.8, unresolved: 0, already_answered: 0, human_pingpong: 0 };
    expect(decide(base, DEFAULT_THRESHOLDS).wake).toBe(true);
    expect(decide({ ...base, already_answered: 0.9 }, DEFAULT_THRESHOLDS).wake).toBe(false);
    expect(decide({ ...base, direct_invitation: 0.1 }, DEFAULT_THRESHOLDS).wake).toBe(false);
  });
});
