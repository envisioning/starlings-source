#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

livekit_pid=""
api_pid=""
web_pid=""

cleanup() {
  trap - EXIT INT TERM
  for process_id in "$livekit_pid" "$api_pid" "$web_pid"; do
    if test -n "$process_id"; then
      kill "$process_id" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

./scripts/livekit-dev.sh &
livekit_pid=$!
pnpm dev:api &
api_pid=$!
pnpm dev:web &
web_pid=$!

printf 'Local Meet stack starting:\n'
printf '  Web:     http://127.0.0.1:5173/room/rosa\n'
printf '  API:     http://127.0.0.1:8787/api/health\n'
printf '  LiveKit: ws://127.0.0.1:7880\n'
printf 'Press Ctrl-C to stop everything.\n'

wait "$livekit_pid" "$api_pid" "$web_pid"
