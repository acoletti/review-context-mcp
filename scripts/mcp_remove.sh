#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib.sh"
require_supported_platform
scope="$(validate_claude_scope "${MCP_SCOPE:-user}")"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: claude CLI not found on PATH; install Claude Code first" >&2
  exit 1
fi

args=(mcp remove review-context -s "$scope")
echo "claude ${args[*]}"
exec claude "${args[@]}"
