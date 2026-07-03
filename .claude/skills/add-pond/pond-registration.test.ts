/**
 * Guards for the add-pond container-side integration (.claude/skills/add-pond):
 *
 * 1. Behavior of `pondMcpServers` — one stdio server per mounted store, with
 *    the env pond needs to serve read-only off an offline, read-only mount.
 * 2. Structural guard for the `index.ts` reach-in — the registration call
 *    lives inside `main()`, which spawns the whole agent loop, so the call's
 *    presence is asserted on the source instead of by invocation.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { pondMcpServers } from './pond-mcp.js';

describe('pondMcpServers', () => {
  it('registers nothing when no store is mounted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-root-'));
    expect(Object.keys(pondMcpServers(root))).toEqual([]);
  });

  it('registers one server per mounted store, pointed at that store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-root-'));
    fs.mkdirSync(path.join(root, 'own'));
    fs.mkdirSync(path.join(root, 'shared'));

    const servers = pondMcpServers(root);
    expect(Object.keys(servers).sort()).toEqual(['pond', 'pond_shared']);
    expect(servers.pond.command).toBe('/usr/local/bin/pond');
    expect(servers.pond.args).toEqual(['mcp']);
    expect(servers.pond.env.POND_STORAGE_PATH).toBe(path.join(root, 'own'));
    expect(servers.pond_shared.env.POND_STORAGE_PATH).toBe(path.join(root, 'shared'));
  });

  it('keeps pond state writes off the read-only store mount', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-root-'));
    fs.mkdirSync(path.join(root, 'own'));
    const { pond } = pondMcpServers(root);
    expect(pond.env.XDG_STATE_HOME).toBe('/tmp/pond-state');
    expect(pond.env.POND_CONFIG_FILE).toBeDefined();
  });
});

describe('index.ts wiring (structural)', () => {
  it('merges pondMcpServers into the mcpServers map', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dir, 'index.ts'), 'utf8');
    expect(src).toMatch(/Object\.assign\(mcpServers,\s*pondMcpServers\(\)\)/);
  });
});
