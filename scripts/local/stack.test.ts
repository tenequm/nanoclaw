import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { platformIdFor } from '../../src/channels/telegram-grammy/inbound.js';

it('seeds the same DM identity that Telegram inbound routes and wires it to the agent', () => {
  const owner = 'telegram:123456789';
  const calls = JSON.parse(
    execFileSync(
      'python3',
      [
        '-B',
        '-c',
        `
import json, sys
sys.path.insert(0, 'scripts/local')
import stack
calls = []
def ncl(state, *args):
    calls.append(args)
    return {'id': 'dm' if 'telegram' in args else 'local',
            'platform_id': args[args.index('--platform-id') + 1] if '--platform-id' in args else ''}
stack.ncl = ncl
stack.save = lambda state: None
stack.result = lambda *args: None
stack.seed({'profile': 'fast', 'folder': 'test', 'owner': sys.argv[1]})
print(json.dumps(calls))
`,
        owner,
      ],
      { encoding: 'utf8', env: { ...process.env, LOCAL_AGENT_PROVIDER: 'stand-in' } },
    ),
  ) as string[][];
  const dm = calls.find((args) => args[0] === 'messaging-groups' && args.includes('telegram'))!;
  expect(dm[dm.indexOf('--platform-id') + 1]).toBe(platformIdFor(123456789));
  expect(calls).toContainEqual(['wirings', 'create', '--agent-group-id', 'local', '--messaging-group-id', 'dm']);
});
