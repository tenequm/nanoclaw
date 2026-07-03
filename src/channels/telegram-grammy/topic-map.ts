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
 */
const MAX_ENTRIES = 4096;

const topicByMessage = new Map<string, string>();

export function rememberTopicMessage(chatId: number, messageId: number, platformId: string): void {
  const key = `${chatId}:${messageId}`;
  if (topicByMessage.has(key)) topicByMessage.delete(key);
  topicByMessage.set(key, platformId);
  if (topicByMessage.size > MAX_ENTRIES) {
    const oldest = topicByMessage.keys().next().value;
    if (oldest !== undefined) topicByMessage.delete(oldest);
  }
}

export function resolveTopicPlatformId(chatId: number, messageId: number): string | null {
  return topicByMessage.get(`${chatId}:${messageId}`) ?? null;
}

export function _clearTopicMapForTest(): void {
  topicByMessage.clear();
}
