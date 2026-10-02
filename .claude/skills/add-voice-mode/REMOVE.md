# Remove Voice mode

Reverses `/add-voice-mode`. Every step can be re-run, and works on a partial
install: a step whose target is already gone does nothing.

## 1. Stop the worker

Stop and remove the worker's service, if one was installed:

```bash
# Linux
if [ -f ~/.config/systemd/user/nanoclaw-voice-mode-worker.service ]; then
  systemctl --user disable --now nanoclaw-voice-mode-worker.service
  rm -f ~/.config/systemd/user/nanoclaw-voice-mode-worker.service && systemctl --user daemon-reload
fi
# macOS
if [ -f ~/Library/LaunchAgents/com.nanoclaw-voice-mode-worker.plist ]; then
  launchctl unload ~/Library/LaunchAgents/com.nanoclaw-voice-mode-worker.plist
  rm -f ~/Library/LaunchAgents/com.nanoclaw-voice-mode-worker.plist
fi
```

Remove the `tailscale serve` mount or proxy route for `/voice` (and, with a
self-hosted LiveKit, for `/rtc` and the TURN name) too.

## 2. Retire the lines

With the host still running, invalidate every call link (the table holds only
token hashes, the caller and the bound chat). The empty table stays, so a later
reinstall starts with no working links. On an install whose host never started
with the channel there is no table, and the command reports `no such table`:
nothing to retire.

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM voice_mode_lines"
```

Roles granted for `/voice` are core's and stay; revoke any you no longer want
with `ncl roles revoke`.

## 3. Remove the registration

Delete the line `import './voice-mode.js';` from `src/channels/index.ts`:

```bash
sed -i.bak "/^import '\.\/voice-mode\.js';$/d" src/channels/index.ts && rm -f src/channels/index.ts.bak
```

## 4. Remove the copied files

```bash
rm -f src/channels/voice-mode.ts src/channels/voice-mode-page.ts src/channels/voice-mode-command.ts \
  src/channels/voice-mode-line.ts src/channels/voice-mode-livekit.ts src/channels/voice-mode-protocol.ts \
  src/channels/voice-mode-route.ts src/voice-mode-worker.ts src/db/voice-mode-lines.ts \
  src/channels/voice-mode-registration.test.ts src/channels/voice-mode-adapter.test.ts \
  src/channels/voice-mode-page.test.ts src/channels/voice-mode-command.test.ts \
  src/channels/voice-mode-line.test.ts src/channels/voice-mode-livekit.test.ts \
  src/channels/voice-mode-route.test.ts src/voice-mode-worker.test.ts
rm -rf container/skills/voice-mode-formatting
```

## 5. Make the router's delivery private again

Applying the skill exported `deliverToAgent` from `src/router.ts`. Make it
private again unless other code now imports it (then the command lists those
files and changes nothing):

```bash
if grep -rlqE --include='*.ts' --exclude=router.ts "import .*\bdeliverToAgent\b" src; then
  grep -rlE --include='*.ts' --exclude=router.ts "import .*\bdeliverToAgent\b" src
else
  sed -i.bak 's/^export async function deliverToAgent(/async function deliverToAgent(/' src/router.ts && rm -f src/router.ts.bak
fi
```

## 6. Remove the packages

Remove each LiveKit package unless remaining code still imports it (another
voice integration, say):

```bash
for pkg in @livekit/agents @livekit/agents-plugin-google @livekit/agents-plugin-silero @livekit/rtc-node livekit-server-sdk; do
  grep -q "\"$pkg\"" package.json || continue
  if grep -rqIE --exclude-dir=node_modules "from ['\"]$pkg['\"/]" src setup scripts container 2>/dev/null; then
    echo "keeping $pkg: still imported"
  else
    pnpm remove "$pkg"
  fi
done
```

`zod` may be shared. Remove it only when no code imports it and no other
package depends on it (`pnpm why zod` lists nothing but the project itself):

```bash
grep -rlE --include='*.ts' "from ['\"]zod" src setup scripts container/agent-runner/src 2>/dev/null
pnpm why zod
```

If both show nothing else uses it: `pnpm remove zod`.

## 7. Remove the environment keys

Keep a private copy of `.env` first; delete it once nothing turned out to need
a removed key:

```bash
(umask 077 && cp .env .env.before-voice-mode-remove)
```

The `VOICE_MODE_*` keys are this skill's alone:

```bash
sed -i.bak '/^VOICE_MODE_[A-Z_]*=/d' .env && rm -f .env.bak
```

The LiveKit and Gemini keys may serve another integration, so each goes only
when nothing left in the checkout mentions it (code, scripts, compose or
Docker files). Keep by hand any you set for something outside this checkout:

```bash
for key in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_WORKER_URL LIVEKIT_AGENT_NAME LIVEKIT_HOST_URL GEMINI_API_KEY; do
  if grep -rqI --exclude-dir={node_modules,.git,dist,data,logs,groups} --exclude='.env*' --exclude='*.md' "$key" . 2>/dev/null; then
    echo "keeping $key: still mentioned by remaining files"
  else
    sed -i.bak "/^$key=/d" .env && rm -f .env.bak && echo "removed $key"
  fi
done
```

## 8. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

Applying the skill adds no git remote; if you added one only to fetch its files,
remove it with `git remote remove <name>`. A LiveKit Cloud project or a
self-hosted LiveKit server is yours to delete.
