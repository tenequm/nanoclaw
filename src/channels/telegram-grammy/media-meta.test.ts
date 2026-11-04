/**
 * probeMediaMeta degradation contract.
 *
 * sendVideo / sendAnimation / sendAudio / sendVoice / InputMediaVideo all
 * spread `meta ?? {}` — the entire wiring assumes probeMediaMeta NEVER
 * throws and returns null when it can't read the file. If that contract
 * ever breaks (e.g. a mediabunny upgrade starts throwing on truncated
 * input), every media send in the telegram-grammy adapter would crash
 * the delivery loop. This test pins the contract.
 */
import { describe, expect, it } from 'vitest';

import { probeMediaMeta } from './media-meta.js';

describe('probeMediaMeta', () => {
  it('returns null on empty buffer', async () => {
    expect(await probeMediaMeta(Buffer.alloc(0))).toBeNull();
  });

  it('returns null on garbage bytes', async () => {
    expect(await probeMediaMeta(Buffer.from('not a video, just text'))).toBeNull();
  });

  it('returns null on truncated mp4 header', async () => {
    // Plausible-looking ftyp box (mp4 magic) followed by nothing — should
    // make the parser fail mid-stream, not throw out of the function.
    const truncated = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(await probeMediaMeta(truncated)).toBeNull();
  });
});
