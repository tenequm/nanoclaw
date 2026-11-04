/**
 * Guard for the add-pond Dockerfile integration (.claude/skills/add-pond).
 *
 * The pond CLI binary is a Dockerfile-installed dependency: not importable,
 * so neither a behavior test nor the build leg can see it. This structural
 * test asserts the pinned ARG and the install line, per the dependency
 * guidance in docs/skill-guidelines.md.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const dockerfile = fs.readFileSync(path.resolve(__dirname, '..', 'container', 'Dockerfile'), 'utf8');

describe('Dockerfile pond layer', () => {
  it('pins POND_VERSION exactly (never latest)', () => {
    const m = dockerfile.match(/^ARG POND_VERSION=(.+)$/m);
    expect(m).not.toBeNull();
    expect(m?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('installs the pinned pond release binary to /usr/local/bin', () => {
    expect(dockerfile).toContain(
      'github.com/tenequm/pond/releases/download/v${POND_VERSION}/pond-${POND_TARGET}.tar.xz',
    );
    expect(dockerfile).toMatch(/tar -xJ -C \/usr\/local\/bin pond/);
  });
});
