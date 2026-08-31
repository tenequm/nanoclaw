import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createTurnLiveness, heartbeatPath, touchHeartbeat } from './heartbeat.js';

afterEach(() => {
  delete process.env.NANOCLAW_HEARTBEAT_PATH;
});

describe('heartbeat path', () => {
  it('defaults to the workspace heartbeat', () => {
    expect(heartbeatPath()).toBe('/workspace/.heartbeat');
  });

  it('honors NANOCLAW_HEARTBEAT_PATH and touches that file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-'));
    const override = path.join(dir, '.heartbeat');
    process.env.NANOCLAW_HEARTBEAT_PATH = override;

    expect(heartbeatPath()).toBe(override);
    touchHeartbeat();
    expect(fs.existsSync(override)).toBe(true);

    // Second touch goes down the utimes path (file exists) and lands within
    // clock tolerance — utimes stores whole ms while write stamps fractional.
    const before = fs.statSync(override).mtimeMs;
    touchHeartbeat();
    expect(fs.statSync(override).mtimeMs).toBeGreaterThanOrEqual(before - 5);
  });
});

describe('turn liveness', () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('ticks while a turn is in flight and stops after its result', async () => {
    let touches = 0;
    const turn = createTurnLiveness({ touch: () => touches++, intervalMs: 5 });
    turn.begin();
    expect(touches).toBe(1); // immediate touch covers the pre-init gap
    await tick(40);
    expect(touches).toBeGreaterThan(3);
    turn.end();
    const atEnd = touches;
    await tick(30);
    expect(touches).toBe(atEnd);
    turn.dispose();
  });

  it('keeps ticking across a follow-up queued mid-turn until every result is in', async () => {
    let touches = 0;
    const turn = createTurnLiveness({ touch: () => touches++, intervalMs: 5 });
    turn.begin();
    turn.begin();
    turn.end();
    const afterFirst = touches;
    await tick(30);
    expect(touches).toBeGreaterThan(afterFirst);
    turn.end();
    const afterSecond = touches;
    await tick(30);
    expect(touches).toBe(afterSecond);
    turn.dispose();
  });

  it('stops vouching after the silence cap and resumes on the next event', async () => {
    let clock = 0;
    let touches = 0;
    const turn = createTurnLiveness({ touch: () => touches++, intervalMs: 5, silenceCapMs: 100, now: () => clock });
    turn.begin();
    clock = 200;
    await tick(30);
    const capped = touches;
    await tick(30);
    expect(touches).toBe(capped);
    turn.noteEvent();
    await tick(30);
    expect(touches).toBeGreaterThan(capped);
    turn.dispose();
  });

  it('dispose stops ticking and ignores later begins', async () => {
    let touches = 0;
    const turn = createTurnLiveness({ touch: () => touches++, intervalMs: 5 });
    turn.begin();
    turn.dispose();
    turn.begin();
    const atDispose = touches;
    await tick(30);
    expect(touches).toBe(atDispose);
  });

  it('never goes negative on an unmatched result', async () => {
    let touches = 0;
    const turn = createTurnLiveness({ touch: () => touches++, intervalMs: 5 });
    turn.end();
    turn.begin();
    await tick(30);
    expect(touches).toBeGreaterThan(1);
    turn.dispose();
  });
});
