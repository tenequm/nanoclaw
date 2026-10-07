import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';

interface CoreEdit {
  file: string;
  before: string;
  after: string;
  /** Not voice-mode's own text: core may carry it itself, so remove reverses it only where apply made it. */
  shared?: true;
}
const edits: CoreEdit[] = [
  {
    file: 'src/router.ts',
    before: 'async function deliverToAgent(',
    after: 'export async function deliverToAgent(',
    shared: true,
  },
  {
    file: 'src/router.ts',
    before: '  if (wake && created) {',
    after: '  voiceModeStored({ ...event, threadId: effectiveThreadId }, session, wake);\n\n  if (wake && created) {',
  },
  {
    file: 'src/delivery.ts',
    before: '    msg.content,\n    files,',
    after: '    presentVoiceModeOutbound(msg, session),\n    files,',
  },
  {
    file: 'src/webhook-server.ts',
    before: "      const url = req.url || '/';",
    after: "      if (await handleVoiceModeRoot(req, res)) return;\n      const url = req.url || '/';",
  },
];
const imports = [
  ['src/channels/index.ts', "import './voice-mode.js';"],
  ['src/router.ts', "import { voiceModeStored } from './channels/voice-mode-integration.js';"],
  ['src/delivery.ts', "import { presentVoiceModeOutbound } from './channels/voice-mode-integration.js';"],
  ['src/webhook-server.ts', "import { handleVoiceModeRoot } from './channels/voice-mode-integration.js';"],
];
/** Which shared edits apply made, so remove leaves the ones core already had. Gitignored runtime state. */
const RECORD = 'data/voice-mode-core-edits.json';

/** `line` after the file's last import declaration: below its doc header, with its other imports. */
function addImport(text: string, line: string, file: string): string {
  let end = -1;
  for (const m of text.matchAll(/^import\b[^;]*;[^\n]*\n/gm)) end = m.index + m[0].length;
  if (end < 0) throw new Error(`voice-mode: no import declarations in ${file}`);
  return `${text.slice(0, end)}${line}\n${text.slice(end)}`;
}

export function installVoiceModeCore(root: string, remove = false): void {
  const recordFile = path.join(root, RECORD);
  const recorded = new Set<string>(existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : []);
  const files = new Map<string, string>();
  for (const file of [...edits.map((e) => e.file), ...imports.map(([file]) => file)])
    files.set(file, readFileSync(path.join(root, file), 'utf8'));
  for (const { file, before, after, shared } of edits) {
    const key = `${file}: ${after}`;
    let text = files.get(file)!;
    if (remove) {
      if (shared && !recorded.has(key)) continue;
      if (text.includes(after)) text = text.replace(after, before);
      else if (!text.includes(before)) throw new Error(`voice-mode: integration anchor changed in ${file}`);
      recorded.delete(key);
    } else if (!text.includes(after)) {
      if (!text.includes(before)) throw new Error(`voice-mode: integration anchor changed in ${file}`);
      text = text.replace(before, after);
      if (shared) recorded.add(key);
    }
    files.set(file, text);
  }
  for (const [file, line] of imports) {
    const text = files.get(file)!;
    files.set(file, remove ? text.replace(`${line}\n`, '') : text.includes(line) ? text : addImport(text, line, file));
  }
  for (const [file, text] of files) writeFileSync(path.join(root, file), text);
  if (recorded.size > 0) {
    mkdirSync(path.dirname(recordFile), { recursive: true });
    writeFileSync(recordFile, `${JSON.stringify([...recorded])}\n`);
  } else rmSync(recordFile, { force: true });
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  if (remove) delete pkg.scripts['voice-mode-worker'];
  else pkg.scripts['voice-mode-worker'] = 'node dist/channels/voice-mode-worker.js start';
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * The worker's user service, named after the host's own (src/install-slug.ts, which honours
 * NANOCLAW_INSTALL_ID) with its own prefix: setup's peer cleanup takes every `nanoclaw*` unit and
 * `com.nanoclaw*` plist for another NanoClaw host, and the worker is none.
 */
export function voiceModeService(
  root: string,
  platform: string,
  home: string,
  node: string,
): { name: string; file: string; content: string } {
  const worker = path.join(root, 'dist/channels/voice-mode-worker.js');
  const escapeXml = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  if (platform === 'darwin') {
    const name = `voice-mode-worker.${getLaunchdLabel(root)}`;
    const entries = [node, worker, 'start'].map((s) => `<string>${escapeXml(s)}</string>`).join('');
    // launchd's default PATH lacks Homebrew, where the worker's ffmpeg usually is.
    const PATH = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${path.join(home, '.local/bin')}`;
    const log = escapeXml(path.join(root, 'logs/voice-mode-worker.log'));
    return {
      name,
      file: path.join(home, 'Library/LaunchAgents', `${name}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${entries}</array><key>WorkingDirectory</key><string>${escapeXml(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(PATH)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string></dict></plist>\n`,
    };
  }
  if (platform !== 'linux') throw new Error('voice-mode: services support Linux and macOS');
  const unit = getSystemdUnit(root);
  const name = `voice-mode-worker-${unit}.service`;
  const quote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
  return {
    name,
    file: path.join(home, '.config/systemd/user', name),
    content: `[Unit]\nDescription=NanoClaw voice-mode worker (${unit})\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(root)}\nExecStart=${quote(node)} ${quote(worker)} start\nRestart=always\nRestartSec=5\nTimeoutStopSec=75\n\n[Install]\nWantedBy=default.target\n`,
  };
}

/** What managing the service touches outside the checkout: the real system by default, faked in tests. */
export interface ServiceHost {
  platform: string;
  home: string;
  node: string;
  uid: number;
  /** Runs a command and returns its exit status; `quiet` for a probe whose output nobody needs. */
  run(command: string, args: string[], quiet?: boolean): number;
  sleep(ms: number): void;
}
const systemHost: ServiceHost = {
  platform: process.platform,
  home: os.homedir(),
  node: process.execPath,
  uid: process.getuid?.() ?? 0,
  run(command, args, quiet) {
    const result = spawnSync(command, args, { stdio: quiet ? 'ignore' : 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  },
  sleep: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};
/** `launchctl print`'s status for a label launchd does not have. */
const NOT_LOADED = 113;
const UNLOAD_WAIT_MS = 5_000;

export function manageService(root: string, remove: boolean, host: ServiceHost = systemHost): void {
  const spec = voiceModeService(root, host.platform, host.home, host.node);
  const domain = `gui/${host.uid}`;
  const must = (command: string, args: string[]): void => {
    if (host.run(command, args) !== 0) throw new Error(`voice-mode: ${command} ${args[0]} failed`);
  };
  const loaded = (): boolean => {
    const status = host.run('launchctl', ['print', `${domain}/${spec.name}`], true);
    if (status !== 0 && status !== NOT_LOADED) throw new Error('voice-mode: cannot inspect the worker service');
    return status === 0;
  };
  if (!remove) {
    const worker = path.join(root, 'dist/channels/voice-mode-worker.js');
    if (!existsSync(worker)) throw new Error(`voice-mode: ${worker} is missing; run pnpm run build first`);
  }
  if (existsSync(spec.file)) {
    if (host.platform === 'darwin') {
      if (loaded()) {
        must('launchctl', ['bootout', domain, spec.file]);
        // bootout returns before launchd lets the label go, and a bootstrap until then fails.
        for (let waited = 0; loaded(); waited += 100) {
          if (waited >= UNLOAD_WAIT_MS) throw new Error('voice-mode: the old worker service did not unload');
          host.sleep(100);
        }
      }
    } else must('systemctl', ['--user', 'disable', '--now', spec.name]);
    rmSync(spec.file);
    if (host.platform === 'linux') must('systemctl', ['--user', 'daemon-reload']);
  }
  if (remove) return;
  mkdirSync(path.dirname(spec.file), { recursive: true });
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  writeFileSync(spec.file, spec.content, { mode: 0o600 });
  if (host.platform === 'linux') {
    must('systemctl', ['--user', 'daemon-reload']);
    must('systemctl', ['--user', 'enable', '--now', spec.name]);
  } else if (host.run('launchctl', ['bootstrap', domain, spec.file]) !== 0) {
    // Loaded meanwhile (a login item, say): restart it on the new plist instead.
    if (!loaded()) throw new Error('voice-mode: launchctl bootstrap failed');
    must('launchctl', ['kickstart', '-k', `${domain}/${spec.name}`]);
  }
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
