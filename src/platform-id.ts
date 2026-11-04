/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a channel prefix: "telegram:123456", "discord:guild:chan".
 * The router stores channel_type and platform_id in separate columns, but
 * Chat SDK adapters send the prefixed form as the platform_id — so any code
 * that writes messaging_groups rows must produce the same shape the adapter
 * will later emit as event.platformId, or router lookups miss and messages
 * get silently dropped.
 *
 * Native adapters (Signal, WhatsApp, iMessage, DeltaChat) use their own ID
 * formats and send them as-is — no channel prefix. WhatsApp/iMessage emit
 * JIDs/emails containing '@'. Signal emits raw phone numbers ('+15551234567')
 * for DMs and 'group:<id>' for group chats. DeltaChat emits numeric chat IDs
 * ('12'). Prefixing any of these would cause a mismatch with what the adapter
 * later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.startsWith(`${channel}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  return `${channel}:${raw}`;
}

/**
 * Suffix an inbound message id with its agent group.
 *
 * One platform message fans out to a `messages_in` row per agent group, and
 * `id` is that table's PRIMARY KEY, so the raw platform id would collide
 * across sessions (and within one session on a re-route after a retry).
 */
export function agentScopedMessageId(baseId: string, agentGroupId: string): string {
  return `${baseId}:${agentGroupId}`;
}

/**
 * Recover the platform's own id from an agent-scoped one.
 *
 * The container addresses a message by the inbound ROW id (that is what
 * `getMessageIdBySeq` returns for an inbound seq), so every id reaching an
 * adapter through `edit_message` / `add_reaction` carries the scope suffix.
 * Telegram tolerates it by accident — `extractTelegramMessageId` reads only
 * the first two colon-separated parts — but Slack hands the whole string to
 * `reactions.add` as a `ts` and gets `message_not_found`.
 *
 * Exact-suffix match, never a heuristic split: an id that was never scoped
 * (an outbound row's id, which resolves through `delivered.platform_message_id`
 * and is already clean) passes through untouched.
 */
export function platformMessageId(scopedId: string, agentGroupId: string): string {
  const suffix = `:${agentGroupId}`;
  return scopedId.endsWith(suffix) ? scopedId.slice(0, -suffix.length) : scopedId;
}
