---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Welcome the user to NanoClaw. Introduce yourself — you'll be walking them through the entire setup process step by step, from installing dependencies to getting their first message through. Keep it warm and brief (2-3 sentences).

Then explain that setup involves running many shell commands (installing packages, building containers, starting services), and recommend pre-approving the standard setup commands so they don't have to confirm each one individually.

Use `AskUserQuestion` with these options:

1. **Pre-approve (recommended)** — description: "Pre-approve standard setup commands so you don't have to confirm each one. You can review the list first if you'd like."
2. **No thanks** — description: "I'll approve each command individually as it comes up."
3. **Show me the list first** — description: "Show me exactly which commands will be pre-approved before I decide."

If they pick option 1: read `.claude/skills/setup/setup-permissions.json`, then read the project settings file at `.claude/settings.json` (create it if it doesn't exist with `{}`), and directly edit it to add/merge the permissions into the `permissions.allow` array. Do NOT use the `update-config` skill.

If they pick option 3: read and display `.claude/skills/setup/setup-permissions.json`, then re-ask with just options 1 and 2.

If they decline, continue — they'll approve commands individually.

---

**Internal guidance (do not show to user):**

- Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices).
- Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.
- **Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair.
- **UX Note:** Use `AskUserQuestion` for multiple-choice questions only (e.g. "which credential method?"). Do NOT use it when free-text input is needed (e.g. phone numbers, tokens, paths) — just ask the question in plain text and wait for the user's reply.
- **Timeouts:** Use 5m timeouts for install and build steps.
- **Waiting on user:** When the user needs to do something (change a setting, get a token, open a browser, etc.), stop and wait. Give clear instructions, then say "Let me know when done or if you need help." Do NOT continue to the next step. If they ask for help, give more detail, ask where they got stuck, and try to assist.

## 0. Git Upstream

Ensure `upstream` remote points to `qwibitai/nanoclaw`. If missing, add it silently:

```bash
git remote -v
git remote add upstream https://github.com/qwibitai/nanoclaw.git 2>/dev/null || true
```

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `pnpm exec tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record DOCKER value for step 3

### OpenClaw Migration Detection

If OPENCLAW_PATH is not `none` from the environment check above, AskUserQuestion:

1. **Migrate now** — "Import identity, credentials, and settings from OpenClaw before continuing setup."
2. **Fresh start** — "Skip migration and set up NanoClaw from scratch."
3. **Migrate later** — "Continue setup now, run `/migrate-from-openclaw` anytime later."

If "Migrate now": invoke `/migrate-from-openclaw`, then return here and continue at step 2a (Timezone).

## 2a. Timezone

Run `pnpm exec tsx setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true → The system timezone could not be autodetected (e.g. POSIX-style TZ like `IST-2`). AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) and an "Other" escape. Then re-run: `pnpm exec tsx setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success and RESOLVED_TZ is `UTC` or `Etc/UTC` → confirm with the user: "Your system timezone is UTC — is that correct, or are you on a remote server?" If wrong, ask for their actual timezone and re-run with `--tz`.
- If STATUS=success → Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime (Docker)

### 3a. Install Docker

- DOCKER=running → continue to step 4
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. CJK fonts

Agent containers skip CJK fonts by default (~200MB saved). Without them, Chromium-rendered screenshots and PDFs show tofu for Chinese/Japanese/Korean.

- **User writing to you in Chinese, Japanese, or Korean** → enable without asking. Mention it briefly.
- **Resolved timezone from step 2a is a CJK region** (`Asia/Tokyo`, `Asia/Shanghai`, `Asia/Hong_Kong`, `Asia/Taipei`, `Asia/Seoul`) or other signal short of active CJK use → ask: "Enable CJK fonts? Adds ~200MB, lets the agent render CJK in screenshots and PDFs."
- **Otherwise** → skip.

To enable, write `INSTALL_CJK_FONTS=true` to `.env`:

```bash
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env
```

The next step's build picks it up automatically.

### 3c. Build and test

Run `pnpm exec tsx setup/index.ts --step container -- --runtime docker` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f`. Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Credential System

### 4a. OneCLI

Install OneCLI and its CLI tool:

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

Verify both installed: `onecli version`. If the command is not found, the CLI was likely installed to `~/.local/bin/`. Add it to PATH for the current session and persist it:

```bash
export PATH="$HOME/.local/bin:$PATH"
# Persist for future sessions (append to shell profile if not already present)
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Then re-verify with `onecli version`.

Point the CLI at the local OneCLI instance, the ONECLI_URL was output from the install script above:
```bash
onecli config set api-host ${ONECLI_URL}
```

Ensure `.env` has the OneCLI URL (create the file if it doesn't exist):
```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=${ONECLI_URL}' >> .env
```

Check if a secret already exists:
```bash
onecli secrets list
```

If an Anthropic secret is listed, confirm with user: keep or reconfigure? If keeping, skip to step 5.

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

#### Subscription path

Tell the user:

> Run `claude setup-token` in another terminal. It will output a token — copy it but don't paste it here.

Then stop and wait for the user to confirm they have the token. Do NOT proceed until they respond.

Once they confirm, they register it with OneCLI. AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI. Use type 'anthropic' and paste your token as the value."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

#### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

Then AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

#### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-`): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

## 5. Set Up Channels

Show the full list of available channels in plain text (do NOT use AskUserQuestion — it limits to 4 options). Ask which one they want to start with. They can add more later with `/customize`.

Channels where the agent gets its own identity (name and avatar) are marked as recommended.

1. Discord *(recommended — agent gets own identity)*
2. Slack *(recommended — agent gets own identity)*
3. Telegram *(recommended — agent gets own identity)*
4. Microsoft Teams *(recommended — agent gets own identity)*
5. Webex *(recommended — agent gets own identity)*
6. WhatsApp
7. WhatsApp Cloud API
8. iMessage
9. GitHub
10. Linear
11. Google Chat
12. Resend (email)
13. Matrix

**Delegate to the selected channel's skill.** Each channel skill handles its own package installation, authentication, registration, and configuration.

Invoke the matching skill:

- **Discord:** Invoke `/add-discord`
- **Slack:** Invoke `/add-slack`
- **Telegram:** Invoke `/add-telegram`
- **GitHub:** Invoke `/add-github`
- **Linear:** Invoke `/add-linear`
- **Microsoft Teams:** Invoke `/add-teams`
- **Google Chat:** Invoke `/add-gchat`
- **WhatsApp Cloud API:** Invoke `/add-whatsapp-cloud`
- **WhatsApp Baileys:** Invoke `/add-whatsapp`
- **Resend:** Invoke `/add-resend`
- **Matrix:** Invoke `/add-matrix`
- **Webex:** Invoke `/add-webex`
- **iMessage:** Invoke `/add-imessage`

The skill will:
1. Install the Chat SDK adapter package
2. Uncomment the channel import in `src/channels/index.ts`
3. Collect credentials/tokens and write to `.env`
4. Build and verify

**After the channel skill completes**, install dependencies and rebuild — channel merges may introduce new packages:

```bash
pnpm install && pnpm run build
```

If the build fails, read the error output and fix it (usually a missing dependency). Then continue to step 5a.

## 6. Mount Allowlist

Set empty mount allowlist (agents only access their own workspace). Users can configure mounts later with `/manage-mounts`.

```bash
pnpm exec tsx setup/index.ts --step mounts -- --empty
```

## 7. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `pnpm exec tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 7a. Wire Channels to Agent Groups

The service is now running, so polling-based adapters (Telegram) can observe inbound messages — required for pairing.

Invoke `/manage-channels` to wire the installed channels to agent groups. This step:
1. Creates the agent group(s) and assigns a name to the assistant
2. Resolves each channel's platform-specific ID (Telegram via pairing code; other channels via the platform's own ID lookup)
3. Decides the isolation level — whether channels share an agent, session, or are fully separate

The `/manage-channels` skill reads each channel's `## Channel Info` section from its SKILL.md for platform-specific guidance (terminology, how to find IDs, recommended isolation).

**This step is required.** Without it, channels are installed but not wired — messages will be silently dropped because the router has no agent group to route to.

## 7b. Dashboard & Web Applications

AskUserQuestion: Do you want to create a dashboard and build web applications?

1. **Yes (recommended)** — description: "Get a NanoClaw dashboard to monitor your agents and build custom websites however you want. Deploys to Vercel."
2. **Not now** — description: "You can add this later with `/add-vercel`."

If yes: invoke `/add-vercel`.

## 8. Verify

Run `pnpm exec tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `pnpm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4 (check `onecli secrets list`)
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke `/manage-channels` from step 7a
Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), credential system not running (check `curl ${ONECLI_URL}/api/health`), missing channel credentials (re-invoke channel skill).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure Docker is running — `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `pnpm exec tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`


## 9. Fork Setup

Only run this after the user has confirmed 2-way messaging works.

Check `git remote -v`. If `origin` points to `qwibitai/nanoclaw` (not a fork), ask in plain text:

> We recommend forking NanoClaw so you can push your customizations and pull updates easily. Would you like to set up a fork now?

If yes: instruct the user to fork `qwibitai/nanoclaw` on GitHub (they need to do this in their browser), then ask for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/nanoclaw.git
git push --force origin main
```

If no: skip — upstream is already configured from step 0.
