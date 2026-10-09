import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as k8s from '@kubernetes/client-node';

import { KubernetesSessionDriver, groupPvcName } from '../../src/drivers/kubernetes-driver.js';
import { fixtureGroupVolumeSpec } from '../../src/drivers/spec-fixture.js';
import type { SessionEvent, SessionWatch } from '../../src/drivers/types.js';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    kubeconfig: { type: 'string' },
    image: { type: 'string' },
    'surface-image': { type: 'string' },
  },
});
if (values.help) {
  console.log(
    'Usage: pnpm exec tsx dev/k8s/driver-harness.ts --kubeconfig <local kind file> --image <pinned base> [--surface-image <digest>]',
  );
  process.exit(0);
}
if (!values.kubeconfig || !values.image)
  throw new Error('--kubeconfig and --image are required; this harness uses only kind-nanoclaw-dev');
const context = 'kind-nanoclaw-dev';
const config = new k8s.KubeConfig();
config.loadFromFile(path.resolve(values.kubeconfig));
config.setCurrentContext(context);
assert.equal(config.getCurrentCluster()?.name, 'kind-nanoclaw-dev');
const core = config.makeApiClient(k8s.CoreV1Api);
const namespace = `nanoclaw-test-b1-${Date.now().toString(36)}`;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-b1-'));
let watch: SessionWatch | undefined;
let namespaceCreated = false;
const events: SessionEvent[] = [];
const step = (label: string, detail: unknown) =>
  console.log(`${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
const kubectl = (...args: string[]) =>
  execFileSync(
    'kubectl',
    ['--kubeconfig', path.resolve(values.kubeconfig!), '--context', context, '-n', namespace, ...args],
    { encoding: 'utf8', timeout: 30_000 },
  ).trim();
try {
  await core.createNamespace({ body: { metadata: { name: namespace } } });
  namespaceCreated = true;
  const spec = fixtureGroupVolumeSpec({}, { longFolder: true, surfaceImage: Boolean(values['surface-image']) });
  const agent = spec.containers[0];
  agent.image = values.image;
  agent.command = ['bash', '-c'];
  agent.args = ['exec sleep infinity'];
  if (agent.surfaceImage) agent.surfaceImage.image = values['surface-image']!;
  for (const mount of agent.mounts) {
    mount.hostPath = path.join(temp, mount.hostPath.slice('/install/'.length));
    if (mount.realization?.kind === 'file-snapshot') {
      await fs.mkdir(path.dirname(mount.hostPath), { recursive: true });
      await fs.writeFile(mount.hostPath, 'fixture-version-1\n');
    } else await fs.mkdir(mount.hostPath, { recursive: true });
  }
  const driver = new KubernetesSessionDriver({
    groupsRoot: path.join(temp, 'groups'),
    dataRoot: path.join(temp, 'data'),
    surfaceRoots: [path.join(temp, 'container')],
    materialsRoot: path.join(temp, 'data/session-materials'),
    gatewayTrustRoot: path.join(temp, 'data/gateway-trust'),
    kubeconfigPath: path.resolve(values.kubeconfig),
    context,
    namespace,
    startTimeoutMs: 180_000,
  });
  step('namespace', namespace);
  watch = driver.watchSessions(spec.key.installSlug, (event) => {
    events.push(event);
  });
  let handle = await driver.prepare(spec);
  step('prepare', await handle.status());
  step(
    'pvc-before-start',
    (await core.readNamespacedPersistentVolumeClaim({ namespace, name: groupPvcName(spec.key) })).status?.phase,
  );
  await handle.start();
  step('start', await handle.status());
  const oldUid = (await core.readNamespacedPod({ namespace, name: handle.name })).metadata!.uid;
  const attach = handle.execSpec([
    'bash',
    '-c',
    "echo pvc-persisted > /workspace/persisted; id -u; cat /proc/1/comm; cat /app/.nanoclaw-session.json; cat /home/node/.claude/settings.json; readlink /home/node/.claude/skills/welcome; test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token; test -f /app/src/index.ts; test -d /app/skills/welcome; awk '/CapEff|NoNewPrivs/ {print}' /proc/self/status",
  ]);
  const output = execFileSync(attach.bin, attach.argsPlain, { encoding: 'utf8', timeout: 30_000 }).trim();
  assert.match(output, /1000/);
  assert.match(output, /tini/);
  assert.match(output, /fixture-version-1/);
  assert.match(output, /autoMemoryEnabled/);
  assert.match(output, /NoNewPrivs:\s+1/);
  assert.match(output, /CapEff:\s+0000000000000000/);
  step('exec', output);
  kubectl(
    'exec',
    handle.name,
    '-c',
    'agent',
    '--',
    'bash',
    '-c',
    `printf '%s\n' '{"preserved":true}' > /home/node/.claude/settings.json; ln -s /app/skills/obsolete /home/node/.claude/skills/obsolete; rm /home/node/.claude/skills/agent-browser; mkdir /home/node/.claude/skills/agent-browser`,
  );

  await handle.stop('harness-resume');
  step('suspend-requested', await handle.status());
  for (const mount of agent.mounts.filter((m) => m.realization?.kind === 'file-snapshot'))
    await fs.writeFile(mount.hostPath, 'fixture-version-2\n');
  agent.env.NANOCLAW_WAKE_REASON = 'resume';
  spec.resources.cpus = '0.5';
  handle = await driver.prepare(spec);
  step('suspend-settled', await handle.status());
  await handle.start();
  step('resume', await handle.status());
  const newPod = await core.readNamespacedPod({ namespace, name: handle.name });
  assert.notEqual(newPod.metadata!.uid, oldUid);
  step('new-pod-uid', { old: oldUid, new: newPod.metadata!.uid });
  const resumed = kubectl(
    'exec',
    handle.name,
    '-c',
    'agent',
    '--',
    'bash',
    '-c',
    'cat /workspace/persisted; cat /app/.nanoclaw-session.json; printf "%s\n" "$NANOCLAW_WAKE_REASON"',
  );
  assert.match(resumed, /pvc-persisted/);
  assert.match(resumed, /fixture-version-2/);
  assert.match(resumed, /resume/);
  step('resumed-bytes-and-env', resumed);
  const reconciled = kubectl(
    'exec',
    handle.name,
    '-c',
    'agent',
    '--',
    'bash',
    '-c',
    `grep preserved /home/node/.claude/settings.json; test ! -L /home/node/.claude/skills/obsolete; test -d /home/node/.claude/skills/agent-browser; test ! -L /home/node/.claude/skills/agent-browser; test ! -w /app/.nanoclaw-session.json; test ! -w /app/src/index.ts; echo provider-state-and-readonly-mounts-verified`,
  );
  assert.match(reconciled, /provider-state-and-readonly-mounts-verified/);
  step('provider-reconciliation', reconciled);

  assert.equal(newPod.spec!.containers[0].resources!.limits!.cpu, '500m');
  step(
    'list',
    (await driver.listSessions(spec.key.installSlug)).map((s) => ({ name: s.handle.name, phase: s.phase })),
  );
  await handle.stop('harness-complete');
  await driver.prepare(spec);
  assert.deepEqual(await driver.listSessions(spec.key.installSlug), []);
  step('final-status', await handle.status());
  step('retained', await driver.listRetained(spec.key.installSlug));
  await driver.reapRetained(spec.key.installSlug, [spec.key]);
  assert.equal(
    (await core.readNamespacedPersistentVolumeClaim({ namespace, name: groupPvcName(spec.key) })).status?.phase,
    'Bound',
  );
  step('pvc-survives-session-delete', 'Bound');
  step('watch-events', { total: events.length, terminal: events.filter((e) => e.kind === 'terminal').length });
} finally {
  watch?.stop();
  if (namespaceCreated) {
    await core.deleteNamespace({ name: namespace });
    step('cleanup', `deleted ${namespace}`);
  }
  await fs.rm(temp, { recursive: true, force: true });
}
