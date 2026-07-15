# Remove add-pond

Reverses every change `/add-pond` made. Data (pond stores, stores.json) is user
runtime data: removal steps for it are listed last and are optional.

## 1. Delete the copied files

```bash
rm -f src/pond-stores.ts src/pond-stores.test.ts src/pond-dockerfile.test.ts
rm -f container/agent-runner/src/pond-mcp.ts container/agent-runner/src/pond-registration.test.ts
rm -f scripts/pond-sync.sh
rm -rf container/skills/pond-recall
```

## 2. Revert the reach-ins

In `src/container-runner.ts`, delete the import line:

```ts
import { pondStoreMounts } from './pond-stores.js';
```

and the block in `buildMounts`:

```ts
  // Pond recall stores (.claude/skills/add-pond): read-only, host-decided.
  mounts.push(...pondStoreMounts(agentGroup.id, DATA_DIR));
```

In `container/agent-runner/src/index.ts`, delete the import line:

```ts
import { pondMcpServers } from './pond-mcp.js';
```

and the merge line:

```ts
  Object.assign(mcpServers, pondMcpServers());
```

## 3. Revert the Dockerfile layer

Delete the block starting `# ---- pond` through the `chmod +x /usr/local/bin/pond` line (the `ARG POND_VERSION` and the whole `RUN` that installs it), then rebuild:

```bash
./container/build.sh
```

## 4. Remove the sync schedule

If a systemd user timer (or cron entry) was created for `scripts/pond-sync.sh`, remove it:

```bash
systemctl --user disable --now nanoclaw-pond-sync.timer 2>/dev/null
rm -f ~/.config/systemd/user/nanoclaw-pond-sync.{service,timer}
systemctl --user daemon-reload
```

## 5. Restart the service

```bash
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## 6. Optional: delete the data

Only if the recall corpora should be destroyed too. Remote stores (URL
backends) are never touched by removal.

```bash
rm -rf data/pond
```
