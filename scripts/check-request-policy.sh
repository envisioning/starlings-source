#!/bin/sh
set -eu

# No client keeps its own list of what a write clears, and no client sets its
# own request timeout or retry. The table is
# packages/contracts/src/request-policy.ts; a write names itself
# (`invalidating: .taskUpdate`, `invalidateFor('task.update')`) and the table
# says which snapshotted lists that makes stale.

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

problems=0

report() {
  printf '%s\n' "$1" >&2
  problems=$((problems + 1))
}

# Swift: the two API files name a write, never a list.
swift_hits=$(grep -nE 'invalidating: \[|prefixes: \[|SnapshotStore\.invalidate\(|invalidating [a-z]+: \[String\]|withOneRetry' \
  Sources/MeetingControlAPI.swift iOS/StarlingsAPI.swift || true)
if [ -n "$swift_hits" ]; then
  report "An API file lists the snapshots a write clears, or retries on its own. Name the write in packages/contracts/src/request-policy.ts instead:"
  printf '%s\n' "$swift_hits" >&2
fi

# Swift: the transport takes its timeout and retry from the table.
timeout_hits=$(grep -nE 'StarlingsHTTPTransport\(.*timeout:' Sources/MeetingControlAPI.swift iOS/StarlingsAPI.swift || true)
if [ -n "$timeout_hits" ]; then
  report "An API file sets the transport timeout. It comes from StarlingsRequestPolicy.timeoutSeconds:"
  printf '%s\n' "$timeout_hits" >&2
fi

# Web: a write calls invalidateFor(write). Docs keeps its own snapshots
# (core-kit), so DocsPage is the one file that still names keys.
web_hits=$(grep -rnE 'invalidateSnapshots\(' web/src \
  --include='*.ts' --include='*.tsx' \
  | grep -vE '^web/src/(snapshot-store\.ts|DocsPage\.tsx):|\.test\.tsx?:' || true)
if [ -n "$web_hits" ]; then
  report "The web lists the snapshots a write clears. Call invalidateFor('<write>') from snapshot-store.ts:"
  printf '%s\n' "$web_hits" >&2
fi

if [ "$problems" -gt 0 ]; then
  exit 1
fi
echo "request policy: no client keeps its own list"
