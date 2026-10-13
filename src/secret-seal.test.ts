import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { openSealed, parseEncryptionKey, sealText } from './secret-seal.js';

const key = randomBytes(32);

describe('parseEncryptionKey', () => {
  it('takes exactly 32 bytes in canonical base64 and nothing else', () => {
    const raw = key.toString('base64');
    expect(parseEncryptionKey(raw)?.equals(key)).toBe(true);
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(parseEncryptionKey('')).toBeNull();
    expect(parseEncryptionKey(randomBytes(31).toString('base64'))).toBeNull();
    expect(parseEncryptionKey(randomBytes(33).toString('base64'))).toBeNull();
    expect(parseEncryptionKey(key.toString('base64url'))).toBeNull();
    expect(parseEncryptionKey(raw.slice(0, -1))).toBeNull();
    expect(parseEncryptionKey(` ${raw}`)).toBeNull();
    expect(parseEncryptionKey('correct horse battery staple')).toBeNull();
    // Same bytes, but a non-zero padding bit: not the canonical spelling.
    const last = raw.at(-2)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const sloppy = raw.slice(0, -2) + alphabet[alphabet.indexOf(last) | 1] + '=';
    if (sloppy !== raw) expect(parseEncryptionKey(sloppy)).toBeNull();
  });
});

describe('sealText / openSealed', () => {
  it('round-trips, with a fresh nonce every time', () => {
    const a = sealText('secret', 'voice-link:abc', key);
    const b = sealText('secret', 'voice-link:abc', key);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret');
    expect(openSealed(a, 'voice-link:abc', key)).toBe('secret');
    expect(openSealed(b, 'voice-link:abc', key)).toBe('secret');
  });

  it('opens nothing under another key, another context, a tampered value or another version', () => {
    const sealed = sealText('secret', 'voice-link:abc', key);
    expect(openSealed(sealed, 'voice-link:abc', randomBytes(32))).toBeNull();
    expect(openSealed(sealed, 'voice-link:abd', key)).toBeNull();
    const raw = Buffer.from(sealed.slice(3), 'base64');
    for (const at of [0, 12, 28, raw.length - 1]) {
      const bent = Buffer.from(raw);
      bent[at] ^= 1;
      expect(openSealed(`v1:${bent.toString('base64')}`, 'voice-link:abc', key)).toBeNull();
    }
    expect(openSealed(`v1:${raw.subarray(0, 27).toString('base64')}`, 'voice-link:abc', key)).toBeNull();
    expect(openSealed(`v2:${raw.toString('base64')}`, 'voice-link:abc', key)).toBeNull();
    expect(openSealed('', 'voice-link:abc', key)).toBeNull();
  });
});

describe('encryptionKey', () => {
  async function keyFrom(raw: string | undefined) {
    vi.resetModules();
    vi.doMock('./env.js', () => ({
      readEnvFile: () => ({}),
      envValue: (k: string) => (k === 'NANOCLAW_ENCRYPTION_KEY' ? raw : undefined),
    }));
    const mod = await import('./secret-seal.js');
    const { log: freshLog } = await import('./log.js');
    vi.mocked(freshLog.warn).mockClear();
    return { first: mod.encryptionKey(), second: mod.encryptionKey(), warns: vi.mocked(freshLog.warn).mock.calls };
  }

  it('reads a valid key without a warning', async () => {
    const valid = await keyFrom(key.toString('base64'));
    expect(valid.first?.equals(key)).toBe(true);
    expect(valid.warns).toEqual([]);
  });

  it('turns sealed storage off, warning once and never with the value, for a missing or malformed key', async () => {
    const missing = await keyFrom(undefined);
    expect([missing.first, missing.second]).toEqual([null, null]);
    expect(missing.warns).toEqual([['NANOCLAW_ENCRYPTION_KEY is not set; sealed storage is off']]);
    const malformed = await keyFrom('not-a-key-value');
    expect([malformed.first, malformed.second]).toEqual([null, null]);
    expect(malformed.warns).toHaveLength(1);
    expect(JSON.stringify(malformed.warns)).not.toContain('not-a-key-value');
  });
});
