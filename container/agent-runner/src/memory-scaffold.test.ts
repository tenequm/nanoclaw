import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureMemoryScaffold } from './memory-scaffold.js';

describe('ensureMemoryScaffold', () => {
  it('deterministically creates the memory tree', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    try {
      ensureMemoryScaffold(base);

      expect(fs.existsSync(path.join(base, 'memory', 'index.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'system', 'definition.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'memories'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'data'))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('is idempotent and never clobbers the agent edits', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    try {
      ensureMemoryScaffold(base);
      const indexFile = path.join(base, 'memory', 'index.md');
      fs.writeFileSync(indexFile, '# my own index\n');

      ensureMemoryScaffold(base);

      expect(fs.readFileSync(indexFile, 'utf-8')).toBe('# my own index\n');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
