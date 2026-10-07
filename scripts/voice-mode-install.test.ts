import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { installVoiceModeCore, voiceModeService } from './voice-mode-install.js';

const coreFiles = [
  'src/channels/index.ts',
  'src/router.ts',
  'src/delivery.ts',
  'src/webhook-server.ts',
  'package.json',
];

describe('voice-mode core footprint', () => {
  it('applies twice, removes twice and preserves the rest of core', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'voice-mode-footprint-'));
    try {
      for (const file of coreFiles) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), readFileSync(file));
      }
      installVoiceModeCore(root, true);
      const snapshot = () => coreFiles.map((file) => readFileSync(path.join(root, file), 'utf8'));
      const before = snapshot();
      installVoiceModeCore(root);
      const applied = snapshot();
      installVoiceModeCore(root);
      expect(snapshot()).toEqual(applied);
      installVoiceModeCore(root, true);
      installVoiceModeCore(root, true);
      expect(snapshot()).toEqual(before);
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
  it.each(['linux', 'darwin'])(
    'scopes %s to the install, quotes paths and keeps credentials out of the unit',
    (platform) => {
      const first = voiceModeService('/tmp/install one', platform, '/tmp/home', '/tmp/node & tools/node');
      const second = voiceModeService('/tmp/install two', platform, '/tmp/home', '/tmp/node & tools/node');
      expect(first.file).not.toBe(second.file);
      expect(first.name).toContain('voice-mode-worker');
      expect(first.content).toContain('dist/channels/voice-mode-worker.js');
      expect(first.content).not.toMatch(/Environment(File|Variables)?/);
      if (platform === 'linux') expect(first.content).toContain('ExecStart="/tmp/node & tools/node"');
      else expect(first.content).toContain('<string>/tmp/node &amp; tools/node</string>');
    },
  );
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
