import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('stand-in', (ctx) => {
  // Group configuration alone must never enable the local test provider.
  if (ctx.hostEnv.NANOCLAW_LOCAL_STAND_IN !== '1') {
    throw new Error('stand-in requires NANOCLAW_LOCAL_STAND_IN=1 in the local host process');
  }
  return { env: { NANOCLAW_LOCAL_STAND_IN: '1' } };
});
