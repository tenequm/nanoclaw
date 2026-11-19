# Peer channel and mesh membership

Replay after section [08](08-app.md) and the HTTP mailbox in section [06](06-mailbox-k8s.md). Use the integrated fork revision containing both the peer adapter and its agent tools. The core history starts at [the wire contract](https://github.com/tenequm/nanoclaw/commit/4856b8c663a3ecd5f5bd09f093266fc3e28d4bee), adds [storage](https://github.com/tenequm/nanoclaw/commit/368d20b77605f08175714b71f26a81b1a2545fc6), [session routing](https://github.com/tenequm/nanoclaw/commit/039e27aa360d51619b8f3c05515f685ce36ffea0), [signed routes and replay](https://github.com/tenequm/nanoclaw/commit/506740bf8acba3ed0eb9163b8f20de9697d3c121), [cross-machine and admission tests](https://github.com/tenequm/nanoclaw/commit/9c2ae56b7f9cdf905cd9701e70576af16816774b), [provider permission reporting](https://github.com/tenequm/nanoclaw/commit/82998b9e82111571477fdc4a2c5dd2e27acfc80f) and [durable send acknowledgement](https://github.com/tenequm/nanoclaw/commit/d4174e48bbfa7a2ab2d2c71ca36d566c7701a62d).

## Copy

- Copy `src/channels/peer/` in full, including its OpenAPI source, generated types and request schemas, contract tests, store, routing, lifecycle, stream, group instructions and directory projection. Copy `scripts/generate-peer-contract.mjs` and restore its package dependencies. Regenerate both artifacts from the same contract when the wire changes.
- Copy `src/cli/resources/peers.ts`, its dispatcher tests and [the operator guide](../docs/peer-channel.md).

## Merge into the new upstream

1. Import the peer channel and its directory lifecycle from the channel barrel. The store registers the named central migration. Keep the webhook root route behind the voice proxy gate. Preserve signature verification, nonce persistence, epoch checks, bounded queueing and stream teardown.
2. In `src/delivery.ts`, dispatch peer outbound rows with the sending session and stable outbox id, clear the delivered outbox, and suppress cross-chat echoes. In `src/router.ts`, reset peer hops on owner chat turns. In the agent-to-agent guard, accept shared mesh membership alongside an existing destination grant and preserve the subsequent target and policy checks.
3. Add the mesh peer record to the canonical mailbox model and regenerate the runner copy with `pnpm mailbox-model:generate`. Carry the host and runner mailbox operations, the inbound SQLite schema and the lazy upgrade for existing databases. Keep group ids internal to agent routing. Refresh on wake in `src/container-runner.ts` and on store changes in the directory module.
4. Apply the peer snapshot changes to **both** HTTP transport ends after installing the HTTP mailbox skill. The host includes the directory on every snapshot and the runner replaces its replica, including on empty snapshots. Older hosts can omit the field. Repeat this merge if the mailbox skill is reapplied. Retain the host/runner integration test in `container/mailbox-http.test.ts`.
5. In the runner's destination resolver, share mesh lookup between tools, inbound sender labels and explicit reply tags. In the core tools, register `list_peers`, resolve peer names in `send_message`, and send file descriptions for remote sessions. Keep the peer reply address in the formatter, peer question routing in the interactive tools, and the core tool instructions and regression tests. Peer addresses belong in the mailbox, outside the generated prompt.
6. Import the CLI resources in `src/cli/resources/index.ts`. All machine and membership commands are host-only. Carry the first-stamp boolean mesh flag through the template extension reader, parser and creator.
7. In `scripts/local/stack.py`, retain the `nanoclaw-peer` Traefik router for the local chain, using the voice route's host service. Production ingress is configured separately.

## Verify

Run `pnpm check --base origin/main` and the peer routing, CLI and mailbox tests against the replayed source. On a disposable test stack, confirm a network-admitted hello through Caddy, directory refresh and removal in a running agent, and a reply to the originating session. Use test identities for live messages.
