import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { platformIdFor } from '../../src/channels/telegram-grammy/inbound.js';
import { getInstallSlug } from '../../src/install-slug.js';

function python(source: string, ...args: string[]): string {
  return execFileSync('python3', ['-B', '-c', `import sys\nsys.path.insert(0, 'scripts/local')\n${source}`, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOCAL_AGENT_PROVIDER: 'stand-in', NANOCLAW_LOCAL_SETTINGS: '/nonexistent' },
  });
}

it('seeds the same DM identity that Telegram inbound routes and wires it to the agent', () => {
  const owner = 'telegram:123456789';
  const calls = JSON.parse(
    python(
      `
import json
import stack
calls = []
def ncl(*args):
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
    ),
  ) as string[][];
  const dm = calls.find((args) => args[0] === 'messaging-groups' && args.includes('telegram'))!;
  expect(dm[dm.indexOf('--platform-id') + 1]).toBe(platformIdFor(123456789));
  expect(calls).toContainEqual(['wirings', 'create', '--agent-group-id', 'local', '--messaging-group-id', 'dm']);
});

it('derives the image and container label slug the way the host does', () => {
  const [slug, root] = JSON.parse(python('import json, stack\nprint(json.dumps([stack.SLUG, str(stack.ROOT)]))')) as string[];
  expect(slug).toBe(getInstallSlug(root));
});
