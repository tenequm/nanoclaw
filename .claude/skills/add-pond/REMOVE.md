# Remove Pond Integration

Reverses every change `/add-pond` made. Recall stores under `data/pond/` are user data — this file tells you how to delete them but never does so silently.

## 1. Unschedule the sync

macOS:

```bash
source setup/lib/install-slug.sh
LABEL="$(launchd_label).pond-sync"
launchctl unload ~/Library/LaunchAgents/$LABEL.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/$LABEL.plist
```

Linux:

```bash
source setup/lib/install-slug.sh
UNIT="$(systemd_unit)-pond-sync"
systemctl --user disable --now $UNIT.timer 2>/dev/null
rm -f ~/.config/systemd/user/$UNIT.service ~/.config/systemd/user/$UNIT.timer
systemctl --user daemon-reload
```

## 2. Revert the code reach-ins

- In `src/container-runner.ts`: delete the `import { pondMounts } from './pond-mounts.js';` line and the `mounts.push(...pondMounts(agentGroup.id, DATA_DIR));` line (and its comment) in `buildMounts`.
- In `container/agent-runner/src/index.ts`: delete the `import { pondMcpServers } from './pond-mcp.ts';` line and the `Object.assign(mcpServers, pondMcpServers());` line.
- In `container/Dockerfile`: delete the whole `# ---- pond — cross-session recall` block (the `ARG POND_VERSION` line through the `chmod +x /usr/local/bin/pond` line).

## 3. Delete every copied file

```bash
rm -f src/pond-mounts.ts src/pond-mounts.test.ts src/pond-dockerfile.test.ts
rm -f container/agent-runner/src/pond-mcp.ts container/agent-runner/src/pond-registration.test.ts
rm -f scripts/pond-sync.sh
rm -rf container/skills/pond-recall
```

## 4. Rebuild and restart

```bash
pnpm run build
./container/build.sh
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux
```

## 5. Stores and grants (ask first)

```bash
rm -f data/pond/access.json          # revokes shared/operator grants
# Only if the user confirms deleting recall history:
# rm -rf data/pond
```

The host `pond` binary and the embedding-model cache (`~/.cache/huggingface/hub/models--intfloat--multilingual-e5-small`) may serve the user's own pond outside NanoClaw — leave them unless the user asks.
