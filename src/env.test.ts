import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envValue, readEnvFile } from './env.js';

/**
 * `envValue` is the single-key form of `readEnvFile` — same file, same parser,
 * same rules. These pin that equivalence, because the reason it exists is that
 * a second hand-rolled parser drifted from this one on quoted values.
 */
describe('envValue', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (content: string): void => fs.writeFileSync(path.join(root, '.env'), content);

  it('strips surrounding quotes, exactly as readEnvFile does', () => {
    write('TZ="America/New_York"\nPLAIN=bare\nSINGLE=\'quoted\'\n');
    expect(envValue('TZ', root)).toBe('America/New_York');
    expect(envValue('PLAIN', root)).toBe('bare');
    expect(envValue('SINGLE', root)).toBe('quoted');
    for (const key of ['TZ', 'PLAIN', 'SINGLE']) {
      expect(envValue(key, root)).toBe(readEnvFile([key], root)[key]);
    }
  });

  it('preserves a quoted value that contains spaces', () => {
    write('TEMPLATE_PATH="/opt/my templates"\n');
    expect(envValue('TEMPLATE_PATH', root)).toBe('/opt/my templates');
  });

  it('returns undefined for a missing key, an empty value, and a missing file', () => {
    write('SET=value\nEMPTY=\n# COMMENT=no\n');
    expect(envValue('ABSENT', root)).toBeUndefined();
    expect(envValue('EMPTY', root)).toBeUndefined();
    expect(envValue('COMMENT', root)).toBeUndefined();
    expect(envValue('SET', path.join(root, 'nowhere'))).toBeUndefined();
  });

  it('keeps = inside the value', () => {
    write('TOKEN=abc=def==\n');
    expect(envValue('TOKEN', root)).toBe('abc=def==');
  });
});

describe('NANOCLAW_ENV_OVERLAY', () => {
  let root: string;
  let cwd: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-overlay-'));
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  });

  afterEach(() => {
    cwd.mockRestore();
    delete process.env.NANOCLAW_ENV_OVERLAY;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("wins over the process's own .env, key by key, and leaves other keys to .env", () => {
    fs.writeFileSync(path.join(root, '.env'), 'LIVEKIT_URL=wss://old\nLIVEKIT_HOST_URL=http://127.0.0.1:3001\n');
    const overlay = path.join(root, 'overlay.env');
    fs.writeFileSync(overlay, 'LIVEKIT_URL="wss://new.livekit.cloud"\n');
    process.env.NANOCLAW_ENV_OVERLAY = overlay;
    expect(readEnvFile(['LIVEKIT_URL', 'LIVEKIT_HOST_URL'])).toEqual({
      LIVEKIT_URL: 'wss://new.livekit.cloud',
      LIVEKIT_HOST_URL: 'http://127.0.0.1:3001',
    });
    expect(envValue('LIVEKIT_URL')).toBe('wss://new.livekit.cloud');
  });

  it("does not apply to another checkout's .env, and a missing overlay file changes nothing", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-other-'));
    try {
      fs.writeFileSync(path.join(other, '.env'), 'LIVEKIT_URL=wss://other\n');
      const overlay = path.join(root, 'overlay.env');
      fs.writeFileSync(overlay, 'LIVEKIT_URL=wss://new\n');
      process.env.NANOCLAW_ENV_OVERLAY = overlay;
      expect(envValue('LIVEKIT_URL', other)).toBe('wss://other');
      process.env.NANOCLAW_ENV_OVERLAY = path.join(root, 'missing.env');
      expect(envValue('LIVEKIT_URL', other)).toBe('wss://other');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

// The guard lives in src/test-setup.ts. A real .env already in the checkout is
// never overwritten: then the test proves it is invisible without planting.
describe('test-setup guard on the checkout .env', () => {
  it('hides <cwd>/.env from readEnvFile and config.ts, reads a temp-dir .env', async () => {
    const repoEnv = path.join(process.cwd(), '.env');
    let planted = false;
    try {
      fs.writeFileSync(repoEnv, 'JEV_MODEL=planted-in-repo\n', { flag: 'wx' });
      planted = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      expect(fs.existsSync(repoEnv)).toBe(false);
      expect(() => fs.readFileSync(repoEnv, 'utf-8')).toThrow(/ENOENT/);
      expect(readEnvFile(['JEV_MODEL'])).toEqual({});
      vi.resetModules();
      expect((await import('./config.js')).JEV_MODEL).not.toBe('planted-in-repo');

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
      try {
        fs.writeFileSync(path.join(tmp, '.env'), 'JEV_MODEL=from-temp\n');
        expect(readEnvFile(['JEV_MODEL'], tmp)).toEqual({ JEV_MODEL: 'from-temp' });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      if (planted) fs.rmSync(repoEnv);
    }
  });
});
