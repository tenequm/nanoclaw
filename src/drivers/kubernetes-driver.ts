import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';

import type * as k8s from '@kubernetes/client-node';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import { registerSessionDriver } from './driver-registry.js';
import { projectLabels, projectLabelValue } from './label-projection.js';
import {
  LABELS,
  asFailureError,
  deniedByPolicy,
  isGatewayOwned,
  labelsForKey,
  specInvalid,
  validateSpec,
  type DriverCapabilities,
  type MountPolicy,
  type RetainedObject,
  type SessionDriver,
  type SessionEvent,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionPhase,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

const GROUP = 'agents.x-k8s.io';
const VERSION = 'v1beta1';
const PLURAL = 'sandboxes';
const API_VERSION = `${GROUP}/${VERSION}`;
export const STARTED_ONCE = 'nanoclaw.dev/started-once';
const LAST_POD_UID = 'nanoclaw.dev/last-pod-uid';
const SPEC_UPDATED = 'nanoclaw.dev/spec-updated-at';
export const SECRET_LIMIT_BYTES = 1024 * 1024;

export interface Sandbox extends k8s.KubernetesObject {
  metadata: k8s.V1ObjectMeta;
  spec: { operatingMode?: string; podTemplate: k8s.V1PodTemplateSpec };
  status?: { observedGeneration?: number; conditions?: k8s.V1Condition[] };
}

export interface KubernetesDriverOptions extends MountPolicy {
  kubeconfigPath?: string;
  context?: string;
  namespace?: string;
  hostAddress?: string;
  startTimeoutMs?: number;
  controllerTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  coreApi?: k8s.CoreV1Api;
  customObjectsApi?: k8s.CustomObjectsApi;
  kubeConfig?: k8s.KubeConfig;
  informerFactory?: typeof k8s.makeInformer<Sandbox>;
}

const SETTINGS = [
  'NANOCLAW_KUBERNETES_KUBECONFIG',
  'NANOCLAW_KUBERNETES_CONTEXT',
  'NANOCLAW_KUBERNETES_NAMESPACE',
  'NANOCLAW_KUBERNETES_HOST_ADDRESS',
] as const;

export function kubernetesSettings(env: NodeJS.ProcessEnv = process.env): Partial<KubernetesDriverOptions> {
  const file = readEnvFile([...SETTINGS]);
  const read = (key: (typeof SETTINGS)[number]) => env[key]?.trim() || file[key]?.trim() || undefined;
  return {
    kubeconfigPath: read(SETTINGS[0]),
    context: read(SETTINGS[1]),
    namespace: read(SETTINGS[2]),
    hostAddress: read(SETTINGS[3]),
  };
}

export function kubernetesName(prefix: string, identity: string): string {
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 10);
  const stem = prefix
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 52)
    .replace(/^-+|-+$/g, '');
  return `${stem || 'ncl'}-${hash}`;
}

export function kubernetesNamespace(installSlug: string): string {
  const name = `nanoclaw-${installSlug}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return name.length <= 63 ? name.replace(/-+$/g, '') : kubernetesName(name, installSlug);
}

export function groupPvcName(key: SessionKey): string {
  return kubernetesName(`ncl-${key.agentGroupId}-state`, JSON.stringify([key.installSlug, key.agentGroupId]));
}

function sandboxName(key: SessionKey): string {
  return kubernetesName(
    `ncl-${key.agentGroupId}-${key.sessionId}`,
    JSON.stringify([key.installSlug, key.agentGroupId, key.sessionId]),
  );
}

export function secretName(key: SessionKey): string {
  return kubernetesName(
    `ncl-${key.agentGroupId}-${key.sessionId}-files`,
    JSON.stringify([key.installSlug, key.agentGroupId, key.sessionId, 'files']),
  );
}

function condition(box: Sandbox, type: string): k8s.V1Condition | undefined {
  return box.status?.conditions?.find((c) => c.type === type);
}

function currentCondition(box: Sandbox, type: string): k8s.V1Condition | undefined {
  const found = condition(box, type);
  return found && (found.observedGeneration ?? box.status?.observedGeneration ?? 0) >= (box.metadata.generation ?? 1)
    ? found
    : undefined;
}

function suspended(box: Sandbox): boolean {
  return box.spec.operatingMode === 'Suspended';
}

export function sandboxPhase(box: Sandbox): SessionPhase {
  if (
    box.metadata.deletionTimestamp ||
    currentCondition(box, 'Finished')?.status === 'True' ||
    currentCondition(box, 'Ready')?.reason === 'SandboxExpired'
  )
    return 'terminal';
  return !suspended(box) && currentCondition(box, 'Ready')?.status === 'True' ? 'running' : 'starting';
}

function keyFromLabels(labels: Record<string, string> | undefined): SessionKey | undefined {
  if (!labels?.[LABELS.install] || !labels[LABELS.group] || !labels[LABELS.session] || labels[LABELS.role] !== 'agent')
    return;
  return { installSlug: labels[LABELS.install], agentGroupId: labels[LABELS.group], sessionId: labels[LABELS.session] };
}

function apiCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return;
  const e = error as {
    code?: number;
    statusCode?: number;
    response?: { statusCode?: number };
    body?: { code?: number };
  };
  return e.code ?? e.statusCode ?? e.body?.code ?? e.response?.statusCode;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const e = error as { message?: string; body?: unknown };
  return `${e.message ?? ''} ${JSON.stringify(e.body ?? {})}`;
}

export function kubernetesFailure(error: unknown, opaqueRef = 'kubernetes'): SessionFailure {
  if (error && typeof error === 'object' && 'kind' in error && 'retryable' in error) return error as SessionFailure;
  const code = apiCode(error);
  const message = errorText(error);
  if (/exceeded quota|quota.*exceed|insufficient|Unschedulable|Forbidden.*resource.?quota/i.test(message)) {
    return { kind: 'resources-exhausted', retryable: true };
  }
  if (code === 401 || code === 403 || /admission.*denied|webhook.*denied|forbidden/i.test(message)) {
    return { kind: 'denied-by-policy', retryable: false, detail: 'Kubernetes RBAC or admission denied the request' };
  }
  if (code === 400 || code === 422)
    return { kind: 'spec-invalid', retryable: false, detail: 'Kubernetes rejected the manifest' };
  if (/ErrImagePull|ImagePullBackOff/.test(message)) return { kind: 'image-unavailable', retryable: true };
  if (
    code === 404 ||
    code === 408 ||
    code === 429 ||
    (code && code >= 500) ||
    /ECONN|ENOTFOUND|EHOST|fetch failed|timeout|timed out|AbortError|TimeoutError|No active cluster/i.test(message)
  ) {
    return { kind: 'runtime-unavailable', retryable: true };
  }
  return { kind: 'unknown', retryable: false, opaqueRef };
}

function normalizeKubernetesError(error: unknown, opaqueRef?: string): Error & SessionFailure {
  if (error instanceof Error && 'kind' in error && 'retryable' in error) {
    const failure = error as Error & SessionFailure;
    return failure.kind === 'unknown' && opaqueRef ? asFailureError({ ...failure, opaqueRef }) : failure;
  }
  const failure = kubernetesFailure(error, opaqueRef);
  if (failure.kind === 'spec-invalid') return specInvalid(failure.detail);
  if (failure.kind === 'denied-by-policy') return deniedByPolicy(failure.detail);
  return asFailureError(failure);
}

function safeRelative(value: string): boolean {
  return (
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    value.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
  );
}

function validateKubernetesSpec(spec: SessionSpec, policy: MountPolicy, caps: DriverCapabilities): void {
  validateSpec(spec, policy, caps);
  if (spec.containers.length !== 1) throw specInvalid('kubernetes does not support auxiliary containers');
  if (spec.network === 'none') throw specInvalid('kubernetes MVP cannot realize network: none');
  const agent = spec.containers[0];
  if (!/@sha256:[a-f0-9]{64}$/.test(agent.image) && (!/:[^/:]+$/.test(agent.image) || /:latest$/.test(agent.image))) {
    throw specInvalid(
      `kubernetes requires a pinned imageTag; local default/latest image '${agent.image}' is unsupported`,
    );
  }
  for (const mount of agent.mounts) {
    if (mount.realization?.kind === 'group-volume') {
      if (mount.class !== 'group-state' || !safeRelative(mount.realization.subPath)) {
        throw specInvalid(`invalid group-volume mount '${mount.containerPath}'`);
      }
    } else if (mount.realization?.kind === 'file-snapshot') {
      if (mount.mode !== 'ro') throw specInvalid(`file-snapshot '${mount.containerPath}' must be read-only`);
    } else
      throw specInvalid(
        `unrealized mount '${mount.containerPath}': additional mounts, plugins and pond stores are unsupported`,
      );
  }
  for (const state of spec.providerState ?? []) {
    if (state.provider !== 'claude') throw specInvalid(`unsupported provider contract '${state.provider}'`);
    if (
      !safeRelative(state.subPath) ||
      state.createIfMissing.some((f) => !safeRelative(f.relativePath)) ||
      (state.skillLinks &&
        (!safeRelative(state.skillLinks.relativeDir) ||
          state.skillLinks.names.some((n) => !safeRelative(n) || n.includes('/'))))
    ) {
      throw specInvalid('provider state paths must stay within the group volume');
    }
  }
  if (
    agent.surfaceImage &&
    (!/@sha256:[a-f0-9]{64}$/.test(agent.surfaceImage.image) ||
      agent.surfaceImage.mounts.some((m) => !safeRelative(m.imagePath)))
  )
    throw specInvalid('surfaceImage must carry a digest and safe image paths');
}

export function sandboxManifest(spec: SessionSpec, namespace: string): Sandbox {
  const agent = spec.containers[0];
  const labels = projectLabels({ ...spec.labels, ...agent.labels, ...labelsForKey(spec.key, 'agent') });
  const volumes: k8s.V1Volume[] = [
    { name: 'group-state', persistentVolumeClaim: { claimName: groupPvcName(spec.key) } },
  ];
  const volumeMounts: k8s.V1VolumeMount[] = [];
  const files = agent.mounts.filter((m) => m.realization?.kind === 'file-snapshot');
  if (files.length)
    volumes.push({ name: 'session-files', secret: { secretName: secretName(spec.key), defaultMode: 0o444 } });
  let fileIndex = 0;
  for (const mount of agent.mounts) {
    volumeMounts.push({
      name: mount.realization?.kind === 'group-volume' ? 'group-state' : 'session-files',
      mountPath: mount.containerPath,
      subPath: mount.realization?.kind === 'group-volume' ? mount.realization.subPath : `file-${fileIndex++}`,
      readOnly: mount.mode === 'ro',
    });
  }
  if (agent.surfaceImage) {
    volumes.push({ name: 'surfaces', image: { reference: agent.surfaceImage.image, pullPolicy: 'IfNotPresent' } });
    volumeMounts.push(
      ...agent.surfaceImage.mounts.map((m) => ({
        name: 'surfaces',
        mountPath: m.containerPath,
        subPath: m.imagePath,
        readOnly: true,
      })),
    );
  }
  volumes.push({ name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: `${spec.resources.shmSizeMb ?? 64}Mi` } });
  volumeMounts.push({ name: 'shm', mountPath: '/dev/shm' });
  const securityContext: k8s.V1SecurityContext = {
    capabilities: { drop: ['ALL'] },
    allowPrivilegeEscalation: false,
    runAsNonRoot: true,
  };
  const limits: Record<string, string> = {};
  if (spec.resources.memoryMb !== undefined) limits.memory = `${spec.resources.memoryMb}Mi`;
  if (spec.resources.cpus !== undefined) limits.cpu = spec.resources.cpus;
  const initMounts: k8s.V1VolumeMount[] = [{ name: 'group-state', mountPath: '/ncl-state' }];
  if (agent.surfaceImage)
    initMounts.push(
      ...agent.surfaceImage.mounts.map((m) => ({
        name: 'surfaces',
        mountPath: m.containerPath,
        subPath: m.imagePath,
        readOnly: true,
      })),
    );
  const initData = {
    directories: agent.mounts.flatMap((m) => (m.realization?.kind === 'group-volume' ? [m.realization.subPath] : [])),
    states: spec.providerState ?? [],
  };
  const initScript = `
const fs = require('fs'); const path = require('path');
const data = JSON.parse(process.argv[1]);
for (const dir of data.directories) fs.mkdirSync(path.join('/ncl-state', dir), { recursive: true });
for (const state of data.states) {
  const root = path.join('/ncl-state', state.subPath); fs.mkdirSync(root, { recursive: true });
  for (const file of state.createIfMissing) {
    const dest = path.join(root, file.relativePath); fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.writeFileSync(dest, file.content, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (state.skillLinks) {
    const links = state.skillLinks; const dir = path.join(root, links.relativeDir); fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      const dest = path.join(dir, name); if (fs.lstatSync(dest).isSymbolicLink() && !links.names.includes(name)) fs.unlinkSync(dest);
    }
    for (const name of links.names) {
      const dest = path.join(dir, name);
      try { fs.lstatSync(dest); } catch (e) { if (e.code !== 'ENOENT') throw e; fs.symlinkSync(path.join(links.targetRoot, name), dest); }
    }
  }
}`;
  const command = agent.command ?? ['/app/entrypoint.sh'];
  return {
    apiVersion: API_VERSION,
    kind: 'Sandbox',
    metadata: {
      name: sandboxName(spec.key),
      namespace,
      labels,
      annotations: { [SPEC_UPDATED]: new Date().toISOString() },
    },
    spec: {
      operatingMode: 'Suspended',
      podTemplate: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: spec.stopGraceSeconds,
          securityContext: {
            runAsUser: spec.runAs?.uid ?? 1000,
            runAsGroup: spec.runAs?.gid ?? 1000,
            fsGroup: spec.runAs?.gid ?? 1000,
            runAsNonRoot: true,
          },
          volumes,
          initContainers: [
            {
              name: 'provider-state-init',
              image: agent.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['bun', '-e', initScript],
              args: [JSON.stringify(initData)],
              securityContext,
              volumeMounts: initMounts,
            },
          ],
          containers: [
            {
              name: 'agent',
              image: agent.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['/usr/bin/tini', '--', ...command],
              args: agent.args ?? [],
              env: Object.entries({ ...agent.env, ...agent.contributedEnv }).map(([name, value]) => ({ name, value })),
              resources: { limits },
              securityContext,
              volumeMounts,
            },
          ],
        },
      },
    },
  };
}

function labelPatch(existing: Record<string, string> | undefined, desired: Record<string, string> | undefined) {
  return {
    ...Object.fromEntries(
      Object.keys(existing ?? {})
        .filter((key) => !(key in (desired ?? {})))
        .map((key) => [key, null]),
    ),
    ...desired,
  };
}

interface InstallWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  informer?: k8s.Informer<Sandbox>;
  timer?: NodeJS.Timeout;
  stopped: boolean;
  starting: boolean;
  attempt: number;
  known: Map<string, SessionKey>;
}

export class KubernetesSessionDriver implements SessionDriver {
  readonly kind = 'kubernetes';
  private library?: typeof k8s;
  private clients?: { core: k8s.CoreV1Api; custom: k8s.CustomObjectsApi; config: k8s.KubeConfig };
  private readonly watches = new Map<string, InstallWatch>();
  private readonly groupLocks = new Map<string, Promise<unknown>>();
  private readonly staleSince = new Map<string, number>();

  constructor(readonly opts: KubernetesDriverOptions) {}

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      unrealized: ['pidsLimit'],
      sharedNetworkNamespace: true,
      auxiliaryContainers: false,
      imageBuild: false,
      imageCarriedSurfaces: true,
      storage: 'group-volume',
      providerContracts: ['claude'],
      sessionsPerGroup: 'one',
      pinnedImages: true,
      ...(this.opts.hostAddress && { hostAddress: this.opts.hostAddress }),
    };
  }

  runtimeName(key: SessionKey): string {
    return sandboxName(key);
  }

  namespace(installSlug: string): string {
    return this.opts.namespace ?? kubernetesNamespace(installSlug);
  }

  private async api() {
    if (this.clients) return this.clients;
    try {
      const library = (this.library ??= await import('@kubernetes/client-node'));
      const config = this.opts.kubeConfig ?? new library.KubeConfig();
      if (!this.opts.coreApi || !this.opts.customObjectsApi) {
        if (!this.opts.kubeConfig) {
          if (!this.opts.kubeconfigPath || !this.opts.context)
            throw new Error('No active cluster: configure kubeconfig path and context');
          config.loadFromFile(this.opts.kubeconfigPath);
          config.setCurrentContext(this.opts.context);
        }
        if (!config.getCurrentCluster()) throw new Error('No active cluster');
      }
      this.clients = {
        config,
        core: this.opts.coreApi ?? config.makeApiClient(library.CoreV1Api),
        custom: this.opts.customObjectsApi ?? config.makeApiClient(library.CustomObjectsApi),
      };
      return this.clients;
    } catch {
      throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
    }
  }

  private requestOptions(patch = false): k8s.ConfigurationOptions {
    return {
      middlewareMergeStrategy: 'append',
      middleware: [
        {
          pre: (ctx: k8s.RequestContext) => {
            ctx.setSignal(AbortSignal.timeout(this.opts.requestTimeoutMs ?? 10_000));
            if (patch) ctx.setHeaderParam('Content-Type', 'application/merge-patch+json');
            return new this.library!.Observable(Promise.resolve(ctx));
          },
          post: (ctx: k8s.ResponseContext) => new this.library!.Observable(Promise.resolve(ctx)),
        },
      ],
    };
  }

  private params(installSlug: string) {
    return { group: GROUP, version: VERSION, plural: PLURAL, namespace: this.namespace(installSlug) };
  }

  private async readSandbox(key: SessionKey, name = this.runtimeName(key)): Promise<Sandbox | undefined> {
    try {
      return (await (
        await this.api()
      ).custom.getNamespacedCustomObject({ ...this.params(key.installSlug), name }, this.requestOptions())) as Sandbox;
    } catch (error) {
      // A resource 404 is absence only if the CRD collection remains readable.
      if (apiCode(error) === 404) {
        await this.listSandboxes(key.installSlug);
        return;
      }
      throw normalizeKubernetesError(error);
    }
  }

  private async readPod(installSlug: string, name: string): Promise<k8s.V1Pod | undefined> {
    try {
      return await (
        await this.api()
      ).core.readNamespacedPod({ namespace: this.namespace(installSlug), name }, this.requestOptions());
    } catch (error) {
      if (apiCode(error) === 404) return;
      throw normalizeKubernetesError(error);
    }
  }

  private async listSandboxes(installSlug: string): Promise<k8s.KubernetesListObject<Sandbox>> {
    try {
      return (await (
        await this.api()
      ).custom.listNamespacedCustomObject(
        { ...this.params(installSlug), labelSelector: `${LABELS.install}=${projectLabelValue(installSlug)}` },
        this.requestOptions(),
      )) as k8s.KubernetesListObject<Sandbox>;
    } catch (error) {
      throw normalizeKubernetesError(error);
    }
  }

  private async patch(key: SessionKey, name: string, body: unknown): Promise<Sandbox> {
    try {
      return (await (
        await this.api()
      ).custom.patchNamespacedCustomObject(
        { ...this.params(key.installSlug), name, body },
        this.requestOptions(true),
      )) as Sandbox;
    } catch (error) {
      throw normalizeKubernetesError(error);
    }
  }

  private locked<T>(key: SessionKey, task: () => Promise<T>): Promise<T> {
    const id = JSON.stringify([key.installSlug, key.agentGroupId]);
    const previous = this.groupLocks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.groupLocks.set(id, next);
    void next
      .finally(() => {
        if (this.groupLocks.get(id) === next) this.groupLocks.delete(id);
      })
      .catch(() => {});
    return next;
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateKubernetesSpec(spec, this.opts, this.capabilities());
    const desired = sandboxManifest(spec, this.namespace(spec.key.installSlug));
    return this.locked(spec.key, async () => {
      let opaqueRef: string | undefined;
      try {
        const { core, custom } = await this.api();
        const namespace = this.namespace(spec.key.installSlug);
        try {
          await core.readNamespace({ name: namespace }, this.requestOptions());
        } catch (error) {
          if (apiCode(error) !== 404) throw error;
          try {
            await core.createNamespace(
              {
                body: {
                  metadata: { name: namespace, labels: { [LABELS.install]: projectLabelValue(spec.key.installSlug) } },
                },
              },
              this.requestOptions(),
            );
          } catch (createError) {
            if (apiCode(createError) !== 409) throw createError;
          }
        }
        const pvcName = groupPvcName(spec.key);
        try {
          const pvc = await core.readNamespacedPersistentVolumeClaim(
            { namespace, name: pvcName },
            this.requestOptions(),
          );
          if (
            pvc.metadata?.labels?.[LABELS.install] !== projectLabelValue(spec.key.installSlug) ||
            pvc.metadata?.labels?.[LABELS.group] !== projectLabelValue(spec.key.agentGroupId) ||
            pvc.metadata.ownerReferences?.length
          ) {
            throw deniedByPolicy('group PVC has conflicting identity or a session owner reference');
          }
        } catch (error) {
          if (apiCode(error) !== 404) throw error;
          try {
            await core.createNamespacedPersistentVolumeClaim(
              {
                namespace,
                body: {
                  metadata: {
                    name: pvcName,
                    labels: projectLabels({
                      [LABELS.install]: spec.key.installSlug,
                      [LABELS.group]: spec.key.agentGroupId,
                    }),
                  },
                  spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '20Gi' } } },
                },
              },
              this.requestOptions(),
            );
          } catch (createError) {
            if (apiCode(createError) !== 409) throw createError;
          }
        }
        let box = await this.readSandbox(spec.key);
        if (!box) {
          try {
            box = (await custom.createNamespacedCustomObject(
              { ...this.params(spec.key.installSlug), body: desired },
              this.requestOptions(),
            )) as Sandbox;
          } catch (error) {
            if (apiCode(error) !== 409) throw error;
            box = await this.readSandbox(spec.key);
          }
        }
        if (!box || !isDeepStrictEqual(keyFromLabels(box.metadata.labels), spec.key))
          throw deniedByPolicy('Sandbox identity does not match the requested session key');
        opaqueRef = box.metadata.uid;
        if (!suspended(box)) return this.handle(spec.key, box.metadata.name!, null, opaqueRef);
        await this.waitSuspended(spec.key, box.metadata.name!);
        if (
          !isDeepStrictEqual(box.spec.podTemplate, desired.spec.podTemplate) ||
          !isDeepStrictEqual(box.metadata.labels, desired.metadata.labels)
        ) {
          box = await this.patch(spec.key, box.metadata.name!, {
            metadata: {
              labels: labelPatch(box.metadata.labels, desired.metadata.labels),
              annotations: desired.metadata.annotations,
            },
            spec: {
              podTemplate: {
                ...desired.spec.podTemplate,
                metadata: {
                  ...desired.spec.podTemplate.metadata,
                  labels: labelPatch(box.spec.podTemplate.metadata?.labels, desired.spec.podTemplate.metadata?.labels),
                },
              },
            },
          });
        }
        await this.syncSecret(spec, box);
        return this.handle(spec.key, box.metadata.name!, spec, opaqueRef);
      } catch (error) {
        throw normalizeKubernetesError(error, opaqueRef);
      }
    });
  }

  private async syncSecret(spec: SessionSpec, box: Sandbox): Promise<void> {
    const data: Record<string, string> = {};
    let total = 0;
    const files = spec.containers[0].mounts.filter((m) => m.realization?.kind === 'file-snapshot');
    for (const [index, mount] of files.entries()) {
      let bytes: Buffer;
      try {
        const file = await fs.promises.open(mount.hostPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw specInvalid(`file-snapshot '${mount.containerPath}' requires a regular file`);
          if (stat.size + total > SECRET_LIMIT_BYTES)
            throw specInvalid('per-session Secret exceeds the 1 MiB (1048576 bytes) limit');
          bytes = await file.readFile();
        } finally {
          await file.close();
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'kind' in error) throw error;
        throw specInvalid(`cannot snapshot regular file '${mount.containerPath}'`);
      }
      total += bytes.length;
      if (total > SECRET_LIMIT_BYTES) throw specInvalid('per-session Secret exceeds the 1 MiB (1048576 bytes) limit');
      data[`file-${index}`] = bytes.toString('base64');
    }
    if (!box.metadata.uid) throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
    const body: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: secretName(spec.key),
        labels: box.metadata.labels,
        ownerReferences: [
          {
            apiVersion: API_VERSION,
            kind: 'Sandbox',
            name: box.metadata.name!,
            uid: box.metadata.uid,
            controller: true,
          },
        ],
      },
      data,
    };
    const { core } = await this.api();
    const namespace = this.namespace(spec.key.installSlug);
    try {
      const old = await core.readNamespacedSecret({ namespace, name: body.metadata!.name! }, this.requestOptions());
      if (!old.metadata?.ownerReferences?.some((owner) => owner.uid === box.metadata.uid))
        throw deniedByPolicy('session Secret has a conflicting owner');
      body.metadata!.resourceVersion = old.metadata?.resourceVersion;
      await core.replaceNamespacedSecret({ namespace, name: body.metadata!.name!, body }, this.requestOptions());
    } catch (error) {
      if (apiCode(error) !== 404) throw error;
      try {
        await core.createNamespacedSecret({ namespace, body }, this.requestOptions());
      } catch (createError) {
        if (apiCode(createError) !== 409) throw createError;
        await this.syncSecret(spec, box);
      }
    }
  }

  private async poll<T>(read: () => Promise<T | undefined>, timeoutFailure?: () => SessionFailure): Promise<T> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 180_000);
    do {
      const result = await read();
      if (result !== undefined) return result;
      await new Promise((resolve) => setTimeout(resolve, this.opts.pollIntervalMs ?? 250));
    } while (Date.now() < deadline);
    throw asFailureError(timeoutFailure?.() ?? { kind: 'runtime-unavailable', retryable: true });
  }

  private async waitSuspended(key: SessionKey, name: string): Promise<Sandbox> {
    return this.poll(async () => {
      const box = await this.readSandbox(key, name);
      if (!box) throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
      if (!suspended(box)) throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
      const pod = await this.readPod(key.installSlug, name);
      return currentCondition(box, 'Suspended')?.status === 'True' && !pod ? box : undefined;
    });
  }

  private async start(key: SessionKey, name: string, spec: SessionSpec | null, opaqueRef?: string): Promise<void> {
    return this.locked(key, async () => {
      try {
        let box = await this.readSandbox(key, name);
        if (!box) throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
        opaqueRef = box.metadata.uid;
        let oldUid = box.metadata.annotations?.[LAST_POD_UID];
        if (suspended(box)) {
          const oldPod = await this.readPod(key.installSlug, name);
          oldUid = oldPod?.metadata?.uid ?? oldUid;
          box = await this.waitSuspended(key, name);
          if (!spec) throw specInvalid('a retained Sandbox must be prepared with a fresh SessionSpec before resume');
          const others = (await this.listSandboxes(key.installSlug)).items.filter(
            (other) =>
              other.metadata.name !== name &&
              other.metadata.labels?.[LABELS.group] === projectLabelValue(key.agentGroupId) &&
              keyFromLabels(other.metadata.labels),
          );
          for (const other of others) {
            if (!suspended(other) || (await this.readPod(key.installSlug, other.metadata.name!)))
              throw asFailureError({ kind: 'resources-exhausted', retryable: true });
          }
          await this.syncSecret(spec, box);
          box = await this.patch(key, name, {
            metadata: {
              annotations: { [SPEC_UPDATED]: new Date().toISOString(), ...(oldUid && { [LAST_POD_UID]: oldUid }) },
            },
            spec: { operatingMode: 'Running' },
          });
        } else oldUid = undefined;
        let pendingFailure: SessionFailure | undefined;
        const pod = await this.poll(
          async () => {
            const current = await this.readSandbox(key, name);
            if (!current) throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
            const backing = await this.readPod(key.installSlug, name);
            const status = await this.statusFrom(current, backing);
            if (status.phase === 'failed') {
              if (status.failure.kind === 'resources-exhausted') {
                const scheduling =
                  backing?.status?.conditions?.find((c) => c.reason === 'Unschedulable') ??
                  currentCondition(current, 'PodScheduled');
                if (
                  (scheduling?.reason === 'Unschedulable' &&
                    !/persistentvolumeclaim|volume binding|unbound/i.test(scheduling.message ?? '')) ||
                  currentCondition(current, 'Ready')?.reason === 'ReconcilerError'
                ) {
                  throw asFailureError(status.failure);
                }
                pendingFailure = status.failure;
                return;
              }
              if (status.failure.kind === 'started-then-died') {
                await this.patch(key, name, {
                  metadata: {
                    annotations: {
                      [STARTED_ONCE]: 'true',
                      ...(backing?.metadata?.uid && { [LAST_POD_UID]: backing.metadata.uid }),
                    },
                  },
                });
              }
              throw asFailureError(status.failure);
            }
            if (status.phase === 'stopped') return backing ?? { metadata: {} };
            return status.phase === 'running' && backing?.metadata?.uid && backing.metadata.uid !== oldUid
              ? backing
              : undefined;
          },
          () => pendingFailure ?? { kind: 'runtime-unavailable', retryable: true },
        );
        await this.patch(key, name, {
          metadata: {
            annotations: { [STARTED_ONCE]: 'true', ...(pod.metadata?.uid && { [LAST_POD_UID]: pod.metadata.uid }) },
          },
        });
      } catch (error) {
        throw normalizeKubernetesError(error, opaqueRef);
      }
    });
  }

  private async statusFrom(box: Sandbox, pod?: k8s.V1Pod): Promise<SessionStatus> {
    const terminated = pod?.status?.containerStatuses?.find((c) => c.name === 'agent')?.state?.terminated;
    if (terminated || pod?.status?.phase === 'Failed' || pod?.status?.phase === 'Succeeded') {
      if (terminated?.exitCode === 0 || pod?.status?.phase === 'Succeeded') return { phase: 'stopped' };
      return {
        phase: 'failed',
        failure: { kind: 'started-then-died', retryable: false, ...(terminated && { exitCode: terminated.exitCode }) },
      };
    }
    if (suspended(box)) {
      if (pod || currentCondition(box, 'Suspended')?.status !== 'True') return { phase: 'preparing' };
      return { phase: box.metadata.annotations?.[STARTED_ONCE] === 'true' ? 'stopped' : 'ready' };
    }
    if (currentCondition(box, 'Finished')?.status === 'True') {
      return currentCondition(box, 'Finished')?.reason === 'PodSucceeded'
        ? { phase: 'stopped' }
        : { phase: 'failed', failure: { kind: 'started-then-died', retryable: false } };
    }
    const ready = currentCondition(box, 'Ready');
    if (ready?.reason === 'SandboxExpired') return { phase: 'stopped' };
    const statuses = [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])];
    if (statuses.some((s) => /ErrImagePull|ImagePullBackOff/.test(s.state?.waiting?.reason ?? '')))
      return { phase: 'failed', failure: { kind: 'image-unavailable', retryable: true } };
    const unschedulable =
      currentCondition(box, 'PodScheduled')?.reason === 'Unschedulable' ||
      pod?.status?.conditions?.some((c) => c.reason === 'Unschedulable');
    if (unschedulable) return { phase: 'failed', failure: { kind: 'resources-exhausted', retryable: true } };
    const initFailure = statuses.find(
      (s) => s.name !== 'agent' && s.state?.terminated && s.state.terminated.exitCode !== 0,
    );
    if (initFailure)
      return {
        phase: 'failed',
        failure: { kind: 'started-then-died', retryable: false, exitCode: initFailure.state!.terminated!.exitCode },
      };
    if (ready?.reason === 'ReconcilerError' || ready?.reason === 'InvalidConfiguration') {
      const failure = kubernetesFailure(
        { code: ready.reason === 'InvalidConfiguration' ? 422 : undefined, message: ready.message },
        box.metadata.uid,
      );
      return { phase: 'failed', failure };
    }
    const generation = box.metadata.generation ?? 1;
    const observed = condition(box, 'Ready')?.observedGeneration ?? box.status?.observedGeneration ?? 0;
    const identity = box.metadata.uid ?? box.metadata.name!;
    if (observed < generation) {
      const stamp = box.metadata.annotations?.[SPEC_UPDATED] ?? box.metadata.creationTimestamp;
      const since = this.staleSince.get(identity) ?? (stamp ? new Date(stamp).getTime() : Date.now());
      this.staleSince.set(identity, since);
      if (Date.now() - since >= (this.opts.controllerTimeoutMs ?? 30_000))
        return { phase: 'failed', failure: { kind: 'runtime-unavailable', retryable: true } };
    } else this.staleSince.delete(identity);
    if (ready?.status === 'True' && pod && !pod.metadata?.deletionTimestamp && pod.status?.phase === 'Running')
      return { phase: 'running' };
    if (pod?.status?.phase === 'Pending' && box.spec.podTemplate.spec?.volumes?.some((v) => v.persistentVolumeClaim)) {
      for (const volume of box.spec.podTemplate.spec.volumes) {
        if (!volume.persistentVolumeClaim) continue;
        const pvc = await (
          await this.api()
        ).core.readNamespacedPersistentVolumeClaim(
          { namespace: box.metadata.namespace!, name: volume.persistentVolumeClaim.claimName },
          this.requestOptions(),
        );
        if (pvc.status?.phase === 'Pending')
          return { phase: 'failed', failure: { kind: 'resources-exhausted', retryable: true } };
      }
    }
    return { phase: 'preparing' };
  }

  private handle(key: SessionKey, name: string, spec: SessionSpec | null, opaqueRef?: string): SessionHandle {
    return {
      key,
      name,
      start: () => this.start(key, name, spec, opaqueRef),
      status: async () => {
        try {
          const box = await this.readSandbox(key, name);
          opaqueRef = box?.metadata.uid ?? opaqueRef;
          return box ? await this.statusFrom(box, await this.readPod(key.installSlug, name)) : { phase: 'stopped' };
        } catch (error) {
          throw normalizeKubernetesError(error, opaqueRef);
        }
      },
      stop: (_reason) =>
        this.locked(key, async () => {
          try {
            const box = await this.readSandbox(key, name);
            opaqueRef = box?.metadata.uid ?? opaqueRef;
            if (!box || suspended(box)) return;
            const pod = await this.readPod(key.installSlug, name);
            await this.patch(key, name, {
              metadata: {
                annotations: {
                  [SPEC_UPDATED]: new Date().toISOString(),
                  ...(pod?.metadata?.uid && { [LAST_POD_UID]: pod.metadata.uid }),
                },
              },
              spec: { operatingMode: 'Suspended' },
            });
          } catch (error) {
            throw normalizeKubernetesError(error, opaqueRef);
          }
        }),
      execSpec: (command) => {
        const base = [
          ...(this.opts.kubeconfigPath ? ['--kubeconfig', this.opts.kubeconfigPath] : []),
          ...(this.opts.context ? ['--context', this.opts.context] : []),
          '-n',
          this.namespace(key.installSlug),
          'exec',
          name,
          '-c',
          'agent',
        ];
        return { bin: 'kubectl', argsPlain: [...base, '--', ...command], argsTty: [...base, '-it', '--', ...command] };
      },
    };
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    try {
      const boxes = (await this.listSandboxes(installSlug)).items.filter(
        (box) => !suspended(box) && keyFromLabels(box.metadata.labels),
      );
      if (!boxes.length) return [];
      const pods = await (
        await this.api()
      ).core.listNamespacedPod(
        {
          namespace: this.namespace(installSlug),
          labelSelector: `${LABELS.install}=${projectLabelValue(installSlug)}`,
        },
        this.requestOptions(),
      );
      const byName = new Map(pods.items.map((pod) => [pod.metadata?.name, pod]));
      return boxes.map((box) => {
        const key = keyFromLabels(box.metadata.labels)!;
        const pod = byName.get(box.metadata.name);
        const terminated = pod?.status?.containerStatuses?.find((s) => s.name === 'agent')?.state?.terminated;
        const observedPhase = sandboxPhase(box);
        const phase =
          terminated || ['Succeeded', 'Failed'].includes(pod?.status?.phase ?? '')
            ? 'terminal'
            : observedPhase === 'running' &&
                (!pod || pod.metadata?.deletionTimestamp || pod.status?.phase !== 'Running')
              ? 'starting'
              : observedPhase;
        const failed = terminated
          ? terminated.exitCode !== 0
          : pod?.status?.phase === 'Failed' || currentCondition(box, 'Finished')?.reason === 'PodFailed';
        return {
          handle: this.handle(key, box.metadata.name!, null, box.metadata.uid),
          phase,
          ...(failed && {
            failure: {
              kind: 'started-then-died' as const,
              retryable: false as const,
              ...(terminated && { exitCode: terminated.exitCode }),
            },
          }),
        };
      });
    } catch (error) {
      throw normalizeKubernetesError(error);
    }
  }

  async listRetained(installSlug: string): Promise<RetainedObject[]> {
    try {
      const boxes = (await this.listSandboxes(installSlug)).items.filter(
        (box) => suspended(box) && keyFromLabels(box.metadata.labels),
      );
      const { core } = await this.api();
      const namespace = this.namespace(installSlug);
      const selector = `${LABELS.install}=${projectLabelValue(installSlug)}`;
      const [pvcs, pods] = await Promise.all([
        core.listNamespacedPersistentVolumeClaim({ namespace, labelSelector: selector }, this.requestOptions()),
        core.listNamespacedPod({ namespace, labelSelector: selector }, this.requestOptions()),
      ]);
      const podNames = new Set(pods.items.map((p) => p.metadata?.name));
      return [
        ...boxes.map(
          (box): RetainedObject => ({
            key: keyFromLabels(box.metadata.labels)!,
            name: box.metadata.name!,
            kind: 'session',
            state:
              podNames.has(box.metadata.name) || currentCondition(box, 'Suspended')?.status !== 'True'
                ? 'stopping'
                : box.metadata.annotations?.[STARTED_ONCE] === 'true'
                  ? 'stopped'
                  : 'prepared',
          }),
        ),
        ...pvcs.items
          .filter((pvc) => pvc.metadata?.labels?.[LABELS.group])
          .map(
            (pvc): RetainedObject => ({
              key: { installSlug, agentGroupId: pvc.metadata!.labels![LABELS.group], sessionId: '' },
              name: pvc.metadata!.name!,
              kind: 'group-storage',
            }),
          ),
      ];
    } catch (error) {
      throw normalizeKubernetesError(error);
    }
  }

  private async deleteSandbox(key: SessionKey, box: Sandbox): Promise<void> {
    try {
      if (box.metadata.uid) this.staleSince.delete(box.metadata.uid);
      await (
        await this.api()
      ).custom.deleteNamespacedCustomObject(
        {
          ...this.params(key.installSlug),
          name: box.metadata.name!,
          body: { preconditions: { uid: box.metadata.uid }, propagationPolicy: 'Background' },
        },
        this.requestOptions(),
      );
    } catch (error) {
      if (apiCode(error) !== 404) throw normalizeKubernetesError(error);
    }
  }

  async reapRetained(installSlug: string, keys: SessionKey[]): Promise<void> {
    const boxes = (await this.listSandboxes(installSlug)).items;
    for (const key of keys) {
      if (key.installSlug !== installSlug || !key.sessionId) continue;
      const box = boxes.find((b) => isDeepStrictEqual(keyFromLabels(b.metadata.labels), key));
      if (
        box &&
        suspended(box) &&
        !isGatewayOwned(box.metadata.labels?.[LABELS.session], box.metadata.labels?.[LABELS.role])
      )
        await this.deleteSandbox(key, box);
    }
  }

  async reapResidue(installSlug: string): Promise<void> {
    for (const snapshot of await this.listSessions(installSlug)) {
      if (snapshot.phase !== 'terminal') continue;
      const box = await this.readSandbox(snapshot.handle.key, snapshot.handle.name);
      if (box && !suspended(box)) await this.deleteSandbox(snapshot.handle.key, box);
    }
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.watches.get(installSlug);
    if (!watch) {
      watch = { subscribers: new Set(), stopped: false, starting: false, attempt: 0, known: new Map() };
      this.watches.set(installSlug, watch);
    }
    const current = watch;
    current.subscribers.add(onEvent);
    if (!current.informer && !current.timer && !current.starting) void this.startWatch(installSlug, current);
    let unsubscribed = false;
    return {
      stop: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        current.subscribers.delete(onEvent);
        if (current.subscribers.size) return;
        current.stopped = true;
        clearTimeout(current.timer);
        void current.informer?.stop().catch(() => {});
        this.watches.delete(installSlug);
      },
    };
  }

  private emit(watch: InstallWatch, event: SessionEvent): void {
    for (const subscriber of watch.subscribers) {
      try {
        subscriber(event);
      } catch {
        log.warn('Kubernetes session watch subscriber failed');
      }
    }
  }

  private async startWatch(installSlug: string, watch: InstallWatch): Promise<void> {
    if (watch.stopped || watch.starting) return;
    watch.starting = true;
    try {
      if (!watch.informer) {
        const { config } = await this.api();
        if (watch.stopped) return;
        const selector = `${LABELS.install}=${projectLabelValue(installSlug)}`;
        watch.informer = (this.opts.informerFactory ?? this.library!.makeInformer<Sandbox>)(
          config,
          `/apis/${GROUP}/${VERSION}/namespaces/${this.namespace(installSlug)}/${PLURAL}`,
          async () => {
            const list = await this.listSandboxes(installSlug);
            const seen = new Set(list.items.map((box) => box.metadata.name!));
            for (const [name, key] of watch.known)
              if (!seen.has(name)) {
                this.emit(watch, { key, kind: 'terminal' });
                watch.known.delete(name);
              }
            return list;
          },
          selector,
        );
        const changed = (box: Sandbox) => {
          const key = keyFromLabels(box.metadata.labels);
          if (!key) return;
          watch.attempt = 0;
          watch.known.set(box.metadata.name!, key);
          const stopped =
            suspended(box) &&
            currentCondition(box, 'Suspended')?.status === 'True' &&
            box.metadata.annotations?.[STARTED_ONCE] === 'true';
          this.emit(watch, { key, kind: sandboxPhase(box) === 'terminal' || stopped ? 'terminal' : 'phase' });
        };
        watch.informer.on('add', changed);
        watch.informer.on('update', changed);
        watch.informer.on('delete', (box) => {
          const key = keyFromLabels(box.metadata.labels);
          if (!key) return;
          watch.known.delete(box.metadata.name!);
          this.emit(watch, { key, kind: 'terminal' });
        });
        watch.informer.on('error', (error?: unknown) => {
          // An intentional stop aborts the old watch; it must not schedule another restart.
          if (error instanceof Error && error.name === 'AbortError') return;
          this.recoverWatch(installSlug, watch);
        });
      }
      await watch.informer.start();
      if (watch.stopped) await watch.informer.stop();
    } catch {
      this.recoverWatch(installSlug, watch);
    } finally {
      watch.starting = false;
    }
  }

  private recoverWatch(installSlug: string, watch: InstallWatch): void {
    if (watch.stopped || watch.timer) return;
    const delay = Math.min(1_000 * 2 ** Math.min(watch.attempt++, 5), 30_000);
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      void (async () => {
        await watch.informer?.stop();
        await this.startWatch(installSlug, watch);
      })().catch(() => this.recoverWatch(installSlug, watch));
    }, delay);
    watch.timer.unref();
  }
}

registerSessionDriver('kubernetes', (policy) => new KubernetesSessionDriver({ ...policy, ...kubernetesSettings() }));
