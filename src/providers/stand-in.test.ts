import { expect, it } from 'vitest';
import './stand-in.js';
import { getProviderContainerConfig, type ProviderContainerContext } from './provider-container-registry.js';

it('requires a host-process opt-in and passes it to the runner', () => {
  const configure = getProviderContainerConfig('stand-in')!;
  const context: ProviderContainerContext = {
    sessionDir: '',
    agentGroupId: '',
    groupDir: '',
    selectedSkills: [],
    hostEnv: {},
  };
  expect(() => configure(context)).toThrow('NANOCLAW_LOCAL_STAND_IN');
  context.hostEnv.NANOCLAW_LOCAL_STAND_IN = '1';
  expect(configure(context)).toEqual({ env: { NANOCLAW_LOCAL_STAND_IN: '1' } });
});
