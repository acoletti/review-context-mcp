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

if [ ! -x "$repo_root/start.sh" ]; then
  echo "error: $repo_root/start.sh not found or not executable; run 'make install' first" >&2
  exit 1
fi

args=(mcp add review-context -s "$scope")

# AUGMENT_API_TOKEN/URL are only needed for review_search_and_ask — indexing
# and semantic search fall back to ~/.augment/session.json without them.
while IFS= read -r part; do
  args+=("$part")
done < <(review_context_env_args)

args+=(-- "$repo_root/start.sh")

echo "claude $(redact_env_args "${args[@]}")"

run_cli_and_scrub claude "${args[@]}"
