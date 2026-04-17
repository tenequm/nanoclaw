# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.112
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=latest
ARG X402_PROXY_VERSION=latest
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# ---- Media stack: yt-dlp / instaloader / deno -------------------------------
# Layered after the base apt block so changes here don't bust the main cache.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        atomicparsley \
        python3-pip \
    && pip install --break-system-packages --no-cache-dir \
        yt-dlp \
        yt-dlp-ejs \
        instaloader \
        mutagen \
        pycryptodomex \
        brotli \
        websockets \
        requests \
        certifi \
        curl_cffi \
        secretstorage \
        xattr \
    && rm -rf /var/lib/apt/lists/*

# Deno — required by yt-dlp's modern YouTube signature extractors.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# ---- GitHub CLI (gh) ---------------------------------------------------------
# Auth is injected by OneCLI gateway (Authorization header on api.github.com).
# Agents can run `gh pr list`, `gh repo view`, etc. without holding a real PAT.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# gh refuses to run without a token configured. The placeholder satisfies its
# local auth check; OneCLI's HTTPS_PROXY rewrites Authorization on outbound
# api.github.com calls with the real token from the vault. Same trick the
# vercel-cli skill uses with `--token placeholder`.
ENV GH_TOKEN=placeholder

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- pnpm + global Node CLIs -------------------------------------------------
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# agent-browser has a postinstall build script — pnpm skips these by default.
# Allowlist it via .npmrc so the install doesn't silently produce a broken
# package. Pinned versions so every rebuild is reproducible.
RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    pnpm install -g \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "agent-browser@${AGENT_BROWSER_VERSION}" \
        "vercel@${VERCEL_VERSION}"

# x402-proxy is installed via `npm install -g` to bypass the host pnpm
# supply-chain policy (minimumReleaseAge) — this global install happens
# inside the image build, not against the host workspace.
RUN npm install -g "x402-proxy@${X402_PROXY_VERSION}"

# ---- agent-runner ------------------------------------------------------------
WORKDIR /app

# Copy manifest + lockfile first so the install layer caches independently of
# source edits.
COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Source. Bun runs TS directly — no tsc build step. The host remounts this
# path at runtime via `src/container-runner.ts` so source edits on the host
# take effect without rebuilding the image; the baked copy is the fallback.
COPY agent-runner/ ./

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/global /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 755 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
