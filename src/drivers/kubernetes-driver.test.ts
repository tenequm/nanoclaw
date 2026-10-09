import fs from 'fs';
import os from 'os';
import path from 'path';

import * as k8s from '@kubernetes/client-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { armSessionLifecycle } from '../container-runner.js';
import {
  KubernetesSessionDriver,
  SECRET_LIMIT_BYTES,
  STARTED_ONCE,
  groupPvcName,
  kubernetesFailure,
  kubernetesName,
  kubernetesNamespace,
  sandboxManifest,
  sandboxPhase,
  secretName,
  type KubernetesDriverOptions,
  type Sandbox,
} from './kubernetes-driver.js';
import { projectLabels } from './label-projection.js';
import { withSessionEvents } from './session-events.js';
import { FIXTURE_GROUP_VOLUME_CAPABILITIES, fixtureGroupVolumeSpec } from './spec-fixture.js';
import { LABELS, type SessionEvent } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});
const notFound = () => Object.assign(new Error('NotFound'), { code: 404 });

function harness(options: Partial<KubernetesDriverOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kubernetes-driver-'));
  dirs.push(root);
  const spec = fixtureGroupVolumeSpec({}, { longFolder: true });
  for (const mount of spec.containers[0].mounts) {
    mount.hostPath = path.join(root, mount.hostPath.slice('/install/'.length));
    if (mount.realization?.kind === 'file-snapshot') {
      fs.mkdirSync(path.dirname(mount.hostPath), { recursive: true });
      fs.writeFileSync(mount.hostPath, 'old');
    } else fs.mkdirSync(mount.hostPath, { recursive: true });
  }
  const boxes = new Map<string, Sandbox>();
  const pods = new Map<string, k8s.V1Pod>();
  const pvcs = new Map<string, k8s.V1PersistentVolumeClaim>();
  const secrets = new Map<string, k8s.V1Secret>();
  let podCount = 0;
  const setConditions = (box: Sandbox) => {
    const ready = box.spec.operatingMode === 'Running';
    box.status = {
      conditions: [
        {
          type: 'Suspended',
          status: ready ? 'False' : 'True',
          reason: 'Suspended',
          message: '',
          lastTransitionTime: new Date(),
          observedGeneration: box.metadata.generation,
        },
        {
          type: 'Ready',
          status: ready ? 'True' : 'False',
          reason: ready ? 'DependenciesReady' : 'Suspended',
          message: '',
          lastTransitionTime: new Date(),
          observedGeneration: box.metadata.generation,
        },
      ],
    };
  };
  const core = {
    readNamespace: vi.fn(async () => ({ metadata: { name: 'nanoclaw-test-b1-unit' } })),
    createNamespace: vi.fn(async () => ({})),
    readNamespacedPersistentVolumeClaim: vi.fn(async ({ name }: { name: string }) => {
      const pvc = pvcs.get(name);
      if (!pvc) throw notFound();
      return structuredClone(pvc);
    }),
    createNamespacedPersistentVolumeClaim: vi.fn(async ({ body }: { body: k8s.V1PersistentVolumeClaim }) => {
      const pvc = { ...body, status: { phase: 'Pending' } };
      pvcs.set(body.metadata!.name!, pvc);
      return structuredClone(pvc);
    }),
    listNamespacedPersistentVolumeClaim: vi.fn(async () => ({ items: [...pvcs.values()] })),
    readNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
      const pod = pods.get(name);
      if (!pod) throw notFound();
      return structuredClone(pod);
    }),
    listNamespacedPod: vi.fn(async () => ({ items: [...pods.values()] })),
    readNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
      const secret = secrets.get(name);
      if (!secret) throw notFound();
      return structuredClone(secret);
    }),
    createNamespacedSecret: vi.fn(async ({ body }: { body: k8s.V1Secret }) => {
      secrets.set(body.metadata!.name!, structuredClone(body));
      return body;
    }),
    replaceNamespacedSecret: vi.fn(async ({ body }: { body: k8s.V1Secret }) => {
      secrets.set(body.metadata!.name!, structuredClone(body));
      return body;
    }),
  };
  const custom = {
    getNamespacedCustomObject: vi.fn(async ({ name }: { name: string }) => {
      const box = boxes.get(name);
      if (!box) throw notFound();
      return structuredClone(box);
    }),
    listNamespacedCustomObject: vi.fn(async () => ({
      metadata: { resourceVersion: '1' },
      items: structuredClone([...boxes.values()]),
    })),
    createNamespacedCustomObject: vi.fn(async ({ body }: { body: Sandbox }) => {
      const box = structuredClone(body);
      Object.assign(box.metadata, { uid: 'sandbox-uid', generation: 1, resourceVersion: '1' });
      setConditions(box);
      boxes.set(box.metadata.name!, box);
      return structuredClone(box);
    }),
    patchNamespacedCustomObject: vi.fn(async ({ name, body }: { name: string; body: Partial<Sandbox> }) => {
      const box = boxes.get(name)!;
      if (body.spec) {
        Object.assign(box.spec, body.spec);
        for (const [key, value] of Object.entries(box.spec.podTemplate.metadata?.labels ?? {}))
          if (value === null) delete box.spec.podTemplate.metadata!.labels![key];
        box.metadata.generation = (box.metadata.generation ?? 0) + 1;
      }
      if (body.metadata) {
        box.metadata.labels = { ...box.metadata.labels, ...body.metadata.labels };
        for (const [key, value] of Object.entries(box.metadata.labels))
          if (value === null) delete box.metadata.labels[key];
        box.metadata.annotations = { ...box.metadata.annotations, ...body.metadata.annotations };
      }
      if (body.spec?.operatingMode === 'Running') {
        pods.set(name, {
          metadata: { name, uid: `pod-${++podCount}`, labels: box.metadata.labels },
          status: { phase: 'Running' },
          spec: box.spec.podTemplate.spec,
        });
        for (const pvc of pvcs.values()) pvc.status = { phase: 'Bound' };
      } else if (body.spec?.operatingMode === 'Suspended') pods.delete(name);
      box.metadata.resourceVersion = String(Number(box.metadata.resourceVersion) + 1);
      setConditions(box);
      return structuredClone(box);
    }),
    deleteNamespacedCustomObject: vi.fn(async ({ name, body }: { name: string; body: k8s.V1DeleteOptions }) => {
      const box = boxes.get(name);
      if (!box) throw notFound();
      if (
        (body.preconditions?.uid && body.preconditions.uid !== box.metadata.uid) ||
        (body.preconditions?.resourceVersion && body.preconditions.resourceVersion !== box.metadata.resourceVersion)
      )
        throw Object.assign(new Error('Conflict'), { code: 409 });
      boxes.delete(name);
      pods.delete(name);
      for (const [key, secret] of secrets)
        if (secret.metadata?.ownerReferences?.some((o) => o.name === name)) secrets.delete(key);
      return {};
    }),
  };
  const driver = new KubernetesSessionDriver({
    groupsRoot: path.join(root, 'groups'),
    dataRoot: path.join(root, 'data'),
    surfaceRoots: [path.join(root, 'container')],
    materialsRoot: path.join(root, 'data/session-materials'),
    gatewayTrustRoot: path.join(root, 'data/gateway-trust'),
    kubeconfigPath: '/explicit/kind.yaml',
    context: 'kind-nanoclaw-dev',
    namespace: 'nanoclaw-test-b1-unit',
    hostAddress: '192.168.97.254',
    coreApi: core as unknown as k8s.CoreV1Api,
    customObjectsApi: custom as unknown as k8s.CustomObjectsApi,
    startTimeoutMs: 30,
    pollIntervalMs: 1,
    ...options,
  });
  return { root, spec, driver, core, custom, boxes, pods, pvcs, secrets };
}

function setCondition(
  box: Sandbox,
  type: string,
  status: string,
  reason: string,
  observedGeneration = box.metadata.generation,
) {
  box.status ??= {};
  box.status.conditions ??= [];
  box.status.conditions = box.status.conditions.filter((c) => c.type !== type);
  box.status.conditions.push({ type, status, reason, message: '', lastTransitionTime: new Date(), observedGeneration });
}

describe('kubernetes driver manifests', () => {
  it('declares A1 capabilities field for field', () => {
    expect(harness().driver.capabilities()).toEqual(FIXTURE_GROUP_VOLUME_CAPABILITIES);
  });
  it('uses stable RFC1123 names and separates normalized collisions', () => {
    expect(kubernetesName('NCL_A'.repeat(30), 'original')).toMatch(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/);
    expect(kubernetesName('ncl-a', 'a')).not.toBe(kubernetesName('ncl-a', 'b'));
    expect(kubernetesNamespace('UPPER_slug')).toBe('nanoclaw-upper-slug');
    expect(kubernetesNamespace('x'.repeat(100))).toHaveLength(63);
  });
  it('names depend on key values, never JavaScript object property order', () => {
    const h = harness();
    const reordered = {
      sessionId: h.spec.key.sessionId,
      agentGroupId: h.spec.key.agentGroupId,
      installSlug: h.spec.key.installSlug,
    };
    expect(h.driver.runtimeName(reordered)).toBe(h.driver.runtimeName(h.spec.key));
    expect(secretName(reordered)).toBe(secretName(h.spec.key));
  });

  it('group PVC names are independent of session ids', () => {
    const { key } = fixtureGroupVolumeSpec();
    expect(groupPvcName(key)).toBe(groupPvcName({ ...key, sessionId: 'other' }));
    expect(groupPvcName(key)).not.toBe(groupPvcName({ ...key, agentGroupId: 'other' }));
  });
  it('projects the same labels onto Sandbox and podTemplate', () => {
    const spec = fixtureGroupVolumeSpec({}, { longFolder: true });
    const box = sandboxManifest(spec, 'nanoclaw-spike');
    expect(box.metadata.labels).toEqual(box.spec.podTemplate.metadata!.labels);
    expect(box.metadata.labels!['nanoclaw-group-folder']).toBe(spec.labels['nanoclaw-group-folder']);
    expect(box.metadata.labels!['nanoclaw-container-name']).toHaveLength(63);
    expect(box.metadata.labels![LABELS.session]).toBe('s1');
  });
  it('maps PVC directories and every readonly file to separate subPaths', () => {
    const spec = fixtureGroupVolumeSpec();
    const pod = sandboxManifest(spec, 'nanoclaw-spike').spec.podTemplate.spec!;
    const mounts = pod.containers[0].volumeMounts!;
    for (const mount of spec.containers[0].mounts) {
      const realized = mounts.find((m) => m.mountPath === mount.containerPath)!;
      expect(realized.readOnly).toBe(mount.mode === 'ro');
      if (mount.realization?.kind === 'group-volume') expect(realized.subPath).toBe(mount.realization.subPath);
      else {
        expect(realized.name).toBe('session-files');
        expect(realized.subPath).toMatch(/^file-/);
      }
    }
    expect(pod.volumes!.find((v) => v.name === 'session-files')!.secret!.defaultMode).toBe(0o444);
    expect(pod.volumes!.find((v) => v.name === 'group-state')!.persistentVolumeClaim!.claimName).toBe(
      groupPvcName(spec.key),
    );
  });
  it('realizes standard posture, resources and tini', () => {
    const spec = fixtureGroupVolumeSpec({ resources: { memoryMb: 2048, cpus: '0.5', shmSizeMb: 64 } });
    const pod = sandboxManifest(spec, 'nanoclaw-spike').spec.podTemplate.spec!;
    expect(pod.restartPolicy).toBe('Never');
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsUser: 1000, fsGroup: 1000 });
    expect(pod.containers[0].securityContext).toMatchObject({
      capabilities: { drop: ['ALL'] },
      allowPrivilegeEscalation: false,
    });
    expect(pod.containers[0].command).toEqual(['/usr/bin/tini', '--', 'bash', '-c']);
    expect(pod.containers[0].resources!.limits).toEqual({ memory: '2048Mi', cpu: '0.5' });
    expect(pod.volumes!.find((v) => v.name === 'shm')!.emptyDir).toEqual({ medium: 'Memory', sizeLimit: '64Mi' });
    expect(pod.initContainers![0].securityContext).toEqual(pod.containers[0].securityContext);
  });
  it('mounts one source ImageVolume in agent and provider init, or none in baked mode', () => {
    const spec = fixtureGroupVolumeSpec({}, { surfaceImage: true });
    const pod = sandboxManifest(spec, 'nanoclaw-spike').spec.podTemplate.spec!;
    expect(pod.volumes!.find((v) => v.name === 'surfaces')!.image).toEqual({
      reference: spec.containers[0].surfaceImage!.image,
      pullPolicy: 'IfNotPresent',
    });
    expect(pod.containers[0].volumeMounts!.filter((m) => m.name === 'surfaces').map((m) => m.subPath)).toEqual([
      'src',
      'skills',
    ]);
    expect(pod.initContainers![0].volumeMounts!.filter((m) => m.name === 'surfaces')).toHaveLength(2);
    expect(sandboxManifest(fixtureGroupVolumeSpec(), 'ns').spec.podTemplate.spec!.volumes!.some((v) => v.image)).toBe(
      false,
    );
  });
  it('contributed environment wins collisions', () => {
    const spec = fixtureGroupVolumeSpec();
    spec.containers[0].contributedEnv = { TZ: 'Europe/Lisbon' };
    expect(
      sandboxManifest(spec, 'ns').spec.podTemplate.spec!.containers[0].env!.filter((e) => e.name === 'TZ'),
    ).toEqual([{ name: 'TZ', value: 'Europe/Lisbon' }]);
  });
});

describe('kubernetes driver lifecycle', () => {
  it('prepares idempotently while the standalone PVC remains Pending', async () => {
    const h = harness();
    const first = await h.driver.prepare(h.spec);
    const second = await h.driver.prepare(h.spec);
    expect(first.name).toBe(second.name);
    expect(await first.status()).toEqual({ phase: 'ready' });
    expect(h.custom.createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const pvc = [...h.pvcs.values()][0];
    expect(pvc.status!.phase).toBe('Pending');
    expect(pvc.metadata!.ownerReferences).toBeUndefined();
    expect(pvc.spec!.storageClassName).toBeUndefined();
    expect(pvc.spec!.resources!.requests).toEqual({ storage: '20Gi' });
    expect(pvc.spec!.accessModes).toEqual(['ReadWriteOnce']);
  });
  it('snapshots composed and gateway files with Sandbox ownership and projected labels', async () => {
    const h = harness();
    await h.driver.prepare(h.spec);
    const secret = h.secrets.get(secretName(h.spec.key))!;
    expect(Object.keys(secret.data!)).toHaveLength(6);
    expect(Object.values(secret.data!).every((value) => Buffer.from(value, 'base64').toString() === 'old')).toBe(true);
    expect(secret.metadata!.ownerReferences).toEqual([
      {
        apiVersion: 'agents.x-k8s.io/v1beta1',
        kind: 'Sandbox',
        name: h.driver.runtimeName(h.spec.key),
        uid: 'sandbox-uid',
        controller: true,
      },
    ]);
    expect(secret.metadata!.labels).toEqual([...h.boxes.values()][0].metadata.labels);
  });
  it('starts and stamps persistent started-once after Ready', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    expect(await handle.status()).toEqual({ phase: 'running' });
    expect([...h.boxes.values()][0].metadata.annotations![STARTED_ONCE]).toBe('true');
  });
  it('removes lineage labels that are absent from a refreshed suspended spec', async () => {
    const h = harness();
    h.spec.labels['temporary-lineage'] = 'old';
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    await handle.stop('refresh');
    delete h.spec.labels['temporary-lineage'];
    await h.driver.prepare(h.spec);
    const box = h.boxes.get(handle.name)!;
    expect(box.metadata.labels).not.toHaveProperty('temporary-lineage');
    expect(box.spec.podTemplate.metadata!.labels).not.toHaveProperty('temporary-lineage');
    expect(h.secrets.get(secretName(h.spec.key))!.metadata!.labels).not.toHaveProperty('temporary-lineage');
  });

  it('syncs latest bytes at start even without another prepare', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    fs.writeFileSync(h.spec.containers[0].mounts[1].hostPath, 'changed');
    await handle.start();
    expect(Buffer.from(h.secrets.get(secretName(h.spec.key))!.data!['file-0'], 'base64').toString()).toBe('changed');
  });
  it('suspends execution, excludes retained sessions, preserves PVC and Secret', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    await handle.stop('idle');
    expect(await handle.status()).toEqual({ phase: 'stopped' });
    expect(await h.driver.listSessions('spike')).toEqual([]);
    expect(h.pvcs.size).toBe(1);
    expect(h.secrets.size).toBe(1);
    expect((await h.driver.listRetained('spike')).map((r) => [r.kind, r.state])).toEqual([
      ['session', 'stopped'],
      ['group-storage', undefined],
    ]);
  });
  it('updates suspended templates and bytes then resumes on a new pod UID', async () => {
    const h = harness();
    let handle = await h.driver.prepare(h.spec);
    await handle.start();
    const oldUid = h.pods.get(handle.name)!.metadata!.uid;
    await handle.stop('idle');
    h.spec.containers[0].env.NANOCLAW_WAKE_REASON = 'resume';
    h.spec.resources.cpus = '2';
    fs.writeFileSync(h.spec.containers[0].mounts[1].hostPath, 'new');
    handle = await h.driver.prepare(h.spec);
    await handle.start();
    expect(h.pods.get(handle.name)!.metadata!.uid).not.toBe(oldUid);
    expect(h.pods.get(handle.name)!.spec!.containers[0].resources!.limits!.cpu).toBe('2');
    expect(h.pods.get(handle.name)!.spec!.containers[0].env).toContainEqual({
      name: 'NANOCLAW_WAKE_REASON',
      value: 'resume',
    });
    expect(Buffer.from(h.secrets.get(secretName(h.spec.key))!.data!['file-0'], 'base64').toString()).toBe('new');
  });
  it('does not mutate a live incarnation or re-read deleted sources', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    const before = structuredClone([...h.boxes.values()][0]);
    const writes = h.core.replaceNamespacedSecret.mock.calls.length;
    h.spec.containers[0].env.TZ = 'other';
    fs.unlinkSync(h.spec.containers[0].mounts[1].hostPath);
    const adopted = await h.driver.prepare(h.spec);
    await adopted.start();
    expect([...h.boxes.values()][0].spec).toEqual(before.spec);
    expect(h.core.replaceNamespacedSecret.mock.calls.length).toBe(writes);
  });
  it.each([0, 7])('handles exit %i before Ready without inventing a clean-exit failure', async (code) => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    const patch = h.custom.patchNamespacedCustomObject.getMockImplementation()!;
    h.custom.patchNamespacedCustomObject.mockImplementation(async (input) => {
      const result = await patch(input);
      if (input.body.spec?.operatingMode === 'Running') {
        const pod = h.pods.get(handle.name)!;
        pod.status = {
          phase: code ? 'Failed' : 'Succeeded',
          containerStatuses: [
            {
              name: 'agent',
              image: 'test',
              imageID: 'test',
              ready: false,
              restartCount: 0,
              state: { terminated: { exitCode: code } },
            },
          ],
        };
        setCondition(h.boxes.get(handle.name)!, 'Ready', 'False', code ? 'PodFailed' : 'PodSucceeded');
      }
      return result;
    });
    if (code) {
      await expect(handle.start()).rejects.toMatchObject({ kind: 'started-then-died', exitCode: code });
      await handle.stop('cleanup');
      expect(await handle.status()).toEqual({ phase: 'stopped' });
    } else {
      await handle.start();
      expect(await handle.status()).toEqual({ phase: 'stopped' });
      await handle.stop('cleanup');
      expect(await handle.status()).toEqual({ phase: 'stopped' });
    }
  });

  it('refuses to dress a missing or terminating pod as running in discovery', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    h.pods.get(handle.name)!.metadata!.deletionTimestamp = new Date();
    expect((await h.driver.listSessions('spike'))[0].phase).toBe('starting');
    h.pods.delete(handle.name);
    expect((await h.driver.listSessions('spike'))[0].phase).toBe('starting');
  });

  it('reports real unschedulability promptly rather than waiting the startup bound', async () => {
    const h = harness({ startTimeoutMs: 90_000 });
    const handle = await h.driver.prepare(h.spec);
    const patch = h.custom.patchNamespacedCustomObject.getMockImplementation()!;
    h.custom.patchNamespacedCustomObject.mockImplementation(async (input) => {
      const result = await patch(input);
      if (input.body.spec?.operatingMode === 'Running')
        h.pods.get(handle.name)!.status = {
          phase: 'Pending',
          conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient cpu' }],
        };
      return result;
    });
    await expect(handle.start()).rejects.toMatchObject({ kind: 'resources-exhausted' });
  });

  it('blocks resume until current-generation suspension and old pod deletion', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    const box = h.boxes.get(handle.name)!;
    box.metadata.generation = 2;
    setCondition(box, 'Suspended', 'True', 'Suspended', 1);
    h.pods.set(handle.name, { metadata: { name: handle.name, uid: 'old' }, status: { phase: 'Running' } });
    await expect(handle.start()).rejects.toMatchObject({ kind: 'runtime-unavailable', retryable: true });
    expect(h.custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });
  it('does not accept stale Ready from an old generation', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    const box = h.boxes.get(handle.name)!;
    box.metadata.generation!++;
    setCondition(box, 'Ready', 'True', 'DependenciesReady', box.metadata.generation! - 1);
    expect(await handle.status()).toEqual({ phase: 'preparing' });
  });
  it('reports stale controller generation as runtime-unavailable after the deadline', async () => {
    const h = harness({ controllerTimeoutMs: 0 });
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    const box = h.boxes.get(handle.name)!;
    box.metadata.generation!++;
    expect(await handle.status()).toMatchObject({
      phase: 'failed',
      failure: { kind: 'runtime-unavailable', retryable: true },
    });
  });
  it('fences two racing session starts on the same group volume', async () => {
    const h = harness();
    const first = await h.driver.prepare(h.spec);
    const second = await h.driver.prepare({ ...h.spec, key: { ...h.spec.key, sessionId: 's2' } });
    const result = await Promise.allSettled([first.start(), second.start()]);
    expect(result[0].status).toBe('fulfilled');
    expect(result[1]).toMatchObject({ status: 'rejected', reason: { kind: 'resources-exhausted' } });
    expect(h.pods.size).toBe(1);
  });
  it('describes an explicit kubeconfig/context exec argv without executing', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    const reads = h.core.readNamespacedPod.mock.calls.length;
    const exec = handle.execSpec(['bash', '-lc', 'echo hi']);
    expect(exec.argsPlain).toEqual([
      '--kubeconfig',
      '/explicit/kind.yaml',
      '--context',
      'kind-nanoclaw-dev',
      '-n',
      'nanoclaw-test-b1-unit',
      'exec',
      handle.name,
      '-c',
      'agent',
      '--',
      'bash',
      '-lc',
      'echo hi',
    ]);
    expect(exec.argsTty).toContain('-it');
    expect(h.core.readNamespacedPod.mock.calls.length).toBe(reads);
  });
  it('reaps only host-named retained sessions, never group storage', async () => {
    const h = harness();
    await h.driver.prepare(h.spec);
    await h.driver.reapResidue('spike');
    expect(h.boxes.size).toBe(1);
    await h.driver.reapRetained('spike', [
      { ...h.spec.key, installSlug: 'other' },
      { ...h.spec.key, sessionId: '' },
    ]);
    expect(h.boxes.size).toBe(1);
    await h.driver.reapRetained('spike', [h.spec.key]);
    expect(h.boxes.size).toBe(0);
    expect(h.secrets.size).toBe(0);
    expect(h.pvcs.size).toBe(1);
    await h.driver.reapRetained('spike', [h.spec.key]);
  });
  it.each(['retained', 'residue'] as const)('does not reap a resumed session after %s observation', async (path) => {
    const h = harness();
    let handle = await h.driver.prepare(h.spec);
    await handle.start();
    if (path === 'retained') await handle.stop('idle');
    else setCondition(h.boxes.get(handle.name)!, 'Finished', 'True', 'PodFailed');
    let release!: () => void;
    let observed!: () => void;
    const observation = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = h.custom.listNamespacedCustomObject.getMockImplementation()!;
    h.custom.listNamespacedCustomObject.mockImplementationOnce(async () => {
      const result = await list();
      observed();
      await gate;
      return result;
    });
    const cleanup = path === 'retained' ? h.driver.reapRetained('spike', [h.spec.key]) : h.driver.reapResidue('spike');
    await observation;
    await handle.stop('resume');
    handle = await h.driver.prepare(h.spec);
    await handle.start();
    expect(await handle.status()).toEqual({ phase: 'running' });
    release();
    await cleanup;
    expect(h.boxes.has(handle.name)).toBe(true);
    expect(h.secrets.size).toBe(1);
    expect(h.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it.each(['retained', 'residue'] as const)(
    'does not reap a replacement Sandbox after %s observation',
    async (path) => {
      const h = harness();
      const handle = await h.driver.prepare(h.spec);
      if (path === 'residue') {
        await handle.start();
        setCondition(h.boxes.get(handle.name)!, 'Finished', 'True', 'PodFailed');
      }
      const list = h.custom.listNamespacedCustomObject.getMockImplementation()!;
      h.custom.listNamespacedCustomObject.mockImplementationOnce(async () => {
        const result = await list();
        h.boxes.get(handle.name)!.metadata.uid = 'replacement-uid';
        return result;
      });
      if (path === 'retained') await h.driver.reapRetained('spike', [h.spec.key]);
      else await h.driver.reapResidue('spike');
      expect(h.boxes.get(handle.name)?.metadata.uid).toBe('replacement-uid');
      expect(h.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    },
  );

  it.each(['retained', 'residue'] as const)(
    'skips %s deletion on concurrent resourceVersion conflict',
    async (path) => {
      const h = harness();
      const handle = await h.driver.prepare(h.spec);
      if (path === 'residue') {
        await handle.start();
        setCondition(h.boxes.get(handle.name)!, 'Finished', 'True', 'PodFailed');
      }
      const remove = h.custom.deleteNamespacedCustomObject.getMockImplementation()!;
      const box = h.boxes.get(handle.name)!;
      const version = box.metadata.resourceVersion;
      h.custom.deleteNamespacedCustomObject.mockImplementationOnce(async (input) => {
        box.spec.operatingMode = 'Running';
        box.metadata.resourceVersion = String(Number(version) + 1);
        return remove(input);
      });
      if (path === 'retained') await h.driver.reapRetained('spike', [h.spec.key]);
      else await h.driver.reapResidue('spike');
      expect(h.boxes.has(handle.name)).toBe(true);
      expect(h.custom.deleteNamespacedCustomObject).toHaveBeenCalledTimes(1);
      expect(h.custom.deleteNamespacedCustomObject.mock.calls[0][0].body.preconditions).toEqual({
        uid: 'sandbox-uid',
        resourceVersion: version,
      });
    },
  );

  it.each(['retained', 'residue'] as const)('revalidates current %s eligibility before deletion', async (path) => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    if (path === 'residue') {
      await handle.start();
      setCondition(h.boxes.get(handle.name)!, 'Finished', 'True', 'PodFailed');
    }
    const list = h.custom.listNamespacedCustomObject.getMockImplementation()!;
    h.custom.listNamespacedCustomObject.mockImplementationOnce(async () => {
      const result = await list();
      const box = h.boxes.get(handle.name)!;
      if (path === 'retained') setCondition(box, 'Suspended', 'False', 'Suspending');
      else setCondition(box, 'Finished', 'False', 'Running');
      return result;
    });
    if (path === 'retained') await h.driver.reapRetained('spike', [h.spec.key]);
    else await h.driver.reapResidue('spike');
    expect(h.boxes.has(handle.name)).toBe(true);
    expect(h.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('resets a stale deadline on generation change without a suspension observation', async () => {
    const h = harness({ controllerTimeoutMs: 50 });
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    const box = h.boxes.get(handle.name)!;
    box.metadata.generation!++;
    box.metadata.annotations!['nanoclaw.dev/spec-updated-at'] = new Date(Date.now() - 1000).toISOString();
    expect(await handle.status()).toMatchObject({ phase: 'failed', failure: { kind: 'runtime-unavailable' } });
    box.metadata.generation!++;
    box.metadata.annotations!['nanoclaw.dev/spec-updated-at'] = new Date().toISOString();
    expect(await handle.status()).toEqual({ phase: 'preparing' });
  });

  it.each(['retained', 'residue'] as const)('serializes %s revalidation with lifecycle operations', async (path) => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    if (path === 'residue') {
      await handle.start();
      setCondition(h.boxes.get(handle.name)!, 'Finished', 'True', 'PodFailed');
    }
    let release!: () => void;
    let observed!: () => void;
    const observation = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = h.custom.getNamespacedCustomObject.getMockImplementation()!;
    h.custom.getNamespacedCustomObject.mockImplementationOnce(async (input) => {
      observed();
      await gate;
      return read(input);
    });
    const cleanup = path === 'retained' ? h.driver.reapRetained('spike', [h.spec.key]) : h.driver.reapResidue('spike');
    await observation;
    let stopped = false;
    const stop = handle.stop('cleanup').then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);
    release();
    await Promise.all([cleanup, stop]);
    expect(h.boxes.size).toBe(0);
  });

  it('gives a resumed generation a fresh controller deadline after outage recovery', async () => {
    const h = harness({ controllerTimeoutMs: 50, startTimeoutMs: 200 });
    let handle = await h.driver.prepare(h.spec);
    await handle.start();
    const box = h.boxes.get(handle.name)!;
    box.metadata.generation!++;
    box.metadata.annotations!['nanoclaw.dev/spec-updated-at'] = new Date(Date.now() - 1000).toISOString();
    expect(await handle.status()).toMatchObject({ phase: 'failed', failure: { kind: 'runtime-unavailable' } });
    await handle.stop('controller-recovered');
    handle = await h.driver.prepare(h.spec);
    const patch = h.custom.patchNamespacedCustomObject.getMockImplementation()!;
    h.custom.patchNamespacedCustomObject.mockImplementation(async (input) => {
      const result = await patch(input);
      if (input.body.spec?.operatingMode === 'Running') {
        setCondition(box, 'Ready', 'True', 'DependenciesReady', box.metadata.generation! - 1);
        setTimeout(() => setCondition(box, 'Ready', 'True', 'DependenciesReady'), 10);
      }
      return result;
    });
    await handle.start();
    expect(await handle.status()).toEqual({ phase: 'running' });
  });

  it('reports clean exit and failure before Ready with exact exit codes', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    const pod = h.pods.get(handle.name)!;
    pod.status = {
      phase: 'Failed',
      containerStatuses: [
        {
          name: 'agent',
          image: 'test',
          imageID: 'test',
          ready: false,
          restartCount: 0,
          state: { terminated: { exitCode: 7 } },
        },
      ],
    };
    expect(await handle.status()).toEqual({
      phase: 'failed',
      failure: { kind: 'started-then-died', retryable: false, exitCode: 7 },
    });
    setCondition(h.boxes.get(handle.name)!, 'Ready', 'False', 'PodFailed');
    expect(await handle.status()).toMatchObject({ phase: 'failed', failure: { exitCode: 7 } });
    pod.status.phase = 'Succeeded';
    pod.status.containerStatuses![0].state!.terminated!.exitCode = 0;
    expect(await handle.status()).toEqual({ phase: 'stopped' });
  });
  it('maps image pull, unschedulable and pod-waiting PVC Pending', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    const pod = h.pods.get(handle.name)!;
    pod.status = {
      phase: 'Pending',
      containerStatuses: [
        {
          name: 'agent',
          image: 'test',
          imageID: 'test',
          ready: false,
          restartCount: 0,
          state: { waiting: { reason: 'ErrImagePull' } },
        },
      ],
    };
    expect(await handle.status()).toMatchObject({ phase: 'failed', failure: { kind: 'image-unavailable' } });
    pod.status = { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] };
    expect(await handle.status()).toMatchObject({ phase: 'failed', failure: { kind: 'resources-exhausted' } });
    pod.status = { phase: 'Pending' };
    setCondition(h.boxes.get(handle.name)!, 'Ready', 'False', 'DependenciesNotReady');
    [...h.pvcs.values()][0].status = { phase: 'Pending' };
    expect(await handle.status()).toMatchObject({ phase: 'failed', failure: { kind: 'resources-exhausted' } });
  });
  it('bulk joins pods for terminal discovery without per-handle reads', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    h.pods.get(handle.name)!.status = {
      phase: 'Failed',
      containerStatuses: [
        {
          name: 'agent',
          image: 'test',
          imageID: 'test',
          ready: false,
          restartCount: 0,
          state: { terminated: { exitCode: 9 } },
        },
      ],
    };
    const calls = h.core.readNamespacedPod.mock.calls.length;
    expect(await h.driver.listSessions('spike')).toMatchObject([
      { phase: 'terminal', failure: { exitCode: 9 }, handle: { key: h.spec.key } },
    ]);
    expect(h.core.readNamespacedPod.mock.calls.length).toBe(calls);
    await h.driver.reapResidue('spike');
    expect(h.boxes.size).toBe(0);
    expect(h.pvcs.size).toBe(1);
  });
  it('leaves gateway-owned objects out of all sweep paths', async () => {
    const h = harness();
    const gateway = sandboxManifest(h.spec, 'nanoclaw-test-b1-unit');
    gateway.spec.operatingMode = 'Running';
    gateway.metadata.labels = projectLabels({
      [LABELS.install]: 'spike',
      [LABELS.group]: 'gateway',
      [LABELS.role]: 'gateway',
    });
    gateway.metadata.name = 'gateway';
    h.boxes.set('gateway', gateway);
    setCondition(gateway, 'Finished', 'True', 'PodFailed');
    await h.driver.reapResidue('spike');
    await h.driver.reapRetained('spike', [{ installSlug: 'spike', agentGroupId: 'gateway', sessionId: '' }]);
    expect(h.boxes.has('gateway')).toBe(true);
    expect(h.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

describe('kubernetes failure and admission mapping', () => {
  it('retains the Sandbox UID for unexpected handle API failures', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    await handle.start();
    h.custom.getNamespacedCustomObject.mockRejectedValue(new Error('opaque'));
    for (const operation of [() => handle.status(), () => handle.start(), () => handle.stop('shutdown')])
      await expect(operation()).rejects.toMatchObject({ kind: 'unknown', opaqueRef: 'sandbox-uid' });
  });
  it.each([
    [{ code: 403, body: { message: 'exceeded quota: storage' } }, 'resources-exhausted'],
    [{ code: 403, body: { reason: 'Forbidden' } }, 'denied-by-policy'],
    [{ code: 422 }, 'spec-invalid'],
    [{ code: 404 }, 'runtime-unavailable'],
    [new Error('fetch failed'), 'runtime-unavailable'],
    [new Error('ErrImagePull'), 'image-unavailable'],
    [new Error('opaque'), 'unknown'],
  ])('maps structured cause %j to %s', (error, kind) => {
    expect(kubernetesFailure(error, 'uid').kind).toBe(kind);
  });
  it('constructs without touching kubeconfig and fails only at runtime use', async () => {
    const h = harness();
    const driver = new KubernetesSessionDriver({
      ...h.driver.opts,
      coreApi: undefined,
      customObjectsApi: undefined,
      kubeconfigPath: '/missing/config',
    });
    expect(driver.capabilities().storage).toBe('group-volume');
    await expect(driver.prepare(h.spec)).rejects.toMatchObject({ kind: 'runtime-unavailable' });
  });
  it('refuses unnamed host-bind mounts, unsupported providers and mutable images', async () => {
    const h = harness();
    h.spec.containers[0].mounts[0].realization = undefined;
    await expect(h.driver.prepare(h.spec)).rejects.toMatchObject({ kind: 'spec-invalid' });
    expect(h.custom.createNamespacedCustomObject).not.toHaveBeenCalled();
    h.spec.containers[0].mounts[0].realization = { kind: 'group-volume', subPath: 'v2-sessions/g1/s1' };
    h.spec.providerState![0].provider = 'codex';
    await expect(h.driver.prepare(h.spec)).rejects.toThrow(/unsupported provider.*codex/);
    h.spec.providerState![0].provider = 'claude';
    h.spec.containers[0].image = 'local:latest';
    await expect(h.driver.prepare(h.spec)).rejects.toThrow(/pinned imageTag/);
  });
  it('refuses escaping PVC/provider subPaths', async () => {
    const h = harness();
    h.spec.containers[0].mounts[0].realization = { kind: 'group-volume', subPath: '../other' };
    await expect(h.driver.prepare(h.spec)).rejects.toThrow(/invalid group-volume/);
    h.spec.containers[0].mounts[0].realization = { kind: 'group-volume', subPath: 'workspace' };
    h.spec.providerState![0].createIfMissing[0].relativePath = '../secret';
    await expect(h.driver.prepare(h.spec)).rejects.toThrow(/provider state paths/);
  });
  it('preserves shared mount-policy failures before allocation', async () => {
    const h = harness();
    h.spec.containers[0].mounts[0].hostPath = '/private/other';
    await expect(h.driver.prepare(h.spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    expect(h.core.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });
  it('names the 1 MiB Secret cap, refuses directory and symlink snapshots', async () => {
    const h = harness();
    const mount = h.spec.containers[0].mounts[1];
    fs.writeFileSync(mount.hostPath, Buffer.alloc(SECRET_LIMIT_BYTES + 1));
    await expect(h.driver.prepare(h.spec)).rejects.toThrow(/1 MiB/);
    fs.unlinkSync(mount.hostPath);
    fs.mkdirSync(mount.hostPath);
    await expect(h.driver.prepare(h.spec)).rejects.toThrow(/regular file/);
    fs.rmdirSync(mount.hostPath);
    fs.symlinkSync(h.spec.containers[0].mounts[4].hostPath, mount.hostPath);
    await expect(h.driver.prepare(h.spec)).rejects.toThrow(/regular file/);
  });
  it('does not fabricate stopped when the CRD is missing or API is unreadable', async () => {
    const h = harness();
    const handle = await h.driver.prepare(h.spec);
    h.custom.getNamespacedCustomObject.mockRejectedValue(notFound());
    h.custom.listNamespacedCustomObject.mockRejectedValue(notFound());
    await expect(handle.status()).rejects.toMatchObject({ kind: 'runtime-unavailable' });
    await expect(h.driver.listRetained('spike')).rejects.toMatchObject({ kind: 'runtime-unavailable' });
  });
  it('classifies only current-generation Ready/Finished', () => {
    const box = sandboxManifest(fixtureGroupVolumeSpec(), 'ns');
    box.metadata.generation = 2;
    box.spec.operatingMode = 'Running';
    setCondition(box, 'Ready', 'True', 'Ready', 1);
    expect(sandboxPhase(box)).toBe('starting');
    setCondition(box, 'Ready', 'True', 'Ready', 2);
    expect(sandboxPhase(box)).toBe('running');
    setCondition(box, 'Finished', 'True', 'PodFailed', 2);
    expect(sandboxPhase(box)).toBe('terminal');
  });
});

describe('kubernetes Sandbox informer', () => {
  function fakeInformer() {
    const callbacks = new Map<string, ((value?: unknown) => void)[]>();
    const informer = {
      on: vi.fn((verb: string, cb: (value?: unknown) => void) => {
        callbacks.set(verb, [...(callbacks.get(verb) ?? []), cb]);
      }),
      off: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const factory = vi.fn(() => informer) as unknown as KubernetesDriverOptions['informerFactory'];
    return {
      informer,
      factory,
      emit: (verb: string, value?: unknown) => {
        for (const cb of callbacks.get(verb) ?? []) cb(value);
      },
    };
  }
  it('does not finalize a resumed execution for a suspended informer update during Secret sync', async () => {
    const fake = fakeInformer();
    const h = harness({ informerFactory: fake.factory });
    const supervised = withSessionEvents(h.driver);
    const first = await supervised.prepare(h.spec);
    await armSessionLifecycle({ handle: first, onTerminal: vi.fn() });
    await first.stop('idle');
    const suspended = structuredClone(h.boxes.get(first.name)!);
    expect(await first.status()).toEqual({ phase: 'stopped' });
    const resumed = await supervised.prepare(h.spec);
    const snapshot = h.spec.containers[0].mounts.find((mount) => mount.realization?.kind === 'file-snapshot')!;
    fs.writeFileSync(snapshot.hostPath, 'resumed');

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let syncing!: () => void;
    const entered = new Promise<void>((resolve) => {
      syncing = resolve;
    });
    const replace = h.core.replaceNamespacedSecret.getMockImplementation()!;
    h.core.replaceNamespacedSecret.mockImplementationOnce(async (request) => {
      syncing();
      await blocked;
      return replace(request);
    });
    let finalization: Promise<void> | undefined;
    const terminal = vi.fn(() => {
      finalization = resumed.stop('terminal-finalization');
    });
    const starting = armSessionLifecycle({ handle: resumed, onTerminal: terminal });
    try {
      await entered;
      fake.emit('update', suspended);
      await new Promise((resolve) => setImmediate(resolve));
      expect(terminal).not.toHaveBeenCalled();
    } finally {
      release();
      await starting;
      await finalization;
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(terminal).not.toHaveBeenCalled();
    expect(await resumed.status()).toEqual({ phase: 'running' });
    expect(h.pods.has(resumed.name)).toBe(true);
    expect(h.boxes.get(resumed.name)!.spec.operatingMode).toBe('Running');
  });
  it('shares one subscription, emits all terminals and stops only after the final subscriber', async () => {
    const fake = fakeInformer();
    const h = harness({ informerFactory: fake.factory });
    const events: SessionEvent[] = [];
    const first = h.driver.watchSessions('spike', (e) => events.push(e));
    const second = h.driver.watchSessions('spike', () => {});
    await vi.dynamicImportSettled();
    const box = sandboxManifest(h.spec, 'ns');
    box.metadata.generation = 1;
    box.spec.operatingMode = 'Running';
    setCondition(box, 'Finished', 'True', 'PodFailed');
    fake.emit('add', box);
    fake.emit('update', box);
    fake.emit('delete', box);
    expect(fake.factory).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.kind)).toEqual(['terminal', 'terminal', 'terminal']);
    first.stop();
    expect(fake.informer.stop).not.toHaveBeenCalled();
    second.stop();
    await Promise.resolve();
    expect(fake.informer.stop).toHaveBeenCalled();
    fake.emit('error');
    expect(fake.informer.start).toHaveBeenCalledTimes(1);
  });
  it('does not schedule a new restart from deliberately aborting the old watch', async () => {
    vi.useFakeTimers();
    const fake = fakeInformer();
    fake.informer.stop.mockImplementation(async () => {
      fake.emit('error', Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    });
    const h = harness({ informerFactory: fake.factory });
    const watch = h.driver.watchSessions('spike', () => {});
    await vi.dynamicImportSettled();
    fake.emit('error', new Error('fetch failed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.informer.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.informer.start).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it('reconnects forever with bounded backoff and cancels pending retries on stop', async () => {
    vi.useFakeTimers();
    const fake = fakeInformer();
    const h = harness({ informerFactory: fake.factory });
    const watch = h.driver.watchSessions('spike', () => {});
    await vi.dynamicImportSettled();
    for (let n = 0; n < 8; n++) {
      fake.emit('error');
      await vi.advanceTimersByTimeAsync(Math.min(1000 * 2 ** n, 30000));
    }
    expect(fake.informer.start).toHaveBeenCalledTimes(9);
    fake.emit('error');
    watch.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.informer.start).toHaveBeenCalledTimes(9);
  });
});
