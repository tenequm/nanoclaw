import { describe, it, expect } from 'vitest';

import {
  describeModel,
  isEffortLevel,
  modelLabelFor,
  parsePositiveInt,
  resolveModelInput,
  COMPACT_WINDOW_PRESETS,
  EFFORT_LEVELS,
  MODEL_CATALOG,
} from './types.js';

describe('resolveModelInput', () => {
  it('resolves catalog aliases to ids + labels', () => {
    expect(resolveModelInput('opus')).toEqual({ ok: true, id: 'claude-opus-4-8', label: 'Opus 4.8' });
    expect(resolveModelInput('sonnet')).toEqual({ ok: true, id: 'claude-sonnet-5', label: 'Sonnet 5' });
    expect(resolveModelInput('fable')).toEqual({ ok: true, id: 'claude-fable-5', label: 'Fable 5' });
  });

  it('is case-insensitive and trims whitespace on aliases', () => {
    expect(resolveModelInput('  OPUS  ')).toEqual({ ok: true, id: 'claude-opus-4-8', label: 'Opus 4.8' });
  });

  it('accepts a catalog id directly and labels it', () => {
    expect(resolveModelInput('claude-opus-4-8')).toEqual({ ok: true, id: 'claude-opus-4-8', label: 'Opus 4.8' });
  });

  it('accepts a sane raw id outside the catalog with a null label', () => {
    expect(resolveModelInput('claude-opus-4-6')).toEqual({ ok: true, id: 'claude-opus-4-6', label: null });
    expect(resolveModelInput('claude-sonnet-4-5-20250929')).toEqual({
      ok: true,
      id: 'claude-sonnet-4-5-20250929',
      label: null,
    });
  });

  it('rejects garbage: empty, spaces, uppercase, leading punctuation, too short', () => {
    expect(resolveModelInput('')).toEqual({ ok: false });
    expect(resolveModelInput('   ')).toEqual({ ok: false });
    expect(resolveModelInput('a b')).toEqual({ ok: false });
    expect(resolveModelInput('-bad')).toEqual({ ok: false });
    expect(resolveModelInput('..')).toEqual({ ok: false });
    // Control / non-ascii characters must be rejected.
    expect(resolveModelInput('claude/opus')).toEqual({ ok: false });
    expect(resolveModelInput('claude opus')).toEqual({ ok: false });
  });

  it('rejects ids beyond the length bounds', () => {
    expect(resolveModelInput('ab')).toEqual({ ok: false });
    expect(resolveModelInput('a'.repeat(65))).toEqual({ ok: false });
  });
});

describe('modelLabelFor / describeModel', () => {
  it('labels catalogued ids and nulls the rest', () => {
    expect(modelLabelFor('claude-fable-5')).toBe('Fable 5');
    expect(modelLabelFor('claude-opus-4-6')).toBeNull();
  });

  it('describeModel returns id + label, null for unset', () => {
    expect(describeModel(null)).toEqual({ id: null, label: null });
    expect(describeModel('claude-sonnet-5')).toEqual({ id: 'claude-sonnet-5', label: 'Sonnet 5' });
    expect(describeModel('claude-opus-4-6')).toEqual({ id: 'claude-opus-4-6', label: null });
  });
});

describe('isEffortLevel', () => {
  it('accepts every catalogued level and nothing else', () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true);
    expect(isEffortLevel('ultra')).toBe(false);
    expect(isEffortLevel('High')).toBe(false);
    expect(isEffortLevel('')).toBe(false);
  });
});

describe('parsePositiveInt (ncl rule: positive integer, shared by window + max-messages)', () => {
  it('accepts compact-window presets and arbitrary positive integers', () => {
    for (const preset of COMPACT_WINDOW_PRESETS) expect(parsePositiveInt(preset)).toBe(preset);
    expect(parsePositiveInt('250000')).toBe(250000);
    expect(parsePositiveInt(1)).toBe(1);
  });

  it('accepts small positive integers (max-messages-per-prompt)', () => {
    expect(parsePositiveInt('5')).toBe(5);
    expect(parsePositiveInt(20)).toBe(20);
  });

  it('rejects zero, negatives, non-integers, and garbage', () => {
    expect(parsePositiveInt(0)).toBeNull();
    expect(parsePositiveInt(-5)).toBeNull();
    expect(parsePositiveInt(-1)).toBeNull();
    expect(parsePositiveInt('1.5')).toBeNull();
    expect(parsePositiveInt('2.2')).toBeNull();
    expect(parsePositiveInt('abc')).toBeNull();
    expect(parsePositiveInt('nope')).toBeNull();
    expect(parsePositiveInt('')).toBeNull();
  });
});

describe('MODEL_CATALOG shape', () => {
  it('matches the confirmed catalog exactly', () => {
    expect(MODEL_CATALOG).toEqual([
      { alias: 'sonnet', label: 'Sonnet 5', id: 'claude-sonnet-5' },
      { alias: 'opus', label: 'Opus 4.8', id: 'claude-opus-4-8' },
      { alias: 'fable', label: 'Fable 5', id: 'claude-fable-5' },
    ]);
  });
});
