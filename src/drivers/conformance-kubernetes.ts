import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KubernetesSessionDriver } from './kubernetes-driver.js';
import { projectLabels } from './label-projection.js';
import { withSessionEvents } from './session-events.js';
import {
  FIXTURE_GROUP_VOLUME_CAPABILITIES,
  FIXTURE_LONG_GROUP_FOLDER,
  fixtureAuxContainer,
  fixtureGroupVolumeSpec,
} from './spec-fixture.js';
import {
  GATEWAY_ROLE,
  GROUP_FOLDER_LABEL,
  LABELS,
  labelsForKey,
  validateSpec,
  type MountPolicy,
  type SessionDriver,
  type SessionEvent,
  type SessionHandle,
  type SessionSpec,
  type SessionWatch,
} from './types.js';

const CONTEXT = 'kind-nanoclaw-dev';
const NODE = 'nanoclaw-dev-control-plane';
const CRD = 'sandboxes.agents.x-k8s.io';
const RESOURCE = 'sandboxes.agents.x-k8s.io';
const MANIFEST = '/etc/kubernetes/manifests/kube-apiserver.yaml';
const MOVED_MANIFEST = '/tmp/nanoclaw-b2-kube-apiserver.yaml';
const ENABLED = process.env.NANOCLAW_CONFORMANCE_KUBERNETES === '1';
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type Metadata = {
  name: string;
  uid: string;
  generation?: number;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: { uid: string; kind: string; name: string }[];
  deletionTimestamp?: string;
};
type Volume = {
  name: string;
  persistentVolumeClaim?: { claimName: string };
  secret?: { secretName: string; defaultMode?: number; items?: { key: string; path: string }[] };
  image?: { reference: string; pullPolicy?: string };
  emptyDir?: { medium?: string; sizeLimit?: string };
};
type PodContainer = {
  name: string;
  image: string;
  env?: { name: string; value?: string }[];
  command?: string[];
  args?: string[];
  volumeMounts?: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[];
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
  securityContext?: { allowPrivilegeEscalation?: boolean; capabilities?: { drop?: string[] } };
};
type PodSpec = {
  containers: PodContainer[];
  initContainers?: PodContainer[];
  volumes?: Volume[];
  restartPolicy?: string;
  automountServiceAccountToken?: boolean;
  securityContext?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number };
};
type KubeObject = {
  apiVersion: string;
  kind: string;
  metadata: Metadata;
  spec: {
    operatingMode?: string;
    podTemplate?: { metadata?: { labels?: Record<string, string> }; spec: PodSpec };
  } & Record<string, unknown>;
  status?: {
    observedGeneration?: number;
    phase?: string;
    conditions?: { type: string; status: string; reason?: string; observedGeneration?: number }[];
    containerStatuses?: { state?: { waiting?: { reason?: string }; terminated?: { exitCode: number } } }[];
  };
  data?: Record<string, string>;
};

async function command(bin: string, args: string[], input?: string, timeout = 30_000): Promise<string> {
  return new Promise((done, fail) => {
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeout);
    proc.stdout.setEncoding('utf8').on('data', (data: string) => (stdout += data));
    proc.stderr.setEncoding('utf8').on('data', (data: string) => (stderr += data));
    proc.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout);
      else fail(new Error(`${bin} exited ${code}: ${stderr.slice(-1500)}`));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accepts(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`condition did not converge within ${timeout}ms`, { cause: lastError });
}

export function registerKubernetesConformance(): void {
  describe.skipIf(!ENABLED)('conformance: kubernetes on kind', () => {
    let root: string;
    let namespace: string;
    let kubeconfig: string;
    let image: string;
    let surfaceImage: string;
    let hostAddress: string;
    let driver: SessionDriver;
    let policy: MountPolicy;
    let spec: SessionSpec;
    let serial = 0;
    let informerCreations = 0;
    let informerConnections = 0;
    const informerErrors: string[] = [];
    let makeInformer: typeof import('@kubernetes/client-node').makeInformer;
    function tracedInformer<T extends import('@kubernetes/client-node').KubernetesObject>(
      ...args: Parameters<typeof makeInformer<T>>
    ) {
      informerCreations++;
      const informer = makeInformer<T>(...args);
      informer.on('connect', () => informerConnections++);
      informer.on('error', (error: unknown) =>
        informerErrors.push(error instanceof Error ? error.name : String(error)),
      );
      return informer;
    }
    const watches: SessionWatch[] = [];

    const kubectl = (args: string[], input?: string, timeout?: number): Promise<string> =>
      command(
        'kubectl',
        ['--kubeconfig', kubeconfig, '--context', CONTEXT, '--request-timeout=5s', ...args],
        input,
        timeout,
      );
    const ns = (args: string[], input?: string, timeout?: number): Promise<string> =>
      kubectl(['--namespace', namespace, ...args], input, timeout);
    const get = async (resource: string, name: string): Promise<KubeObject | undefined> => {
      const out = await ns(['get', resource, name, '--ignore-not-found', '-o', 'json']);
      return out.trim() ? (JSON.parse(out) as KubeObject) : undefined;
    };
    const list = async (resource: string, selector?: string): Promise<KubeObject[]> => {
      const args = ['get', resource, '-o', 'json'];
      if (selector) args.push('-l', selector);
      return (JSON.parse(await ns(args)) as { items: KubeObject[] }).items;
    };
    const apply = (object: unknown): Promise<string> => ns(['apply', '-f', '-'], JSON.stringify(object));
    const installSelector = (): string => `${LABELS.install}=${spec.key.installSlug}`;
    const driverFor = (options: { startTimeoutMs?: number } = {}): SessionDriver => {
      const raw = new KubernetesSessionDriver({
        ...policy,
        kubeconfigPath: kubeconfig,
        context: CONTEXT,
        namespace,
        hostAddress,
        startTimeoutMs: 30_000,
        pollIntervalMs: 100,
        requestTimeoutMs: 1500,
        informerFactory: tracedInformer,
        ...options,
      });
      const original = raw.watchSessions.bind(raw);
      vi.spyOn(raw, 'watchSessions').mockImplementation((slug, listener) => {
        const watch = original(slug, listener);
        watches.push(watch);
        return watch;
      });
      return raw;
    };
    const podGone = (handle: SessionHandle): Promise<KubeObject | undefined> =>
      eventually(
        () => get('pod', handle.name),
        (pod) => !pod,
        30_000,
      );
    const start = async (): Promise<SessionHandle> => {
      const handle = await driver.prepare(spec);
      await handle.start();
      expect(await handle.status()).toEqual({ phase: 'running' });
      return handle;
    };
    const exec = async (handle: SessionHandle, args: string[]): Promise<string> => {
      const description = handle.execSpec(args);
      expect(description.argsPlain).toContain(kubeconfig);
      expect(description.argsPlain).toContain(CONTEXT);
      expect(description.argsPlain).toContain(namespace);
      expect(description.argsPlain.slice(-args.length)).toEqual(args);
      return command(description.bin, description.argsPlain);
    };
    const crash = (handle: SessionHandle) =>
      eventually(
        async () => {
          const status = await handle.status();
          if (status.phase === 'failed') return status;
          await exec(handle, ['bash', '-c', 'read -r child rest < /proc/1/task/1/children; kill -KILL "$child"']);
          return handle.status();
        },
        (status) =>
          status.phase === 'failed' && status.failure.kind === 'started-then-died' && status.failure.exitCode === 137,
        90_000,
      );
    const terminalHint = async (handle: SessionHandle, events: SessionEvent[], timeout: number): Promise<void> => {
      // API readiness precedes controller recovery; the informer only observes Sandbox conditions.
      const source = await eventually(
        () => get(RESOURCE, handle.name),
        (box) =>
          box?.status?.conditions?.some(
            (condition) =>
              condition.type === 'Finished' &&
              condition.status === 'True' &&
              (condition.observedGeneration ?? box.status?.observedGeneration ?? 0) >= (box.metadata.generation ?? 1),
          ) === true,
        90_000,
      );
      try {
        await eventually(
          async () => events,
          (all) => all.some((event) => event.kind === 'terminal' && event.key.sessionId === spec.key.sessionId),
          timeout,
        );
      } catch (error) {
        throw new Error(
          JSON.stringify({
            source: { generation: source?.metadata.generation, status: source?.status },
            informerCreations,
            informerConnections,
            informerErrors,
            events: events.map((event) => event.kind),
          }),
          { cause: error },
        );
      }
    };
    const pvc = async (): Promise<KubeObject> => {
      const pvcs = await list('pvc', installSelector());
      expect(pvcs).toHaveLength(1);
      return pvcs[0];
    };
    const writeSnapshots = async (version: number): Promise<void> => {
      for (const mount of spec.containers[0].mounts) {
        if (mount.realization?.kind !== 'file-snapshot') continue;
        let content = `snapshot-${version}:${mount.containerPath}\n`;
        if (mount.containerPath === '/app/.nanoclaw-session.json') {
          content = JSON.stringify({ mailbox: { token: randomBytes(24).toString('hex') }, version });
        }
        if (mount.containerPath.endsWith('container.json')) content = JSON.stringify({ version });
        await mkdir(dirname(mount.hostPath), { recursive: true });
        await writeFile(mount.hostPath, content);
      }
    };
    const assertSnapshots = async (handle: SessionHandle): Promise<void> => {
      for (const mount of spec.containers[0].mounts) {
        if (mount.realization?.kind !== 'file-snapshot') continue;
        const wanted = await readFile(mount.hostPath);
        const actual = await exec(handle, ['cat', mount.containerPath]);
        expect(digest(actual) === digest(wanted), `snapshot bytes at ${mount.containerPath}`).toBe(true);
      }
    };
    const chaos = async (body: () => Promise<void>): Promise<void> => {
      const lock = join(tmpdir(), 'nanoclaw-dev-conformance-chaos.lock');
      await mkdir(lock);
      try {
        await body();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    };
    const apiReady = async (): Promise<void> => {
      await eventually(
        () => kubectl(['get', '--raw', '/readyz']),
        (out) => out.trim() === 'ok',
        180_000,
      );
      // Repeated static-pod outages can leave the controller in Kubernetes' five-minute restart backoff.
      await eventually(
        async () => {
          const out = await kubectl([
            '--namespace',
            'agent-sandbox-system',
            'get',
            'pods',
            '-l',
            'app=agent-sandbox-controller',
            '-o',
            'json',
          ]);
          const pods = (JSON.parse(out) as { items: KubeObject[] }).items;
          return pods.some((pod) => pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'));
        },
        Boolean,
        360_000,
      );
    };

    beforeAll(async () => {
      makeInformer = (await import('@kubernetes/client-node')).makeInformer;
      const supplied = process.env.NANOCLAW_CONFORMANCE_KUBECONFIG;
      if (!supplied || resolve(supplied) === resolve(join(process.env.HOME ?? '', '.kube/config'))) {
        throw new Error('explicit non-default NANOCLAW_CONFORMANCE_KUBECONFIG required');
      }
      kubeconfig = resolve(supplied);
      root = await mkdtemp(join(tmpdir(), 'nanoclaw-b2-'));
      namespace = `nanoclaw-b2-${randomBytes(5).toString('hex')}`;
      const exported = join(root, 'kind.kubeconfig');
      await command('kind', ['export', 'kubeconfig', '--name', 'nanoclaw-dev', '--kubeconfig', exported]);
      const view = (file: string): Promise<string> =>
        command('kubectl', ['--kubeconfig', file, '--context', CONTEXT, 'config', 'view', '--minify', '-o', 'json']);
      const [suppliedView, exportedView] = await Promise.all([view(kubeconfig), view(exported)]);
      const server = (value: string): string =>
        (JSON.parse(value) as { clusters: { cluster: { server: string } }[] }).clusters[0].cluster.server;
      expect(server(suppliedView)).toBe(server(exportedView));
      expect((await command('kind', ['get', 'nodes', '--name', 'nanoclaw-dev'])).trim()).toBe(NODE);
      expect(
        (await command('docker', ['inspect', '-f', '{{index .Config.Labels "io.x-k8s.kind.cluster"}}', NODE])).trim(),
      ).toBe('nanoclaw-dev');
      const images = (await command('docker', ['exec', NODE, 'ctr', '-n', 'k8s.io', 'images', 'list', '-q']))
        .trim()
        .split('\n');
      image =
        process.env.NANOCLAW_CONFORMANCE_IMAGE ?? images.find((ref) => /\/nanoclaw-agent-dev:sha256-/.test(ref)) ?? '';
      if (!image || !images.includes(image)) throw new Error('preloaded pinned NANOCLAW_CONFORMANCE_IMAGE required');
      surfaceImage =
        process.env.NANOCLAW_CONFORMANCE_SURFACE_IMAGE ??
        images.find((ref) => /\/nanoclaw-source-dev@sha256:/.test(ref)) ??
        '';
      if (!surfaceImage || !images.includes(surfaceImage))
        throw new Error('preloaded digest-pinned source image required');
      hostAddress = (await command('docker', ['exec', NODE, 'getent', 'ahostsv4', 'host.docker.internal']))
        .trim()
        .split(/\s+/)[0];
      await apiReady();
      await kubectl(['get', 'crd', CRD, '-o', 'name']);
      await kubectl(['create', 'namespace', namespace]);
    }, 600_000);

    beforeEach(async () => {
      informerCreations = 0;
      informerConnections = 0;
      informerErrors.length = 0;
      policy = {
        groupsRoot: join(root, 'groups'),
        dataRoot: join(root, 'data'),
        surfaceRoots: [join(root, 'container')],
        materialsRoot: join(root, 'data/session-materials'),
        gatewayTrustRoot: join(root, 'data/gateway-trust'),
      };
      spec = fixtureGroupVolumeSpec({
        key: { installSlug: `b2-${namespace.slice(-10)}-${++serial}`, agentGroupId: 'g1', sessionId: 's1' },
        resources: { memoryMb: 256, cpus: '0.5', shmSizeMb: 64 },
      });
      spec.containers[0].image = image;
      spec.containers[0].surfaceImage = {
        image: surfaceImage,
        mounts: [
          { imagePath: 'src', containerPath: '/app/src' },
          { imagePath: 'skills', containerPath: '/app/skills' },
        ],
      };
      spec.containers[0].command = ['bash', '-c'];
      spec.containers[0].args = ['exec sleep infinity'];
      for (const mount of spec.containers[0].mounts) {
        mount.hostPath = mount.hostPath.replace('/install', root);
      }
      spec.containers[0].contributedEnv = { HTTPS_PROXY: `http://placeholder@${hostAddress}:10255` };
      spec.networkAccess.endpoint = hostAddress;
      await writeSnapshots(1);
      driver = driverFor();
    });

    afterEach(async () => {
      for (const watch of watches.splice(0)) watch.stop();
      if (spec && namespace) {
        await ns(
          [
            'delete',
            `${RESOURCE},pods,secrets,persistentvolumeclaims`,
            '-l',
            installSelector(),
            '--ignore-not-found',
            '--wait=true',
            '--timeout=45s',
          ],
          undefined,
          60_000,
        );
      }
      vi.restoreAllMocks();
    }, 90_000);

    afterAll(async () => {
      try {
        if (namespace)
          await kubectl(
            ['delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=60s'],
            undefined,
            75_000,
          );
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    }, 90_000);

    it('declares the composed group-volume capabilities honestly', () => {
      expect(driver.capabilities()).toEqual({ ...FIXTURE_GROUP_VOLUME_CAPABILITIES, hostAddress });
    });

    it('prepare is idempotent on key and never mutates a live incarnation', async () => {
      const first = await driver.prepare(spec);
      const object = await get(RESOURCE, first.name);
      const second = await driver.prepare(spec);
      expect(second.key).toEqual(first.key);
      expect(second.name).toBe(first.name);
      expect((await get(RESOURCE, second.name))?.metadata.uid).toBe(object?.metadata.uid);
      expect(await second.status()).toEqual({ phase: 'ready' });
      await first.start();
      const livePod = await get('pod', first.name);
      const liveTemplate = (await get(RESOURCE, first.name))?.spec.podTemplate;
      spec.containers[0].env.NANOCLAW_WAKE_REASON = 'changed-while-live';
      const adopted = await driver.prepare(spec);
      expect(adopted.name).toBe(first.name);
      expect((await get('pod', first.name))?.metadata.uid).toBe(livePod?.metadata.uid);
      expect((await get(RESOURCE, first.name))?.spec.podTemplate).toEqual(liveTemplate);
      expect(await adopted.status()).toEqual({ phase: 'running' });
    }, 60_000);

    it('prepare succeeds while group PVC is Pending without a consumer', async () => {
      const handle = await driver.prepare(spec);
      expect((await pvc()).status?.phase).toBe('Pending');
      expect(await get('pod', handle.name)).toBeUndefined();
      expect(await handle.status()).toEqual({ phase: 'ready' });
      await handle.start();
      expect((await pvc()).status?.phase).toBe('Bound');
    }, 60_000);

    it('realizes every composed mount and env with no host binds or silently dropped surfaces', async () => {
      // Named amendments (brief Blocks A/C/D): group-volume directories and
      // file snapshots replace host binds; install surfaces are image-carried.
      const handle = await start();
      const pod = (await get('pod', handle.name))!;
      const podSpec = pod.spec as unknown as PodSpec;
      const agent = podSpec.containers.find((c) => c.name === 'agent')!;
      expect(podSpec.containers).toHaveLength(1);
      expect(agent.image).toBe(spec.containers[0].image);
      expect(Object.fromEntries((agent.env ?? []).map((entry) => [entry.name, entry.value]))).toEqual({
        ...spec.containers[0].env,
        ...spec.containers[0].contributedEnv,
      });
      const actual = (agent.volumeMounts ?? []).filter(
        (mount) => !['/dev/shm', '/app/src', '/app/skills'].includes(mount.mountPath),
      );
      expect(actual.map((m) => m.mountPath).sort()).toEqual(
        spec.containers[0].mounts.map((m) => m.containerPath).sort(),
      );
      const volumes = podSpec.volumes ?? [];
      expect(volumes.filter((v) => v.secret)).toHaveLength(1);
      const storage = await pvc();
      expect(storage.metadata.ownerReferences ?? []).toEqual([]);
      expect(storage.spec.accessModes).toEqual(['ReadWriteOnce']);
      expect(storage.spec.resources).toMatchObject({ requests: { storage: '20Gi' } });
      for (const mount of spec.containers[0].mounts) {
        const realized = actual.find((m) => m.mountPath === mount.containerPath)!;
        expect(Boolean(realized.readOnly)).toBe(mount.mode === 'ro');
        const source = volumes.find((v) => v.name === realized.name)!;
        if (mount.realization?.kind === 'group-volume') {
          expect(source.persistentVolumeClaim?.claimName).toBe(storage.metadata.name);
          expect(realized.subPath).toBe(mount.realization.subPath);
        } else {
          expect(source.secret).toBeDefined();
          expect(realized.subPath).toBeTruthy();
          expect((source.secret?.defaultMode ?? 0o644) & 0o044).not.toBe(0);
        }
      }
      expect(JSON.stringify(volumes)).not.toContain('hostPath');
      expect(podSpec.restartPolicy).toBe('Never');
      expect(podSpec.automountServiceAccountToken).toBe(false);
      expect(podSpec.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 });
      expect(agent.securityContext).toMatchObject({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
      expect(agent.command?.join(' ')).toContain('tini');
      expect(volumes.find((v) => v.emptyDir?.medium === 'Memory')?.emptyDir?.sizeLimit).toBe('64Mi');
      await assertSnapshots(handle);
      expect((await exec(handle, ['id', '-u'])).trim()).toBe('1000');
    }, 60_000);

    it('ImageVolume surfaces are declared read-only and baked mode adds no surface mounts (8b.4)', async () => {
      const handle = await start();
      const pod = (await get('pod', handle.name))!;
      const actual = pod.spec as unknown as PodSpec;
      const agent = actual.containers.find((container) => container.name === 'agent')!;
      for (const surface of spec.containers[0].surfaceImage!.mounts) {
        const mount = agent.volumeMounts!.find((entry) => entry.mountPath === surface.containerPath)!;
        expect(mount.subPath).toBe(surface.imagePath);
        expect(mount.readOnly).toBe(true);
        expect(actual.volumes!.find((entry) => entry.name === mount.name)?.image?.reference).toBe(surfaceImage);
        await expect(exec(handle, ['touch', `${surface.containerPath}/b2-write-probe`])).rejects.toThrow(
          /Read-only file system/,
        );
      }
      expect(await exec(handle, ['test', '-f', '/app/src/index.ts'])).toBe('');
      await handle.stop('conformance');
      await podGone(handle);
      delete spec.containers[0].surfaceImage;
      const baked = await driver.prepare(spec);
      const template = (await get(RESOURCE, baked.name))!.spec.podTemplate!.spec;
      expect(template.volumes?.some((volume) => volume.image)).toBe(false);
      expect(
        template.containers[0].volumeMounts?.some((mount) => ['/app/src', '/app/skills'].includes(mount.mountPath)),
      ).toBe(false);
    }, 60_000);

    it('provider initialization preserves existing settings and reconciles only skill symlinks (8b.1)', async () => {
      const handle = await start();
      const settings = spec.providerState![0].createIfMissing[0].content;
      expect(digest(await exec(handle, ['cat', '/home/node/.claude/settings.json'])) === digest(settings)).toBe(true);
      expect((await exec(handle, ['readlink', '/home/node/.claude/skills/welcome'])).trim()).toBe(
        '/app/skills/welcome',
      );
      await exec(handle, [
        'bash',
        '-c',
        'printf operator-settings > /home/node/.claude/settings.json; mkdir /home/node/.claude/skills/real-entry; ln -s /app/skills/obsolete /home/node/.claude/skills/obsolete',
      ]);
      await handle.stop('conformance');
      await podGone(handle);
      spec.providerState![0].skillLinks!.names = ['agent-browser'];
      const resumed = await driver.prepare(spec);
      await resumed.start();
      expect(await exec(resumed, ['cat', '/home/node/.claude/settings.json'])).toBe('operator-settings');
      expect(await exec(resumed, ['test', '-d', '/home/node/.claude/skills/real-entry'])).toBe('');
      expect(
        await exec(resumed, [
          'bash',
          '-c',
          'test ! -L /home/node/.claude/skills/obsolete && test ! -L /home/node/.claude/skills/welcome',
        ]),
      ).toBe('');
      expect((await exec(resumed, ['readlink', '/home/node/.claude/skills/agent-browser'])).trim()).toBe(
        '/app/skills/agent-browser',
      );
    }, 60_000);

    it('projects non-admission labels, preserves legal labels and rebuilds a handle from labels alone', async () => {
      // Named amendment (brief section 6): runtime label grammar permits
      // projection of lineage, while admission's folder label stays verbatim.
      spec.labels = {
        ...spec.labels,
        legal: 'Upper.case_with-dash',
        empty: '',
        boundary: 'a'.repeat(63),
        lineage: `bad/value/${'x'.repeat(80)}`,
      };
      const handle = await start();
      const expected = projectLabels(labelsForKey(spec.key, 'agent', { ...spec.labels, ...spec.containers[0].labels }));
      const sandbox = (await get(RESOURCE, handle.name))!;
      expect(sandbox.metadata.labels).toMatchObject(expected);
      expect(sandbox.spec.podTemplate?.metadata?.labels).toMatchObject(expected);
      const pod = (await get('pod', handle.name))!;
      expect(pod.metadata.labels).toMatchObject(expected);
      const secrets = await list('secret', installSelector());
      expect(secrets).toHaveLength(1);
      expect(secrets[0].metadata.labels).toMatchObject(expected);
      expect(secrets[0].metadata.ownerReferences).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'Sandbox', uid: sandbox.metadata.uid })]),
      );
      const freshDriver = driverFor();
      const snapshots = await freshDriver.listSessions(spec.key.installSlug);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].handle.key).toEqual(spec.key);
      expect(snapshots[0].handle.name).toBe(handle.name);
      expect(snapshots[0].phase).toBe('running');
      expect(await snapshots[0].handle.status()).toEqual({ phase: 'running' });
      expect((await exec(snapshots[0].handle, ['printf', 'adopted'])).trim()).toBe('adopted');
    }, 60_000);

    it('long group folder projects lineage but keeps the folder label verbatim', async () => {
      const oldFolder = spec.labels[GROUP_FOLDER_LABEL];
      spec.labels[GROUP_FOLDER_LABEL] = FIXTURE_LONG_GROUP_FOLDER;
      spec.labels['nanoclaw-container-name'] = `nanoclaw-v2-${FIXTURE_LONG_GROUP_FOLDER}-1700000000000`;
      for (const mount of spec.containers[0].mounts) {
        mount.hostPath = mount.hostPath.replace(`/groups/${oldFolder}`, `/groups/${FIXTURE_LONG_GROUP_FOLDER}`);
        if (mount.realization?.kind === 'group-volume' && mount.realization.subPath === oldFolder)
          mount.realization.subPath = FIXTURE_LONG_GROUP_FOLDER;
      }
      await writeSnapshots(1);
      const handle = await driver.prepare(spec);
      const object = (await get(RESOURCE, handle.name))!;
      expect(object.metadata.labels?.[GROUP_FOLDER_LABEL]).toBe(FIXTURE_LONG_GROUP_FOLDER);
      expect(object.metadata.labels?.['nanoclaw-container-name']).toBe(
        projectLabels(spec.labels)['nanoclaw-container-name'],
      );
      await handle.start();
      await assertSnapshots(handle);
    }, 60_000);

    it('refuses an illegal folder label instead of projecting it', async () => {
      spec.labels[GROUP_FOLDER_LABEL] = 'x'.repeat(64);
      // Isolate label grammar: the shared policy already refuses mounts whose
      // admission join uses an illegal folder, before runtime label projection.
      spec.containers[0].mounts = spec.containers[0].mounts.filter(
        (mount) => !mount.hostPath.startsWith(`${policy.groupsRoot}/`),
      );
      await expect(driver.prepare(spec)).rejects.toMatchObject({ kind: 'spec-invalid', retryable: false });
      expect(await list('pvc', installSelector())).toHaveLength(0);
      expect(await list(RESOURCE, installSelector())).toHaveLength(0);
    });

    it('enforces exactly one agent and the composed Block E refusal backstops', async () => {
      const auxiliary = fixtureAuxContainer();
      for (const mount of auxiliary.mounts) mount.hostPath = mount.hostPath.replace('/install', root);
      for (const containers of [
        [],
        [spec.containers[0], structuredClone(spec.containers[0])],
        [...spec.containers, auxiliary],
      ]) {
        await expect(driver.prepare({ ...spec, containers })).rejects.toMatchObject({
          kind: 'spec-invalid',
          retryable: false,
        });
      }
      for (const [name, mount] of [
        [
          'additionalMounts',
          {
            class: 'allowlisted-extra' as const,
            hostPath: join(root, 'operator-extra'),
            containerPath: '/workspace/extra',
          },
        ],
        [
          'plugins',
          {
            class: 'install-surface' as const,
            hostPath: join(policy.groupsRoot, 'agent-one/plugins'),
            containerPath: '/workspace/agent/plugins',
          },
        ],
        [
          'pond',
          { class: 'allowlisted-extra' as const, hostPath: join(root, 'pond'), containerPath: '/workspace/pond' },
        ],
      ] as const) {
        const refused = structuredClone(spec);
        refused.containers[0].mounts.push({ ...mount, mode: 'ro', groupScope: spec.key.agentGroupId });
        let error: unknown;
        try {
          await driver.prepare(refused);
        } catch (caught) {
          error = caught;
        }
        expect(error, name).toMatchObject({ kind: 'spec-invalid', retryable: false });
        expect(String(error)).toContain(mount.containerPath);
      }
      expect(await list(RESOURCE, installSelector())).toHaveLength(0);
      expect(await list('pvc', installSelector())).toHaveLength(0);
    });

    it('runs the same host-side MountPolicy checks before any API allocation', async () => {
      const invalid = structuredClone(spec);
      invalid.containers[0].mounts[0].hostPath = join(policy.dataRoot, 'v2-sessions/other-group/s1');
      invalid.containers[0].mounts[0].groupScope = 'other-group';
      expect(() => validateSpec(invalid, policy, driver.capabilities())).toThrow();
      const offline = new KubernetesSessionDriver({
        ...policy,
        kubeconfigPath: join(root, 'absent'),
        context: CONTEXT,
        namespace,
      });
      await expect(offline.prepare(invalid)).rejects.toMatchObject({ kind: 'denied-by-policy', retryable: false });
      const secret = structuredClone(spec);
      secret.containers[0].env.SERVICE_TOKEN = 'placeholder';
      await expect(offline.prepare(secret)).rejects.toMatchObject({ kind: 'denied-by-policy', retryable: false });
      expect(await list(RESOURCE, installSelector())).toHaveLength(0);
      expect(await list('pvc', installSelector())).toHaveLength(0);
    });

    it('listSessions reports progressing, live and terminal phases without handle status reads', async () => {
      spec.containers[0].args = ['sleep 4; exit 17'];
      const handle = await driver.prepare(spec);
      const statusRead = vi.spyOn(handle, 'status');
      const starting = handle.start();
      const outcome = starting.then(
        () => undefined,
        (error: unknown) => error,
      );
      const progressing = await eventually(
        () => driver.listSessions(spec.key.installSlug),
        (items) => items.some((item) => item.phase === 'starting'),
      );
      expect(progressing[0].handle.key).toEqual(spec.key);
      await outcome;
      await eventually(
        () => driver.listSessions(spec.key.installSlug),
        (items) => items.some((item) => item.phase === 'running'),
      );
      const terminal = await eventually(
        () => driver.listSessions(spec.key.installSlug),
        (items) => items.some((item) => item.phase === 'terminal'),
      );
      expect(terminal[0].failure).toMatchObject({ kind: 'started-then-died', exitCode: 17 });
      expect(statusRead).not.toHaveBeenCalled();
    }, 60_000);

    it('stop retains only the Block B objects and group PVC survives all teardown paths', async () => {
      // Named amendment (brief Blocks B/C): retention is explicitly permitted;
      // execution ends, retained objects leave discovery, storage is group-owned.
      const handle = await start();
      const storage = await pvc();
      await exec(handle, ['bash', '-c', 'printf persisted > /workspace/agent/persisted']);
      await handle.stop('conformance');
      await podGone(handle);
      expect(await handle.status()).toEqual({ phase: 'stopped' });
      expect(await driver.listSessions(spec.key.installSlug)).toHaveLength(0);
      expect((await get(RESOURCE, handle.name))?.spec.operatingMode).toBe('Suspended');
      expect(await list('secret', installSelector())).toHaveLength(1);
      expect((await pvc()).metadata.uid).toBe(storage.metadata.uid);
      expect(driver.listRetained).toBeTypeOf('function');
      const retained = await driver.listRetained!(spec.key.installSlug);
      expect(retained).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: spec.key, kind: 'session', state: 'stopped' }),
          expect.objectContaining({ key: { ...spec.key, sessionId: '' }, kind: 'group-storage' }),
        ]),
      );
      await driver.reapResidue!(spec.key.installSlug);
      expect(await get(RESOURCE, handle.name)).toBeDefined();
      const resumed = await driver.prepare(spec);
      await resumed.start();
      expect(await exec(resumed, ['cat', '/workspace/agent/persisted'])).toBe('persisted');
      await resumed.stop('conformance');
      await podGone(resumed);
      await driver.reapRetained!(spec.key.installSlug, [spec.key]);
      await driver.reapRetained!(spec.key.installSlug, [spec.key]);
      await eventually(
        () => get(RESOURCE, handle.name),
        (value) => !value,
      );
      await eventually(
        () => list('secret', installSelector()),
        (values) => values.length === 0,
      );
      expect((await pvc()).metadata.uid).toBe(storage.metadata.uid);
      const fresh = await start();
      expect(await exec(fresh, ['cat', '/workspace/agent/persisted'])).toBe('persisted');
      await ns(['delete', RESOURCE, fresh.name, '--wait=true', '--timeout=30s']);
      await podGone(fresh);
      expect((await pvc()).metadata.uid).toBe(storage.metadata.uid);
    }, 120_000);

    it('execSpec attaches live and raced teardown yields kubectl own error', async () => {
      const handle = await start();
      expect(await exec(handle, ['printf', 'attached'])).toBe('attached');
      const args = ['printf', 'raced'];
      const attach = handle.execSpec(args);
      expect(attach.argsTty.slice(-args.length)).toEqual(args);
      expect(attach.argsTty.some((arg) => ['-it', '-ti', '-t', '--tty'].includes(arg))).toBe(true);
      expect(attach.argsPlain.some((arg) => ['-it', '-ti', '-t', '--tty'].includes(arg))).toBe(false);
      await handle.stop('conformance');
      await podGone(handle);
      await expect(command(attach.bin, attach.argsPlain)).rejects.toThrow(
        /kubectl exited .*NotFound|kubectl exited .*not found/,
      );
    }, 60_000);

    it('forced agent crash emits one supervised terminal with started-then-died exit code', async () => {
      const handle = await withSessionEvents(driver).prepare(spec);
      const terminal = vi.fn();
      handle.onTerminal(terminal);
      await handle.start();
      await exec(handle, ['bash', '-c', 'read -r child rest < /proc/1/task/1/children; kill -KILL "$child"']).catch(
        () => {},
      );
      await eventually(
        () => handle.status(),
        (status) => status.phase === 'failed',
      );
      await eventually(
        async () => terminal.mock.calls.length,
        (calls) => calls === 1,
      );
      expect(await handle.status()).toMatchObject({
        phase: 'failed',
        failure: { kind: 'started-then-died', exitCode: 137 },
      });
      expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'started-then-died', exitCode: 137 });
      await delay(1000);
      expect(terminal).toHaveBeenCalledOnce();
    }, 60_000);

    it('multiple supervised handles share one informer and host stop suppresses terminal callbacks', async () => {
      const supervised = withSessionEvents(driver);
      const first = await supervised.prepare(spec);
      const callback = vi.fn();
      first.onTerminal(callback);
      await first.start();
      const adopted = (await supervised.listSessions(spec.key.installSlug))[0].handle;
      adopted.onTerminal(callback);
      expect(driver.watchSessions).toHaveBeenCalledOnce();
      await eventually(
        async () => informerCreations,
        (count) => count === 1,
      );
      await adopted.stop('host-requested');
      await podGone(adopted);
      await delay(1000);
      expect(callback).not.toHaveBeenCalled();
      expect(informerCreations).toBe(1);
    }, 60_000);

    it('fresh snapshots, rotated mailbox token, image, env and resources reach the resumed pod', async () => {
      const handle = await start();
      const oldPod = (await get('pod', handle.name))!;
      const contextMount = spec.containers[0].mounts.find((m) => m.containerPath === '/app/.nanoclaw-session.json')!;
      const oldContext = digest(await readFile(contextMount.hostPath));
      await handle.stop('conformance');
      await podGone(handle);
      await writeSnapshots(2);
      expect(digest(await readFile(contextMount.hostPath)) === oldContext).toBe(false);
      const alternate = `${image}-b2-${namespace.slice(-10)}`;
      await command('docker', ['exec', NODE, 'ctr', '-n', 'k8s.io', 'images', 'tag', image, alternate]);
      try {
        spec.containers[0].image = alternate;
        spec.containers[0].env.NANOCLAW_WAKE_REASON = 'resume';
        spec.containers[0].contributedEnv = {
          ...spec.containers[0].contributedEnv,
          HTTPS_PROXY: `http://placeholder@${hostAddress}:10256`,
        };
        spec.resources = { ...spec.resources, memoryMb: 320, cpus: '0.75', shmSizeMb: 96 };
        const resumed = await driver.prepare(spec);
        await resumed.start();
        const newPod = (await get('pod', resumed.name))!;
        expect(newPod.metadata.uid).not.toBe(oldPod.metadata.uid);
        const agent = (newPod.spec as unknown as PodSpec).containers.find((c) => c.name === 'agent')!;
        expect(agent.image).toBe(alternate);
        expect(agent.env).toEqual(
          expect.arrayContaining([
            { name: 'NANOCLAW_WAKE_REASON', value: 'resume' },
            { name: 'HTTPS_PROXY', value: spec.containers[0].contributedEnv!.HTTPS_PROXY },
          ]),
        );
        expect(agent.resources?.limits?.memory).toBe('320Mi');
        expect(['0.75', '750m']).toContain(agent.resources?.limits?.cpu);
        expect(
          (newPod.spec as unknown as PodSpec).volumes?.find((v) => v.emptyDir?.medium === 'Memory')?.emptyDir
            ?.sizeLimit,
        ).toBe('96Mi');
        await assertSnapshots(resumed);
      } finally {
        await command('docker', ['exec', NODE, 'ctr', '-n', 'k8s.io', 'images', 'rm', alternate]);
      }
    }, 90_000);

    it.each([0, 23])(
      'self-exit %i before first Ready maps stopped or failed with code',
      async (code) => {
        const handle = await driver.prepare(spec);
        await ns([
          'patch',
          RESOURCE,
          handle.name,
          '--type=merge',
          '-p',
          JSON.stringify({
            spec: {
              podTemplate: {
                spec: {
                  containers: [
                    {
                      ...(await get(RESOURCE, handle.name))!.spec.podTemplate!.spec.containers[0],
                      command: ['/usr/bin/tini', '--', 'bash', '-c'],
                      args: [`sleep 1; exit ${code}`],
                      readinessProbe: { exec: { command: ['false'] }, periodSeconds: 1 },
                    },
                  ],
                },
              },
            },
          }),
        ]);
        const result = await handle.start().then(
          () => undefined,
          (error: unknown) => error,
        );
        const status = await eventually(
          () => handle.status(),
          (value) => value.phase === 'stopped' || value.phase === 'failed',
        );
        const sandbox = (await get(RESOURCE, handle.name))!;
        expect(
          sandbox.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'),
        ).toBe(false);
        if (code === 0) expect(status).toEqual({ phase: 'stopped' });
        else {
          expect(result).toMatchObject({ kind: 'started-then-died', exitCode: code });
          expect(status).toMatchObject({ phase: 'failed', failure: { kind: 'started-then-died', exitCode: code } });
        }
      },
      60_000,
    );

    it('rapid stop then start waits for old pod UID deletion before new execution', async () => {
      const handle = await start();
      const old = (await get('pod', handle.name))!;
      const observed: { type: string; object: KubeObject }[] = [];
      const proc = spawn(
        'kubectl',
        [
          '--kubeconfig',
          kubeconfig,
          '--context',
          CONTEXT,
          '-n',
          namespace,
          'get',
          'pods',
          '--field-selector',
          `metadata.name=${handle.name}`,
          '--watch-only',
          '--output-watch-events',
          '-o',
          'json',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let buffer = '';
      proc.stdout.on('data', (bytes: Buffer) => {
        buffer += bytes.toString();
        // kubectl emits concatenated pretty JSON objects, not JSON lines.
        let depth = 0;
        let quoted = false;
        let escaped = false;
        let begin = -1;
        for (let i = 0; i < buffer.length; i++) {
          const ch = buffer[i];
          if (quoted) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') quoted = false;
            continue;
          }
          if (ch === '"') {
            quoted = true;
            continue;
          }
          if (ch === '{') {
            if (depth++ === 0) begin = i;
          }
          if (ch === '}' && --depth === 0 && begin >= 0) {
            observed.push(JSON.parse(buffer.slice(begin, i + 1)) as { type: string; object: KubeObject });
            buffer = buffer.slice(i + 1);
            i = -1;
            begin = -1;
          }
        }
      });
      try {
        await delay(500);
        await handle.stop('conformance');
        await handle.start();
        const renewed = (await get('pod', handle.name))!;
        expect(renewed.metadata.uid).not.toBe(old.metadata.uid);
        await eventually(
          async () => observed,
          (events) =>
            events.some((event) => event.type === 'ADDED' && event.object.metadata.uid === renewed.metadata.uid),
        );
        const deleted = observed.findIndex(
          (event) => event.type === 'DELETED' && event.object.metadata.uid === old.metadata.uid,
        );
        const added = observed.findIndex(
          (event) => event.type === 'ADDED' && event.object.metadata.uid === renewed.metadata.uid,
        );
        expect(deleted).toBeGreaterThanOrEqual(0);
        expect(added).toBeGreaterThan(deleted);
      } finally {
        proc.kill('SIGKILL');
        await new Promise<void>((done) => {
          if (proc.exitCode !== null || proc.signalCode !== null) done();
          else proc.once('close', () => done());
        });
      }
    }, 60_000);

    it('started-once distinguishes prepared ready from stopped after driver reconstruction', async () => {
      const handle = await driver.prepare(spec);
      expect(
        await driverFor()
          .prepare(spec)
          .then((adopted) => adopted.status()),
      ).toEqual({ phase: 'ready' });
      expect(await driver.listRetained!(spec.key.installSlug)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'session', state: 'prepared' })]),
      );
      await handle.start();
      const before = (await get(RESOURCE, handle.name))!.metadata.annotations ?? {};
      expect(Object.keys(before).some((key) => key.includes('started'))).toBe(true);
      await handle.stop('conformance');
      await podGone(handle);
      expect(
        await driverFor()
          .prepare(spec)
          .then((adopted) => adopted.status()),
      ).toEqual({ phase: 'stopped' });
    }, 60_000);

    it('two session ids in one group expose prepared and stopping state for the host fence (8b.2)', async () => {
      // The group admission mutex lives on the host. The seam must expose both
      // ids and retain stopping truth so the host cannot release it too early.
      expect(driver.capabilities().sessionsPerGroup).toBe('one');
      const secondSpec = structuredClone(spec);
      secondSpec.key.sessionId = 's2';
      for (const mount of secondSpec.containers[0].mounts) {
        mount.hostPath = mount.hostPath.replace('/s1', '/s2');
        if (mount.realization?.kind === 'group-volume')
          mount.realization.subPath = mount.realization.subPath.replace('/s1', '/s2');
      }
      for (const mount of secondSpec.containers[0].mounts.filter((m) => m.realization?.kind === 'file-snapshot')) {
        await mkdir(dirname(mount.hostPath), { recursive: true });
        await writeFile(mount.hostPath, 'fence snapshot');
      }
      const [first, second] = await Promise.all([driver.prepare(spec), driver.prepare(secondSpec)]);
      expect(first.name).not.toBe(second.name);
      expect(await list('pvc', installSelector())).toHaveLength(1);
      await first.start();
      await first.stop('conformance');
      const retained = await driver.listRetained!(spec.key.installSlug);
      const firstState = retained.find(
        (value) => value.kind === 'session' && value.key.sessionId === first.key.sessionId,
      );
      if (await get('pod', first.name)) expect(firstState?.state).toBe('stopping');
      else expect(['stopping', 'stopped']).toContain(firstState?.state);
      expect(retained).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: secondSpec.key, state: 'prepared' })]),
      );
      await podGone(first);
      await second.start();
      expect(await get('pod', first.name)).toBeUndefined();
      expect(await second.status()).toEqual({ phase: 'running' });
    }, 60_000);

    it('maps forced ErrImagePull to image-unavailable', async () => {
      spec.containers[0].image = '127.0.0.1:1/nanoclaw-missing:b2';
      const handle = await driver.prepare(spec);
      await expect(handle.start()).rejects.toMatchObject({ kind: 'image-unavailable', retryable: true });
      const pod = (await get('pod', handle.name))!;
      expect(JSON.stringify(pod.status)).toMatch(/ErrImagePull|ImagePullBackOff/);
      expect(await handle.status()).toMatchObject({
        phase: 'failed',
        failure: { kind: 'image-unavailable', retryable: true },
      });
    }, 60_000);

    it('maps unschedulable pod to resources-exhausted', async () => {
      driver = driverFor({ startTimeoutMs: 8000 });
      spec.resources = { ...spec.resources, cpus: '100000' };
      const handle = await driver.prepare(spec);
      await expect(handle.start()).rejects.toMatchObject({ kind: 'resources-exhausted', retryable: true });
      const pod = (await get('pod', handle.name))!;
      expect(pod.status?.conditions).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: 'Unschedulable' })]),
      );
    }, 60_000);

    it('gateway-owned sessionless objects are exempt from discovery and every sweep', async () => {
      const gateway = 'ncl-b2-gateway';
      await apply({
        apiVersion: 'agents.x-k8s.io/v1beta1',
        kind: 'Sandbox',
        metadata: {
          name: gateway,
          namespace,
          labels: { [LABELS.install]: spec.key.installSlug, [LABELS.role]: GATEWAY_ROLE },
        },
        spec: {
          operatingMode: 'Suspended',
          podTemplate: {
            spec: {
              containers: [{ name: 'gateway', image, command: ['sleep'], args: ['infinity'] }],
              restartPolicy: 'Never',
            },
          },
        },
      });
      await driver.reapResidue!(spec.key.installSlug);
      expect(await get(RESOURCE, gateway)).toBeDefined();
      expect(await driver.listSessions(spec.key.installSlug)).toHaveLength(0);
      expect((await driver.listRetained!(spec.key.installSlug)).some((value) => value.name === gateway)).toBe(false);
      await driver.reapRetained!(spec.key.installSlug, [{ ...spec.key, sessionId: '' }]);
      expect(await get(RESOURCE, gateway)).toBeDefined();
    });

    it('one watch subscription survives apiserver restart and emits forced and host-requested terminals', async () => {
      driver = driverFor({ startTimeoutMs: 90_000 });
      const events: SessionEvent[] = [];
      const watch = driver.watchSessions(spec.key.installSlug, (event) => events.push(event));
      try {
        const handle = await start();
        await eventually(
          async () => events.length,
          (count) => count > 0,
        );
        await chaos(async () => {
          await command('docker', ['exec', NODE, 'mv', MANIFEST, MOVED_MANIFEST]);
          try {
            await eventually(
              async () => {
                try {
                  await kubectl(['get', '--raw', '/readyz']);
                  return false;
                } catch {
                  return true;
                }
              },
              Boolean,
              45_000,
            );
            await expect(driverFor({ startTimeoutMs: 3000 }).listSessions(spec.key.installSlug)).rejects.toMatchObject({
              kind: 'runtime-unavailable',
              retryable: true,
            });
            await expect(driver.listRetained!(spec.key.installSlug)).rejects.toMatchObject({
              kind: 'runtime-unavailable',
              retryable: true,
            });
          } finally {
            await command('docker', ['exec', NODE, 'mv', MOVED_MANIFEST, MANIFEST]);
            await apiReady();
          }
        });
        events.length = 0;
        await crash(handle);
        await terminalHint(handle, events, 60_000);
        await handle.stop('conformance');
        await podGone(handle);
        const resumed = await driver.prepare(spec);
        await resumed.start();
        events.length = 0;
        await resumed.stop('host-requested');
        await podGone(resumed);
        await eventually(
          async () => events,
          (all) => all.some((event) => event.kind === 'terminal'),
          60_000,
        );
        events.length = 0;
        await driver.reapRetained!(spec.key.installSlug, [spec.key]);
        await eventually(
          async () => events,
          (all) => all.some((event) => event.kind === 'terminal'),
          60_000,
        );
        expect(driver.watchSessions).toHaveBeenCalledOnce();
        expect(informerCreations).toBe(1);
      } finally {
        watch.stop();
      }
    }, 600_000);

    it('the same watch recovers from a half-open paused node within a liveness bound', async () => {
      driver = driverFor({ startTimeoutMs: 90_000 });
      const events: SessionEvent[] = [];
      const watch = driver.watchSessions(spec.key.installSlug, (event) => events.push(event));
      try {
        const handle = await start();
        await eventually(
          async () => events.length,
          (count) => count > 0,
        );
        await chaos(async () => {
          const connectedBefore = informerConnections;
          await command('docker', ['pause', NODE]);
          try {
            await eventually(
              async () => informerConnections,
              (count) => count > connectedBefore,
              45_000,
            );
          } finally {
            await command('docker', ['unpause', NODE]);
            await apiReady();
          }
        });
        events.length = 0;
        await crash(handle);
        await terminalHint(handle, events, 90_000);
        expect(driver.watchSessions).toHaveBeenCalledOnce();
        expect(informerCreations).toBe(1);
      } finally {
        watch.stop();
      }
    }, 600_000);

    it('a deleted CRD maps runtime-unavailable and is restored in finally', async () => {
      await chaos(async () => {
        // CRD deletion is cluster-wide: refuse to destroy another lane's objects.
        const all = JSON.parse(await kubectl(['get', RESOURCE, '-A', '-o', 'json'])) as { items: KubeObject[] };
        expect(all.items, 'CRD chaos requires no Sandboxes from any lane').toHaveLength(0);
        const saved = JSON.parse(await kubectl(['get', 'crd', CRD, '-o', 'json'])) as Record<string, unknown> & {
          metadata: Record<string, unknown>;
        };
        saved.metadata = { name: CRD };
        delete saved.status;
        try {
          await kubectl(['delete', 'crd', CRD, '--wait=true', '--timeout=30s']);
          await expect(driver.prepare(spec)).rejects.toMatchObject({ kind: 'runtime-unavailable', retryable: true });
        } finally {
          await kubectl(['apply', '-f', '-'], JSON.stringify(saved));
          await kubectl(['wait', '--for=condition=Established', `crd/${CRD}`, '--timeout=30s']);
        }
        const restored = driverFor();
        const handle = await eventually(
          () => restored.prepare(spec),
          () => true,
          90_000,
        );
        await handle.start();
        expect(await handle.status()).toEqual({ phase: 'running' });
      });
    }, 150_000);
  });
}
