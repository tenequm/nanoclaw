/**
 * Guards for the add-pond host-side integration (.claude/skills/add-pond):
 *
 * 1. Behavior of `pondMounts` — the skill's own mount policy: own store
 *    always, shared/operator stores only with an explicit access.json grant,
 *    everything read-only. This is what keeps cross-group recall opt-in.
 * 2. Structural guard for the `buildMounts` reach-in — the single
 *    `mounts.push(...pondMounts(...))` call. `buildMounts` composes group
 *    files and skill symlinks as side effects, so it is not invoked here;
 *    the call's presence is asserted on the source instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pondMounts } from './pond-mounts.js';

function makeDataDir(structure: { ownStoreFor?: string; shared?: boolean; access?: object }): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-mounts-'));
  if (structure.ownStoreFor) {
    fs.mkdirSync(path.join(dataDir, 'pond', 'groups', structure.ownStoreFor), { recursive: true });
  }
  if (structure.shared) {
    fs.mkdirSync(path.join(dataDir, 'pond', 'shared'), { recursive: true });
  }
  if (structure.access) {
    fs.mkdirSync(path.join(dataDir, 'pond'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'pond', 'access.json'), JSON.stringify(structure.access));
  }
  return dataDir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pondMounts', () => {
  it('returns no mounts when no store exists', () => {
    const dataDir = makeDataDir({});
    expect(pondMounts('g1', dataDir)).toEqual([]);
  });

  it('mounts the own store read-only when it exists', () => {
    const dataDir = makeDataDir({ ownStoreFor: 'g1' });
    const mounts = pondMounts('g1', dataDir);
    const own = mounts.find((m) => m.containerPath === '/workspace/extra/pond/own');
    expect(own).toBeDefined();
    expect(own?.readonly).toBe(true);
    expect(own?.hostPath).toBe(path.join(dataDir, 'pond', 'groups', 'g1'));
  });

  it("never mounts another group's store", () => {
    const dataDir = makeDataDir({ ownStoreFor: 'g1' });
    expect(pondMounts('g2', dataDir)).toEqual([]);
  });

  it('mounts the shared store only for groups granted in access.json', () => {
    const dataDir = makeDataDir({
      ownStoreFor: 'g1',
      shared: true,
      access: { shared: { groups: ['g1'] } },
    });
    const granted = pondMounts('g1', dataDir);
    expect(granted.some((m) => m.containerPath === '/workspace/extra/pond/shared')).toBe(true);
    expect(granted.every((m) => m.readonly)).toBe(true);

    const denied = pondMounts('g2', dataDir);
    expect(denied.some((m) => m.containerPath === '/workspace/extra/pond/shared')).toBe(false);
  });

  it('withholds the shared store when access.json is absent', () => {
    const dataDir = makeDataDir({ ownStoreFor: 'g1', shared: true });
    const mounts = pondMounts('g1', dataDir);
    expect(mounts.some((m) => m.containerPath === '/workspace/extra/pond/shared')).toBe(false);
  });

  it('mounts an operator store only for granted groups', () => {
    const operatorStore = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-operator-'));
    const dataDir = makeDataDir({
      ownStoreFor: 'g1',
      access: { operator: { path: operatorStore, groups: ['g1'] } },
    });
    const granted = pondMounts('g1', dataDir);
    const operator = granted.find((m) => m.containerPath === '/workspace/extra/pond/operator');
    expect(operator).toBeDefined();
    expect(operator?.readonly).toBe(true);

    const denied = pondMounts('g2', dataDir);
    expect(denied.some((m) => m.containerPath === '/workspace/extra/pond/operator')).toBe(false);
  });

  it('adds the embedding-model cache mount when the host cache exists', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-home-'));
    const modelDir = path.join(fakeHome, '.cache', 'huggingface', 'hub', 'models--intfloat--multilingual-e5-small');
    fs.mkdirSync(modelDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const dataDir = makeDataDir({ ownStoreFor: 'g1' });
    const mounts = pondMounts('g1', dataDir);
    const model = mounts.find((m) => m.hostPath === modelDir);
    expect(model).toBeDefined();
    expect(model?.readonly).toBe(true);
    // Only the one model directory — never the whole HF cache (token leak).
    expect(model?.containerPath).toContain('models--intfloat--multilingual-e5-small');
  });
});

describe('buildMounts wiring (structural)', () => {
  it('container-runner.ts pushes pondMounts into the mount list', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'container-runner.ts'), 'utf8');
    expect(src).toMatch(/mounts\.push\(\.\.\.pondMounts\(/);
  });
});
