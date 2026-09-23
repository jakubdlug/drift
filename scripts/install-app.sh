#!/bin/sh
# Builds Drift.app and swaps it into /Applications, restarting it if it was running.
set -e
cd "$(dirname "$0")/.."
npm run dist
# Stop a live/dev instance gracefully (it flushes state on SIGTERM)
if pkill -TERM -f "drift/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null; then
  while pgrep -f "drift/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null; do sleep 0.5; done
fi
if pgrep -x Drift >/dev/null; then
  osascript -e 'quit app "Drift"'
  while pgrep -x Drift >/dev/null; do sleep 0.5; done
fi
rm -rf /Applications/Drift.app
cp -R dist/mac-arm64/Drift.app /Applications/
open -a /Applications/Drift.app --args --control
echo "Zainstalowano /Applications/Drift.app"
