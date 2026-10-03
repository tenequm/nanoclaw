/**
 * The call page's review mode view (`ui/src/lib/review.ts`): keys, readout and draft panel for
 * every review state (SKILL.md's review mode section). It lives in the maintainer build tree, which an
 * installed payload does not carry, so these tests run only where it is.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewLib = path.resolve(here, '../../.claude/skills/add-voice-mode/ui/src/lib/review.ts');

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
};
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
  keyIdentity(action: string | null, draftId?: number): string;
  autoListening(input: { agentName: string; silenceMs: number | null; review: ReviewState }): {
    chip: string;
    hint: string;
    empty: string;
  };
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
      hint: 'Pauses stay here - tap done to review.',
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
    expect(v.panel?.title).toBe('draft too long');
  });

  it('the agent speaking: talk waits, a draft can still be sent as a follow-up', () => {
    let v = view({}, 'talking');
    expect(keys(v)).toEqual(['End', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Andy is speaking', hint: 'Tap talk when Andy finishes.' });

    v = view({ draft: draft('empty') }, 'talking');
    expect(keys(v)).toEqual(['Discard', 'Talk(off)']);

    v = view({ draft: draft('ready', 'Also this', { reason: 'agent' }) }, 'talking');
    expect(keys(v)).toEqual(['Discard', 'Send']);
    expect(v).toMatchObject({ chip: 'Andy is speaking', hint: 'Send adds a follow-up.' });
    expect(v.panel?.note).toBe('Andy started speaking - review what was heard');

    v = view({ draft: draft('finishing') }, 'talking');
    expect(keys(v)).toEqual(['Discard', 'Send(off)']);
    expect(v.hint).toBe('Mic off - nothing sent.');
  });

  it('the agent working: talk adds a follow-up, recording and drafts say so', () => {
    expect(view({}, 'thinking', { waited: 12 })).toMatchObject({
      chip: 'Andy is working',
      hint: 'Tap talk to add a follow-up · waiting 0:12',
    });
    expect(keys(view({}, 'thinking'))).toEqual(['End', 'Talk']);
    const rec = view({ draft: draft('recording'), micOn: true }, 'thinking');
    expect(keys(rec)).toEqual(['End', 'Done']);
    expect(rec.hint).toBe('Recording - tap done to review.');
    expect(view({ draft: draft('ready', 'x') }, 'thinking').hint).toBe('Send adds a follow-up.');
  });

  it('switching, reconnecting and microphone failures override the routine state', () => {
    let v = view({ pending: { op: 'mode', to: 'auto' } });
    expect(keys(v)).toEqual(['End', 'Talk(off)']);
    expect(v).toMatchObject({ chip: 'Switching to auto', hint: 'Mic off - please wait.', modeDisabled: true });

    v = view({ mode: 'auto', pending: { op: 'mode', to: 'review' }, micOn: true });
    expect(v).toMatchObject({ chip: 'Switching to review', hint: 'Please wait.' });

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
    expect(lib.autoBlock(review({ draft: draft('ready', 'x') }))).toBe('Send or discard before auto.');
    expect(lib.autoBlock(review({ draft: draft('ready', 'x', { tooLong: true }) }))).toBe('Discard before auto.');
    expect(lib.autoBlock(review({ draft: draft('empty') }))).toBe('Discard before auto.');
    expect(lib.autoBlock(review({ draft: draft('failed', 'x') }))).toBe('Discard before auto.');
    // A draft leaves the switch usable, so a pick of auto can say why it waits.
    expect(view({ draft: draft('ready', 'x') }).modeDisabled).toBe(false);
    expect(lib.refusalNote('draft_open', 'Andy')).toBe('Send or discard before auto.');
    expect(lib.refusalNote('agent_speaking', 'Andy')).toBe('Tap talk when Andy finishes.');
    expect(lib.refusalNote('stale', 'Andy')).toBeNull();
  });

  it('a call that ended with a draft keeps it to read: discard first, nothing to send', () => {
    const v = view({ draft: draft('ready', 'Keep me'), ended: true }, 'ended');
    expect(keys(v)).toEqual(['Discard', 'Send(off)']);
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

  it("auto's readout: over or a pause sends, and with the wake switch the phrase that opens a turn", () => {
    const listen = (fields: Partial<ReviewState>, silenceMs: number | null = 2500) =>
      lib.autoListening({ agentName: 'Andy', silenceMs, review: { ...lib.INITIAL_REVIEW, ...fields } });
    expect(listen({})).toEqual({
      chip: 'Listening',
      hint: 'Go ahead. Pause about 2.5 s or say "over" to send.',
      empty: 'Speak when ready.',
    });
    // A worker without spoken commands keeps the old copy.
    expect(listen({ commands: false }).hint).toBe('Go ahead. Pause about 2.5 s to send.');
    expect(listen({ wake: true, awaitingWake: true })).toEqual({
      chip: 'Say "hey Andy"',
      hint: 'Nothing is sent until you say "hey Andy".',
      empty: 'Say "hey Andy" to start.',
    });
    // A worker with an acoustic wake word names its phrase instead.
    expect(listen({ wake: true, awaitingWake: true, wakePhrase: 'hey livekit' })).toEqual({
      chip: 'Say "hey livekit"',
      hint: 'Nothing is sent until you say "hey livekit".',
      empty: 'Say "hey livekit" to start.',
    });
    expect(listen({ wake: true, awaitingWake: false })).toMatchObject({
      chip: 'Listening',
      hint: 'Say "over" to send - pauses don\'t.',
    });
    expect(listen({ wake: true, pauseSends: true }).hint).toBe('Say "over" or pause about 2.5 s to send.');
    expect(listen({ wake: true, pauseSends: true }, null).hint).toBe('Say "over" or pause to send.');
    // The switch's picks start off; the worker's wake state rides on its review state.
    expect(lib.INITIAL_REVIEW).toMatchObject({
      wake: false,
      pauseSends: false,
      awaitingWake: false,
      commands: true,
      wakePhrase: null,
    });
    expect(
      lib.isReviewSnapshot({ seq: 3, mode: 'auto', draft: null, wake: { on: true, pauseSends: false, waiting: true } }),
    ).toBe(true);
  });
});
