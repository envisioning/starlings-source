# One gate at a time on this machine, across every worktree of this repo.
#
# Two locks, by name: `gate` for anything that starts the Workers or web
# test pools (verify-fast.sh, the package tests), and `xcode` for the Apple
# builds and tests in verify.sh. They do not compete for the same thing, so
# a fast gate runs beside an Xcode build; two of either kind never do.
#
# Sourced by verify.sh, verify-fast.sh and with-gate-lock.sh. A gate starts
# a Workers test pool and a web test pool; several at once (two sessions,
# three worktrees) starve each other until tests time out. The lock lives in
# the git common directory, which every worktree of the repo shares.
#
# The `xcode` lock also takes the machine lock (scripts/build-lock), which
# every repository on the Mac shares: one heavy build at a time across
# Starlings and other repos on this machine (2026-10-19). The lock code is build-lock's.
#
# A second gate waits and says who holds the lock. A lock whose process has
# exited is cleared. A gate started inside one that already holds the lock
# (verify-fast.sh runs the package tests) passes through: the lock's
# MEET_<NAME>_LOCK_HELD=1 is exported to every child.
#
#   gate_lock_acquire <what> [gate|xcode]
#
#   MEET_GATE_LOCK_WAIT  seconds to wait before giving up (default 3600)
#
# The land queue goes first (2026-10-08). While the queue waits for a lock,
# it leaves a `meet-<name>.queue-waiting` file with its PID, and a session's
# gate does not take that lock until the queue has had it. Without this, every
# session's `verify:changed` could take the lock ahead of the queue, and the
# queue gave up after an hour and marked a good branch failed. The queue sets
# MEET_LAND_QUEUE=1.
#
# A gate also runs at a low CPU priority, so parallel sessions do not take
# the whole Mac (2026-10-05). `gate_low_priority <script> [args]` starts the
# script again under `taskpolicy -c background`: macOS keeps it and every
# child on the efficiency cores. The gate takes longer; the Mac stays usable.
#
#   MEET_GATE_QOS  background (default), utility (also uses the performance
#                  cores when they are free), or off

gate_low_priority() {
  if [ "${MEET_GATE_QOS_SET:-}" = 1 ]; then return 0; fi
  gate_qos=${MEET_GATE_QOS:-background}
  if [ "$gate_qos" = off ]; then return 0; fi
  if ! command -v taskpolicy >/dev/null 2>&1; then return 0; fi
  MEET_GATE_QOS_SET=1
  export MEET_GATE_QOS_SET
  exec taskpolicy -c "$gate_qos" "$@"
}

gate_lock_acquire() {
  gate_lock_name=${2:-gate}
  gate_lock_held_var="MEET_$(printf '%s' "$gate_lock_name" | tr '[:lower:]' '[:upper:]')_LOCK_HELD"
  if [ "$(eval "printf '%s' \"\${$gate_lock_held_var:-}\"")" = 1 ]; then return 0; fi
  gate_lock_common=$(git rev-parse --git-common-dir 2>/dev/null || true)
  # Outside git (an exported tarball, a CI copy without .git): nothing to share.
  if [ -z "$gate_lock_common" ]; then return 0; fi
  # The mkdir lock itself is scripts/build-lock, the one copy every repository
  # on the Mac uses (2026-10-19).
  BUILD_LOCK_SOURCED=1
  . "$(git rev-parse --show-toplevel)/scripts/build-lock"
  BUILD_LOCK_TAG=gate-lock
  BUILD_LOCK_WAIT=${MEET_GATE_LOCK_WAIT:-${BUILD_LOCK_WAIT:-3600}}
  if [ "${MEET_LAND_QUEUE:-}" = 1 ]; then BUILD_LOCK_FIRST=1; fi
  build_lock_take "$(CDPATH= cd -- "$gate_lock_common" && pwd -P)/meet-$gate_lock_name.lock" "${1:-gate}" "$gate_lock_held_var"
  # The Apple builds also take the machine lock, so another repo's build or another
  # repository's gate does not run beside them. This repository's lock comes
  # first: every holder takes the two in the same order, and the queue keeps
  # its place for both.
  if [ "$gate_lock_name" = xcode ]; then build_lock_machine "starlings ${1:-gate}"; fi
}
