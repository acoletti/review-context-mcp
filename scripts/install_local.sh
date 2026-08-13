#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node_bin="${NODE_BIN:-node}"
if ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "error: node not found on PATH; install Node.js >=20 or set NODE_BIN" >&2
  exit 1
fi

node_version_raw="$("$node_bin" --version 2>/dev/null || true)"
if [ -z "$node_version_raw" ]; then
  echo "error: '$node_bin' did not report a version" >&2
  exit 1
fi
node_major="$(printf '%s\n' "$node_version_raw" | sed -E 's/^v?([0-9]+).*/\1/')"
if ! [[ "$node_major" =~ ^[0-9]+$ ]] || [ "$node_major" -lt 20 ]; then
  echo "error: Node.js >=20 required, found $node_version_raw (from $node_bin)" >&2
  exit 1
fi

npm_bin="${NPM_BIN:-npm}"
if ! command -v "$npm_bin" >/dev/null 2>&1; then
  echo "error: npm not found on PATH; install Node.js/npm or set NPM_BIN" >&2
  exit 1
fi

# --ignore-scripts matches start.sh: audited on 2026-08-08, no dependency
# in this project's tree relies on install/postinstall for functionality
# (protobufjs's postinstall is a cosmetic stderr version-scheme warning;
# no compiled/downloaded artifacts depend on lifecycle scripts running).
"$npm_bin" install --ignore-scripts
"$npm_bin" run build
chmod +x "$repo_root/dist/index.js" "$repo_root/start.sh"

echo "Installed review-context-mcp into $repo_root"
echo "Launcher: $repo_root/start.sh"
echo "Register with:  make mcp-add   # Claude Code"
echo "                make auggie-add # Augment CLI"
