# Shared helpers for review-context-mcp setup scripts.

# Echoes "$@" with the value half of every "-e KEY=VAL" pair redacted, so
# callers can safely log a command line before it runs with secrets in argv.
redact_env_args() {
  local out=() redact_next=0 a
  for a in "$@"; do
    if [ "$redact_next" = 1 ]; then
      out+=("${a%%=*}=***")
      redact_next=0
    elif [ "$a" = "-e" ]; then
      out+=("$a")
      redact_next=1
    else
      out+=("$a")
    fi
  done
  echo "${out[*]}"
}

# Escapes a literal string for safe use as a BRE `sed` pattern (delimited
# by `/`). Backslash must be escaped first so later escapes aren't doubled.
_sed_escape_literal() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' \
          -e 's/\./\\./g' \
          -e 's/\*/\\*/g' \
          -e 's/\^/\\^/g' \
          -e 's/\$/\\$/g' \
          -e 's/\[/\\[/g' \
          -e 's/\]/\\]/g' \
          -e 's/\//\\\//g'
}

# Reads stdin and replaces every literal occurrence of each non-empty "$@"
# value with '***'. Use this on a downstream CLI's own stdout/stderr, since
# tools like `auggie mcp add` echo back the config they just saved —
# including secret values — even when our own invocation was redacted.
#
# Implemented with `sed` (POSIX-guaranteed, present even on minimal/Alpine
# images) instead of python3 — python3 is not reliably on PATH (e.g. fresh
# macOS, slim Docker bases), and a missing interpreter here would either
# abort registration entirely or, worse, silently skip redaction depending
# on how the failure was handled. sed has no such availability gap.
scrub_secrets() {
  local sed_args=() secret esc
  for secret in "$@"; do
    if [ -n "$secret" ]; then
      esc="$(_sed_escape_literal "$secret")"
      sed_args+=(-e "s/${esc}/***/g")
    fi
  done
  if [ "${#sed_args[@]}" -eq 0 ]; then
    cat
  else
    sed "${sed_args[@]}"
  fi
}

# Prints the `-e KEY=VAL` args needed to forward AUGMENT_API_TOKEN,
# AUGMENT_API_URL, and REVIEW_CONTEXT_DEBUG to the launcher, one token per
# line (only for vars that are actually set). Shared by mcp_add.sh and
# auggie_add.sh so the two don't drift. Consume like `auggie_scope_flags`:
#   while IFS= read -r part; do env_args+=("$part"); done < <(review_context_env_args)
review_context_env_args() {
  # printf, not echo: bash's echo builtin treats a bare "-e" argument as
  # its own -e flag (enable backslash escapes) even when quoted, so
  # `echo "-e"` prints nothing instead of the literal string.
  if [ -n "${AUGMENT_API_TOKEN:-}" ]; then
    printf '%s\n' "-e" "AUGMENT_API_TOKEN=$AUGMENT_API_TOKEN"
  fi
  if [ -n "${AUGMENT_API_URL:-}" ]; then
    printf '%s\n' "-e" "AUGMENT_API_URL=$AUGMENT_API_URL"
  fi
  if [ -n "${REVIEW_CONTEXT_DEBUG:-}" ]; then
    printf '%s\n' "-e" "REVIEW_CONTEXT_DEBUG=$REVIEW_CONTEXT_DEBUG"
  fi
}

# Runs `"$1"` with the remaining args, captures its combined stdout+stderr,
# scrubs AUGMENT_API_TOKEN/AUGMENT_API_URL/REVIEW_CONTEXT_DEBUG values out
# of it (the CLI echoes back the config it just saved, secrets included),
# prints the scrubbed output, then exits the calling script with the CLI's
# own exit status. Shared by mcp_add.sh and auggie_add.sh; exits the shell,
# so it must be the last statement of the caller.
run_cli_and_scrub() {
  local bin="$1"
  shift
  local status output
  set +e
  output="$("$bin" "$@" 2>&1)"
  status=$?
  set -e
  echo "$output" | scrub_secrets "${AUGMENT_API_TOKEN:-}" "${AUGMENT_API_URL:-}" "${REVIEW_CONTEXT_DEBUG:-}"
  exit "$status"
}

# Validate and echo a Claude MCP scope. Accepts user|project|local; falls
# back to a clear error otherwise.
validate_claude_scope() {
  local s="${1:-user}"
  case "$s" in
    user|project|local) echo "$s" ;;
    *)
      echo "error: MCP_SCOPE='$s' is not valid; use user|project|local" >&2
      exit 1
      ;;
  esac
}

# Translate AUGGIE_SCOPE into the flags `auggie mcp add|remove` expects.
# Prints one flag per line (may print nothing for the default user scope).
auggie_scope_flags() {
  local s="${1:-user}"
  case "$s" in
    user) ;;  # no flag
    project) echo "--project" ;;
    local) echo "--local" ;;
    *)
      echo "error: AUGGIE_SCOPE='$s' is not valid; use user|project|local" >&2
      exit 1
      ;;
  esac
}

# Refuse to run on unsupported OSes so the user sees a clean message
# instead of cryptic downstream CLI output. Darwin and Linux are the
# platforms exercised by tests and by the Claude/Auggie CLIs.
require_supported_platform() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *)
      echo "error: unsupported platform '$(uname -s)'; run this on macOS or Linux" >&2
      exit 1
      ;;
  esac
}
