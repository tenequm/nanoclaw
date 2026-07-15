/**
 * Pond recall store mounts: skill-owned logic behind the single `buildMounts`
 * reach-in (.claude/skills/add-pond).
 *
 * One concept: a store with `ingest` and `read` member lists, declared in
 * `data/pond/stores.json`: a host-only file no container can reach:
 *
 *   {
 *     "stores": {
 *       "team":    { "ingest": ["<gid>", "<gid>"], "read": ["<gid>"] },
 *       "mychat":  { "ingest": ["<gid>"], "read": ["<gid>"] },
 *       "archive": { "backend": "s3+https://…", "ingest": ["<gid>"], "read": ["<gid>"] }
 *     }
 *   }
 *
 * `ingest` is enforced by the host sync loop (scripts/pond-sync.sh): which
 * groups' transcripts get written into the store. `read` is enforced here:
 * which groups' containers get the store mounted. The two are independent on
 * purpose: a group can contribute its transcripts to a store it cannot
 * search (e.g. every teammate feeds a shared store only a librarian agent
 * reads).
 *
 * A local store (no `backend`, or `backend: "local"`) lives at
 * `data/pond/stores/<name>` and mounts read-only at
 * /workspace/extra/pond/<name>. A remote backend (a URL) cannot be mounted:
 * reads for those ride the credential gateway (a host-side `pond serve` plus
 * an injected bearer token), so this module skips them: `read` on a remote
 * store documents that path, it grants nothing here.
 *
 * Everything mounted is read-only; pond's MCP surface is read-only by design
 * and the ro mount enforces it even against a direct `pond` invocation in
 * the shell.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { VolumeMount } from './providers/provider-container-registry.js';

/** Container-side root; `pond-mcp.ts` in the agent-runner probes these paths. */
export const POND_CONTAINER_ROOT = '/workspace/extra/pond';

/** Embedding model pond embeds queries with; synced stores carry its vectors. */
const POND_MODEL_CACHE_SUBPATH = path.join('.cache', 'huggingface', 'hub', 'models--intfloat--multilingual-e5-small');

interface PondStore {
  backend?: string;
  ingest?: string[];
  read?: string[];
}

interface PondStoresConfig {
  stores?: Record<string, PondStore>;
}

function readStoresConfig(pondDir: string): PondStoresConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(pondDir, 'stores.json'), 'utf8')) as PondStoresConfig;
  } catch {
    // Absent or malformed config means no stores, no mounts. Installs
    // without the skill configured see a silent no-op.
    return {};
  }
}

function isRemote(store: PondStore): boolean {
  return Boolean(store.backend && store.backend !== 'local');
}

/**
 * Pond store mounts for one agent group. Returns [] until the operator has
 * written `data/pond/stores.json` and a first sync has created a store
 * directory, so the `buildMounts` reach-in is a no-op on unconfigured
 * installs.
 */
export function pondStoreMounts(agentGroupId: string, dataDir: string): VolumeMount[] {
  const pondDir = path.join(dataDir, 'pond');
  const config = readStoresConfig(pondDir);
  const mounts: VolumeMount[] = [];

  for (const [name, store] of Object.entries(config.stores ?? {})) {
    if (!store.read?.includes(agentGroupId)) continue;
    if (isRemote(store)) continue; // remote reads go through the gateway, never a mount
    const storeDir = path.join(pondDir, 'stores', name);
    if (!fs.existsSync(storeDir)) continue;
    mounts.push({
      hostPath: storeDir,
      containerPath: `${POND_CONTAINER_ROOT}/${name}`,
      readonly: true,
    });
  }

  // Query-side embedding model: pond embeds the *query* at search time, so
  // vector search inside the (offline) container needs the model weights the
  // host sync already downloaded. Only the one model directory is mounted -
  // never the whole HF cache, which can hold an auth token.
  if (mounts.length > 0) {
    const hostModelCache = path.join(os.homedir(), POND_MODEL_CACHE_SUBPATH);
    if (fs.existsSync(hostModelCache)) {
      mounts.push({
        hostPath: hostModelCache,
        containerPath: path.join('/home/node', POND_MODEL_CACHE_SUBPATH),
        readonly: true,
      });
    }
  }

  return mounts;
}
