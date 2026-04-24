/**
 * Ask-question keyboard builder: callback_data 64-byte guard.
 *
 * Telegram's callback_data is hard-capped at 64 bytes UTF-8. Overflow
 * means the host's onAction handler receives a truncated value. The
 * builder drops overflow options with a non-empty skippedLabels[] so the
 * caller can log a clear error — we never silently ship a garbled row.
 */
import { describe, expect, it } from 'vitest';

import type { NormalizedOption } from '../ask-question.js';
import { buildAskQuestionKeyboard, encodeCallbackData, parseCallbackData } from './ask-question.js';

describe('buildAskQuestionKeyboard', () => {
  it('builds one row per option when under the 64-byte limit', () => {
    const options: NormalizedOption[] = [
      { label: 'Yes', selectedLabel: 'Yes', value: 'yes' },
      { label: 'No', selectedLabel: 'No', value: 'no' },
    ];
    const { keyboard, skippedLabels } = buildAskQuestionKeyboard('q1', options);
    expect(skippedLabels).toEqual([]);
    expect(keyboard.inline_keyboard).toHaveLength(2);
  });

  it('drops options whose callback_data overflows 64 bytes', () => {
    const big = 'x'.repeat(70); // 70 bytes — encoded as "ncq:q1:<70 x>" > 64
    const options: NormalizedOption[] = [
      { label: 'ok', selectedLabel: 'ok', value: 'ok' },
      { label: 'big-one', selectedLabel: 'big-one', value: big },
    ];
    const { keyboard, skippedLabels } = buildAskQuestionKeyboard('q1', options);
    expect(skippedLabels).toEqual(['big-one']);
    expect(keyboard.inline_keyboard).toHaveLength(1);
  });

  it('encode/parse round-trips simple values', () => {
    const encoded = encodeCallbackData('q1', 'option-a');
    expect(encoded).toBe('ncq:q1:option-a');
    expect(parseCallbackData(encoded)).toEqual({ questionId: 'q1', value: 'option-a' });
  });

  it('parse preserves colons in the value portion', () => {
    const encoded = encodeCallbackData('q1', 'a:b:c');
    expect(parseCallbackData(encoded)).toEqual({ questionId: 'q1', value: 'a:b:c' });
  });

  it('parse returns null for malformed data', () => {
    expect(parseCallbackData('not-a-prefix')).toBeNull();
    expect(parseCallbackData('ncq:')).toBeNull();
  });
});
