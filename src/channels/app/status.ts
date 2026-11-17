import type { ChannelAdapter } from '../adapter.js';
/** N2b persists status revisions and publishes typing changes. */
export const setTyping: NonNullable<ChannelAdapter['setTyping']> = async (
  _platformId,
  _threadId,
  _status,
  _statusKind,
) => {};
/** N2b publishes idle status. */
export const clearTyping: NonNullable<ChannelAdapter['clearTyping']> = async (_platformId, _threadId) => {};
