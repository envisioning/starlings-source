#!/bin/sh
# Remove the worktrees whose work is on main.
#
# On 2026-10-11 both Macs held about 190 GB of worktrees and build caches.
# Sessions that stop, crash or are interrupted never remove their worktree,
# so this sweep needs no session. The land queue runs it after each landed
# branch and once an hour (land-queue.sh); a person runs `pnpm worktrees:sweep`.
#
# It removes a worktree of this repository, wherever it is (`../_worktrees/`,
# `.claude/worktrees/`, `~/.codex/worktrees/`), only when all of these hold:
#
#   - `git status --porcelain` shows nothing: no change, no untracked file;
#   - `git cherry origin/main` marks every commit `-`: its work is on main.
#     With --landed, HEAD may instead be in the commit the queue landed: a
#     rebase can change a patch so that `git cherry` no longer matches it;
#   - nothing touched its index, HEAD or reflog in MEET_SWEEP_IDLE_MINUTES
#     (default 120): a session that just committed is still working there;
#   - no running process has its current folder in it: a session can work
#     for hours without a git write (2026-10-11, the sweep removed a live
#     desktop session's worktree).
#
# It never removes the main checkout, the worktree it runs in (the queue's),
# or a locked worktree. A worktree that does not qualify is reported with
# its path, size and reason, and left alone. When a worktree goes, its local
# branch goes too, unless another worktree holds it.
#
#   worktrees-sweep.sh                  sweep every worktree, then report
#   worktrees-sweep.sh --branch <name>  only the worktrees on this branch
#       [--landed <sha>]                 the branch commit the queue landed
#   worktrees-sweep.sh --dry-run        say what would go; remove nothing
set -u

# The repository of the current folder: the queue's worktree, or wherever
# `pnpm worktrees:sweep` runs.
cd "$(git rev-parse --show-toplevel)" || exit 1

only_branch=''
landed=''
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) only_branch=${2:-}; [ -n "$only_branch" ] || { printf 'usage: worktrees-sweep.sh [--branch <name> [--landed <sha>]] [--dry-run]\n' >&2; exit 2; }; shift ;;
    --landed) landed=${2:-}; shift ;;
    --dry-run) dry_run=1 ;;
    *) printf 'usage: worktrees-sweep.sh [--branch <name> [--landed <sha>]] [--dry-run]\n' >&2; exit 2 ;;
  esac
  shift
done

idle_seconds=$(( ${MEET_SWEEP_IDLE_MINUTES:-120} * 60 ))
# Reading a worktree must not write its index: that would reset its idle time.
GIT_OPTIONAL_LOCKS=0
export GIT_OPTIONAL_LOCKS
now=$(date +%s)
here=$(git rev-parse --show-toplevel)
here=$(CDPATH= cd -- "$here" && pwd -P)
# The land queue's worktree, when a person runs the sweep beside it.
common_dir=$(CDPATH= cd -- "$(git rev-parse --git-common-dir)" && pwd -P)
queue_dir=$(cat "$common_dir/meet-land/queue.lock/where" 2>/dev/null || true)
[ -n "$queue_dir" ] && [ -d "$queue_dir" ] && queue_dir=$(CDPATH= cd -- "$queue_dir" && pwd -P)

git fetch --quiet origin main 2>/dev/null || printf 'sweep: fetch failed; comparing with the origin/main this clone has\n' >&2
git worktree prune

removed=0
freed_kb=0

# Every running process's current folder, read once (`MEET_SWEEP_CWDS`, one
# path per line, replaces it in tests).
if [ -n "${MEET_SWEEP_CWDS+set}" ]; then
  process_cwds=$MEET_SWEEP_CWDS
else
  process_cwds=$(lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u)
fi

# True when a running process works inside `$1`.
in_use_by_process() {
  printf '%s\n' "$process_cwds" | awk -v root="$1" '$0 == root || index($0, root "/") == 1 { found = 1 } END { exit found ? 0 : 1 }'
}

size_kb() { du -sk "$1" 2>/dev/null | awk '{print $1}'; }
human() { awk -v kb="$1" 'BEGIN { if (kb >= 1048576) printf "%.1f GB", kb / 1048576; else printf "%d MB", kb / 1024 }'; }
# Linux first: GNU `stat -f` means filesystem status and exits 0 with a page
# of text, so the macOS form must come second (Workers Builds, 2026-10-12).
mtime() {
  stamp=$(stat -c %Y "$1" 2>/dev/null) || stamp=$(stat -f %m "$1" 2>/dev/null) || stamp=0
  case $stamp in ''|*[!0-9]*) stamp=0 ;; esac
  echo "$stamp"
}

# Seconds since a session last changed the worktree's index, HEAD or reflog.
idle_for() {
  git_dir=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || { echo "$idle_seconds"; return; }
  newest=0
  for file in "$git_dir/index" "$git_dir/HEAD" "$git_dir/logs/HEAD"; do
    [ -e "$file" ] || continue
    stamp=$(mtime "$file")
    [ "$stamp" -gt "$newest" ] && newest=$stamp
  done
  echo $(( now - newest ))
}

keep() {
  printf 'kept     %s (%s): %s\n' "$1" "$(human "$(size_kb "$1")")" "$2"
}

# The other worktrees that hold this branch, so its local branch stays.
branch_held_elsewhere() {
  git worktree list --porcelain | awk -v ref="refs/heads/$1" -v path="$2" '
    /^worktree / { wt = substr($0, 10) }
    $0 == "branch " ref && wt != path { found = 1 }
    END { exit found ? 0 : 1 }'
}

sweep_one() {
  path=$1 ref=$2 locked=$3
  branch=${ref#refs/heads/}
  [ "$ref" = detached ] && branch=''
  if [ -n "$only_branch" ] && [ "$branch" != "$only_branch" ]; then return; fi
  [ -d "$path" ] || return
  real=$(CDPATH= cd -- "$path" && pwd -P)
  [ "$real" = "$here" ] && return
  [ "$real" = "$queue_dir" ] && return
  if [ "$locked" = 1 ]; then keep "$path" 'locked'; return; fi

  # Before `git status`, which may refresh the index and look like use.
  idle=$(idle_for "$path")
  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    keep "$path" 'uncommitted changes'
    return
  fi
  if git -C "$path" cherry origin/main HEAD 2>/dev/null | grep -q '^+' \
    && ! { [ -n "$landed" ] && git -C "$path" merge-base --is-ancestor HEAD "$landed" 2>/dev/null; }; then
    keep "$path" "commits not on main$( [ -n "$branch" ] && printf ' (%s)' "$branch")"
    return
  fi

  if in_use_by_process "$real"; then
    keep "$path" 'a running process works in it'
    return
  fi
  if [ "$idle" -lt "$idle_seconds" ]; then
    keep "$path" "in use $(( idle / 60 )) minutes ago"
    return
  fi

  kb=$(size_kb "$path")
  if [ "$dry_run" = 1 ]; then
    printf 'would go %s (%s)\n' "$path" "$(human "$kb")"
    return
  fi
  if ! git worktree remove --force "$path" 2>/dev/null; then
    # A file written while git deleted (Finder's .DS_Store, a watcher)
    # leaves the folder behind after git has already dropped the worktree.
    # It was checked clean above, so the rest of the folder goes too.
    if git worktree list --porcelain | grep -qx "worktree $path"; then
      keep "$path" 'git worktree remove failed'
      return
    fi
    rm -rf "$path"
  fi
  removed=$(( removed + 1 ))
  freed_kb=$(( freed_kb + kb ))
  printf 'removed  %s (%s)\n' "$path" "$(human "$kb")"
  if [ -n "$branch" ] && ! branch_held_elsewhere "$branch" "$path"; then
    git branch -D "$branch" >/dev/null 2>&1 && printf '         and the local branch %s\n' "$branch"
  fi
}

# `git worktree list --porcelain`: one block per worktree; the first is the
# main checkout. Read it whole first, because removing changes the list.
list=$(git worktree list --porcelain | awk '
  /^worktree / { if (path != "") print path "\t" ref "\t" locked; path = substr($0, 10); ref = "detached"; locked = 0 }
  /^branch / { ref = substr($0, 8) }
  /^locked/ { locked = 1 }
  END { if (path != "") print path "\t" ref "\t" locked }' | tail -n +2)

tab=$(printf '\t')
while IFS="$tab" read -r path ref locked; do
  [ -n "$path" ] && sweep_one "$path" "$ref" "$locked"
done <<EOF
$list
EOF

# A landed branch with no worktree: its local branch goes, unless it holds a
# commit made after the one the queue landed.
if [ -n "$only_branch" ] && [ "$dry_run" = 0 ] && git show-ref --verify --quiet "refs/heads/$only_branch" \
  && ! git worktree list --porcelain | grep -qx "branch refs/heads/$only_branch"; then
  if ! git cherry origin/main "refs/heads/$only_branch" | grep -q '^+' \
    || { [ -n "$landed" ] && git merge-base --is-ancestor "refs/heads/$only_branch" "$landed" 2>/dev/null; }; then
    git branch -D "$only_branch" >/dev/null && printf 'removed  the local branch %s\n' "$only_branch"
  else
    printf 'kept     the local branch %s: commits not on main\n' "$only_branch"
  fi
fi

printf 'sweep: removed %d worktree(s), freed %s\n' "$removed" "$(human "$freed_kb")"
