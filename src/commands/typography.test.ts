/**
 * Banned-typography enforcement for the chat-command surface.
 *
 * The house style (memory: feedback_no_emdashes_in_artifacts) bans a small set
 * of "smart" typography from codified artifacts. This test scans the modules we
 * author for those characters and fails with a file:line:char report. It is
 * DELIBERATELY scoped to our own new code and docs, not the whole repo, because
 * upstream files legitimately contain em-dashes in comments and must stay
 * byte-identical.
 *
 * Emoji and all other non-ASCII are allowed; only the explicit blacklist below
 * is rejected. The banned code points are referenced via numeric escapes so
 * this test file itself contains no literal banned character.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

// Individual banned code points.
const BANNED_POINTS = new Set<number>([
  0x2014, // em dash
  0x2013, // en dash
  0x2018, // left single quote
  0x2019, // right single quote
  0x201c, // left double quote
  0x201d, // right double quote
  0x2026, // horizontal ellipsis
  0x2192, // rightwards arrow
  0x21d2, // rightwards double arrow
  0x2022, // bullet
  0x00b7, // middle dot
  0x00a0, // non-breaking space
]);

/** Banned code-point ranges: Arrows block and box-drawing dashes. */
function inBannedRange(cp: number): boolean {
  if (cp >= 0x2190 && cp <= 0x21ff) return true; // Arrows block
  if (cp >= 0x2500 && cp <= 0x257f) return true; // Box Drawing
  return false;
}

function isBanned(cp: number): boolean {
  return BANNED_POINTS.has(cp) || inBannedRange(cp);
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Recursively collect *.ts files under a directory. Empty when missing. */
function collectTs(dir: string): string[] {
  const abs = path.resolve(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTs(path.relative(REPO_ROOT, full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function collectFile(rel: string): string[] {
  const abs = path.resolve(REPO_ROOT, rel);
  return fs.existsSync(abs) ? [abs] : [];
}

function targetFiles(): string[] {
  return [
    ...collectTs('src/commands'),
    // Phase 3 adds this dir; skip silently until it exists.
    ...collectTs('src/channels/telegram-grammy/commands'),
    ...collectFile('src/command-gate.ts'),
    ...collectFile('docs/chat-commands.md'),
  ];
}

interface Violation {
  file: string;
  line: number;
  col: number;
  codePoint: number;
}

function scan(file: string): Violation[] {
  const text = fs.readFileSync(file, 'utf8');
  const violations: Violation[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let col = 0;
    for (const ch of line) {
      col++;
      const cp = ch.codePointAt(0);
      if (cp !== undefined && isBanned(cp)) {
        violations.push({ file: path.relative(REPO_ROOT, file), line: i + 1, col, codePoint: cp });
      }
    }
  }
  return violations;
}

describe('chat-command typography blacklist', () => {
  it('finds at least one file to scan', () => {
    // Guards against a broken path config silently passing the whole suite.
    expect(targetFiles().length).toBeGreaterThan(0);
  });

  it('contains no banned typography characters', () => {
    const all: Violation[] = [];
    for (const file of targetFiles()) {
      all.push(...scan(file));
    }
    const report = all
      .map((v) => `${v.file}:${v.line}:${v.col} U+${v.codePoint.toString(16).toUpperCase().padStart(4, '0')}`)
      .join('\n');
    expect(report, `Banned typography found:\n${report}`).toBe('');
  });
});
