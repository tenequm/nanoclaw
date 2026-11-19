// The host contract test runs under Node. Feed its routed mailbox row to the
// Bun runner and capture exactly what the provider receives.
import '../mailbox/compose.js';
import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { runPollLoop } from '../poll-loop.js';
import { claudeRuntimeContract } from '../provider-contracts/claude.js';
import { MockProvider } from '../providers/mock.js';

const row = await Bun.stdin.json();
const { inbound } = initTestSessionDb();
inbound
  .prepare(
    'INSERT INTO messages_in (id, kind, timestamp, channel_type, platform_id, content) VALUES (?, ?, ?, ?, ?, ?)',
  )
  .run(row.id, row.kind, row.timestamp, row.channel_type, row.platform_id, row.content);
const controller = new AbortController();
let prompt: string | undefined;
try {
  await runPollLoop({
    cwd: process.cwd(),
    provider: new MockProvider({}, (input) => {
      prompt = input;
      controller.abort();
      return '';
    }),
    providerName: 'claude',
    providerContract: claudeRuntimeContract,
    signal: controller.signal,
  });
  if (prompt === undefined) throw new Error('Provider did not receive the app command');
  process.stdout.write(prompt);
} finally {
  closeSessionDb();
}
