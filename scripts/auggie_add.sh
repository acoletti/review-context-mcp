#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib.sh"
require_supported_platform

if ! command -v auggie >/dev/null 2>&1; then
  echo "error: auggie CLI not found on PATH; install the Augment CLI first" >&2
  exit 1
fi

if [ ! -x "$repo_root/start.sh" ]; then
  echo "error: $repo_root/start.sh not found or not executable; run 'make install' first" >&2
  exit 1
fi

# Map AUGGIE_SCOPE=user|project|local -> no flag / --project / --local.
scope_flags=()
while IFS= read -r flag; do
  [ -n "$flag" ] && scope_flags+=("$flag")
done < <(auggie_scope_flags "${AUGGIE_SCOPE:-user}")

# --replace avoids an interactive overwrite prompt when review-context is
# already registered (e.g. from an older, non-self-healing entry).
args=(mcp add review-context "${scope_flags[@]+"${scope_flags[@]}"}" --command "$repo_root/start.sh" --replace)

# AUGMENT_API_TOKEN/URL are only needed for review_search_and_ask — indexing
# and semantic search fall back to ~/.augment/session.json without them.
while IFS= read -r part; do
  args+=("$part")
done < <(review_context_env_args)

echo "auggie $(redact_env_args "${args[@]}")"

run_cli_and_scrub auggie "${args[@]}"
