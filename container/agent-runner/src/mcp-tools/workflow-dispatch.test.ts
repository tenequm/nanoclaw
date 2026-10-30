import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { dispatchWorkflow } from './workflow-dispatch.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('dispatch_workflow', () => {
  it('writes the system action the host approves and dispatches', async () => {
    const result = await dispatchWorkflow.handler({ env: 'app-prod', version: '26-10-26.1595', reason: 'ship' });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toEqual({
      action: 'dispatch_workflow',
      env: 'app-prod',
      version: '26-10-26.1595',
      reason: 'ship',
    });
  });

  it('refuses a request missing env, version or reason', async () => {
    for (const args of [
      { version: 'v', reason: 'r' },
      { env: 'e', reason: 'r' },
      { env: 'e', version: 'v', reason: ' ' },
    ]) {
      expect((await dispatchWorkflow.handler(args)).isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
