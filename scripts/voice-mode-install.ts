import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const changes = [
  ['src/router.ts', 'async function deliverToAgent(', 'export async function deliverToAgent('],
  [
    'src/router.ts',
    '  if (wake && created) {',
    '  voiceModeStored({ ...event, threadId: effectiveThreadId }, session);\n\n  if (wake && created) {',
  ],
  ['src/delivery.ts', '    msg.content,\n    files,', '    presentVoiceModeOutbound(msg, session),\n    files,'],
  [
    'src/webhook-server.ts',
    "      const url = req.url || '/';",
    "      if (await handleVoiceModeRoot(req, res)) return;\n      const url = req.url || '/';",
  ],
];
const imports = [
  ['src/channels/index.ts', "import './voice-mode.js';"],
  ['src/router.ts', "import { voiceModeStored } from './channels/voice-mode-integration.js';"],
  ['src/delivery.ts', "import { presentVoiceModeOutbound } from './channels/voice-mode-integration.js';"],
  ['src/webhook-server.ts', "import { handleVoiceModeRoot } from './channels/voice-mode-integration.js';"],
];

export function installVoiceModeCore(root: string, remove = false): void {
  const files = new Map<string, string>();
  for (const [file] of [...changes, ...imports]) files.set(file, readFileSync(path.join(root, file), 'utf8'));
  for (const [file, before, after] of changes) {
    let text = files.get(file)!;
    const source = remove ? after : before;
    const target = remove ? before : after;
    if (text.includes(target) && !remove) continue;
    if (text.includes(source)) text = text.replace(source, target);
    else if (!text.includes(target)) throw new Error(`voice-mode: integration anchor changed in ${file}`);
    files.set(file, text);
  }
  for (const [file, line] of imports) {
    const text = files.get(file)!;
    files.set(file, remove ? text.replace(`${line}\n`, '') : text.includes(line) ? text : `${line}\n${text}`);
  }
  for (const [file, text] of files) writeFileSync(path.join(root, file), text);
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (remove) delete pkg.scripts['voice-mode-worker'];
  else pkg.scripts['voice-mode-worker'] = 'node dist/channels/voice-mode-worker.js start';
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function voiceModeService(
  root: string,
  platform: string,
  home: string,
  node: string,
): { name: string; file: string; content: string } {
  const slug = createHash('sha1').update(root).digest('hex').slice(0, 8);
  const worker = path.join(root, 'dist/channels/voice-mode-worker.js');
  const escapeXml = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  if (platform === 'darwin') {
    const name = `com.nanoclaw-v2-${slug}-voice-mode-worker`;
    const entries = [node, worker, 'start'].map((s) => `<string>${escapeXml(s)}</string>`).join('');
    return {
      name,
      file: path.join(home, 'Library/LaunchAgents', `${name}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${entries}</array><key>WorkingDirectory</key><string>${escapeXml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${escapeXml(path.join(root, 'logs/voice-mode-worker.log'))}</string><key>StandardErrorPath</key><string>${escapeXml(path.join(root, 'logs/voice-mode-worker.log'))}</string></dict></plist>\n`,
    };
  }
  if (platform !== 'linux') throw new Error('voice-mode: services support Linux and macOS');
  const name = `nanoclaw-v2-${slug}-voice-mode-worker.service`;
  const quote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
  return {
    name,
    file: path.join(home, '.config/systemd/user', name),
    content: `[Unit]\nDescription=NanoClaw voice-mode worker (${slug})\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(root)}\nExecStart=${quote(node)} ${quote(worker)} start\nRestart=always\nRestartSec=5\nTimeoutStopSec=75\n\n[Install]\nWantedBy=default.target\n`,
  };
}

export async function updateVoiceModeGuidance(addToGroup?: string): Promise<void> {
  const { getAllContainerConfigs, updateContainerConfigJson } = await import('../src/db/container-configs.js');
  const configs = await getAllContainerConfigs();
  if (addToGroup && !configs.some((row) => row.agent_group_id === addToGroup))
    throw new Error('voice-mode: unknown group');
  for (const row of configs) {
    if (addToGroup && row.agent_group_id !== addToGroup) continue;
    const skills: unknown = JSON.parse(row.skills);
    if (!Array.isArray(skills)) continue;
    const next = addToGroup
      ? [...new Set([...skills, 'voice-mode-formatting'])]
      : skills.filter((name) => name !== 'voice-mode-formatting');
    if (JSON.stringify(skills) !== JSON.stringify(next))
      await updateContainerConfigJson(row.agent_group_id, 'skills', next);
  }
}

async function manageData(addToGroup?: string): Promise<void> {
  const { initDb, closeDb, getDb, hasTable } = await import('../src/db/connection.js');
  await initDb(undefined, { role: 'tool' });
  try {
    if (!addToGroup && (await hasTable(getDb(), 'voice_mode_lines'))) {
      const { retireVoiceModeLines } = await import('../src/db/voice-mode-lines.js');
      await retireVoiceModeLines();
    }
    await updateVoiceModeGuidance(addToGroup);
  } finally {
    await closeDb();
  }
}

function manageService(root: string, remove: boolean): void {
  const spec = voiceModeService(root, process.platform, os.homedir(), process.execPath);
  if (!remove && existsSync(spec.file)) manageService(root, true);
  if (remove) {
    if (!existsSync(spec.file)) return;
    if (process.platform === 'darwin') {
      const loaded = spawnSync('launchctl', ['print', `gui/${process.getuid!()}/${spec.name}`], { stdio: 'ignore' });
      if (loaded.error) throw loaded.error;
      if (loaded.status === 0) execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}`, spec.file]);
      else if (loaded.status !== 113) throw new Error('voice-mode: cannot inspect the worker service');
    } else execFileSync('systemctl', ['--user', 'disable', '--now', spec.name]);
    rmSync(spec.file);
  } else {
    mkdirSync(path.dirname(spec.file), { recursive: true });
    mkdirSync(path.join(root, 'logs'), { recursive: true });
    writeFileSync(spec.file, spec.content, { mode: 0o600 });
  }
  if (process.platform === 'linux') {
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    if (!remove) execFileSync('systemctl', ['--user', 'enable', '--now', spec.name]);
  } else if (!remove) {
    try {
      execFileSync('launchctl', ['bootstrap', `gui/${process.getuid!()}`, spec.file]);
    } catch {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid!()}/${spec.name}`]);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === '--help')
    console.log(
      'Usage: tsx scripts/voice-mode-install.ts apply|remove|service-install|service-remove|retire|guidance-add <group-id>',
    );
  else if (command === 'apply' || command === 'remove') installVoiceModeCore(process.cwd(), command === 'remove');
  else if (command === 'service-install' || command === 'service-remove')
    manageService(process.cwd(), command === 'service-remove');
  else if (command === 'retire') await manageData();
  else if (command === 'guidance-add' && process.argv[3]) await manageData(process.argv[3]);
  else throw new Error('voice-mode: use --help for commands');
}
