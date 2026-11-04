#!/usr/bin/env bash
# Parallel check gate for a nanoclaw checkout. Run from the repo root.
#
#   check.sh                 quick: whole-program typecheck/lint/format (cached), tests affected by
#                            uncommitted changes only (vitest --changed, bun --changed)
#   check.sh --base <ref>    quick, but "changed" means changed since <ref> (e.g. HEAD~1, a base commit)
#   check.sh full            every CI check, full vitest and bun suites
#   check.sh full --baseline <file>        full; fail only on test files not listed in <file>
#   check.sh full --write-baseline <file>  full; write the failing test files to <file>
#
# Logs: $CHECK_LOG_DIR (default node_modules/.cache/check). Exit 0 only when every job passes.
set -uo pipefail

mode=quick base=HEAD baseline="" write_baseline=""
while [ $# -gt 0 ]; do
  case "$1" in
    quick|full) mode=$1 ;;
    --base) base=$2; shift ;;
    --baseline) baseline=$2; shift ;;
    --write-baseline) write_baseline=$2; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
logs=${CHECK_LOG_DIR:-$root/node_modules/.cache/check}
cache=$root/node_modules/.cache
mkdir -p "$logs" "$cache/eslint"
rm -f "$logs"/*.log "$logs"/*.rc "$logs"/*.time

changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)
touches() { printf '%s\n' "$changed" | grep -Eq "$1"; }

export FORCE_COLOR=0 NO_COLOR=1 AGENT=1

job() { # job <name> <command...>: run in the background, record exit code and seconds
  local name=$1; shift
  ( start=$(date +%s); "$@" >"$logs/$name.log" 2>&1; echo $? >"$logs/$name.rc"; echo $(( $(date +%s) - start )) >"$logs/$name.time" ) &
}

# Lockfile drift is the one thing that must run before everything else.
if touches '(^|/)package\.json$|^pnpm-lock\.yaml$'; then
  pnpm install --prefer-offline >"$logs/pnpm-install.log" 2>&1 || { echo "FAIL pnpm-install"; tail -30 "$logs/pnpm-install.log"; exit 1; }
fi
if touches '^container/agent-runner/(package\.json|bun\.lock)$'; then
  (cd container/agent-runner && bun install) >"$logs/bun-install.log" 2>&1 || { echo "FAIL bun-install"; tail -30 "$logs/bun-install.log"; exit 1; }
fi

job typecheck pnpm exec tsc --noEmit
job lint pnpm exec eslint --cache --cache-location "$cache/eslint/" src/
job format pnpm exec prettier --check --cache 'src/**/*.ts'
job generated sh -c 'pnpm -s mailbox-model:check && pnpm -s slash-command:check && pnpm -s stdin-json:check'

runner_re='^container/agent-runner/|^src/mailbox/model\.ts$|^src/slash-command\.ts$'
if [ "$mode" = full ] || touches "$runner_re"; then
  job typecheck-runner pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit \
    --incremental --tsBuildInfoFile "$cache/tsc-runner.tsbuildinfo"
fi
if [ "$mode" = full ] || touches '(^|/)package\.json$|^container/cli-tools\.json$|^\.github/skill-pins/|^\.claude/skills/'; then
  job skill-pins pnpm -s skill-pins:check
fi

if [ "$mode" = full ]; then
  job vitest pnpm exec vitest run --reporter=dot --reporter=json --outputFile.json="$logs/vitest.json"
  job bun sh -c 'cd container/agent-runner && bun test --parallel'
else
  job vitest pnpm exec vitest run --changed "$base" --passWithNoTests --reporter=dot
  if touches "$runner_re"; then
    job bun sh -c "cd container/agent-runner && bun test --parallel --changed=$base"
  fi
fi

wait

# Full mode with a baseline: a vitest failure counts only for test files outside the baseline.
if [ "$mode" = full ] && [ -s "$logs/vitest.json" ]; then
  jq -r --arg root "$root/" '.testResults[] | select(.status == "failed") | .name | ltrimstr($root)' \
    "$logs/vitest.json" | sort -u >"$logs/vitest-failed.txt"
  if [ -n "$write_baseline" ]; then
    cp "$logs/vitest-failed.txt" "$write_baseline"
    echo "baseline: $(wc -l <"$write_baseline" | tr -d ' ') failing test files -> $write_baseline"
    echo 0 >"$logs/vitest.rc"
  elif [ -n "$baseline" ]; then
    comm -23 "$logs/vitest-failed.txt" <(sort -u "$baseline") >"$logs/vitest-new-failures.txt"
    if [ -s "$logs/vitest-new-failures.txt" ]; then
      echo 1 >"$logs/vitest.rc"
    else
      echo 0 >"$logs/vitest.rc"
    fi
  fi
fi

status=0
for rc in "$logs"/*.rc; do
  name=$(basename "$rc" .rc)
  if [ "$(cat "$rc")" = 0 ]; then
    printf 'PASS %-17s %3ss\n' "$name" "$(cat "$logs/$name.time")"
  else
    status=1
    printf 'FAIL %-17s %3ss  log: %s\n' "$name" "$(cat "$logs/$name.time")" "$logs/$name.log"
  fi
done
for rc in "$logs"/*.rc; do
  name=$(basename "$rc" .rc)
  [ "$(cat "$rc")" = 0 ] && continue
  echo "---- $name (last 40 lines)"
  if [ "$name" = vitest ] && [ -s "$logs/vitest-new-failures.txt" ]; then
    echo "test files failing outside the baseline:"; cat "$logs/vitest-new-failures.txt"
  fi
  grep -v -E '^\s*$|INFO|DEBUG' "$logs/$name.log" | tail -40
done
[ $status = 0 ] && echo GATE-OK
exit $status
