/**
 * Coverage for the reaction→topic attribution map. Telegram's
 * `message_reaction` updates carry no topic id, so the adapter remembers
 * where each message lives and the reaction handler looks it up; a miss
 * must fall back cleanly (null) to the base chat id.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { _clearTopicMapForTest, rememberTopicMessage, resolveTopicPlatformId } from './topic-map.js';

afterEach(() => {
  _clearTopicMapForTest();
});

describe('topic-map', () => {
  it('resolves a remembered message to its topic platformId', () => {
    rememberTopicMessage(-1003927289090, 17, 'telegram:-1003927289090:42');
    expect(resolveTopicPlatformId(-1003927289090, 17)).toBe('telegram:-1003927289090:42');
  });

  it('returns null on a miss (falls back to base chat routing)', () => {
    expect(resolveTopicPlatformId(-1003927289090, 999)).toBeNull();
  });

  it('keys on both chatId and messageId', () => {
    rememberTopicMessage(-100111, 5, 'telegram:-100111:2');
    expect(resolveTopicPlatformId(-100222, 5)).toBeNull();
  });

  it('evicts the oldest entry once the cap is exceeded', () => {
    for (let i = 0; i < 4097; i++) {
      rememberTopicMessage(-100, i, `telegram:-100:${i % 4}`);
    }
    expect(resolveTopicPlatformId(-100, 0)).toBeNull();
    expect(resolveTopicPlatformId(-100, 4096)).toBe('telegram:-100:0');
  });

  it('re-remembering a message refreshes its position and value', () => {
    rememberTopicMessage(-100, 1, 'telegram:-100:2');
    rememberTopicMessage(-100, 1, 'telegram:-100:3');
    expect(resolveTopicPlatformId(-100, 1)).toBe('telegram:-100:3');
  });
});
