import type { ChannelAdapter, ChannelDefaults } from '../adapter.js';
import { registerChannelAdapter } from '../channel-registry.js';
import { registerRootHandler } from '../../webhook-server.js';
import '../../modules/device-auth/index.js';
import './db.js';
import { dispatchApp } from './routes.js';
import { deliver } from './deliver.js';
import { setTyping, clearTyping } from './status.js';
const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};
export function createAppAdapter(): ChannelAdapter {
  let connected = false;
  return {
    name: 'app',
    channelType: 'app',
    supportsThreads: false,
    defaults,
    async setup(_config) {
      registerRootHandler('app', (req, res) => dispatchApp({ req, res, params: {} }));
      connected = true;
    },
    async teardown() {
      connected = false;
    },
    isConnected: () => connected,
    deliver,
    setTyping,
    clearTyping,
  };
}
registerChannelAdapter('app', { factory: createAppAdapter, defaults });
