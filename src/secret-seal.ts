/**
 * Seal small secrets the host must show again later (a voice call link) under one host-wide key,
 * `NANOCLAW_ENCRYPTION_KEY` in `.env`: 32 random bytes as canonical base64 (`openssl rand -base64 32`).
 * AES-256-GCM with a fresh 12-byte nonce per seal, as `v1:<base64(nonce | tag | ciphertext)>`; the
 * `context` (what the value is and which row holds it) is authenticated, so a sealed value copied to
 * another row or feature does not open.
 *
 * The key is read with the host's `.env` reader, never from or into `process.env`, so containers and
 * the voice worker never see it. A missing or malformed key only disables what needs it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { envValue } from './env.js';
import { log } from './log.js';

const ENCRYPTION_KEY_ENV = 'NANOCLAW_ENCRYPTION_KEY';

const VERSION = 'v1:';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The key from its `.env` value, or null unless it is exactly 32 bytes in canonical base64. */
export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 && key.toString('base64') === raw ? key : null;
}

let loaded: { key: Buffer | null } | undefined;

/** The host's key, read once per process; null (logged once) when it is missing or malformed. */
export function encryptionKey(): Buffer | null {
  if (!loaded) {
    const raw = envValue(ENCRYPTION_KEY_ENV);
    loaded = { key: parseEncryptionKey(raw) };
    if (!loaded.key) {
      log.warn(
        raw
          ? `${ENCRYPTION_KEY_ENV} is not 32 bytes of canonical base64; sealed storage is off`
          : `${ENCRYPTION_KEY_ENV} is not set; sealed storage is off`,
      );
    }
  }
  return loaded.key;
}

/** Seal `text` for `context` (e.g. `voice-link:<line id>`). */
export function sealText(text: string, context: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return VERSION + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
}

/** The text sealed for `context`, or null for any other version, context or key, or a damaged value. */
export function openSealed(sealed: string, context: string, key: Buffer): string | null {
  const body = sealed.slice(VERSION.length);
  if (!sealed.startsWith(VERSION) || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const raw = Buffer.from(body, 'base64');
  if (raw.length < NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
