#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib.sh"
require_supported_platform

if ! command -v auggie >/dev/null 2>&1; then
  echo "error: auggie CLI not found on PATH; install the Augment CLI first" >&2
  exit 1
fi

scope_flags=()
while IFS= read -r flag; do
  [ -n "$flag" ] && scope_flags+=("$flag")
done < <(auggie_scope_flags "${AUGGIE_SCOPE:-user}")

args=(mcp remove review-context "${scope_flags[@]+"${scope_flags[@]}"}")
echo "auggie ${args[*]}"
exec auggie "${args[@]}"
