# review-context-mcp

Session-aware MCP server wrapping Augment's Context Engine SDK for multi-phase
code review workflows. Designed to be relocatable (works from any clone or
iCloud-synced path), self-healing (auto-installs and rebuilds on first launch
after a source change), and safe to register with the Claude Code
(`claude`), Augment CLI (`auggie`), or Hermes Agent (`hermes`) harnesses.

## Prerequisites

- **Node.js >= 20** and **npm**. Set `NODE_BIN` / `NPM_BIN` to override PATH
  resolution.
- POSIX `/bin/sh` for `start.sh`; Bash for the setup/registration scripts.
- macOS or Linux. The scripts refuse to run on other platforms.

## Install

On each machine (first time only):

```bash
cd <repo-root>
make install
```

`make install` verifies Node >=20, runs `npm install` + `npm run build`, and
marks `start.sh` and `dist/index.js` executable. Nothing to hand-edit —
`start.sh` resolves its own directory at runtime so the same clone works on
every machine.

## Register with Claude Code

```bash
make mcp-add            # defaults to MCP_SCOPE=user
MCP_SCOPE=project make mcp-add
make mcp-remove         # uses the same scope
make mcp-list           # runs `claude mcp list`
```

`AUGMENT_API_TOKEN`, `AUGMENT_API_URL`, and `REVIEW_CONTEXT_DEBUG` are
forwarded via `-e` when set in your shell. Only `review_search_and_ask`
requires them; the indexing and semantic-search tools authenticate via
`~/.augment/session.json` (created by `auggie login`).

If the `claude` CLI is unavailable, `examples/claude-mcp.json` is a copyable
template — replace `<repo-root>` and drop it into
`~/.claude/settings.json`'s `mcpServers` block.

## Register with the Augment CLI

```bash
make auggie-add         # defaults to AUGGIE_SCOPE=user
AUGGIE_SCOPE=project make auggie-add
make auggie-remove
make auggie-list
```

`AUGGIE_SCOPE=user|project|local` maps to no flag / `--project` / `--local`.
`--replace` is always passed so re-registering is non-interactive.

## Register with Hermes Agent

```bash
make hermes-add
make hermes-remove
```

Hermes has no `mcp add` CLI, so `scripts/hermes_add.sh` edits
`~/.hermes/config.yaml` (override with `HERMES_CONFIG`) under `mcp_servers`
via `scripts/hermes_add.py` — backed up, written atomically, verified after
the write, and idempotent. It exits cleanly (status 0) when Hermes is not
installed, so it is safe in shared setup pipelines.

Hermes starts stdio servers with a filtered environment (`PATH`, `HOME`,
`USER`, `LANG`, `TERM`, `SHELL`, `TMPDIR`, `XDG_*` only), which hides
version-manager Node installs (nvm/fnm/volta) from `start.sh`. The script
therefore pins the resolved interpreter as `NODE_BIN` in the entry's `env`;
override with `NODE_BIN=/path/to/node make hermes-add`. `AUGMENT_API_TOKEN`,
`AUGMENT_API_URL`, and `REVIEW_CONTEXT_DEBUG` are forwarded when set, with
secret values redacted from all user-facing output. Restart Hermes Agent to
pick up the change (no hot-reload).

## Register with VS Code / Cursor / DietCode

Copy `.vscode/mcp.example.json` to `.vscode/mcp.json` in the workspace and
replace `<repo-root>` with the checkout path. The local file is gitignored.

## Relocatability and self-healing

- `start.sh` resolves its own directory via
  `PROJ="$(cd "$(dirname "$0")" && pwd)"`, so moving or copying the checkout
  does not require any path edit.
- If `node_modules` or `dist/index.js` are missing (fresh checkout, iCloud
  sync from another machine), the launcher installs and/or rebuilds on the
  first invocation. Diagnostics go to stderr; healthy startup is silent on
  stdout.
- When `npm install` or `npm run build` fails, the launcher prints the last
  `REVIEW_CONTEXT_ERROR_TAIL_LINES` lines (default 120) of the failing
  command to stderr so MCP clients that render stderr inline can surface
  the error.
- A source-less deployment (built `dist/` without `src/`) is supported for
  distribution scenarios.

## Verify

```bash
make test-focused          # launcher + MCP stdio + registration tests
make smoke                 # relocated fixture + source-less dist fixture
make test                  # full suite (includes the two above plus context-manager)
```

Then, in your MCP client:

- **Claude Code**: `/mcp` to list servers; `/restart-mcp` after config
  changes; then call `review_status` — it should print `Active: false`
  until you index files.
- **Augment CLI**: `auggie mcp list` for a static view; interactive
  sessions expose the tools in their command palette.
- **Hermes Agent**: restart Hermes, then check that `mcp_review_context_*`
  tools appear (e.g. ask the agent to call `review_status`).

For end-to-end stderr diagnostics: `REVIEW_CONTEXT_DEBUG=true ./start.sh`.
A stdio server that waits with open stdin is healthy.

## Tool inventory

| Tool | Purpose |
|------|---------|
| `review_index_files` | Index specific files into Augment's index |
| `review_index_directory` | Index a whole directory (reports unreadable/oversized files) |
| `review_search` | Semantic search with result caching |
| `review_search_structured` | Structured search returning chunk IDs + line ranges |
| `review_search_and_ask` | Search + Augment LLM reasoning (needs `AUGMENT_API_TOKEN`/`AUGMENT_API_URL`) |
| `review_prepare_board_context` | Build a reusable review-board context bundle |
| `review_save_session` / `review_resume_session` | Persist and restore index + cache |
| `review_list_sessions` / `review_delete_session` | Manage saved sessions |
| `review_status` / `review_list_cache` / `review_clear` | Inspect and reset the live index and caches (blackboard artifacts are disk-backed and survive `review_clear`; use `review_clear_artifacts` / `review_delete_session` to drop them) |
| `review_store_artifact` / `review_read_artifact` / `review_clear_artifacts` | Persist/read/clear phase artifacts |
| `review_normalize_plans` / `review_derive_queries` / `review_summarize_context` / `review_build_persona_digests` | LLM-transform helpers (`review_normalize_plans` accepts `preserve_fields` to normalize non-code documents, e.g. editorial reviews) |
| `review_save_research` / `review_find_research` | Persist and look up research notes |

If this table changes, also update `test/mcp-stdio.test.js`'s
`EXPECTED_TOOLS` list and `CLAUDE.md`.

## Troubleshooting

- **Server exits immediately** — run `REVIEW_CONTEXT_DEBUG=true ./start.sh`
  from a shell that keeps stdin open (e.g. pipe from `sleep 30`). Any
  `error:` line comes from the launcher; anything else is Node.
- **`node not found`** or **`Node.js >=20 required`** — install a supported
  Node or set `NODE_BIN`/`NPM_BIN` to the correct binaries.
- **First run is slow** — the launcher is running `npm install`/`npm run
  build`. Subsequent runs skip repair unless source is newer than `dist`.
- **Existing entry conflicts** — if `review-context` was previously wired
  into `~/.claude/settings.json` by hand, remove it before running `make
  mcp-add`; the CLI registers into `~/.claude.json` and duplicates
  collide.

## Repository layout

```
<repo-root>/
  start.sh                        # POSIX launcher
  Makefile                        # install / test / (auggie|mcp)-{add,remove,list}
  scripts/
    install_local.sh              # bootstrap Node/npm and build
    mcp_add.sh / mcp_remove.sh    # Claude Code registration
    auggie_add.sh / auggie_remove.sh  # Augment CLI registration
    hermes_add.sh / hermes_add.py # Hermes Agent registration (config.yaml splice)
    lib.sh                        # shared helpers (scope, redaction)
  src/                            # TypeScript sources
  dist/                           # generated by `npm run build` (gitignored)
  test/                           # node --test suites
  examples/claude-mcp.json        # manual Claude config template
  .vscode/mcp.example.json        # manual VS Code MCP config template
```

See `CLAUDE.md` for architecture and design decisions, and
`docs/DIETCODE-SETUP.md` for DietCode-specific integration.
