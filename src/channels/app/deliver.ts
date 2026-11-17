import type { ChannelAdapter } from '../adapter.js';
import { log } from '../../log.js';
/** N2a stores deliveries; the skeleton remains safe with no connected client. */
export const deliver: ChannelAdapter['deliver'] = async (_platformId, _threadId, _message) => {
  log.warn('App delivery is not implemented');
  return undefined;
};
