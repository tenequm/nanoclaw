/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import '../modules/index.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

async function main(): Promise<void> {
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());
  // startMcpServer returns once stdio is attached while tools keep running for
  // the life of the process, so the mailbox stays started; each tool call
  // commits its writes inside run().
  try {
    await startMcpServer((action) => mailbox.run(action));
  } catch (err) {
    await mailbox.stop();
    throw err;
  }
}

main().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
import './canvas.js';
import './rooms.js';
