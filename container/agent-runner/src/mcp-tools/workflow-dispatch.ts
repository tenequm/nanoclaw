/**
 * dispatch_workflow MCP tool — ask an owner to run the host's configured
 * GitHub workflow. Fire-and-forget: the host validates env/version against
 * its own allowlist, cards an owner, dispatches on approve with a token the
 * container never sees, and reports the run URL (or the rejection) back as a
 * system message.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const dispatchWorkflow: McpToolDefinition = {
  tool: {
    name: 'dispatch_workflow',
    description:
      "Request a run of this host's configured GitHub Actions deploy workflow (e.g. deploy a version to an environment). Requires owner approval; fire-and-forget. The result (run URL, rejection or failure) arrives later as a system message. The host decides which repo, workflow and environments are allowed.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        env: { type: 'string', description: 'Target environment, one of the host allowlist (e.g. gamilton-prod)' },
        version: { type: 'string', description: 'Version to deploy, e.g. 26-10-26.1595' },
        reason: { type: 'string', description: 'Why this dispatch is needed; shown to the approving owner' },
      },
      required: ['env', 'version', 'reason'],
    },
  },
  async handler(args) {
    const { env, version, reason } = args;
    if (typeof env !== 'string' || !env.trim()) return err('env is required');
    if (typeof version !== 'string' || !version.trim()) return err('version is required');
    if (typeof reason !== 'string' || !reason.trim()) return err('reason is required');

    await writeMessageOut({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'dispatch_workflow', env: env.trim(), version: version.trim(), reason }),
    });
    return ok('Dispatch request submitted. You will be notified when an owner approves or rejects it.');
  },
};

registerTools([dispatchWorkflow]);
