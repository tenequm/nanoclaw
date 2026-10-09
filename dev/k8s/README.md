# Local Kubernetes driver bench

One long-lived [kind](https://kind.sigs.k8s.io/) cluster, pinned Kubernetes 1.37
and [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) v1.0.6.
The driver creates bare Sandboxes. Templates, warm pools and claims remain an
optional playground. Plain runc; this bench does not provide production isolation.

## Start and edit loop

Prerequisites: local Docker (validated on [OrbStack](https://orbstack.dev/)),
kind and kubectl, plus an agent base image from `./container/build.sh`.
For this fork's existing base image:

```sh
NANOCLAW_K8S_IMAGE=nanoclaw-agent-v2-bc64d37f:latest ./dev/k8s/up.sh
SOURCE_IMAGE=$(./dev/k8s/build-source.sh)
NS=$(./dev/k8s/namespace.sh create 'my-run')
HOST_ADDRESS=$(./dev/k8s/host-address.sh)
# Run the driver harness in $NS with the printed base reference and $SOURCE_IMAGE.
./dev/k8s/namespace.sh delete "$NS"
```

Without `NANOCLAW_K8S_IMAGE`, `up.sh` uses the base built for this checkout.
It creates or converges the cluster, installs the controller and loads both
images. A re-run skips unchanged image loads. After editing runner source or
skills, run `build-source.sh` and use its new digest in the next Sandbox
podTemplate. Running pods retain their mounted bytes; suspend and resume with
the updated podTemplate to pick up a change.

All scripts use `dev/k8s/.kubeconfig` and context `kind-nanoclaw-dev`; they never
use `~/.kube/config`. Use both explicitly for manual commands:

```sh
kubectl --kubeconfig dev/k8s/.kubeconfig --context kind-nanoclaw-dev get sandboxes -A
./dev/k8s/up.sh --playground   # optional template, warm pool, claim
./dev/k8s/down.sh             # deletes this local cluster
```

## Image references and ImageVolume mounts

`up.sh` retags the local base using its Docker content ID. The validated base is:

```text
nanoclaw-agent-dev:sha256-319e17ce64bf1ed761cc5f6f8d1b371634300565cc299975bf1523797fb41789
```

Set container `imagePullPolicy: IfNotPresent` explicitly. The tag is immutable
by convention, includes the entire content ID, and avoids the `:latest` pull
trap. It is local to this node, not published to a registry.

`container/Dockerfile.k8s` has two targets: `baked` (the default complete image)
and `source` (scratch with `/src` and `/skills`). The latter is a real image
with config and rootfs layers, not an empty-config OCI artifact. The source
builder loads it and registers a digest alias in the node's containerd image
store; its **stdout contains only the digest reference**, build output goes to
stderr. For the validated checkout that reference is:

```text
docker.io/library/nanoclaw-source-dev@sha256:cd907d6dae39540eeb61939fabb0e3399875078c27f7b7bc2c831c9695444372
```

Use the reference printed by your build, since source edits change the digest.
In a bare `agents.x-k8s.io/v1beta1` Sandbox podTemplate:

```yaml
volumes:
  - name: source
    image:
      reference: docker.io/library/nanoclaw-source-dev@sha256:<printed-digest>
      pullPolicy: IfNotPresent
containers:
  - name: agent
    # image, command, securityContext and other mounts omitted here
    volumeMounts:
      - name: source
        mountPath: /app/src
        subPath: src
        readOnly: true
      - name: source
        mountPath: /app/skills
        subPath: skills
        readOnly: true
```

Validated on kind's containerd 2.3.4: both subPaths are read-only; `/app/node_modules`
and `/app/package.json` remain present. ImageVolume `IfNotPresent` and `Never`
use the side-loaded digest alias. `Always` attempts a registry pull and fails
for these unpublished images. This is a local delivery mechanism; production
needs registry delivery and compatible Kubernetes/containerd, or the baked image.

## Test namespaces and host reachability

`namespace.sh create [suffix]` prints a fresh `nanoclaw-test-<suffix>` namespace.
The optional suffix is lowercased, RFC1123-sanitized and capped at 63 total
characters; omit it for a timestamp/random suffix. Explicit duplicate names
fail rather than reuse state. `delete <name>` accepts only test namespaces and
returns after requesting deletion (`--wait=false`). Scripts and vitest can call
it with `execFile`; trim stdout for the returned name.

`host-address.sh` resolves `host.docker.internal` inside the node using
`getent ahostsv4`; it never hardcodes an OrbStack address. Probe it from an
actual bare Sandbox:

```sh
./dev/k8s/probe-host.py --image nanoclaw-agent-dev:sha256-319e17ce64bf1ed761cc5f6f8d1b371634300565cc299975bf1523797fb41789
```

The probe starts two ephemeral Mac HTTP listeners, creates its own namespace
and Sandbox, probes both from that Sandbox, then closes listeners and requests
namespace deletion even on failure. On this OrbStack installation the resolved
address was `0.250.250.254`, and both `0.0.0.0` and `127.0.0.1` listeners returned
HTTP 200. Re-probe on another runtime; loopback forwarding is runtime-specific.
Bare Sandboxes use permissive networking here. Template defaults can rewrite
DNS and create NetworkPolicy, so the optional playground has different behavior.

## Lifecycle and outage tests

Create group PVCs without waiting for Bound: the default local-path StorageClass
is WaitForFirstConsumer. A Suspended Sandbox referencing a Pending PVC creates
successfully; switching to Running schedules its pod and binds the PVC.
Use `restartPolicy: Never`, fixed uid/gid 1000 with `fsGroup: 1000`, tini as PID 1,
capabilities drop ALL, `allowPrivilegeEscalation: false`, no service-account token,
and memory emptyDir for `/dev/shm`. Init containers can create PVC subdirectories
as that uid before per-file Secret subPath mounts attach.

For every lifecycle wait, check the relevant condition's `observedGeneration`
against `metadata.generation`. Suspend deletes the pod but retains the Sandbox,
PVC and owned Secret. Wait for `Suspended=True` and pod deletion before updating
Secret bytes and resuming; the new pod UID then sees the new per-file contents.
Terminal pods report `Finished=True` with `PodSucceeded` or `PodFailed`; get the
pod's terminated container status for the exit code.

For a real API outage, move the static-pod manifest out of its watched directory
and restore it in a `finally`/trap:

```sh
docker exec nanoclaw-dev-control-plane mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml
# Observe API failure, then always restore:
docker exec nanoclaw-dev-control-plane mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/kube-apiserver.yaml
```

Do not pause the node for this test: that leaves half-open sockets. client-node
2.0.0 informers reconnect automatically for watch timeouts/410, but a fetch
failure emits `error` and requires an application restart/backoff handler.
