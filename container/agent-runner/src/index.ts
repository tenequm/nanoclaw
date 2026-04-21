/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config:
 *   - SESSION_INBOUND_DB_PATH:  path to host-owned inbound DB (default: /workspace/inbound.db)
 *   - SESSION_OUTBOUND_DB_PATH: path to container-owned outbound DB (default: /workspace/outbound.db)
 *   - SESSION_HEARTBEAT_PATH:   heartbeat file path (default: /workspace/.heartbeat)
 *   - AGENT_PROVIDER: any registered provider name (default: claude). The
 *     set of registered providers is whatever `providers/index.ts` imports.
 *   - NANOCLAW_ASSISTANT_NAME: assistant name for transcript archiving
 *   - NANOCLAW_ADMIN_USER_IDS: comma-separated user IDs allowed to run admin commands
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, skills, working files)
 *     .claude/          ← Claude SDK session data
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const providerName = (process.env.AGENT_PROVIDER || 'claude').toLowerCase() as ProviderName;
  const assistantName = process.env.NANOCLAW_ASSISTANT_NAME;
  const adminUserIds = new Set(
    (process.env.NANOCLAW_ADMIN_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Destinations addendum is the only runtime-generated context we inject.
  // Global CLAUDE.md is loaded by Claude Code from /workspace/agent/CLAUDE.md
  // (which imports /workspace/global/CLAUDE.md via @-syntax) — no need to
  // read it manually anymore.
  const instructions = buildSystemPromptAddendum();

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any additional from host
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {
        SESSION_INBOUND_DB_PATH: process.env.SESSION_INBOUND_DB_PATH || '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: process.env.SESSION_OUTBOUND_DB_PATH || '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: process.env.SESSION_HEARTBEAT_PATH || '/workspace/.heartbeat',
      },
    },
  };

  // Merge additional MCP servers from host configuration
  if (process.env.NANOCLAW_MCP_SERVERS) {
    try {
      const additional = JSON.parse(process.env.NANOCLAW_MCP_SERVERS) as Record<string, Record<string, unknown>>;
      for (const [name, config] of Object.entries(additional)) {
        mcpServers[name] = config as typeof mcpServers[string];
        const transport = typeof config.type === 'string' ? config.type : (typeof config.command === 'string' ? `stdio:${config.command}` : 'unknown');
        log(`Additional MCP server: ${name} (${transport})`);
      }
    } catch (e) {
      log(`Failed to parse NANOCLAW_MCP_SERVERS: ${e}`);
    }
  }

  const provider = createProvider(providerName, {
    assistantName,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    cwd: CWD,
    systemContext: { instructions },
    adminUserIds,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
