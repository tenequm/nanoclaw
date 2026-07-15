/**
 * Guards for the add-pond host-side integration (.claude/skills/add-pond):
 *
 * 1. Behavior of `pondStoreMounts`: the skill's own mount policy: a store
 *    is mounted read-only iff the group is on that store's `read` list, the
 *    store is local, and its directory exists. `ingest` membership grants
 *    nothing here: that separation is what lets a group feed a store it
 *    cannot search.
 * 2. Structural guard for the `buildMounts` reach-in: the single
 *    `mounts.push(...pondStoreMounts(...))` call. `buildMounts` composes
 *    group files and skill symlinks as side effects, so it is not invoked
 *    here; the call's presence is asserted on the source instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pondStoreMounts } from './pond-stores.js';

interface StoreFixture {
  backend?: string;
  ingest?: string[];
  read?: string[];
  createDir?: boolean;
}

function makeDataDir(stores: Record<string, StoreFixture>): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-stores-'));
  const pondDir = path.join(dataDir, 'pond');
  fs.mkdirSync(pondDir, { recursive: true });
  const config: Record<string, object> = {};
  for (const [name, s] of Object.entries(stores)) {
    config[name] = { backend: s.backend, ingest: s.ingest, read: s.read };
    if (s.createDir !== false && (!s.backend || s.backend === 'local')) {
      fs.mkdirSync(path.join(pondDir, 'stores', name), { recursive: true });
    }
  }
  fs.writeFileSync(path.join(pondDir, 'stores.json'), JSON.stringify({ stores: config }));
  return dataDir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pondStoreMounts', () => {
  it('returns no mounts when stores.json is absent', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-stores-'));
    expect(pondStoreMounts('g1', dataDir)).toEqual([]);
  });

  it('mounts a local store read-only for a read-granted group', () => {
    const dataDir = makeDataDir({ mychat: { ingest: ['g1'], read: ['g1'] } });
    const mounts = pondStoreMounts('g1', dataDir);
    const store = mounts.find((m) => m.containerPath === '/workspace/extra/pond/mychat');
    expect(store).toBeDefined();
    expect(store?.readonly).toBe(true);
    expect(store?.hostPath).toBe(path.join(dataDir, 'pond', 'stores', 'mychat'));
  });

  it('grants nothing to a group that is not on the read list', () => {
    const dataDir = makeDataDir({ mychat: { ingest: ['g1'], read: ['g1'] } });
    expect(pondStoreMounts('g2', dataDir)).toEqual([]);
  });

  it('ingest membership alone grants no mount', () => {
    // g2 feeds the store but only g1 may search it: the librarian pattern.
    const dataDir = makeDataDir({ team: { ingest: ['g1', 'g2'], read: ['g1'] } });
    expect(pondStoreMounts('g2', dataDir)).toEqual([]);
    expect(pondStoreMounts('g1', dataDir).some((m) => m.containerPath === '/workspace/extra/pond/team')).toBe(true);
  });

  it('never mounts a remote-backend store, even for read-granted groups', () => {
    const dataDir = makeDataDir({
      archive: { backend: 's3+https://example.com/bucket/prefix', ingest: ['g1'], read: ['g1'] },
    });
    expect(pondStoreMounts('g1', dataDir)).toEqual([]);
  });

  it('skips a granted store whose directory does not exist yet', () => {
    const dataDir = makeDataDir({ mychat: { ingest: ['g1'], read: ['g1'], createDir: false } });
    expect(pondStoreMounts('g1', dataDir)).toEqual([]);
  });

  it('adds the embedding-model cache mount when the host cache exists', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-home-'));
    const modelDir = path.join(fakeHome, '.cache', 'huggingface', 'hub', 'models--intfloat--multilingual-e5-small');
    fs.mkdirSync(modelDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const dataDir = makeDataDir({ mychat: { ingest: ['g1'], read: ['g1'] } });
    const mounts = pondStoreMounts('g1', dataDir);
    const model = mounts.find((m) => m.hostPath === modelDir);
    expect(model).toBeDefined();
    expect(model?.readonly).toBe(true);
    // Only the one model directory: never the whole HF cache (token leak).
    expect(model?.containerPath).toContain('models--intfloat--multilingual-e5-small');
  });
});

describe('buildMounts wiring (structural)', () => {
  it('container-runner.ts pushes pondStoreMounts into the mount list', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'container-runner.ts'), 'utf8');
    expect(src).toMatch(/mounts\.push\(\.\.\.pondStoreMounts\(/);
  });
});
