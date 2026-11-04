/**
 * (chatId, messageId) → per-topic platformId memory.
 *
 * Telegram `message_reaction` updates carry no thread/topic information, so
 * a reaction arriving in a forum topic cannot be attributed to its topic
 * from the update alone. We remember the topic platformId of every message
 * seen (inbound handler) or sent (outbound dispatch) in a forum topic; the
 * reaction handler consults this map to route the reaction to the right
 * per-topic messaging group.
 *
 * Bounded FIFO. A miss falls back to the base `telegram:<chatId>` id (the
 * pre-topic behavior). Host restarts wipe the map — accepted gap: a
 * reaction to a pre-restart message routes to the base chat row instead of
 * the topic.
 *
 * Also hosts the bounded per-message map (`createMessageMap`) that outbound.ts reuses.
 */
const MAX_ENTRIES = 4096;

/** A bounded FIFO keyed by (chatId, messageId): the newest `MAX_ENTRIES` entries survive. */
export function createMessageMap<V>() {
  const entries = new Map<string, V>();
  return {
    remember(chatId: number, messageId: number | string, value: V): void {
      const key = `${chatId}:${messageId}`;
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    get(chatId: number, messageId: number | string): V | undefined {
      return entries.get(`${chatId}:${messageId}`);
    },
    clear(): void {
      entries.clear();
    },
  };
}

const topicByMessage = createMessageMap<string>();

export function rememberTopicMessage(chatId: number, messageId: number, platformId: string): void {
  topicByMessage.remember(chatId, messageId, platformId);
}

export function resolveTopicPlatformId(chatId: number, messageId: number): string | null {
  return topicByMessage.get(chatId, messageId) ?? null;
}

export function _clearTopicMapForTest(): void {
  topicByMessage.clear();
}
