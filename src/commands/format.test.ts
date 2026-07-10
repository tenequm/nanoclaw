import { describe, expect, it, vi, afterEach } from 'vitest';

import { formatDateRel, formatTokens } from './format.js';

describe('formatTokens (OpenClaw heuristic)', () => {
  it('formats millions with 1dp, stripping a trailing .0', () => {
    expect(formatTokens(1_200_000)).toBe('1.2m');
    expect(formatTokens(2_000_000)).toBe('2m');
    expect(formatTokens(1_990_000)).toBe('2m'); // 1.99 -> toFixed(1) -> 2.0 -> 2
  });

  it('formats 10k and up with 0 decimals', () => {
    expect(formatTokens(46_000)).toBe('46k');
    expect(formatTokens(113_000)).toBe('113k');
    expect(formatTokens(400_000)).toBe('400k');
    expect(formatTokens(10_000)).toBe('10k');
  });

  it('formats 1k..10k with 1dp, stripping a trailing .0', () => {
    expect(formatTokens(4_500)).toBe('4.5k');
    expect(formatTokens(4_000)).toBe('4k');
    expect(formatTokens(1_000)).toBe('1k');
  });

  it('leaves sub-1000 counts as the raw integer', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(42)).toBe('42');
  });

  it('falls back to String for negatives and non-finite', () => {
    expect(formatTokens(-5)).toBe('-5');
    expect(formatTokens(NaN)).toBe('NaN');
  });
});

describe('formatDateRel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders local YYYY-MM-DD HH:MM plus a relative suffix', () => {
    const base = new Date('2026-07-10T02:32:00');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(base.getTime() + 2 * 60 * 60 * 1000)); // now = base + 2h
    const out = formatDateRel(base.toISOString());
    // Local stamp mirrors the local components of `base`.
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const stamp = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())} ${pad(base.getHours())}:${pad(base.getMinutes())}`;
    expect(out).toBe(`${stamp} (2h ago)`);
  });

  it('buckets the relative suffix', () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-10T12:00:00');
    vi.setSystemTime(now);
    const ago = (ms: number) => formatDateRel(new Date(now.getTime() - ms).toISOString());
    expect(ago(30 * 1000)).toContain('(just now)');
    expect(ago(5 * 60 * 1000)).toContain('(5m ago)');
    expect(ago(3 * 60 * 60 * 1000)).toContain('(3h ago)');
    expect(ago(3 * 24 * 60 * 60 * 1000)).toContain('(3d ago)');
  });

  it('echoes an unparseable input unchanged', () => {
    expect(formatDateRel('not-a-date')).toBe('not-a-date');
  });
});
