/**
 * Label-value projection for realizations whose label grammar is
 * `labelValueLegal` (<=63 bytes of `[A-Za-z0-9._-]`, alphanumeric at both
 * ends — the Kubernetes label-value grammar).
 *
 * Lineage labels are free-form by contract: the composed container-name label
 * is `nanoclaw-v2-<folder>-<ms>`, which overflows 63 bytes for any folder past
 * ~37 characters, and gateway labels are unchecked. Those values are PROJECTED
 * here: sanitized, truncated and suffixed with a hash of the original, so two
 * distinct values never collapse onto one label. Projection is one-way, which
 * is why `GROUP_FOLDER_LABEL` is excluded — admission joins on it verbatim
 * (see its doc in `types.ts`), so composition refuses an illegal folder
 * instead, and this module refuses to project one.
 */
import { createHash } from 'crypto';

import { GROUP_FOLDER_LABEL, labelValueLegal, specInvalid } from './types.js';

const MAX_LABEL_VALUE = 63;
const HASH_LENGTH = 10;

/** A legal value verbatim; anything else deterministically projected into the grammar. */
export function projectLabelValue(value: string): string {
  if (labelValueLegal(value)) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, HASH_LENGTH);
  const budget = MAX_LABEL_VALUE - HASH_LENGTH - 1;
  const prefix = value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, budget)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');
  return prefix ? `${prefix}-${hash}` : hash;
}

/**
 * Every value of a label map realizable: legal values verbatim, others
 * projected, `GROUP_FOLDER_LABEL` verbatim or `spec-invalid` (composition
 * already refuses an illegal folder; this is the realization's backstop).
 */
export function projectLabels(labels: Record<string, string>): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === GROUP_FOLDER_LABEL) {
      if (!labelValueLegal(value)) {
        throw specInvalid(`${GROUP_FOLDER_LABEL} '${value}' is not a legal label value and is never projected`);
      }
      projected[key] = value;
      continue;
    }
    projected[key] = projectLabelValue(value);
  }
  return projected;
}
