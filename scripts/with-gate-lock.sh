#!/bin/sh
# Run one command under the gate lock (gate-lock.sh): the package test
# scripts use it, so `pnpm test` in a package waits for a running gate.
#
#   sh ../../scripts/with-gate-lock.sh vitest run
set -eu

. "$(dirname -- "$0")/gate-lock.sh"
gate_low_priority "$0" "$@"
gate_lock_acquire "$*"
"$@"
