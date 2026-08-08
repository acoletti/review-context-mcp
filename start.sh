#!/bin/sh
# Review-context MCP server launcher.
#
# Self-healing: resolves Node >=20, installs deps if missing, rebuilds dist
# when source is newer, then execs the compiled server so signals and the
# process lifecycle belong to Node.
#
# Design constraints:
#   * POSIX /bin/sh only; no bash features.
#   * No shell-profile sourcing (MCP clients start with intentionally
#     minimal, non-interactive envs; sourcing user profiles is unreliable
#     and can corrupt caller-provided environment).
#   * Silent on stdout during healthy startup; all diagnostics on stderr.
#   * Fails nonzero with an actionable message when prerequisites are
#     missing.
#
# Deliberate coding-standards deviations (see §E.3 "Forbidden Languages" /
# shell script size and safety conventions), both required by the POSIX
# /bin/sh constraint above:
#   * `set -e` only, no `set -o pipefail` — pipefail is a bash/ksh/zsh
#     extension absent from POSIX.1-2017. Every pipeline in this script
#     (`run_with_tail`'s "$@" >"$_log" 2>&1, `tail ... >&2`) captures the
#     command's own exit status directly rather than relying on a pipe's
#     exit status, so the lack of pipefail does not hide a failure here.
#   * Length: this file exceeds the usual shell-script LOC ceiling because
#     splitting POSIX-only setup logic across multiple sourced files would
#     reintroduce a "does this file support plain /bin/sh" question at each
#     split point; kept as one file to keep that guarantee auditable in
#     one place.
set -e

# Suppress Node.js deprecation warnings (e.g. punycode in v26+) that can
# interfere with MCP clients that treat any stderr as a startup error.
export NODE_OPTIONS="${NODE_OPTIONS:---no-warnings}"

# Resolve the launcher's own directory so the server is relocatable
# (works from an iCloud path, a symlinked clone, or a temp fixture).
PROJ="$(cd "$(dirname "$0")" && pwd)"

# Optional per-run cap on error-tail bytes printed to stderr when
# `npm install` / `npm run build` fail. MCP clients often render stderr
# inline in chat transcripts, so 120 lines is a sane default.
ERROR_TAIL_LINES="${REVIEW_CONTEXT_ERROR_TAIL_LINES:-120}"

# ── Prerequisite: Node.js >=20 ──────────────────────────────────────────
node_bin="${NODE_BIN:-}"
if [ -z "$node_bin" ]; then
  node_bin="$(command -v node 2>/dev/null || true)"
fi
# node_bin is either a bare command name resolved via `command -v node`
# above, or a caller-supplied NODE_BIN which may be a bare name (looked up
# on PATH) or an absolute/relative path (checked directly with -x). The
# compound condition accepts either form: fail only if node_bin is empty,
# OR it isn't an executable path AND it doesn't resolve on PATH either.
if [ -z "$node_bin" ] || ! [ -x "$node_bin" ] && ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "error: node not found on PATH; install Node.js >=20 or set NODE_BIN" >&2
  exit 1
fi

node_version_raw="$("$node_bin" --version 2>/dev/null || true)"
if [ -z "$node_version_raw" ]; then
  echo "error: '$node_bin' did not report a version; is it a working Node binary?" >&2
  exit 1
fi
node_major="$(printf '%s\n' "$node_version_raw" | sed -E 's/^v?([0-9]+).*/\1/')"
case "$node_major" in
  ''|*[!0-9]*)
    echo "error: could not parse Node major version from '$node_version_raw'" >&2
    exit 1
    ;;
esac
if [ "$node_major" -lt 20 ]; then
  echo "error: Node.js >=20 required, found $node_version_raw (from $node_bin)" >&2
  echo "       set NODE_BIN to a newer node, or install one (e.g. via nvm/fnm/brew)" >&2
  exit 1
fi

# ── Helper: tail stderr of a failed npm command onto stderr ─────────────
# $1 = human label, $2 = log file path
run_with_tail() {
  _label="$1"
  _log="$2"
  shift 2
  if "$@" >"$_log" 2>&1; then
    return 0
  fi
  _status=$?
  echo "error: $_label failed (exit $_status); last $ERROR_TAIL_LINES lines:" >&2
  tail -n "$ERROR_TAIL_LINES" "$_log" >&2 || true
  return "$_status"
}

# ── Decide whether repair (install/build) is needed ─────────────────────
need_install=0
need_build=0

# Missing node_modules or missing critical dep => install.
if [ ! -d "$PROJ/node_modules" ] || [ ! -d "$PROJ/node_modules/@augmentcode" ]; then
  need_install=1
fi

# Missing dist/index.js => build (if src exists).
if [ ! -f "$PROJ/dist/index.js" ]; then
  need_build=1
fi

# dist exists but any TS input newer than dist/index.js => rebuild.
if [ "$need_build" -eq 0 ] && [ -f "$PROJ/dist/index.js" ] && [ -d "$PROJ/src" ]; then
  newer="$(find "$PROJ/src" "$PROJ/tsconfig.json" -newer "$PROJ/dist/index.js" -print 2>/dev/null | head -n 1)"
  if [ -n "$newer" ]; then
    need_build=1
  fi
fi

# Source-less built copy: dist present but no src to rebuild from.
# That is a supported deployment; skip build even if dist looks stale.
if [ "$need_build" -eq 1 ] && [ ! -d "$PROJ/src" ]; then
  if [ -f "$PROJ/dist/index.js" ]; then
    need_build=0
  else
    echo "error: no dist/index.js and no src/ to build from at $PROJ" >&2
    exit 1
  fi
fi

# ── Resolve npm only if we actually need it ─────────────────────────────
if [ "$need_install" -eq 1 ] || [ "$need_build" -eq 1 ]; then
  npm_bin="${NPM_BIN:-}"
  if [ -z "$npm_bin" ]; then
    npm_bin="$(command -v npm 2>/dev/null || true)"
  fi
  if [ -z "$npm_bin" ]; then
    echo "error: npm not found on PATH; install Node.js/npm or set NPM_BIN (needed to repair dependencies or build)" >&2
    exit 1
  fi
fi

cd "$PROJ"

if [ "$need_install" -eq 1 ]; then
  log_file="$(mktemp -t review-context-install.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -f '$log_file'" EXIT INT TERM
  run_with_tail "npm install" "$log_file" "$npm_bin" install --ignore-scripts
  rm -f "$log_file"
  trap - EXIT INT TERM
fi

if [ "$need_build" -eq 1 ]; then
  log_file="$(mktemp -t review-context-build.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -f '$log_file'" EXIT INT TERM
  run_with_tail "npm run build" "$log_file" "$npm_bin" run build
  rm -f "$log_file"
  trap - EXIT INT TERM
fi

if [ ! -f "$PROJ/dist/index.js" ]; then
  echo "error: build produced no dist/index.js at $PROJ" >&2
  exit 1
fi

# Hand off to Node; signals/lifecycle now belong to the child.
exec "$node_bin" "$PROJ/dist/index.js"
