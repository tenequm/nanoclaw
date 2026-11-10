# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The BuildKit frontend above is pinned by digest, so a build fetches it by
# content address and never asks Docker Hub to resolve the `1.7` tag first. The
# tag lookup is the HEAD request that returned 500 and took two registry-skills
# legs down on 2026-09-07 with the code untouched. Resolved with
# `crane digest docker/dockerfile:1.7` (docker buildx imagetools inspect agrees).
# Bump the tag and digest together.
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

# Pinned by digest so a rebuild cannot reuse a cached older base; bump tag and digest together.
FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin versions for reproducibility. Bump deliberately — unpinned installs mean
# every rebuild silently picks up the latest and can break in lockstep across
# all users. The global Node CLIs (claude-code, agent-browser) are
# pinned in cli-tools.json so a skill can add one with a json-merge; Bun (the
# runtime) is pinned here because it installs from a different source.
ARG BUN_VERSION=1.4.4

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
# poppler-utils: Claude Code's Read tool shells out to pdftoppm to open a PDF;
# without it every PDF a user sends comes back as an error.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libnss3-tools \
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
        poppler-utils \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Fork additions (tenequm/nanoclaw) --------------------------------------
# One contiguous block through the pond section; upstream lines stay untouched.

# ---- Media stack (yt-dlp / instaloader / ffmpeg) + git-lfs -------------------
# Used by the media-download container skill (ffmpeg also by tts). The yt-dlp
# `default` extra pulls yt-dlp-ejs, mutagen, pycryptodomex, brotli, websockets,
# requests and certifi; `curl-cffi` adds impersonation. pip goes through
# --break-system-packages since apt-packaged Python on Debian slim is PEP 668
# managed and pip would otherwise refuse.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        git-lfs \
        ffmpeg \
        python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir \
        "yt-dlp[default,curl-cffi]" instaloader

# yt-dlp needs Deno for modern YouTube signature extractors.
ARG DENO_VERSION=2.9.6
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s v${DENO_VERSION}

# ---- uv / uvx ----------------------------------------------------------------
# General Python capability for agents, and the launcher for Python MCP servers
# (the `npx -y` equivalent that Debian bookworm has no package for - neither `uv`
# nor `python3-uv` is in the repos). Copied from Astral's official image rather
# than piped from an install script: two static binaries, no network fetch at
# container start, no dependency on the PEP 668 managed system Python. The tag is
# literal because BuildKit expands no ARG in a COPY --from image reference.
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /uvx /usr/local/bin/

# ---- GitHub CLI (gh) ---------------------------------------------------------
# Install gh so agents can run `gh pr list`, `gh repo view`, etc. Auth follows
# the OneCLI "Pattern D" model (onecli.sh/docs/guides/credential-stubs/general-app):
# the sentinel env value only satisfies gh's local auth check; real credentials
# are injected at the network level by the OneCLI gateway (HTTPS_PROXY), via the
# GitHub OAuth app connection. No real token ever enters the container env.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

ENV GH_TOKEN=onecli-managed

# git-over-HTTPS through the gateway. Two gaps the injected env doesn't cover
# (verified against the @onecli-sh/sdk version pinned in package.json - re-check
# on upgrades): git reads GIT_SSL_CAINFO, not SSL_CERT_FILE, for the MITM CA; and
# the gateway only swaps credentials git actually sends, so gh acts as git's
# credential helper to supply the sentinel. The CA path is hardcoded in the
# OneCLI SDK (applyContainerConfig mounts the combined gateway+system bundle
# there), so public hosts still verify normally.
ENV GIT_SSL_CAINFO=/tmp/onecli-combined-ca.pem
RUN git config --system credential.helper '!gh auth git-credential'

# ---- pond: cross-session recall (read-only MCP over mounted stores) ----------
ARG POND_VERSION=0.21.0
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends xz-utils && \
    ARCH=$(dpkg --print-architecture) && case "$ARCH" in \
      arm64) POND_TARGET=aarch64-unknown-linux-gnu ;; \
      amd64) POND_TARGET=x86_64-unknown-linux-gnu ;; \
      *) echo "unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/tenequm/pond/releases/download/v${POND_VERSION}/pond-${POND_TARGET}.tar.xz" \
    | tar -xJ -C /usr/local/bin pond && \
    chmod +x /usr/local/bin/pond

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
# The version check fails the build if the script installed anything but the pin.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun && \
    test "$(bun --version)" = "${BUN_VERSION}"

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.34.9
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# The npm in node:22-slim (10.x) bundles libraries that lag their security
# releases; npm 11.21.2 bundles the patched ones. Drop this pin once the
# base image's npm has caught up.
ARG NPM_VERSION=11.21.2
RUN npm install -g npm@${NPM_VERSION}

# Global Node CLIs the agent invokes at runtime live in cli-tools.json so a
# skill can add one with a json-merge instead of editing this Dockerfile.
# install-cli-tools.sh installs each via pnpm (pinned), writing the per-tool
# only-built-dependencies opt-ins it reads from the manifest.
COPY cli-tools.json install-cli-tools.sh /tmp/
RUN --mount=type=cache,target=/root/.cache/pnpm \
    sh /tmp/install-cli-tools.sh /tmp/cli-tools.json

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

# Drop setuid-root from the binaries Debian ships (mount, su, passwd, ...). The
# agent runs unprivileged and needs none of them.
RUN find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true

USER node
WORKDIR /workspace/group

# Only applies to a bare `docker run` — the host spawn overrides ENTRYPOINT and
# passes --init instead (see hardeningArgs in src/container-runner.ts).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

# ---- Provenance labels -------------------------------------------------------
# LAST on purpose. An ARG invalidates every layer below it, so declaring these
# up with the other build-args would make an otherwise-cached rebuild redo
# `bun install` and the pnpm global CLIs on every existing install, for two
# pieces of metadata. Labels have no filesystem effect, so they cost nothing here.
#
# Which lockfile the baked /app/node_modules came from: /app/src is mounted from
# the host checkout at every spawn, so an image and a checkout whose lockfiles
# disagree fail as a missing module inside a `--rm` container with no logs.
# container/pull.sh checks this before retagging. build.sh passes it; a bare
# `docker build` leaves it empty, which the pull path treats as unverifiable.
#
# image-source defaults to `local` so anything built from this file is honest
# unless its builder says otherwise — the retag cannot forge it after the fact.
ARG AGENT_RUNNER_LOCK_SHA256=
LABEL dev.nanoclaw.agent-runner-lock-sha256="${AGENT_RUNNER_LOCK_SHA256}"
ARG IMAGE_SOURCE=local
LABEL dev.nanoclaw.image-source="${IMAGE_SOURCE}"
