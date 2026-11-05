#!/bin/sh
set -eu

if test "${1:-}" = "--lan"; then
  # Device testing is opt-in because this exposes the development SFU on the
  # local network. LiveKit discovers the Mac's advertised node IP itself.
  exec livekit-server --dev --bind 0.0.0.0
fi

exec livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1
