#!/bin/sh
# Review-context MCP server launcher.
# Auto-installs dependencies and rebuilds dist when needed.
# Designed for iCloud-synced multi-machine setups (no native binaries).
set -e

# Suppress Node.js deprecation warnings (e.g. punycode in v26+) that can
# interfere with MCP clients or clutter output.
export NODE_OPTIONS="--no-warnings"

# Claude/VSCode MCP launchers often start stdio servers with a minimal,
# non-interactive environment. Source the user's zsh config so optional LLM
# helpers can see AUGMENT_API_TOKEN / AUGMENT_API_URL when the user keeps them
# there. This is intentionally best-effort: a broken shell profile must not
# prevent semantic indexing/search from starting.
if [ -f "$HOME/.zshrc" ]; then
  set +e
  # shellcheck disable=SC1090
  . "$HOME/.zshrc" >/dev/null 2>&1
  set -e
fi

PROJ="$HOME/Library/Mobile Documents/com~apple~CloudDocs/review-context-mcp"
cd "$PROJ"

# Install dependencies if missing on this machine.
if [ ! -d "$PROJ/node_modules/@augmentcode" ]; then
  npm install --ignore-scripts 1>&2
fi

# Rebuild dist if any TypeScript source is newer than compiled output.
if [ ! -f "$PROJ/dist/index.js" ] || \
   [ -n "$(find "$PROJ/src" -name '*.ts' -newer "$PROJ/dist/index.js" -print -quit 2>/dev/null)" ]; then
  npm run build 1>&2
fi

# Fail fast with a clear message if dist is missing
if [ ! -f "$PROJ/dist/index.js" ]; then
  echo "Build failed: dist/index.js not found" >&2
  exit 1
fi

exec node "$PROJ/dist/index.js"
