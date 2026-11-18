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

it('routes /app through the chain with the 26 MiB body cap on Caddy', () => {
  const [routes, caddyfile] = JSON.parse(
    python(`
import json, shutil, tempfile
from pathlib import Path
import stack
tmp = Path(tempfile.mkdtemp())
try:
    stack.LOCAL = tmp
    stack.binaries = lambda state: ('caddy', 'traefik')
    stack.run = stack.start = lambda *args, **kwargs: None
    stack.wait_port = lambda *args: None
    stack.save = lambda state: None
    stack.chain({'base': 5000, 'run': str(tmp)})
    print(json.dumps([json.loads((tmp / 'routes.json').read_text()), (tmp / 'Caddyfile').read_text()]))
finally:
    shutil.rmtree(tmp)
`),
  ) as [{ http: { routers: Record<string, { rule: string; service: string }> } }, string];
  expect(routes.http.routers.app).toMatchObject({
    rule: 'Host(`127.0.0.1.sslip.io`) && PathPrefix(`/app`)',
    service: 'host',
  });
  expect(caddyfile).toContain('@app path /app /app/*\n    request_body @app {\n        max_size 26MiB\n    }');
});

it('writes a whole secret entry through LOCAL_SECRET_FILE_CMD at mode 0600', () => {
  const [text, mode, removed] = JSON.parse(
    python(`
import json, os, shutil, tempfile
from pathlib import Path
import stack
tmp = Path(tempfile.mkdtemp())
try:
    (tmp / 'entry').write_text('line one\\nline two\\n')
    os.environ.update(LOCAL_SECRET_FILE_CMD='cat', LOCAL_APNS_KEY_ENTRY=str(tmp / 'entry'))
    stack.secret_file('LOCAL_APNS_KEY_ENTRY', tmp / 'key.p8')
    result = [(tmp / 'key.p8').read_text(), (tmp / 'key.p8').stat().st_mode & 0o777]
    os.environ['LOCAL_SECRET_FILE_CMD'] = 'false'
    try:
        stack.secret_file('LOCAL_APNS_KEY_ENTRY', tmp / 'key.p8')
    except RuntimeError:
        result.append(not (tmp / 'key.p8').exists())
    print(json.dumps(result))
finally:
    shutil.rmtree(tmp)
`),
  ) as [string, number, boolean];
  expect(text).toBe('line one\nline two\n');
  expect(mode).toBe(0o600);
  expect(removed).toBe(true);
});

it('derives the image and container label slug the way the host does', () => {
  const [slug, root] = JSON.parse(
    python('import json, stack\nprint(json.dumps([stack.SLUG, str(stack.ROOT)]))'),
  ) as string[];
  expect(slug).toBe(getInstallSlug(root));
});
