// Extract `nc:` skill directives embedded in a SKILL.md.
//
// A fenced code block whose info-string starts with `nc:` is a load-bearing
// directive; every other fence (and all prose) is the human floor the parser
// ignores. That is the whole "two readers, one document" property: an agent
// applies the prose, a tool applies the directives, and anything the tool
// can't handle degrades to the prose beside it. This is the seed for both the
// conformance linter and the deterministic applier.
//
// Grammar, derived from add-slack:
//
//   ```nc:<directive> <arg>... [key:value]...
//   <body line>
//   ```
//
// `prompt` only *acquires* a value and binds it to a name; a separate directive
// *applies* it, referenced as `{{name}}`. That keeps "ask the human" decoupled
// from "what you do with the answer" (env, ncl, the OneCLI vault, a file).
//
//   copy [from-branch:<b>]  body: `PATH` (src==dst) or `SRC -> DST`   overwrite
//   append to:<file> [at:<marker>]  body: line(s) to add             skip if present
//   dep [manager:pnpm]      body: `pkg@<exact-semver>` line(s)        reinstall no-op
//   run [effect:build|test|fetch|external|wire|restart] [capture:<var>]  re-runnable
//        body: shell command(s). {{vars}} are substituted in. effect:wire runs
//        `ncl …` to wire collected input (no undo — the rows it creates are user
//        runtime data, not reversed on skill remove). effect:restart restarts the
//        service so following `ncl` runs reach it; a caller that owns the restart
//        (rebuild, or a setup that restarts once) skips it via ApplyOptions.
//        skipEffects. capture:<var> binds the command's stdout into {{var}} (twin
//        of prompt) — e.g. resolve an id from an API and feed it to a later step.
//   prompt <var> [secret] [validate:<re>]  body: the question → binds {{var}}  skip if satisfied
//        validate:<re> is a regex the interactive prompter enforces (e.g.
//        validate:^xoxb- to require a Slack bot token); `inputs` bypass it.
//   operator                body: instructions for the human operator  output-only
//        The SKILL.md is addressed to the coding agent; `operator` delineates the
//        parts meant for the HUMAN (e.g. clicking through the Slack UI). Lead it
//        with agent-facing prose like "Tell the user:" so the agent relays it;
//        the engine renders the body to the operator ({{vars}} substituted in).
//   env-set                 body: `KEY=value` ({{var}} allowed)       set-if-absent
//   env-sync                (no body) `.env` → data/env/env           idempotent copy
//   json-merge into:<file> key:<field>  body: a JSON object          push-if-absent
//
// `append` without `at:` adds to EOF; with `at:<marker>` it inserts before the
// `// <<< <marker>` closing line of a dormant marker region (see setup/index.ts).
// `json-merge` reads an array-of-objects JSON file and pushes the body object
// unless an element already has body[key]===element[key] (idempotent by key).
//
// Usage: pnpm exec tsx scripts/skill-directives.ts <SKILL.md>

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Directive {
  kind: string;
  args: string[]; // positional bare tokens, e.g. prompt's variable name
  attrs: Record<string, string | true>; // key:value tokens
  body: string[];
  line: number; // 1-based line of the opening fence
}

export interface Problem {
  line: number;
  kind: string;
  message: string;
}

const FENCE = /^```(\S.*)?$/;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const VAR_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const KNOWN = new Set(['copy', 'append', 'dep', 'run', 'prompt', 'operator', 'env-set', 'env-sync', 'json-merge']);
const PROMPT_FLAGS = new Set(['secret']);

export function parseDirectives(markdown: string): Directive[] {
  const lines = markdown.split('\n');
  const out: Directive[] = [];
  let i = 0;
  while (i < lines.length) {
    const info = lines[i].match(FENCE)?.[1]?.trim();
    if (info === undefined) {
      i++;
      continue;
    }
    // A fence opens here; consume to its closing fence either way.
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && !FENCE.test(lines[j])) {
      body.push(lines[j]);
      j++;
    }
    if (info.startsWith('nc:')) {
      const [tag, ...rest] = info.split(/\s+/);
      const args: string[] = [];
      const attrs: Record<string, string | true> = {};
      for (const tok of rest) {
        const eq = tok.indexOf(':');
        if (eq > 0) attrs[tok.slice(0, eq)] = tok.slice(eq + 1);
        else args.push(tok);
      }
      out.push({
        kind: tag.slice('nc:'.length),
        args,
        attrs,
        body: body.map((l) => l.trim()).filter(Boolean),
        line: i + 1,
      });
    }
    i = j + 1; // skip past the closing fence (directive or plain code block)
  }
  return out;
}

/** The variable a `prompt` binds (the first positional that isn't a flag). */
export function promptVar(d: Directive): string | undefined {
  return d.args.find((a) => !PROMPT_FLAGS.has(a));
}

/** `{{var}}` names referenced anywhere in a directive's body. */
function referencedVars(d: Directive): string[] {
  const found: string[] = [];
  for (const line of d.body) for (const m of line.matchAll(VAR_REF)) found.push(m[1]);
  return found;
}

/**
 * The resolved `chat` core version from our lockfile — the single source of
 * truth a `@chat-adapter/*` adapter pin must match (the adapter and the core
 * move in lockstep). Reads the root importer's direct `chat` dependency, whose
 * `specifier`/`version` pair is unique to importer deps (transitive entries in
 * the packages section have no `specifier`). Returns undefined if not found.
 */
export function resolveChatCoreVersion(root: string): string | undefined {
  let lock = '';
  try {
    lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const m = lock.match(/\n\s+chat:\n\s+specifier:[^\n]*\n\s+version:\s*([0-9][^\s(]*)/);
  return m?.[1];
}

export function validate(directives: Directive[], ctx?: { chatVersion?: string }): Problem[] {
  const problems: Problem[] = [];
  const defined = new Set<string>();
  const flag = (d: Directive, message: string) => problems.push({ line: d.line, kind: d.kind, message });
  for (const d of directives) {
    if (!KNOWN.has(d.kind)) flag(d, `unknown directive nc:${d.kind}`);
    switch (d.kind) {
      case 'dep':
        for (const spec of d.body) {
          const at = spec.lastIndexOf('@');
          const name = at > 0 ? spec.slice(0, at) : spec;
          const version = at > 0 ? spec.slice(at + 1) : '';
          if (!EXACT_SEMVER.test(version)) flag(d, `dep "${spec}" must pin an exact semver (no ranges/latest)`);
          // A @chat-adapter/* adapter must match the chat core version in our
          // lockfile — the family moves together. This catches pin drift (the
          // 4.27.0-vs-chat@4.26.0 mismatch) at lint time.
          if (ctx?.chatVersion && name.startsWith('@chat-adapter/') && version !== ctx.chatVersion) {
            flag(d, `${name} pinned ${version} but our chat core is ${ctx.chatVersion} — a @chat-adapter/* adapter must match the chat package`);
          }
        }
        break;
      case 'append':
        if (!d.attrs.to) flag(d, 'append requires to:<file>');
        if (d.body.length === 0) flag(d, 'append requires a line to add');
        break;
      case 'copy':
        if (d.body.length === 0) flag(d, 'copy requires at least one path');
        break;
      case 'json-merge': {
        if (!d.attrs.into) flag(d, 'json-merge requires into:<json-file>');
        if (!d.attrs.key) flag(d, 'json-merge requires key:<field>');
        if (d.body.length === 0) {
          flag(d, 'json-merge requires a JSON object in its body');
        } else {
          let obj: unknown;
          try {
            obj = JSON.parse(d.body.join('\n'));
          } catch {
            flag(d, 'json-merge body must be a single parseable JSON object');
            break;
          }
          if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            flag(d, 'json-merge body must be a single JSON object (not an array or scalar)');
          } else if (typeof d.attrs.key === 'string' && !(d.attrs.key in obj)) {
            flag(d, `json-merge body has no "${d.attrs.key}" field to match on`);
          }
        }
        break;
      }
      case 'prompt':
        if (!promptVar(d)) flag(d, 'prompt requires a variable name, e.g. `nc:prompt token`');
        if (d.body.length === 0) flag(d, 'prompt requires a question in its body');
        if (typeof d.attrs.validate === 'string') {
          try {
            new RegExp(d.attrs.validate);
          } catch {
            flag(d, `prompt validate:${d.attrs.validate} is not a valid regex`);
          }
        }
        break;
      case 'operator':
        if (d.body.length === 0) flag(d, 'operator requires instructions for the human in its body');
        break;
    }
    // A consumer can only reference a variable an earlier prompt captured, or an
    // earlier `run capture:<var>` bound from a command's output.
    for (const ref of referencedVars(d)) {
      if (!defined.has(ref)) flag(d, `references {{${ref}}} but no earlier nc:prompt or nc:run capture defined it`);
    }
    if (d.kind === 'prompt') {
      const v = promptVar(d);
      if (v) defined.add(v);
    }
    if (d.kind === 'run' && typeof d.attrs.capture === 'string') defined.add(d.attrs.capture);
  }
  return problems;
}

// CLI
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let path = process.argv[2];
  if (!path) {
    console.error('usage: pnpm exec tsx scripts/skill-directives.ts <skillDir|SKILL.md>');
    process.exit(2);
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'SKILL.md');
  const directives = parseDirectives(readFileSync(path, 'utf8'));
  const problems = validate(directives, { chatVersion: resolveChatCoreVersion(process.cwd()) });
  console.log(JSON.stringify({ directives, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}
