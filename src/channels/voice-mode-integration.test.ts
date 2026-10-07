/**
 * The voice channel's core reach-ins on their own: the thinking ticks a stored message starts, what an
 * outbound message looks like after the presentation hook, the expedited reply window and the browser
 * root route. Each must leave core untouched when the channel has nothing to do or fails.
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATA_DIR = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(`${tmpdir()}/nanoclaw-test-voice-mode-integration-`);
});
vi.mock('../config.js', async () => ({ ...(await vi.importActual('../config.js')), DATA_DIR: TEST_DATA_DIR }));
vi.mock('../delivery.js', () => ({ deliverSessionMessages: vi.fn(async () => undefined) }));
afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

import { deliverSessionMessages } from '../delivery.js';
import { getHostStartCallbacks } from '../host-lifecycle.js';
import { log } from '../log.js';
import { heartbeatPath } from '../session-manager.js';
import type { Session } from '../types.js';
import {
  expediteDelivery,
  handleVoiceModeRoot,
  presentVoiceModeOutbound,
  registerTypingObserver,
  registerVoiceModeRootHandler,
  setOutboundPresentation,
  voiceModeReplyDelivered,
  voiceModeStored,
  type TypingTick,
  type VoiceModeInboundEvent,
} from './voice-mode-integration.js';

let sessions = 0;
const newSession = (): Session => ({ id: `sess-${++sessions}`, agent_group_id: 'ag-1' }) as Session;
const event = (fields: Partial<VoiceModeInboundEvent> = {}): VoiceModeInboundEvent => ({
  channelType: 'chat',
  platformId: 'chat:1',
  threadId: null,
  message: { id: 'm1', kind: 'chat', content: '{"text":"hi"}', timestamp: new Date().toISOString() },
  ...fields,
});
/** Writes the session's heartbeat as last touched at `at`. */
const beat = (session: Session, at: number): void => {
  const file = heartbeatPath(session.agent_group_id, session.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.utimesSync(file, at / 1000, at / 1000);
};

// One observer for the whole file (registrations last for the process); each test sets what it does.
const ticks: Array<TypingTick & { sessionId?: string }> = [];
const observer = { live: true, throws: false };
beforeAll(() => {
  registerTypingObserver(
    () => {
      throw new Error('the first observer broke');
    },
    () => observer.throws,
  );
  registerTypingObserver(
    (tick) => void ticks.push(tick),
    () => observer.live,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  ticks.length = 0;
  Object.assign(observer, { live: true, throws: false });
});

describe('thinking ticks for a stored message', () => {
  it('a throwing observer or stored-turn callback is logged, and the other observers still hear the tick', () => {
    observer.throws = true;
    const warn = vi.spyOn(log, 'warn');
    const onStored = vi.fn(() => {
      throw new Error('callback broke');
    });
    expect(() => voiceModeStored(event({ onStored }), newSession(), true)).not.toThrow();
    expect(onStored).toHaveBeenCalledOnce();
    expect(ticks).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('voice-mode: typing observer failed', expect.anything());
    expect(warn).toHaveBeenCalledWith('voice-mode: stored-turn callback failed', expect.anything());
  });

  it('starts no ticks for a message that does not wake the agent, or while no call is live', () => {
    const onStored = vi.fn();
    voiceModeStored(event({ onStored }), newSession(), false);
    expect(onStored).toHaveBeenCalledOnce();
    observer.live = false;
    voiceModeStored(event(), newSession(), true);
    expect(ticks).toEqual([]);
  });

  it('says working only once the heartbeat moved after the message, not for a beat left from before it', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 12) });
    const session = newSession();
    beat(session, Date.now() - 1_000);
    voiceModeStored(event(), session, true);
    expect(ticks.map((t) => t.working)).toEqual([false]);
    beat(session, Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ticks.map((t) => t.working)).toEqual([false, true]);
  });

  it('pauses after a delivered reply as core typing does, and stops past the ceiling with no reply', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 12) });
    const session = newSession();
    const working = () => beat(session, Date.now());
    working();
    voiceModeStored(event(), session, true);
    voiceModeReplyDelivered(session);
    ticks.length = 0;
    for (let i = 0; i < 2; i++) {
      working();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(ticks).toEqual([]);
    working();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ticks).toHaveLength(1);
    // A runner that keeps beating but never delivers is shown thinking for five minutes at most.
    for (let i = 0; i < 80; i++) {
      working();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    const shown = ticks.length;
    expect(shown).toBeLessThan(80);
    working();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ticks).toHaveLength(shown);
  });
});

describe('outbound presentation', () => {
  const session = { id: 's', agent_group_id: 'ag-1' } as Session;
  const msg = (content: string) => ({
    id: 'out-1',
    kind: 'chat',
    channelType: 'telegram',
    platformId: 'telegram:1',
    threadId: null,
    inReplyTo: null,
    content,
  });
  afterEach(() => setOutboundPresentation(null));

  it("hands a message the hook leaves alone over byte for byte, whatever JSON can't round-trip", () => {
    setOutboundPresentation(() => null);
    for (const content of ['{"text": "spaced",  "id": 12345678901234567890}', '"plain"', '[1]', 'not json'])
      expect(presentVoiceModeOutbound(msg(content), session)).toBe(content);
  });

  it('hands over what the hook shows, and the stored message with a warning when the hook throws', () => {
    setOutboundPresentation((_msg, content) => ({ ...content, text: `> ${content.text as string}` }));
    expect(presentVoiceModeOutbound(msg('{"text":"hi"}'), session)).toBe('{"text":"> hi"}');
    const warn = vi.spyOn(log, 'warn');
    setOutboundPresentation(() => {
      throw new Error('hook broke');
    });
    expect(presentVoiceModeOutbound(msg('{"text":"hi"}'), session)).toBe('{"text":"hi"}');
    expect(warn).toHaveBeenCalledWith(
      'voice-mode: outbound presentation failed; delivering the message as stored',
      expect.objectContaining({ id: 'out-1' }),
    );
  });
});

describe('expedited replies', () => {
  it("polls a call's session while its agent works and stops once it is idle, before the window ends", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 12) });
    for (const start of getHostStartCallbacks()) await start({} as never);
    const deliver = vi.mocked(deliverSessionMessages);
    deliver.mockClear();
    const session = newSession();
    expediteDelivery(session, 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deliver).toHaveBeenCalledTimes(5);
    // No heartbeat past the start-up grace: the agent is idle, so its replies are all out.
    await vi.advanceTimersByTimeAsync(20_000);
    const polled = deliver.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deliver).toHaveBeenCalledTimes(polled);
    expect(polled).toBeLessThan(100);
  });
});

describe('browser root route', () => {
  it('answers 500 and logs when the voice handler throws, and leaves other paths to core', async () => {
    const warn = vi.spyOn(log, 'warn');
    registerVoiceModeRootHandler(() => {
      throw new Error('handler broke');
    });
    const res = { headersSent: false, writeHead: vi.fn(), end: vi.fn() };
    const req = (url: string) => ({ url }) as http.IncomingMessage;
    expect(await handleVoiceModeRoot(req('/voice?t=x'), res as unknown as http.ServerResponse)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(500);
    expect(warn).toHaveBeenCalledWith('voice-mode: browser route failed', expect.anything());
    expect(await handleVoiceModeRoot(req('/webhook/telegram'), res as unknown as http.ServerResponse)).toBe(false);
  });
});
