#!/bin/sh
# Live-iteration mode: sidebar hot-reloads, main/preload changes restart the app.
# Shares data with /Applications/Drift.app, so that one is closed first.
set -e
cd "$(dirname "$0")/.."
if pgrep -x Drift >/dev/null; then
  echo "Closing Drift.app (data is shared)…"
  osascript -e 'quit app "Drift"'
  while pgrep -x Drift >/dev/null; do sleep 0.5; done
fi
exec npx electron-vite dev --watch
