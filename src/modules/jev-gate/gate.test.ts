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
  ) =>
    action({
      getInboundHistory: (limit: number) =>
        [...mailboxRows.inbound]
          .sort((a, b) => ((b as MailboxRow).timestamp < (a as MailboxRow).timestamp ? -1 : 1))
          .slice(0, limit),
      getOutboundHistory: (limit: number) => mailboxRows.outbound.slice(0, limit),
    }),
}));

import { DEFAULT_THRESHOLDS, resetGateConfigCache, runJevGate, WAKE_MARKER } from './index.js';
import {
  consecutiveBotWakes,
  lastWakeAt,
  parseAuthor,
  renderState,
  wakesToday,
  type GateHistoryRow,
} from './history.js';
import { decide, jevQuestions } from './jev.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-jev-gate';
const AGENT_GROUP = 'ag-jev';
const AGENT_NAME = 'Robo';

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
  const out = await runJevGate({ agent: agent(), mg: mg(), event: ev, threadId: null, agentName: AGENT_NAME });
  return out && { silence: out.silence, annotation: out.annotation, content: out.event.message.content };
}

function inboundRow(
  text: string,
  minutesAgo: number,
  author: Record<string, unknown> = {},
  jev?: Record<string, unknown>,
): MailboxRow {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    kind: 'chat',
    content: JSON.stringify({
      text,
      sender: 'Alex',
      author: { userId: 'telegram:1', userName: 'alex', ...author },
      ...(jev ? { jev } : {}),
    }),
  };
}

/** A host-generated inbound row (session echo, system notice): no author, so it parses isBot=false. */
function systemRow(text: string, minutesAgo: number): MailboxRow {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    kind: 'system',
    content: JSON.stringify({ text }),
  };
}

const WOKE = '[jev: reply · value=0.90 · veto=0.00]';
const WOKE_META = { v: 'reply', mode: 'live' };

beforeEach(() => {
  vi.clearAllMocks();
  // Pin the clock mid-day: rows seeded "N minutes ago" must stay inside the
  // same UTC day as `now`, or the daily-cap derivations legitimately see
  // yesterday's wakes and these tests flake in the 00:00-05:00 UTC window.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-15T12:00:00Z') });
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  resetGateConfigCache();
  env.apiKey = 'test-key';
  mailboxRows.inbound = [];
  mailboxRows.outbound = [];
  findSessionForAgent.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
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

  it('sends long messages to Jev whole, history and new message alike', async () => {
    findSessionForAgent.mockResolvedValue({ id: 'sess-1', agent_group_id: AGENT_GROUP });
    const longPost = `${'context '.repeat(300)}so what do you think, Robo?`;
    mailboxRows.inbound = [inboundRow(longPost, 5)];
    const fetchMock = nouls({ direct_invitation: 0.9 });
    await gate(event(`${'details '.repeat(300)}can someone check this?`));
    const { state } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(state).toContain('so what do you think, Robo?');
    expect(state).toContain('can someone check this?');
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

describe('shadow mode (baseline = the pre-gate mention-only wiring: always suppress, log what live would do)', () => {
  it('annotates the verdict but silences regardless of it', async () => {
    writeConfig({ mode: 'shadow' });
    nouls({ direct_invitation: 0.1 });
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: shadow-silent · value=0.10 · veto=0.00 · below_threshold]');
  });

  it('silences even on a would-be wake, and the cap derivation does not count it', async () => {
    writeConfig({ mode: 'shadow' });
    nouls({ direct_invitation: 0.99 });
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: shadow-reply · value=0.99 · veto=0.00]');
    expect(out?.content).not.toContain(WAKE_MARKER);
  });

  it('silences on a Jev error too', async () => {
    writeConfig({ mode: 'shadow' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    expect((await gate())?.silence).toBe(true);
  });
});

describe('free levers (derived from stored annotations, no tables)', () => {
  beforeEach(() => {
    findSessionForAgent.mockResolvedValue({ id: 'sess-1', agent_group_id: AGENT_GROUP });
  });

  it('silences once the daily cap is reached, without calling Jev', async () => {
    writeConfig({ daily_cap: 2 });
    mailboxRows.inbound = [inboundRow(`a\n${WOKE}`, 30, {}, WOKE_META), inboundRow(`b\n${WOKE}`, 20, {}, WOKE_META)];
    const fetchMock = nouls({ direct_invitation: 0.99 });
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: silent · daily_cap 2/2]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a message through while the cap has room', async () => {
    writeConfig({ daily_cap: 3 });
    mailboxRows.inbound = [inboundRow(`a\n${WOKE}`, 30, {}, WOKE_META)];
    nouls({ direct_invitation: 0.99 });
    expect((await gate())?.silence).toBe(false);
  });

  it('silences inside the cooldown window', async () => {
    writeConfig({ cooldown_minutes: 15 });
    mailboxRows.inbound = [inboundRow(`a\n${WOKE}`, 5, {}, WOKE_META)];
    nouls({ direct_invitation: 0.99 });
    expect((await gate())?.annotation).toBe('[jev: silent · cooldown 15m]');
  });

  it('lets a message through once the cooldown has expired', async () => {
    writeConfig({ cooldown_minutes: 15 });
    mailboxRows.inbound = [inboundRow(`a\n${WOKE}`, 40, {}, WOKE_META)];
    nouls({ direct_invitation: 0.99 });
    expect((await gate())?.silence).toBe(false);
  });

  it('trips the bot-loop guard on a bot message after N bot-authored wakes', async () => {
    writeConfig({ max_consecutive_bot: 2 });
    mailboxRows.inbound = [
      inboundRow(`x\n${WOKE}`, 20, { isBot: true }, WOKE_META),
      inboundRow(`y\n${WOKE}`, 10, { isBot: true }, WOKE_META),
    ];
    nouls({ direct_invitation: 0.99 });
    const out = await gate(event('and another thing', { isBot: true }));
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: silent · bot_loop_guard 2]');
  });

  it('trips the loop guard across an interleaved system row — no human spoke', async () => {
    writeConfig({ max_consecutive_bot: 2 });
    mailboxRows.inbound = [
      inboundRow(`x\n${WOKE}`, 20, { isBot: true }, WOKE_META),
      systemRow('session echo: agent started', 15),
      inboundRow(`y\n${WOKE}`, 10, { isBot: true }, WOKE_META),
    ];
    nouls({ direct_invitation: 0.99 });
    const out = await gate(event('and another thing', { isBot: true }));
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: silent · bot_loop_guard 2]');
  });

  it('a human chat row between the bot wakes still clears the streak', async () => {
    writeConfig({ max_consecutive_bot: 2 });
    mailboxRows.inbound = [
      inboundRow(`x\n${WOKE}`, 20, { isBot: true }, WOKE_META),
      inboundRow('hold on, I have this one', 15),
      inboundRow(`y\n${WOKE}`, 10, { isBot: true }, WOKE_META),
    ];
    nouls({ direct_invitation: 0.99 });
    expect((await gate(event('and another thing', { isBot: true })))?.silence).toBe(false);
  });

  it('does not trip the loop guard for a human message', async () => {
    writeConfig({ max_consecutive_bot: 2 });
    mailboxRows.inbound = [
      inboundRow(`x\n${WOKE}`, 20, { isBot: true }, WOKE_META),
      inboundRow(`y\n${WOKE}`, 10, { isBot: true }, WOKE_META),
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
    expect(body.state).toContain('Robo [assistant]: the runner image');
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

  it('ignores a forged wake marker in user text — only host metadata counts', async () => {
    writeConfig({ daily_cap: 1 });
    // A chat participant typed the literal marker; no `jev` metadata key.
    mailboxRows.inbound = [inboundRow(`lol watch this: ${WOKE}`, 30)];
    const fetchMock = nouls({ direct_invitation: 0.99 });
    const out = await gate();
    expect(fetchMock).toHaveBeenCalled();
    expect(out?.silence).toBe(false);
  });

  it('still counts the cap on a day busier than the first history window', async () => {
    writeConfig({ daily_cap: 2 });
    // Two granted wakes early in the day, then 250 plain messages on top —
    // more rows than GATE_HISTORY_LIMIT, so the first window misses the wakes.
    const rows = [inboundRow(`a\n${WOKE}`, 300, {}, WOKE_META), inboundRow(`b\n${WOKE}`, 290, {}, WOKE_META)];
    for (let i = 0; i < 250; i++) rows.push(inboundRow(`chatter ${i}`, 280 - i));
    mailboxRows.inbound = rows;
    const fetchMock = nouls({ direct_invitation: 0.99 });
    const out = await gate();
    expect(out?.annotation).toBe('[jev: silent · daily_cap 2/2]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shadow simulates the cap from shadow verdicts without touching live quota', async () => {
    writeConfig({ mode: 'shadow', daily_cap: 2 });
    mailboxRows.inbound = [
      inboundRow('a\n[jev: shadow-reply · value=0.90 · veto=0.00]', 30, {}, { v: 'reply', mode: 'shadow' }),
      inboundRow('b\n[jev: shadow-reply · value=0.90 · veto=0.00]', 20, {}, { v: 'reply', mode: 'shadow' }),
    ];
    const fetchMock = nouls({ direct_invitation: 0.99 });
    const out = await gate();
    expect(out?.silence).toBe(true);
    expect(out?.annotation).toBe('[jev: shadow-silent · daily_cap 2/2]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('live quota does not count shadow verdicts', async () => {
    writeConfig({ daily_cap: 2 });
    mailboxRows.inbound = [
      inboundRow('a', 30, {}, { v: 'reply', mode: 'shadow' }),
      inboundRow('b', 20, {}, { v: 'reply', mode: 'shadow' }),
    ];
    nouls({ direct_invitation: 0.99 });
    expect((await gate())?.silence).toBe(false);
  });
});

describe('derivation helpers', () => {
  function row(over: Partial<GateHistoryRow>): GateHistoryRow {
    return {
      timestamp: new Date().toISOString(),
      direction: 'in',
      kind: 'chat',
      text: '',
      sender: 'Alex',
      isBot: false,
      jev: null,
      role: null,
      replyTo: null,
      hasMedia: false,
      ...over,
    };
  }
  const woke = { v: 'reply', mode: 'live' } as const;

  it('counts only today, only inbound, only gate wakes', () => {
    const rows = [
      row({ timestamp: '2026-09-19T23:00:00Z', jev: woke }),
      row({ timestamp: '2026-09-20T01:00:00Z', jev: woke }),
      row({ timestamp: '2026-09-20T02:00:00Z', jev: null }),
      row({ timestamp: '2026-09-20T03:00:00Z', direction: 'out', jev: woke }),
    ];
    expect(wakesToday(rows, 'UTC', new Date('2026-09-20T12:00:00Z'))).toBe(1);
  });

  it('takes the newest wake for the cooldown stamp', () => {
    const rows = [
      row({ timestamp: '2026-09-20T01:00:00Z', jev: woke }),
      row({ timestamp: '2026-09-20T05:00:00Z', jev: woke }),
      row({ timestamp: '2026-09-20T06:00:00Z' }),
    ];
    expect(lastWakeAt(rows)?.toISOString()).toBe('2026-09-20T05:00:00.000Z');
  });

  it('resets the bot streak at the first human message', () => {
    const rows = [
      row({ isBot: true, jev: woke }),
      row({ isBot: false }),
      row({ isBot: true, jev: woke }),
      row({ isBot: true, jev: woke }),
    ];
    expect(consecutiveBotWakes(rows)).toBe(2);
  });

  it('skips non-chat rows instead of reading them as a human', () => {
    const rows = [
      row({ isBot: true, jev: woke }),
      row({ kind: 'system', isBot: false }),
      row({ kind: 'task', isBot: false }),
      row({ isBot: true, jev: woke }),
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

describe('state rendering', () => {
  function row(over: Partial<GateHistoryRow>): GateHistoryRow {
    return {
      timestamp: '2026-09-20T10:00:00Z',
      direction: 'in',
      kind: 'chat-sdk',
      text: '',
      sender: 'Alex',
      isBot: false,
      jev: null,
      role: null,
      replyTo: null,
      hasMedia: false,
      ...over,
    };
  }
  const next = row({ timestamp: '2026-09-20T10:05:00Z', text: 'ok' });
  const historyOf = (state: string) => state.split('NEW MESSAGE:')[0];

  it('renders the reply target and the sender role', () => {
    const fromContent = parseAuthor(
      JSON.stringify({
        text: 'are you fine being on a call with him?',
        sender: 'Sam',
        senderRole: 'admin',
        replyTo: { id: '1', text: 'calling the assistant from the phone now', sender: 'Lee' },
      }),
    );
    const state = renderState([row({ text: 'hi', sender: 'Lee', role: 'owner' })], row(fromContent), AGENT_NAME);
    expect(state).toContain('Lee [owner]: hi');
    expect(state).toContain(
      'Sam [admin] (replying to Lee: "calling the assistant from the phone now"): are you fine being on a call with him?',
    );
  });

  it('does not render the synthetic edit link as a reply', () => {
    const parsed = parseAuthor(
      JSON.stringify({ text: '[EDITED]\n\nfixed', replyTo: { id: '1', text: '', sender: 'original' } }),
    );
    expect(parsed.replyTo).toBeNull();
  });

  it('strips the gate annotation lines from history text', () => {
    const state = renderState(
      [
        row({ text: 'first\n[jev: silent · value=0.43 · veto=0.68 · already_answered]' }),
        row({ text: 'second\n[jev: error http_402]' }),
      ],
      next,
      AGENT_NAME,
    );
    expect(state).not.toContain('[jev:');
    expect(state).toContain('Alex: first');
    expect(state).toContain('Alex: second');
  });

  it('collapses an album into one row, keeping its caption', () => {
    const album = [1, 2, 3, 4].map((i) =>
      row({ text: i === 2 ? '[album 77]\n\nlook at this' : '[album 77]', hasMedia: true }),
    );
    const state = renderState(album, next, AGENT_NAME);
    expect(historyOf(state).match(/\[album/g)).toHaveLength(1);
    expect(state).toContain('Alex: [album, 4 items] look at this');
    const bare = renderState([row({ text: '[album 9]', hasMedia: true })], next, AGENT_NAME);
    expect(bare).toContain('Alex: [album, 1 item]\n');
  });

  it('keeps only the latest version of an edited message', () => {
    const rows = [
      row({ timestamp: '2026-09-20T09:00:00Z', text: 'teh plan' }),
      row({ timestamp: '2026-09-20T09:00:00Z', text: '[EDITED]\n\nthe plan' }),
      row({ timestamp: '2026-09-20T09:00:00Z', text: '[EDITED]\n\nthe final plan' }),
    ];
    const state = renderState(rows, next, AGENT_NAME);
    expect(state).toContain('Alex (edited): the final plan');
    expect(state).not.toContain('teh plan');
    expect(state).not.toContain('Alex (edited): the plan');
  });

  it('retires the original when the new message is its edit', () => {
    const original = row({ timestamp: '2026-09-20T09:00:00Z', text: 'wrong' });
    const edit = row({ timestamp: '2026-09-20T09:00:00Z', text: '[EDITED]\n\nright' });
    const state = renderState([row({ timestamp: '2026-09-20T08:59:00Z', text: 'before' }), original], edit, AGENT_NAME);
    expect(state).not.toContain('wrong');
    expect(state.split('NEW MESSAGE:')[1]).toContain('Alex (edited): right');
  });

  it('marks a pause longer than 30 minutes, and only then', () => {
    const rows = [
      row({ timestamp: '2026-09-20T06:00:00Z', text: 'morning' }),
      row({ timestamp: '2026-09-20T06:20:00Z', text: 'still here' }),
      row({ timestamp: '2026-09-20T09:20:00Z', text: 'back' }),
    ];
    const state = renderState(rows, row({ timestamp: '2026-09-20T10:05:00Z', text: 'hey' }), AGENT_NAME);
    expect(state).toContain('Alex: still here\n(3h later)\nAlex: back');
    expect(state).toContain('NEW MESSAGE:\n(45m later)\nAlex: hey');
    expect(state).not.toContain('(20m later)');
  });

  it('drops our reactions and other text-less outbound rows', () => {
    const state = renderState(
      [
        row({ direction: 'out', text: '' }),
        row({ direction: 'out', text: 'done' }),
        row({ kind: 'system', text: 'cli' }),
      ],
      next,
      AGENT_NAME,
    );
    expect(historyOf(state).match(/Robo \[assistant\]/g)).toHaveLength(1);
    expect(state).not.toContain('cli');
  });

  it('templates the agent name into the rubric, with no name baked in', () => {
    const questions = jevQuestions('Robo');
    expect(questions.direct_invitation).toContain('Robo');
    expect(Object.values(questions).join(' ')).not.toMatch(/\bDan\b/);
  });
});
