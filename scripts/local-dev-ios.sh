#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

for required_port in 7880 8787; do
  if lsof -nP -iTCP:"$required_port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s is already in use. Stop the ordinary local stack before running pnpm dev:ios.\n' "$required_port" >&2
    exit 1
  fi
done

local_host=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
if test -z "$local_host"; then
  printf 'Could not determine this Mac’s local hostname.\n' >&2
  exit 1
fi
lan_host="${local_host}.local"

livekit_pid=""
api_pid=""

cleanup() {
  trap - EXIT INT TERM
  for process_id in "$livekit_pid" "$api_pid"; do
    if test -n "$process_id"; then
      kill "$process_id" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

./scripts/livekit-dev.sh --lan &
livekit_pid=$!
pnpm --filter @starlings/control-plane exec wrangler dev \
  --config wrangler.local.jsonc \
  --ip 0.0.0.0 \
  --port 8787 \
  --var "LIVEKIT_URL:ws://${lan_host}:7880" &
api_pid=$!

printf 'Local Meet device stack starting (trusted LAN only):\n'
printf '  iOS API:  http://%s:8787/api\n' "$lan_host"
printf '  LiveKit:  ws://%s:7880\n' "$lan_host"
printf 'Enter the iOS API URL in Meet → Settings → Development server.\n'
printf 'The Mac host can continue using its default 127.0.0.1 endpoints.\n'
printf 'Press Ctrl-C to stop everything.\n'

while kill -0 "$livekit_pid" 2>/dev/null && kill -0 "$api_pid" 2>/dev/null; do
  sleep 1
done

status=1
if ! kill -0 "$livekit_pid" 2>/dev/null; then
  wait "$livekit_pid" || status=$?
else
  wait "$api_pid" || status=$?
fi
exit "$status"
