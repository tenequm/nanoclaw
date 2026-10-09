import { createHash } from 'crypto';

import { readEnvFile } from '../env.js';

import { registerSessionDriver } from './driver-registry.js';
import {
  asFailureError,
  type DriverCapabilities,
  type MountPolicy,
  type SessionDriver,
  type SessionHandle,
  type SessionKey,
  type SessionSnapshot,
  type SessionSpec,
  type SessionWatch,
  type SessionEvent,
} from './types.js';

export interface KubernetesDriverOptions extends MountPolicy {
  kubeconfigPath?: string;
  context?: string;
  namespace?: string;
  hostAddress?: string;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
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

export class KubernetesSessionDriver implements SessionDriver {
  readonly kind = 'kubernetes';

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
    return kubernetesName(`ncl-${key.agentGroupId}-${key.sessionId}`, JSON.stringify(key));
  }

  async prepare(_spec: SessionSpec): Promise<SessionHandle> {
    throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
  }

  async listSessions(_installSlug: string): Promise<SessionSnapshot[]> {
    throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
  }

  watchSessions(_installSlug: string, _onEvent: (event: SessionEvent) => void): SessionWatch {
    return { stop() {} };
  }
}

registerSessionDriver('kubernetes', (policy) => new KubernetesSessionDriver({ ...policy, ...kubernetesSettings() }));
