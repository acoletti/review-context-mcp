#!/usr/bin/env bash
# Register review-context with Hermes Agent.
#
# Hermes has no `mcp add` CLI (unlike claude/auggie), so registration is a
# direct edit of ~/.hermes/config.yaml under `mcp_servers`. The heavy lifting
# — backup, atomic write, post-write verification, idempotency — lives in
# hermes_add.py, which is shared with code-inference-query.
#
# Secrets: AUGMENT_API_TOKEN and AUGMENT_API_URL are optional here, exactly as
# in mcp_add.sh — indexing and semantic search fall back to
# ~/.augment/session.json without them; only review_search_and_ask needs them.
# Values are passed via argv to hermes_add.py and echoed back redacted.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib.sh"

MCP_NAME="${MCP_NAME:-review-context}"
HERMES_CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
HERMES_PYTHON="${HERMES_PYTHON:-$HOME/.hermes/hermes-agent/venv/bin/python}"
REGISTRAR="$repo_root/scripts/hermes_add.py"

if [ ! -f "$HERMES_CONFIG" ]; then
  echo "Hermes Agent not found ($HERMES_CONFIG) — skipping registration"
  exit 0
fi

if [ ! -x "$repo_root/start.sh" ]; then
  echo "error: $repo_root/start.sh not found or not executable; run 'make install' first" >&2
  exit 1
fi

if [ ! -f "$REGISTRAR" ]; then
  echo "error: $REGISTRAR missing" >&2
  exit 1
fi

py="$HERMES_PYTHON"
[ -x "$py" ] || py="$(command -v python3 || true)"
if [ -z "$py" ]; then
  echo "error: no python3 found to run the registrar" >&2
  exit 1
fi

args=(--name "$MCP_NAME" --command "$repo_root/start.sh" --config "$HERMES_CONFIG")

if [ "${1:-}" = "--remove" ]; then
  args+=(--remove)
else
  # Hermes starts stdio servers with a filtered environment (PATH, HOME, USER,
  # LANG, TERM, SHELL, TMPDIR and XDG_* only). A version-manager node (nvm,
  # fnm, volta) lives outside that PATH, so start.sh's `command -v node` fails
  # and the server never boots. Pin the resolved interpreter explicitly.
  node_bin="${NODE_BIN:-$(command -v node || true)}"
  if [ -n "$node_bin" ]; then
    args+=(--env "NODE_BIN=$node_bin")
  else
    echo "warning: node not found on PATH; the server may fail to start under Hermes" >&2
    echo "         re-run with NODE_BIN=/path/to/node make hermes-add" >&2
  fi

  for var in AUGMENT_API_TOKEN AUGMENT_API_URL REVIEW_CONTEXT_DEBUG; do
    if [ -n "${!var:-}" ]; then
      args+=(--env "$var=${!var}")
    fi
  done
fi

# Log the invocation with secret values masked (same contract as mcp_add.sh).
printf 'hermes_add.py'
for a in "${args[@]}"; do
  case "$a" in
    AUGMENT_API_TOKEN=*|AUGMENT_API_URL=*) printf ' %s=***' "${a%%=*}" ;;
    *) printf ' %s' "$a" ;;
  esac
done
printf '\n'

"$py" "$REGISTRAR" "${args[@]}"
