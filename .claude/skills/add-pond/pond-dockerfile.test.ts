/**
 * Structural guard for the add-pond Dockerfile reach-in (the dependency
 * install; .claude/skills/add-pond).
 *
 * pond ships as a GitHub-release binary, not an npm package, so it can't be
 * imported or typechecked. Drop the install layer on an upgrade and the MCP
 * server dies with "pond: command not found" at the first recall — nothing
 * else goes red. This test asserts the pinned POND_VERSION ARG and the
 * release download line are present.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

function dockerfile(): string {
  const p = path.resolve(__dirname, '..', 'container', 'Dockerfile');
  return fs.readFileSync(p, 'utf8');
}

describe('container/Dockerfile installs the pond binary', () => {
  const text = dockerfile();

  it('declares POND_VERSION pinned to an exact version', () => {
    const match = text.match(/ARG\s+POND_VERSION=(\S+)/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('downloads the pond release binary', () => {
    expect(text).toContain('tenequm/pond/releases/download');
  });
});
