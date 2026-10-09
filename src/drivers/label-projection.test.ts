import { describe, expect, it } from 'vitest';

import { projectLabelValue, projectLabels } from './label-projection.js';
import { FIXTURE_LONG_GROUP_FOLDER, FIXTURE_POLICY, fixtureGroupVolumeSpec } from './spec-fixture.js';
import { GROUP_FOLDER_LABEL, labelValueLegal, validateSpec } from './types.js';

describe('projectLabelValue', () => {
  it('keeps every legal value verbatim, including empty and boundary-length ones', () => {
    for (const value of ['', 'a', 'A.b_c-9', 'x'.repeat(63)]) {
      expect(projectLabelValue(value)).toBe(value);
    }
  });

  it('projects an over-long value into the grammar, deterministically', () => {
    const long = `nanoclaw-v2-${FIXTURE_LONG_GROUP_FOLDER}-1700000000000`;
    expect(labelValueLegal(long)).toBe(false);
    const projected = projectLabelValue(long);
    expect(labelValueLegal(projected)).toBe(true);
    expect(projected.length).toBeLessThanOrEqual(63);
    expect(projectLabelValue(long)).toBe(projected);
    expect(projected.startsWith('nanoclaw-v2-agent-')).toBe(true);
  });

  it('never collapses two distinct values that share a long prefix', () => {
    const prefix = 'p'.repeat(70);
    expect(projectLabelValue(`${prefix}-a`)).not.toBe(projectLabelValue(`${prefix}-b`));
  });

  it('sanitizes illegal characters and edges', () => {
    for (const value of ['-leading', 'trailing.', 'has space', 'ümlaut', '/slash/', '___']) {
      const projected = projectLabelValue(value);
      expect(labelValueLegal(projected), `${value} -> ${projected}`).toBe(true);
      expect(projected).not.toBe(value);
    }
  });
});

describe('projectLabels', () => {
  it('projects lineage labels and keeps the folder label verbatim', () => {
    const spec = fixtureGroupVolumeSpec({}, { longFolder: true });
    const projected = projectLabels(spec.labels);
    expect(projected[GROUP_FOLDER_LABEL]).toBe(FIXTURE_LONG_GROUP_FOLDER);
    expect(projected['nanoclaw-container-name']).not.toBe(spec.labels['nanoclaw-container-name']);
    expect(Object.values(projected).every(labelValueLegal)).toBe(true);
  });

  it('refuses an illegal folder label instead of projecting it', () => {
    expect(() => projectLabels({ [GROUP_FOLDER_LABEL]: 'Bad Folder' })).toThrow(/spec-invalid/);
  });
});

describe('fixtureGroupVolumeSpec', () => {
  it('is a valid spec under the shared policy, in every variant', () => {
    for (const options of [{}, { longFolder: true }, { surfaceImage: true }]) {
      expect(() => validateSpec(fixtureGroupVolumeSpec({}, options), FIXTURE_POLICY)).not.toThrow();
    }
  });

  it('carries no install-surface mount and classifies every mount', () => {
    const agent = fixtureGroupVolumeSpec().containers[0];
    expect(agent.mounts.some((m) => m.class === 'install-surface')).toBe(false);
    expect(agent.mounts.every((m) => m.realization !== undefined)).toBe(true);
  });
});
