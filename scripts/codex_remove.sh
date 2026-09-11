#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib.sh"
require_supported_platform

if ! command -v codex >/dev/null 2>&1; then
  echo "error: codex CLI not found on PATH; install the Codex CLI first" >&2
  exit 1
fi

args=(mcp remove review-context)
echo "codex ${args[*]}"
exec codex "${args[@]}"
