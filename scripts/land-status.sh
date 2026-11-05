#!/bin/sh
# What the land queue (scripts/land-queue.sh) did with each ship/* branch.
#
#   pnpm land:status               every branch the queue has seen, and whether it runs
#   pnpm land:status ship/<slug>   one branch, with the end of its log when it failed
set -u

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
state_dir="$(CDPATH= cd -- "$(git rev-parse --git-common-dir)" && pwd -P)/meet-land"

holder=$(cat "$state_dir/queue.lock/pid" 2>/dev/null || true)
if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
  printf 'queue: running (PID %s, %s)\n' "$holder" "$(cat "$state_dir/queue.lock/where" 2>/dev/null)"
else
  printf 'queue: NOT RUNNING. Start it in its own worktree: pnpm land:queue (scripts/land-queue.sh)\n'
fi

field() { sed -n "s/^$2=//p" "$1"; }

if [ -n "${1:-}" ]; then
  branch=${1#origin/}
  file="$state_dir/$(printf '%s' "$branch" | tr '/' '_').state"
  if [ ! -f "$file" ]; then
    # --prune: a ref left from a branch origin deleted otherwise reads as waiting.
    git fetch --quiet --prune origin 2>/dev/null || true
    if git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
      printf '%s: waiting\n' "$branch"
    elif git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null &&
      ! git cherry origin/main "$branch" | grep -q '^+'; then
      printf '%s: on main, but the queue did not land it (something pushed main outside the queue)\n' "$branch"
    else
      printf '%s: the queue has not seen it; push it to origin as %s\n' "$branch" "$branch"
    fi
    exit 0
  fi
  printf '%s: %s at %s (%s)\n  %s\n' "$branch" "$(field "$file" state)" "$(field "$file" when)" "$(field "$file" sha | cut -c1-8)" "$(field "$file" detail)"
  log=$(field "$file" log)
  if [ "$(field "$file" state)" = failed ] && [ -f "$log" ]; then
    printf '  log: %s\n' "$log"
    grep -E 'error|Error|FAIL|failed|✗|stale|CONFLICT' "$log" | grep -v 'produced no further output' | tail -n 20 | sed 's/^/  /'
  fi
  exit 0
fi

for file in "$state_dir"/*.state; do
  [ -f "$file" ] || { printf 'no branch landed yet\n'; exit 0; }
  printf '%-40s %-8s %s  %s\n' "$(field "$file" branch)" "$(field "$file" state)" "$(field "$file" when)" "$(field "$file" detail)"
done
