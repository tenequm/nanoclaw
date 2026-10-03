/**
 * The call page's review mode view (`ui/src/lib/review.ts`): keys, readout and draft panel for
 * every review state (SKILL.md's review mode section). It lives in the maintainer build tree, which an
 * installed payload does not carry, so these tests run only where it is.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { matchCommand, type SpokenCommand } from '../voice-livekit-worker.js';
import { CALL_COMMANDS_VERSION } from './voice-livekit-protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, '../../.claude/skills/add-voice-mode');
const reviewLib = path.join(skillDir, 'ui/src/lib/review.ts');

type Draft = { id: number; state: string; text: string; tooLong?: boolean; reason?: string };
type ReviewState = Record<string, unknown> & { draft: Draft | null };
type View = {
  left: { label: string; action: string; disabled: boolean };
  right: { label: string; action: string; disabled: boolean };
  chip: string;
  hint: string;
  mic: string;
  capturing: boolean;
  panel: { title: string; text: string; tone: string; note?: string } | null;
  modeDisabled: boolean;
  endable: boolean;
};
type Prefs = { mode: string; wake: boolean; pauseSends: boolean };
interface ReviewLib {
  INITIAL_REVIEW: ReviewState;
  reviewView(input: {
    phase: string;
    agentName: string;
    reconnecting: boolean;
    waited: number;
    review: ReviewState;
  }): View;
  autoBlock(review: ReviewState): string | null;
  refusalNote(error: string | undefined, agent: string): string | null;
  isReviewSnapshot(v: unknown): boolean;
  infoWakePhrase(info: unknown): string | null | undefined;
  wakePhraseOf(review: ReviewState, agent: string): string;
  keyIdentity(action: string | null, draftId?: number): string;
  autoListening(input: { agentName: string; review: ReviewState }): {
    chip: string;
    hint: string;
    empty: string;
  };
  lineKey(s: string): string;
  isCommandOnly(s: string): boolean;
  endsInDiscard(s: string): boolean;
  norm(s: string): string;
  SEND_WORDS: string[];
  DISCARD_PHRASES: string[];
  COMMANDS_VERSION: string;
  MODE_NAME: Record<string, string>;
  DEFAULT_PREFS: Prefs;
  storedPrefs(): Prefs;
  storePrefs(prefs: Prefs): void;
  settingsNotTaken(ran: { on: boolean; pauseSends: boolean } | undefined): Record<string, unknown>;
  storedWakePhrase(): string | null;
  storeWakePhrase(phrase: string | null): void;
  modeCaption(mode: string, commands: boolean, wake?: { on: boolean; pauseSends: boolean }): string;
  wakeSwitchPhrase(review: ReviewState, agentName: string, placeholder: string): string | null;
  reopensMic(input: { to: string; taken: boolean; muted: boolean; mutedByHand: boolean }): boolean;
  charsOver(text: string): number;
}

describe.skipIf(!existsSync(reviewLib))('review mode page view', async () => {
  const lib = (await import(pathToFileURL(reviewLib).href)) as ReviewLib;
  const review = (fields: Partial<ReviewState> = {}): ReviewState => ({
    ...lib.INITIAL_REVIEW,
    mode: 'review',
    ...fields,
  });
  const view = (
    fields: Partial<ReviewState> = {},
    phase = 'listening',
    extra: { reconnecting?: boolean; waited?: number } = {},
  ) => lib.reviewView({ phase, agentName: 'Andy', reconnecting: false, waited: 0, ...extra, review: review(fields) });
  const keys = (v: View) => [
    `${v.left.label}${v.left.disabled ? '(off)' : ''}`,
    `${v.right.label}${v.right.disabled ? '(off)' : ''}`,
  ];
  const draft = (state: string, text = '', more: Partial<Draft> = {}): Draft => ({ id: 1, state, text, ...more });

  it('before and around the call: call first, then talk; the right key waits', () => {
    expect(keys(view({}, 'idle'))).toEqual(['Call', 'Talk(off)']);
    expect(view({}, 'idle')).toMatchObject({ chip: 'Ready', hint: 'Call first, then tap talk.' });
    expect(keys(view({}, 'connecting'))).toEqual(['Cancel', 'Talk(off)']);
    expect(view({}, 'connecting')).toMatchObject({ chip: 'Connecting…', modeDisabled: true });
    expect(keys(view({}, 'ended'))).toEqual(['Call again', 'Talk(off)']);
  });

  it('walks a turn: talk, recording, finishing, draft, send, sent', () => {
    let v = view();
    expect(keys(v)).toEqual(['End', 'Talk']);
    expect(v).toMatchObject({
      chip: 'Mic muted',
      hint: 'Tap talk to start.',
      mic: 'Mic off',
      panel: null,
      capturing: false,
    });

    v = view({ pending: { op: 'talk' } });
    expect(keys(v)).toEqual(['End', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Starting mic', hint: 'Wait before speaking.' });

    v = view({ draft: draft('recording'), micOn: true, provisional: 'Book a' });
    expect(keys(v)).toEqual(['End', 'Done']);
    expect(v).toMatchObject({
      chip: 'Listening',
      hint: "Pausing won't send - tap done to read it.",
      mic: 'Recording',
      capturing: true,
    });
    expect(v.panel).toEqual({ title: 'hearing - not sent', text: 'Book a', tone: 'hearing' });

    v = view({ draft: draft('finishing'), provisional: 'Book a table' });
    expect(keys(v)).toEqual(['Discard', 'Send(off)']);
    expect(v).toMatchObject({
      chip: 'Finishing transcript',
      hint: 'Mic off - nothing sent.',
      capturing: false,
      modeDisabled: true,
    });
    expect(v.panel?.title).toBe('finishing transcript');

    v = view({ draft: draft('ready', 'Book a table.') });
    expect(keys(v)).toEqual(['Discard', 'Send']);
    expect(v).toMatchObject({ chip: 'Review draft', hint: 'Check the words, then send.' });
    expect(v.panel).toEqual({ title: 'draft - not sent', text: 'Book a table.', tone: 'draft' });

    v = view({ draft: draft('ready', 'Book a table.'), pending: { op: 'send' } });
    expect(keys(v)).toEqual(['End', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Sending', hint: 'Mic off - waiting for confirmation.' });

    v = view({ delivery: 'sending' });
    expect(keys(v)).toEqual(['End', 'Talk']);
    expect(v).toMatchObject({ chip: 'Sending', hint: 'Mic off - waiting for confirmation.' });

    v = view({ delivery: 'sent' });
    expect(keys(v)).toEqual(['End', 'Talk']);
    expect(v).toMatchObject({ chip: 'Mic muted', hint: 'Sent - tap talk for another turn.' });
  });

  it('keeps talk off while the worker gets its transcription ready after a draft', () => {
    let v = view({ preparing: true, delivery: 'sent' });
    expect(keys(v)).toEqual(['End', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Getting ready', hint: 'Talk opens in a moment.', mic: 'Mic off' });
    // An empty draft gives way to talk, which waits the same.
    v = view({ preparing: true, draft: draft('empty') });
    expect(keys(v)).toEqual(['Discard', 'Talk(off)']);
    expect(v.chip).toBe('Getting ready');
    // The agent's own state keeps its chip; talk still waits.
    v = view({ preparing: true }, 'thinking');
    expect(keys(v)).toEqual(['End', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Andy is working', hint: 'Talk opens in a moment.' });
    expect(keys(view({ preparing: true }, 'talking'))).toEqual(['End', 'Talk(off)']);
    // A draft to read or send is not held up by it.
    v = view({ preparing: true, draft: draft('ready', 'Book a table.') });
    expect(keys(v)).toEqual(['Discard', 'Send']);
    expect(v.chip).toBe('Review draft');
    // Ready again: talk opens.
    expect(keys(view({ preparing: false, delivery: 'sent' }))).toEqual(['End', 'Talk']);
  });

  it('re-arms the end key only when it turns into a hang-up from something else', () => {
    // Connecting, live in auto and live in review are all the same hang-up: the key never fades.
    expect(lib.keyIdentity('cancel')).toBe(lib.keyIdentity('end'));
    expect(lib.keyIdentity('end', 3)).toBe(lib.keyIdentity('end'));
    // Discard on a draft becoming end is a change: a double tap on discard must not hang up.
    expect(lib.keyIdentity('discard', 3)).not.toBe(lib.keyIdentity('end'));
    expect(lib.keyIdentity('discard', 3)).not.toBe(lib.keyIdentity('discard', 4));
    expect(lib.keyIdentity('call')).not.toBe(lib.keyIdentity('cancel'));
    expect(lib.keyIdentity(null)).not.toBe(lib.keyIdentity('end'));
  });

  it('discarding waits for the worker; empty, failed and oversize drafts cannot be sent', () => {
    let v = view({ draft: draft('ready', 'x'), pending: { op: 'discard' } });
    expect(keys(v)).toEqual(['Discard(off)', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Discarding', hint: 'Mic off - please wait.' });

    v = view({ draft: draft('empty') });
    expect(keys(v)).toEqual(['Discard', 'Talk']);
    expect(v).toMatchObject({ chip: 'Nothing heard', hint: 'Nothing heard - tap talk to retry.' });

    v = view({ draft: draft('failed', 'Send the') });
    expect(keys(v)).toEqual(['Discard', 'Send(off)']);
    expect(v).toMatchObject({ chip: 'Transcript failed', hint: "Couldn't finish transcript - discard and try again." });
    expect(v.panel).toMatchObject({
      title: "couldn't finish transcript",
      text: 'Send the',
      note: 'unverified - not sendable',
    });

    v = view({ draft: draft('ready', 'я'.repeat(4200), { tooLong: true }) });
    expect(keys(v)).toEqual(['Discard', 'Send(off)']);
    expect(v).toMatchObject({ chip: 'Draft too long', hint: 'Discard and try a shorter turn.' });
    // 4200 two-byte letters are 8400 bytes: 208 over the host's 8192, so 104 letters to cut.
    expect(v.panel).toMatchObject({ title: 'draft too long', note: 'about 104 characters over the limit' });
    expect(lib.charsOver('я'.repeat(4096))).toBe(0);
    expect(lib.charsOver('a'.repeat(8193))).toBe(1);
  });

  it('the agent speaking: talk waits, a draft can still be sent as a follow-up', () => {
    let v = view({}, 'talking');
    expect(keys(v)).toEqual(['End', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Andy is speaking', hint: 'Tap talk when Andy finishes.' });

    v = view({ draft: draft('empty') }, 'talking');
    expect(keys(v)).toEqual(['Discard', 'Talk(off)']);

    v = view({ draft: draft('ready', 'Also this', { reason: 'agent' }) }, 'talking');
    expect(keys(v)).toEqual(['Discard', 'Send']);
    expect(v).toMatchObject({ chip: 'Andy is speaking', hint: 'You can send it now; Andy gets it next.' });
    expect(v.panel?.note).toBe('Andy started speaking - review what was heard');

    v = view({ draft: draft('finishing') }, 'talking');
    expect(keys(v)).toEqual(['Discard', 'Send(off)']);
    expect(v.hint).toBe('Mic off - nothing sent.');
  });

  it('the agent working: talk adds a follow-up, recording and drafts say so', () => {
    expect(view({}, 'thinking', { waited: 12 })).toMatchObject({
      chip: 'Andy is working',
      hint: 'Tap talk to add more · waiting 0:12',
    });
    expect(keys(view({}, 'thinking'))).toEqual(['End', 'Talk']);
    const rec = view({ draft: draft('recording'), micOn: true }, 'thinking');
    expect(keys(rec)).toEqual(['End', 'Done']);
    expect(rec.hint).toBe('Recording - tap done to read it.');
    expect(view({ draft: draft('ready', 'x') }, 'thinking').hint).toBe('You can send it now; Andy gets it next.');
  });

  it('switching, reconnecting and microphone failures override the routine state', () => {
    let v = view({ pending: { op: 'mode', to: 'auto' } });
    expect(keys(v)).toEqual(['End', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Switching to hands-free', hint: 'Mic off - please wait.', modeDisabled: true });

    v = view({ mode: 'auto', pending: { op: 'mode', to: 'review' }, micOn: true });
    expect(v).toMatchObject({ chip: 'Switching to Manual', hint: 'Please wait.' });

    v = view({ draft: draft('ready', 'x') }, 'listening', { reconnecting: true });
    expect(keys(v)).toEqual(['Discard(off)', 'Send(off)']);
    expect(v).toMatchObject({ chip: 'Reconnecting…', hint: 'Wait before speaking.', modeDisabled: true });
    expect(keys(view({}, 'listening', { reconnecting: true }))).toEqual(['End', 'Talk(off)']);

    v = view({ micError: 'start' });
    expect(keys(v)).toEqual(['End', 'Talk']);
    expect(v).toMatchObject({ hint: "Mic didn't start - tap talk to retry.", mic: 'Mic off' });

    // Never "mic off" while the microphone did not stop, and the draft waits.
    v = view({ micError: 'stop', micOn: true, draft: draft('ready', 'x') });
    expect(keys(v)).toEqual(['Discard', 'Send(off)']);
    expect(v).toMatchObject({ hint: "Mic couldn't stop - end call to stop capture.", mic: 'Mic still on' });
  });

  it('back to auto only without a draft, and why not', () => {
    expect(lib.autoBlock(review())).toBeNull();
    expect(lib.autoBlock(review({ draft: draft('recording') }))).toBe('Tap done, then send or discard.');
    expect(lib.autoBlock(review({ draft: draft('finishing') }))).toBe('Finishing transcript.');
    expect(lib.autoBlock(review({ draft: draft('ready', 'x') }))).toBe('Send or discard before hands-free.');
    expect(lib.autoBlock(review({ draft: draft('ready', 'x', { tooLong: true }) }))).toBe('Discard before hands-free.');
    expect(lib.autoBlock(review({ draft: draft('empty') }))).toBe('Discard before hands-free.');
    expect(lib.autoBlock(review({ draft: draft('failed', 'x') }))).toBe('Discard before hands-free.');
    // A draft leaves the switch usable, so a pick of auto can say why it waits.
    expect(view({ draft: draft('ready', 'x') }).modeDisabled).toBe(false);
    expect(lib.refusalNote('draft_open', 'Andy')).toBe('Send or discard before hands-free.');
    expect(lib.refusalNote('agent_speaking', 'Andy')).toBe('Tap talk when Andy finishes.');
    expect(lib.refusalNote('stale', 'Andy')).toBeNull();
  });

  it('a call that ended with a draft keeps it to read: discard first, nothing to send', () => {
    const v = view({ draft: draft('ready', 'Keep me'), ended: true }, 'ended');
    expect(keys(v)).toEqual(['Discard', 'Send(off)']);
    // The chip says the call ended; the hint does not say it again.
    expect(v).toMatchObject({ chip: 'Call ended', hint: 'Draft not sent. Copy it, or discard it to call again.' });
    expect(v.panel).toMatchObject({ text: 'Keep me', tone: 'draft' });
    expect(v.modeDisabled).toBe(true);
    expect(keys(view({ draft: null, ended: false }, 'ended'))).toEqual(['Call again', 'Talk(off)']);
  });

  it('takes only well-formed worker states', () => {
    expect(lib.isReviewSnapshot({ seq: 1, mode: 'review', draft: null })).toBe(true);
    expect(lib.isReviewSnapshot({ seq: 2, mode: 'auto', draft: { id: 1, state: 'ready', text: 'x' } })).toBe(true);
    expect(lib.isReviewSnapshot({ seq: 1, mode: 'walkie', draft: null })).toBe(false);
    expect(lib.isReviewSnapshot({ mode: 'review', draft: null })).toBe(false);
  });

  it("names the host's wake phrase before the call as configured, Hey <agent> when it has none or does not say", () => {
    const named = (info: unknown) =>
      lib.wakePhraseOf({ ...lib.INITIAL_REVIEW, wakePhrase: lib.infoWakePhrase(info) ?? null }, 'Concierge');
    expect(lib.infoWakePhrase({ agent: 'Concierge', wakePhrase: 'Hey LiveKit' })).toBe('Hey LiveKit');
    expect(named({ agent: 'Concierge', wakePhrase: 'Hey LiveKit' })).toBe('Hey LiveKit');
    // Exactly as configured: the case is kept, and a custom phrase is never title-cased.
    expect(named({ agent: 'Concierge', wakePhrase: 'Hey Casa' })).toBe('Hey Casa');
    expect(named({ agent: 'Concierge', wakePhrase: ' Hey Casa ' })).toBe('Hey Casa');
    expect(named({ agent: 'Concierge', wakePhrase: 'hey jarvis' })).toBe('hey jarvis');
    expect(named({ agent: 'Concierge', wakePhrase: 'OK computer' })).toBe('OK computer');
    expect(lib.infoWakePhrase({ agent: 'Concierge', wakePhrase: null })).toBeNull();
    expect(named({ agent: 'Concierge', wakePhrase: null })).toBe('Hey Concierge');
    // An older host, or a broken answer: undefined, so the page keeps what it had.
    for (const info of [null, 'x', { agent: 'Concierge' }, { wakePhrase: 3 }, { wakePhrase: ' ' }]) {
      expect(lib.infoWakePhrase(info)).toBeUndefined();
    }
  });

  it("auto's readout: send it or a pause sends, and with the wake switch the phrase that opens a turn", () => {
    const listen = (fields: Partial<ReviewState>) =>
      lib.autoListening({ agentName: 'Andy', review: { ...lib.INITIAL_REVIEW, ...fields } });
    expect(listen({ wake: false })).toEqual({
      chip: 'Listening',
      hint: 'Go ahead. Stop for a moment, or say "send it" to send now.',
      empty: 'Speak when ready.',
    });
    // A worker without spoken commands keeps the old copy.
    expect(listen({ commands: false }).hint).toBe('Go ahead. Stop for a moment to send.');
    expect(listen({ wake: true, awaitingWake: true })).toEqual({
      chip: 'Say "Hey Andy"',
      hint: 'Nothing is sent until you say "Hey Andy".',
      empty: 'Say "Hey Andy" to start.',
    });
    // A worker with an acoustic wake word names its phrase instead, as configured.
    expect(listen({ wake: true, awaitingWake: true, wakePhrase: 'Hey LiveKit' })).toEqual({
      chip: 'Say "Hey LiveKit"',
      hint: 'Nothing is sent until you say "Hey LiveKit".',
      empty: 'Say "Hey LiveKit" to start.',
    });
    expect(listen({ wake: true, awaitingWake: true, wakePhrase: 'Hey Casa' }).chip).toBe('Say "Hey Casa"');
    expect(listen({ wake: true, awaitingWake: false })).toMatchObject({
      chip: 'Listening',
      hint: 'Say "send it" to send - stopping won\'t.',
    });
    // The copy never quotes seconds: the countdown shows how long the pause is.
    expect(listen({ wake: true, pauseSends: true }).hint).toBe('Say "send it", or stop for a moment, to send.');
    // A new caller starts hands-free with the wake switch on; the worker's wake state rides on its review state.
    expect(lib.INITIAL_REVIEW).toMatchObject({
      mode: 'auto',
      wake: true,
      pauseSends: false,
      awaitingWake: false,
      commands: true,
      wakePhrase: null,
      wakeHeard: 0,
    });
    expect(
      lib.isReviewSnapshot({ seq: 3, mode: 'auto', draft: null, wake: { on: true, pauseSends: false, waiting: true } }),
    ).toBe(true);
    expect(
      lib.isReviewSnapshot({
        seq: 4,
        mode: 'auto',
        draft: null,
        wake: { on: true, pauseSends: false, waiting: false, heard: 2 },
      }),
    ).toBe(true);
  });

  it('knows the send words the worker takes, in Latin and Cyrillic, as a caption line ends', () => {
    for (const said of [
      'Send it.',
      'sendit',
      'Сенд іт.',
      'Сендіт',
      'Сендип.',
      'Sent it.',
      'Send eat.',
      'Send.',
      'Прийом.',
      'Scratch that.',
      'Discard this turn.',
    ])
      expect(lib.isCommandOnly(said), said).toBe(true);
    expect(lib.lineKey('Book a table for two. Send it.')).toBe('bookatablefortwo');
    expect(lib.lineKey('Скільки я читав? Прийом.')).toBe('скількиячитав');
    // "over" is no longer a command: it stays part of what was said.
    expect(lib.isCommandOnly('Over.')).toBe(false);
    expect(lib.lineKey('Game over')).toBe('gameover');
    expect(lib.isCommandOnly('')).toBe(false);
    expect(lib.isCommandOnly('Book a table.')).toBe(false);
  });

  it('names the turn modes for people and says what each does', () => {
    expect(lib.MODE_NAME).toEqual({ auto: 'hands-free', review: 'Manual' });
    expect(lib.modeCaption('auto', true)).toBe('Stop for a moment, or say "send it", to send.');
    expect(lib.modeCaption('auto', false)).toBe('Stop for a moment to send.');
    expect(lib.modeCaption('review', true)).toBe('Tap talk, read your words, then send.');
    // With the wake switch a pause sends only with the pause switch, as the hint says.
    expect(lib.modeCaption('auto', true, { on: true, pauseSends: false })).toBe('Say "send it" to send.');
    expect(lib.modeCaption('auto', true, { on: true, pauseSends: true })).toBe(
      'Stop for a moment, or say "send it", to send.',
    );
    expect(lib.modeCaption('auto', true, { on: false, pauseSends: false })).toBe(
      'Stop for a moment, or say "send it", to send.',
    );
  });

  it('never names a placeholder agent in the wake switch: no phrase until the line info says one', () => {
    expect(lib.wakeSwitchPhrase(review({ wakePhrase: null }), 'your agent', 'your agent')).toBeNull();
    expect(lib.wakeSwitchPhrase(review({ wakePhrase: null }), 'Dan', 'your agent')).toBe('Hey Dan');
    expect(lib.wakeSwitchPhrase(review({ wakePhrase: 'Hey LiveKit' }), 'your agent', 'your agent')).toBe('Hey LiveKit');
  });

  it('back in hands-free the microphone opens once the worker took it, unless the caller muted it', () => {
    expect(lib.reopensMic({ to: 'auto', taken: true, muted: true, mutedByHand: false })).toBe(true);
    expect(lib.reopensMic({ to: 'auto', taken: true, muted: true, mutedByHand: true })).toBe(false);
    expect(lib.reopensMic({ to: 'auto', taken: false, muted: true, mutedByHand: false })).toBe(false);
    expect(lib.reopensMic({ to: 'review', taken: true, muted: true, mutedByHand: false })).toBe(false);
    expect(lib.reopensMic({ to: 'auto', taken: true, muted: false, mutedByHand: false })).toBe(false);
  });

  it('the call can end while a draft is open, besides its discard and send keys', () => {
    for (const state of ['ready', 'empty', 'failed', 'finishing']) {
      const v = view({ draft: draft(state, 'Words') });
      expect(v.left.action).toBe('discard');
      expect(v.endable).toBe(true);
    }
    expect(view({ draft: null }).endable).toBe(false);
    expect(view({ draft: draft('recording') }).endable).toBe(false);
    expect(view({ draft: draft('ready', 'Keep me'), ended: true }, 'ended').endable).toBe(false);
  });

  it('calls the review mode Manual everywhere a caller or operator reads it', () => {
    const uiSrc = path.join(skillDir, 'ui/src');
    const files = [
      path.join(uiSrc, 'App.tsx'),
      ...['review.ts', 'livekit-call.ts', 'demo-call.ts', 'voice-call.ts'].map((f) => path.join(uiSrc, 'lib', f)),
      path.join(skillDir, 'SKILL.md'),
      path.join(skillDir, 'REMOVE.md'),
      path.resolve(here, 'voice-call-page.ts'),
    ];
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/check[\s-]*first/i);
    expect(readFileSync(path.resolve(here, 'voice-call-page.ts'), 'utf8')).toContain('Manual');
  });

  describe("the caller's remembered picks", () => {
    const fakeStorage = (initial: Record<string, string> = {}) => {
      const items = new Map(Object.entries(initial));
      return {
        items,
        getItem: vi.fn((k: string) => items.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => void items.set(k, v)),
        removeItem: vi.fn((k: string) => void items.delete(k)),
      };
    };
    const withPrefs = (raw: string | undefined) => {
      const store = fakeStorage(raw === undefined ? {} : { 'voice-review-prefs': raw });
      vi.stubGlobal('localStorage', store);
      return store;
    };
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('a new caller starts hands-free with the wake switch on', () => {
      withPrefs(undefined);
      expect(lib.DEFAULT_PREFS).toEqual({ mode: 'auto', wake: true, pauseSends: false });
      expect(lib.storedPrefs()).toEqual({ mode: 'auto', wake: true, pauseSends: false });
    });

    it('a remembered choice wins, a remembered off included; a missing one takes its default', () => {
      withPrefs(JSON.stringify({ mode: 'review', wake: true, pauseSends: true }));
      expect(lib.storedPrefs()).toEqual({ mode: 'review', wake: true, pauseSends: true });
      withPrefs(JSON.stringify({ wake: false }));
      expect(lib.storedPrefs()).toEqual({ mode: 'auto', wake: false, pauseSends: false });
      withPrefs(JSON.stringify({ mode: 'review' }));
      expect(lib.storedPrefs()).toEqual({ mode: 'review', wake: true, pauseSends: false });
    });

    it('corrupt or foreign values read as nothing remembered, each on its own', () => {
      for (const raw of ['{not json', 'null', '"auto"', '42', '[]']) {
        withPrefs(raw);
        expect(lib.storedPrefs(), raw).toEqual(lib.DEFAULT_PREFS);
      }
      withPrefs(JSON.stringify({ mode: 'walkie', wake: 'no', pauseSends: 1 }));
      expect(lib.storedPrefs()).toEqual(lib.DEFAULT_PREFS);
      withPrefs(JSON.stringify({ mode: 'walkie', wake: false }));
      expect(lib.storedPrefs()).toEqual({ mode: 'auto', wake: false, pauseSends: false });
    });

    it('blocked or missing storage reads the defaults and never throws on a write', () => {
      const blocked = () => {
        throw new Error('SecurityError');
      };
      vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
      expect(lib.storedPrefs()).toEqual(lib.DEFAULT_PREFS);
      expect(() => lib.storePrefs({ mode: 'review', wake: false, pauseSends: false })).not.toThrow();
      expect(lib.storedWakePhrase()).toBeNull();
      expect(() => lib.storeWakePhrase('Hey LiveKit')).not.toThrow();
      vi.stubGlobal('localStorage', undefined);
      expect(lib.storedPrefs()).toEqual(lib.DEFAULT_PREFS);
      expect(() => lib.storePrefs(lib.DEFAULT_PREFS)).not.toThrow();
    });

    it('keeps exactly the three picks, and reads back what it kept', () => {
      const store = withPrefs(undefined);
      lib.storePrefs({ mode: 'review', wake: false, pauseSends: true, extra: 1 } as Prefs);
      expect(JSON.parse(store.items.get('voice-review-prefs') ?? '')).toEqual({
        mode: 'review',
        wake: false,
        pauseSends: true,
      });
      expect(lib.storedPrefs()).toEqual({ mode: 'review', wake: false, pauseSends: true });
    });

    it('settings the worker did not take fall back to what it runs, and are never remembered', () => {
      const store = withPrefs(JSON.stringify({ mode: 'auto', wake: false, pauseSends: false }));
      expect(lib.settingsNotTaken({ on: false, pauseSends: true })).toEqual({
        wake: false,
        pauseSends: true,
        note: "Settings didn't reach the call - try again.",
      });
      // A worker that has not said yet starts waiting for the wake phrase.
      expect(lib.settingsNotTaken(undefined)).toMatchObject({ wake: true, pauseSends: false });
      expect(store.setItem).not.toHaveBeenCalled();
      expect(lib.storedPrefs()).toEqual({ mode: 'auto', wake: false, pauseSends: false });
    });

    it('a fresh phrase replaces a stale stored one, case and all', () => {
      const store = fakeStorage({ 'voice-wake-phrase': 'hey livekit' });
      vi.stubGlobal('localStorage', store);
      expect(lib.storedWakePhrase()).toBe('hey livekit');
      const fresh = lib.infoWakePhrase({ agent: 'Andy', wakePhrase: 'Hey LiveKit' });
      lib.storeWakePhrase(fresh ?? null);
      expect(lib.storedWakePhrase()).toBe('Hey LiveKit');
      lib.storeWakePhrase('Hey Casa');
      expect(lib.storedWakePhrase()).toBe('Hey Casa');
      // No acoustic phrase on this line: the page names Hey <agent> again.
      lib.storeWakePhrase(null);
      expect(lib.storedWakePhrase()).toBeNull();
      expect(lib.wakePhraseOf({ ...lib.INITIAL_REVIEW, wakePhrase: lib.storedWakePhrase() }, 'Andy')).toBe('Hey Andy');
    });
  });
  it("the page's command words are the worker's, on the same commands vocabulary", () => {
    // How the transcription writes each one; every page word needs a spelling here.
    const spoken: Array<[string, SpokenCommand]> = [
      ['Send it.', 'send'],
      ['Sent it.', 'send'],
      ['Send eat.', 'send'],
      ['Sendit.', 'send'],
      ['Send.', 'send'],
      ['Сенд іт.', 'send'],
      ['Сендіт.', 'send'],
      ['Сендит.', 'send'],
      ['Сендіп.', 'send'],
      ['Сендип.', 'send'],
      ['Сенд.', 'send'],
      ['Прийом.', 'send'],
      ['Приём.', 'send'],
      ['Discard this turn.', 'discard'],
      ['Discard turn.', 'discard'],
      ['Scratch that.', 'discard'],
    ];
    const covered = new Set(spoken.map(([text]) => lib.norm(text)));
    for (const word of [...lib.SEND_WORDS, ...lib.DISCARD_PHRASES]) expect(covered, word).toContain(word);
    for (const [text, command] of spoken) {
      expect(lib.isCommandOnly(text), text).toBe(true);
      expect(lib.endsInDiscard(text), text).toBe(command === 'discard');
      expect(matchCommand(text), text).toEqual({ command, rest: '' });
    }
    // Not a command for either: words before or after it.
    for (const text of ['Send it to Anna.', 'Scratch that idea.']) {
      expect(lib.isCommandOnly(text), text).toBe(false);
      expect(matchCommand(text), text).toBeNull();
    }
    expect(lib.COMMANDS_VERSION).toBe(CALL_COMMANDS_VERSION);
  });
});
