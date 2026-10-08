# Local agent-sandbox playground (kind)

A throwaway Kubernetes cluster on your machine, running the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller
(v1.0.2, pinned) and our agent image as a `Sandbox` claimed from a warm pool.
It is the bench for the upcoming agent-sandbox `SessionDriver`: everything the
driver will create (templates, pools, claims, lifecycle patches) can be tried
here in seconds, without touching a real cluster.

Plain runc, no gVisor. Isolation strength is not what this is for.

## Prerequisites

- Docker (tested on OrbStack; Docker Desktop should behave the same apart from
  the host-reachability notes below), `kind` (`brew install kind`), `kubectl`.
- The agent image in the local docker store: `./container/build.sh`
  (a few minutes, ~4.6GB). It tags `nanoclaw-agent-v2-<slug>:latest`, where the
  slug is derived from the checkout path. That is the default `up.sh` uses.

## Usage

```sh
./dev/k8s/up.sh                                  # create or converge; safe to re-run
NANOCLAW_K8S_IMAGE=my-agent:tag ./dev/k8s/up.sh  # any other local image
export KUBECONFIG=$PWD/dev/k8s/.kubeconfig       # then plain kubectl works
./dev/k8s/down.sh                                # delete the cluster
```

`down.sh` removes the node container and `dev/k8s/.kubeconfig`; the shared
`kind` docker network stays, as it does for every kind cluster.

The scripts never read or write `~/.kube/config`: the cluster's credentials
live in `dev/k8s/.kubeconfig` (gitignored) and every call names the
`kind-nanoclaw-dev` context, so a stray command can not land on a real
cluster.

`up.sh` creates the `nanoclaw-dev` cluster if absent, server-side-applies the
v1.0.2 `sandbox-with-extensions.yaml` release manifest, waits for the CRDs and
the controller rollout, loads the agent image into the node (skipped when the
node already has that exact image), applies `sandbox-template.yaml` +
`warm-pool.yaml`, waits for the pool to be warm, then applies
`sample-claim.yaml` and waits for the claimed `Sandbox` to be `Ready`.

Measured on an M-series Mac with OrbStack: about 70s from nothing (kind ~25s,
image load ~35s, everything else under 5s); a re-run on a live cluster about 3s.

Lifecycle by hand:

```sh
S=$(kubectl get sandboxclaim nanoclaw-sample -o jsonpath='{.status.sandbox.name}')
kubectl patch sandbox $S --type merge -p '{"spec":{"operatingMode":"Suspended"}}'
kubectl wait --for=condition=Suspended sandbox/$S
kubectl patch sandbox $S --type merge -p '{"spec":{"operatingMode":"Running"}}'
kubectl wait --for=condition=Ready sandbox/$S
```

After rebuilding the image under the same tag, `up.sh` reloads it, but running
pods keep the old one: delete the claim and the warm sandboxes, or
`down.sh && up.sh`.

## What it deliberately does not do yet

- **No SessionDriver.** Nothing in `src/` knows this cluster exists.
- **The agent-runner does not run.** The template runs
  `tini -- sleep infinity` instead of the image's entrypoint: the runner needs
  its mailbox mounts to start. This proves scheduling and lifecycle, not the
  runner.
- No PVCs, no sandbox-router, no Service, no secrets, no gVisor.

## Findings

Recorded 2026-10-08, kind v0.33.0 (node `kindest/node:v1.37.0`), OrbStack,
agent-sandbox v1.0.2.

### Lifecycle

- **Warm adoption works and is instant.** With the pool at 1 ready replica, a
  new `SandboxClaim` adopts the warm sandbox (name stays
  `nanoclaw-agent-pool-xxxxx`, label `agents.x-k8s.io/launch-type: warm`) and is
  `Ready` in ~0.2s; the pool replenishes within a second. Deleting the claim
  (`shutdownPolicy: Delete`) and recreating it adopts the next warm sandbox in
  ~0.2s. The adopted `Sandbox` becomes owned by the claim (ownerReference), so
  claim deletion garbage-collects it.
- **Suspend = delete the pod.** `operatingMode: Suspended` deletes the pod and
  keeps the `Sandbox` object (`Suspended=True` reason `PodTerminated`,
  `Ready=False` reason `SandboxSuspended`). Timings, three rounds: suspend
  1.7-2.7s, resume to `Ready=True` 0.3s (image already on the node).
- **A bare `sleep infinity` makes suspend take 31s.** As PID 1 it ignores
  SIGTERM, so every suspend waited out the 30s grace period. Keeping the image's
  `tini` as PID 1 fixes it; the real runner already runs under tini. A driver
  should still budget for `terminationGracePeriodSeconds` on suspend.
- **Every resume gets a new pod IP** (10.244.0.8 -> .9 -> .10 across three
  rounds). Without PVCs nothing on the filesystem survives a suspend either.
- **A template change never reaches a claimed sandbox.** With the default
  `OnReplenish` strategy even warm sandboxes stay stale until handed out; the
  pool here uses `Recreate`, which replaced the stale warm sandbox within
  seconds while the claimed one kept the old spec.

### Secure-by-default network behaviour

With `networkPolicyManagement` left at its default (`Managed`) and no
`spec.networkPolicy`, the controller:

- creates one shared NetworkPolicy per template
  (`<template>-network-policy`): ingress only from the sandbox-router pods in
  `agent-sandbox-system`; egress to `0.0.0.0/0` and `::/0` **except** 10/8,
  172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10;
- rewrites the pod to `dnsPolicy: None` with nameservers 8.8.8.8 and 1.1.1.1,
  so cluster DNS and any resolver-provided host names are gone;
- sets `automountServiceAccountToken: false`.

kind's kindnet enforces NetworkPolicy, so all of this is live here. Supplying
any `spec.networkPolicy` (or `Unmanaged`) drops the DNS rewrite and the pod is
back on `ClusterFirst`. The DNS rewrite is applied when the pod spec is built,
so changing the template's policy later does not change DNS on existing pods.

### Reaching the Mac from a sandbox (mailbox-over-HTTP path)

A listener on the Mac at `0.0.0.0:3999`, probed with curl from inside pods:

| Target | kind node | plain pod (no policy) | sandbox, default policy | sandbox, custom policy |
|---|---|---|---|---|
| `host.docker.internal` | 200 | 200 | DNS fails | 200 |
| `0.250.250.254` (OrbStack's host IP) | 200 | 200 | 200 | 200 |
| `192.168.97.1` (kind network gateway) | timeout | refused | timeout | - |
| `192.168.8.141` (Mac LAN IP) | 200 | 200 | timeout | timeout |
| `100.84.68.83` (Mac tailnet IP) | 200 | 200 | 200 | timeout |

"custom policy" was a probe template whose `spec.networkPolicy` allowed only
kube-dns:53 and `0.250.250.254/32:3999`; public egress (`example.com`) was then
blocked as well, as expected.

- **The default policy blocks the Docker Desktop host but not OrbStack's.**
  OrbStack puts the host at `0.250.250.254`, outside every excluded range, so it
  is reachable by IP even under the default policy, but not by name (public DNS
  cannot resolve `host.docker.internal`). Docker Desktop's host address
  (192.168.65.x, not tested here) falls inside 192.168/16 and would be blocked. The Mac's
  tailnet IP (100.64/10, CGNAT) also slips through the default policy.
- **The kind network gateway is not the Mac** under OrbStack; do not use the
  pod or node default route to find the host.
- **OrbStack's `host.docker.internal` reaches loopback-only listeners.** A
  listener bound to `127.0.0.1:3998` on the Mac answered via
  `host.docker.internal` from the node (the Mac logs the peer as 127.0.0.1),
  while the LAN and tailnet IPs did not. The host does not need to bind
  0.0.0.0 for this path.
- **There is an enforcement gap at template creation.** A pool created in the
  same instant as its template had unrestricted egress for its first few
  seconds (LAN, tailnet and public all answered), and the policy was enforced
  by the next probe ten seconds later. Seen with kindnet; not checked on other CNIs.

What this means for the driver: the host endpoint should be passed in
explicitly (env or claim), and the template should carry its own
`spec.networkPolicy` that allows exactly that endpoint plus DNS, rather than
relying on the default policy and host names.

### Other notes

- v1.0.2 `SandboxClaim.spec.warmPoolRef` is required: no warm pool, no claim.
- Claims can inject env (`spec.env`) and PVCs, but only when the template opts
  in (`envVarsInjectionPolicy`, `volumeClaimTemplatesPolicy`, both default
  `Disallowed`); left at the defaults here.
- `kind load docker-image` never sees the image as present under Docker's
  containerd image store (OrbStack and recent Docker Desktop): docker reports
  the index digest, the node the config digest, so it re-copied ~4.6GB on every
  run. `up.sh` compares the index digest against the node's containerd image
  list itself.
- agent-sandbox v1.0.5 is out; this stays on v1.0.2 until the driver work picks
  a version.
