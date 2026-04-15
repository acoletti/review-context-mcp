#!/bin/sh
# Review-context MCP server launcher.
# Auto-installs dependencies and rebuilds dist when needed.
# Designed for iCloud-synced multi-machine setups (no native binaries).
set -e

PROJ="$HOME/Library/Mobile Documents/com~apple~CloudDocs/review-context-mcp"
cd "$PROJ"

# Install dependencies if missing on this machine.
if [ ! -d "$PROJ/node_modules/@augmentcode" ]; then
  npm install --ignore-scripts 1>&2
fi

# Rebuild dist if TypeScript sources are newer than compiled output.
if [ "$PROJ/src/index.ts" -nt "$PROJ/dist/index.js" ] || \
   [ "$PROJ/src/context-manager.ts" -nt "$PROJ/dist/index.js" ]; then
  npm run build 1>&2
fi

# Fail fast with a clear message if dist is missing
if [ ! -f "$PROJ/dist/index.js" ]; then
  echo "Build failed: dist/index.js not found" >&2
  exit 1
fi

exec node "$PROJ/dist/index.js"
