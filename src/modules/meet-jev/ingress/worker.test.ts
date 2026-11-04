import { describe, expect, it } from 'vitest';

import { createWorkerIngress, parseWorkerEvent } from './worker.js';

const CALLER = { id: 'caller', name: 'Ethan' };

describe('worker ingress', () => {
  it('maps the worker events to CallEvents from the caller, in order', () => {
    const ingress = createWorkerIngress({ name: 'Ethan' }, 1024);
    const { events, dropped } = ingress.convert(
      [
        { type: 'speech', on: true, at: 1000 },
        { type: 'utterance', uttId: 'u1', text: 'Dan, what', final: false, at: 1200 },
        { type: 'utterance', uttId: 'u1', text: 'Dan, what time is it?', final: true, at: 1500 },
        { type: 'speech', on: false, at: 1600 },
        { type: 'playback', replyId: 'r1', state: 'cut_off', delivered: 'It is', at: 1700 },
        { type: 'playback', replyId: 'r2', state: 'completed', at: 1800 },
      ],
      1800,
    );
    expect(dropped).toBe(0);
    expect(events).toEqual([
      { kind: 'speech', speaker: CALLER, on: true, at: 1000 },
      { kind: 'utterance', speaker: CALLER, uttId: 'u1', text: 'Dan, what', final: false, at: 1200 },
      { kind: 'utterance', speaker: CALLER, uttId: 'u1', text: 'Dan, what time is it?', final: true, at: 1500 },
      { kind: 'speech', speaker: CALLER, on: false, at: 1600 },
      { kind: 'playback', replyId: 'r1', state: 'cut_off', delivered: 'It is', at: 1700 },
      { kind: 'playback', replyId: 'r2', state: 'completed', at: 1800 },
    ]);
  });

  it('moves worker times onto the host clock by the smallest gap seen, never past arrival', () => {
    const ingress = createWorkerIngress({ name: 'Ethan' }, 1024);
    // The worker's clock runs 5 s behind; this batch took 40 ms to arrive.
    const first = ingress.convert(
      [
        { type: 'speech', on: true, at: 10_000 },
        { type: 'speech', on: false, at: 10_500 },
      ],
      15_540,
    );
    expect(first.events.map((e) => e.at)).toEqual([15_040, 15_540]);
    // A slower POST keeps the better estimate; a faster one improves it.
    expect(ingress.convert([{ type: 'speech', on: true, at: 11_000 }], 16_300).events[0].at).toBe(16_040);
    expect(ingress.convert([{ type: 'speech', on: false, at: 12_000 }], 17_010).events[0].at).toBe(17_010);
    expect(ingress.convert([{ type: 'speech', on: true, at: 11_500 }], 17_100).events[0].at).toBe(16_510);
  });

  it('skips and counts malformed events', () => {
    const ingress = createWorkerIngress({ name: 'Ethan' }, 8);
    const { events, dropped } = ingress.convert(
      [
        null,
        'speech',
        [],
        { type: 'speech', on: 'yes', at: 1 },
        { type: 'speech', on: true },
        { type: 'speech', on: true, at: Number.NaN },
        { type: 'utterance', uttId: '', text: 'hi', final: true, at: 1 },
        { type: 'utterance', uttId: 'x'.repeat(65), text: 'hi', final: true, at: 1 },
        { type: 'utterance', uttId: 'u', text: 'too long text', final: true, at: 1 },
        { type: 'utterance', uttId: 'u', text: 'hi', at: 1 },
        { type: 'playback', replyId: 'r', state: 'paused', at: 1 },
        { type: 'playback', replyId: 'r', state: 'cut_off', delivered: 42, at: 1 },
        { type: 'turn', at: 1 },
        { type: 'utterance', uttId: 'u', text: 'ok', final: true, at: 1 },
      ],
      1,
    );
    expect(dropped).toBe(13);
    expect(events).toEqual([{ kind: 'utterance', speaker: CALLER, uttId: 'u', text: 'ok', final: true, at: 1 }]);
  });

  it('bounds text by UTF-8 bytes', () => {
    expect(parseWorkerEvent({ type: 'utterance', uttId: 'u', text: 'яя', final: true, at: 1 }, 4)).not.toBeNull();
    expect(parseWorkerEvent({ type: 'utterance', uttId: 'u', text: 'яяя', final: true, at: 1 }, 4)).toBeNull();
  });
});
