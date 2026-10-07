import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceModeCore, manageService, voiceModeService, type ServiceHost } from './voice-mode-install.js';

const coreFiles = [
  'src/channels/index.ts',
  'src/router.ts',
  'src/delivery.ts',
  'src/webhook-server.ts',
  'package.json',
];

/** A temporary root holding this checkout's core files. */
function coreCopy(): { root: string; snapshot(): string[] } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'voice-mode-footprint-'));
  for (const file of coreFiles) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), readFileSync(file));
  }
  return { root, snapshot: () => coreFiles.map((file) => readFileSync(path.join(root, file), 'utf8')) };
}

describe('voice-mode core footprint', () => {
  it('applies exactly the installed core files, twice, and removes back to core without a voice-mode trace', () => {
    const { root, snapshot } = coreCopy();
    try {
      const installed = snapshot();
      installVoiceModeCore(root, true);
      const before = snapshot();
      for (const text of before.slice(0, -1)) expect(text).not.toMatch(/voice-?mode/i);
      // An import goes below the file's doc header, never above it.
      for (const [i, text] of before.entries()) expect(installed[i].split('\n')[0]).toBe(text.split('\n')[0]);
      installVoiceModeCore(root);
      expect(snapshot()).toEqual(installed);
      installVoiceModeCore(root);
      expect(snapshot()).toEqual(installed);
      installVoiceModeCore(root, true);
      installVoiceModeCore(root, true);
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an export of the router function that core already had', () => {
    const { root, snapshot } = coreCopy();
    try {
      installVoiceModeCore(root, true);
      const router = path.join(root, 'src/router.ts');
      const exported = readFileSync(router, 'utf8').replace(
        'async function deliverToAgent(',
        'export async function deliverToAgent(',
      );
      writeFileSync(router, exported);
      const before = snapshot();
      installVoiceModeCore(root);
      installVoiceModeCore(root, true);
      expect(snapshot()).toEqual(before);
      expect(readFileSync(router, 'utf8')).toContain('export async function deliverToAgent(');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('calls the skill presentation at the real channel delivery boundary', () => {
    const tree = ts.createSourceFile(
      'src/delivery.ts',
      readFileSync('src/delivery.ts', 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const fn = tree.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'deliverMessage',
    )!;
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'deliveryAdapter.deliver') calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments[4].getText(tree)).toBe('presentVoiceModeOutbound(msg, session)');
    expect(
      tree.statements.some(
        (node) =>
          ts.isImportDeclaration(node) &&
          node.moduleSpecifier.getText(tree) === "'./channels/voice-mode-integration.js'" &&
          node.importClause?.getText(tree).includes('presentVoiceModeOutbound'),
      ),
    ).toBe(true);
  });

  it('awaits the browser root handler before the webhook routing fallback', () => {
    const source = readFileSync('src/webhook-server.ts', 'utf8');
    const tree = ts.createSourceFile('src/webhook-server.ts', source, ts.ScriptTarget.Latest, true);
    const fn = tree.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'ensureServer',
    )!;
    const gates: ts.IfStatement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && node.expression.getText(tree) === 'await handleVoiceModeRoot(req, res)')
        gates.push(node);
      ts.forEachChild(node, visit);
    };
    visit(fn);
    expect(gates).toHaveLength(1);
    expect(ts.isReturnStatement(gates[0].thenStatement)).toBe(true);
    expect(gates[0].getStart(tree)).toBeLessThan(source.indexOf('const match = url.match', fn.getStart(tree)));
    expect(
      tree.statements.some(
        (node) =>
          ts.isImportDeclaration(node) &&
          node.moduleSpecifier.getText(tree) === "'./channels/voice-mode-integration.js'" &&
          node.importClause?.getText(tree).includes('handleVoiceModeRoot'),
      ),
    ).toBe(true);
  });
});

describe('voice-mode worker service footprint', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['linux', 'darwin'])(
    'scopes %s to the install, quotes paths and keeps credentials out of the unit',
    (platform) => {
      const first = voiceModeService('/tmp/install one', platform, '/tmp/home', '/tmp/node & tools/node');
      const second = voiceModeService('/tmp/install two', platform, '/tmp/home', '/tmp/node & tools/node');
      expect(first.file).not.toBe(second.file);
      expect(first.name).toContain('voice-mode-worker');
      expect(first.content).toContain('dist/channels/voice-mode-worker.js');
      expect(first.content).not.toMatch(/EnvironmentFile|Environment=|KEY|SECRET/);
      if (platform === 'linux') expect(first.content).toContain('ExecStart="/tmp/node & tools/node"');
      else {
        expect(first.content).toContain('<string>/tmp/node &amp; tools/node</string>');
        // launchd's default PATH has no Homebrew, where ffmpeg for the typing sound usually is; nothing else is set.
        expect(first.content).toMatch(
          /<key>EnvironmentVariables<\/key><dict><key>PATH<\/key><string>\/opt\/homebrew\/bin:[^<]*<\/string><\/dict>/,
        );
      }
    },
  );

  it("follows the host's install identity, under a name setup's peer cleanup does not take for a host", () => {
    vi.stubEnv('NANOCLAW_INSTALL_ID', 'casa');
    const linux = voiceModeService('/tmp/a', 'linux', '/tmp/home', 'node');
    const darwin = voiceModeService('/tmp/a', 'darwin', '/tmp/home', 'node');
    expect(linux.name).toBe('voice-mode-worker-nanoclaw-v2-casa.service');
    expect(darwin.name).toBe('voice-mode-worker.com.nanoclaw-v2-casa');
    // setup/peer-cleanup.ts probes these as other NanoClaw hosts.
    expect(path.basename(linux.file)).not.toMatch(/^nanoclaw.*\.service$/);
    expect(path.basename(darwin.file)).not.toMatch(/^com\.nanoclaw.*\.plist$/);
  });

  describe('installing the service', () => {
    let root: string;
    let home: string;
    const fakeHost = (platform: string, printed: number[]) => {
      const calls: string[] = [];
      const host: ServiceHost = {
        platform,
        home,
        node: '/usr/bin/node',
        uid: 501,
        run(command, args) {
          calls.push(`${command} ${args[0] === '--user' ? args[1] : args[0]}`);
          return command === 'launchctl' && args[0] === 'print' ? (printed.shift() ?? 113) : 0;
        },
        sleep: () => undefined,
      };
      return { host, calls };
    };
    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), 'voice-mode-service-'));
      home = mkdtempSync(path.join(os.tmpdir(), 'voice-mode-home-'));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it('refuses before a build exists', () => {
      const { host, calls } = fakeHost('linux', []);
      expect(() => manageService(root, false, host)).toThrow('voice-mode-worker.js is missing');
      expect(calls).toEqual([]);
    });

    it('waits on macOS until launchd let the old worker go before it bootstraps the new one', () => {
      mkdirSync(path.join(root, 'dist/channels'), { recursive: true });
      writeFileSync(path.join(root, 'dist/channels/voice-mode-worker.js'), '');
      const first = fakeHost('darwin', []);
      manageService(root, false, first.host);
      expect(first.calls).toEqual(['launchctl bootstrap']);
      // Reapply: the old one is loaded, and launchd still reports it once after bootout.
      const again = fakeHost('darwin', [0, 0, 113]);
      manageService(root, false, again.host);
      expect(again.calls).toEqual([
        'launchctl print',
        'launchctl bootout',
        'launchctl print',
        'launchctl print',
        'launchctl bootstrap',
      ]);
      const gone = fakeHost('darwin', [113]);
      manageService(root, true, gone.host);
      expect(gone.calls).toEqual(['launchctl print']);
      expect(existsSync(voiceModeService(root, 'darwin', home, 'node').file)).toBe(false);
    });
  });
});

it('preserves other guidance and implicit lists when adding and retiring the voice skill', async () => {
  const { createAgentGroup } = await import('../src/db/agent-groups.js');
  const { initTestDb, closeDb, runMigrations } = await import('../src/db/index.js');
  const { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } =
    await import('../src/db/container-configs.js');
  const { updateVoiceModeGuidance } = await import('./voice-mode-install.js');
  await runMigrations(await initTestDb());
  try {
    for (const id of ['explicit', 'implicit']) {
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
      await ensureContainerConfig(id);
    }
    await updateContainerConfigJson('explicit', 'skills', ['other']);
    await updateVoiceModeGuidance('explicit');
    await updateVoiceModeGuidance('explicit');
    expect(JSON.parse((await getContainerConfig('explicit'))!.skills)).toEqual(['other', 'voice-mode-formatting']);
    const implicit = (await getContainerConfig('implicit'))!.skills;
    await updateVoiceModeGuidance();
    await updateVoiceModeGuidance();
    expect(JSON.parse((await getContainerConfig('explicit'))!.skills)).toEqual(['other']);
    expect((await getContainerConfig('implicit'))!.skills).toBe(implicit);
  } finally {
    await closeDb();
  }
});
