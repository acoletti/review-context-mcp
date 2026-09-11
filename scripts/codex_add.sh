#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib.sh"
require_supported_platform

if ! command -v codex >/dev/null 2>&1; then
  echo "error: codex CLI not found on PATH; install the Codex CLI first" >&2
  exit 1
fi

if [ ! -x "$repo_root/start.sh" ]; then
  echo "error: $repo_root/start.sh not found or not executable; run 'make install' first" >&2
  exit 1
fi

# Codex reads stdio MCP servers from ~/.codex/config.toml. `mcp add` without a
# scope flag writes a *global* entry (the default), which is what we want —
# one registration that works in every project, matching how mcp_add.sh and
# auggie_add.sh register by default. Re-adding overwrites the existing entry,
# so no --replace analog is needed (unlike auggie's mcp add).
args=(mcp add review-context)

# AUGMENT_API_TOKEN/URL are only needed for review_search_and_ask — indexing
# and semantic search fall back to ~/.augment/session.json without them.
while IFS= read -r part; do
  args+=("$part")
done < <(review_context_codex_env_args)

args+=(-- "$repo_root/start.sh")

echo "codex $(redact_env_args "${args[@]}")"

run_cli_and_scrub codex "${args[@]}"
