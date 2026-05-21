# DietCode Multi-Agent Code Review Setup Guide

This guide explains how to set up the multi-agent code review system on a new machine with DietCode installed in VS Code.

## Architecture Overview

The code review system has these components:

| Component | Purpose | Location |
|-----------|---------|----------|
| **DietCode skill** | Orchestrates the 4-phase review workflow | `~/.agents/skills/code-review/SKILL.md` |
| **review-context-mcp** | Augment-powered semantic search & board bundles | iCloud Drive: `review-context-mcp/` |
| **code-inference-query** | Vector search over coding standards corpus | iCloud Drive: `code-inference-query/` |
| **code-inference corpus** | Markdown reference materials (books, standards) | iCloud Drive: `code-inference/` |
| **Code review infrastructure** | Personas, templates, coding-standards | `~/.claude/code-review/` |
| **context7 MCP** | External library documentation (npm package) | Installed on demand via npx |

## Prerequisites

- **VS Code** with [DietCode extension](https://marketplace.visualstudio.com/items?itemName=dreambeesai.dietcode) installed
- **Node.js** ≥ 18 (for review-context-mcp and context7)
- **Python** ≥ 3.11 (for code-inference-query)
- **Augment Code** account with API token (for semantic search)
- **iCloud Drive** synced (or manually clone the repos — see Alternative Setup below)

## Step 1: Verify iCloud Sync

The MCP servers and corpus data live in iCloud Drive. Verify they're synced:

```bash
# These directories should exist and contain files:
ls ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/review-context-mcp/
ls ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/code-inference-query/
ls ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/code-inference/
```

If they show as stubs (0-byte files), right-click in Finder → "Download Now" to force sync.

## Step 2: Install review-context-mcp Dependencies

The `start.sh` launcher auto-installs on first run, but you can pre-install:

```bash
cd ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/review-context-mcp
npm install --ignore-scripts
npm run build
```

Verify it starts:
```bash
echo '{}' | timeout 3 ./start.sh 2>&1 || true
# Should see no errors (it will hang waiting for MCP stdin — that's normal)
```

## Step 3: Install code-inference-query

```bash
cd ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/code-inference-query
pip install --user -e .
# Or if using pipx/uv:
# pipx install -e .
# uv pip install -e .
```

Verify the binary is accessible:
```bash
which code-inference-query
# Should print: ~/.local/bin/code-inference-query (or similar)
```

If it's not in `~/.local/bin/`, update the path in Step 5.

## Step 4: Set Up Code Review Infrastructure

The personas, templates, and coding standards must be at `~/.claude/code-review/`:

```bash
# Option A: Symlink from iCloud (if you have the multi_agent repo synced)
mkdir -p ~/.claude
ln -sf ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/multi_agent/code-review ~/.claude/code-review

# Option B: Copy manually
mkdir -p ~/.claude/code-review/{personas,templates}
# Then copy the following files into the right directories:
#   personas/claude.md, personas/implementer.md, personas/augment.md, personas/researcher.md
#   templates/plan.md, templates/debate.md, templates/synthesis.md
#   coding-standards.md
```

The code-inference corpus symlink:
```bash
ln -sf ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/code-inference ~/.claude/code-review/code-inference
```

### Required Infrastructure Files

| File | Purpose |
|------|---------|
| `personas/claude.md` | Senior architect persona |
| `personas/implementer.md` | Implementation-focused persona |
| `personas/augment.md` | Augment-aware persona |
| `personas/researcher.md` | Research & external docs persona |
| `templates/plan.md` | Phase 2 planning template |
| `templates/debate.md` | Phase 3 debate template |
| `templates/synthesis.md` | Phase 4 synthesis template |
| `coding-standards.md` | Full coding standards reference |

## Step 5: Install the DietCode Skill

The skill file lives at `~/.agents/skills/code-review/SKILL.md`:

```bash
mkdir -p ~/.agents/skills/code-review
```

Copy the SKILL.md from this repo:
```bash
cp ~/.agents/skills/code-review/SKILL.md ~/.agents/skills/code-review/SKILL.md
# Or if setting up fresh from the multi_agent repo:
# cp ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/multi_agent/commands/code-review.md /tmp/ref.md
# Then adapt it to SKILL.md format (see the existing SKILL.md for the frontmatter format)
```

The skill is automatically discovered by DietCode when it's in `~/.agents/skills/`.

## Step 6: Configure MCP Servers

### Option A: Workspace-level (per-project)

Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "review-context": {
      "type": "stdio",
      "command": "/bin/sh",
      "args": [
        "-c",
        "exec \"$HOME/Library/Mobile Documents/com~apple~CloudDocs/review-context-mcp/start.sh\""
      ],
      "env": {
        "AUGMENT_API_TOKEN": "YOUR_AUGMENT_TOKEN_HERE"
      }
    },
    "code-inference-query": {
      "type": "stdio",
      "command": "/bin/sh",
      "args": [
        "-c",
        "export CODE_INFERENCE_CORPUS_PATH=\"$HOME/Library/Mobile Documents/com~apple~CloudDocs/code-inference\" && export CODE_INFERENCE_CACHE_PATH=\"${CODE_INFERENCE_CACHE_PATH:-$HOME/.cache/code-inference-query/lance}\" && exec \"$HOME/.local/bin/code-inference-query\""
      ]
    },
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "env": {
        "DEFAULT_MINIMUM_TOKENS": "6000"
      }
    }
  }
}
```

### Option B: User-level (all projects)

Add the same server definitions to your VS Code user settings. Open **Settings (JSON)** and add:

```json
{
  "dietcode.mcpServers": {
    "review-context": { ... },
    "code-inference-query": { ... },
    "context7": { ... }
  }
}
```

(Use the same server objects as Option A.)

## Step 7: Get Your Augment API Token

1. Sign up at [augmentcode.com](https://augmentcode.com) if you haven't already
2. The token is stored in `~/.augment/session.json` after authentication:
   ```bash
   cat ~/.augment/session.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('token','NOT FOUND'))"
   ```
3. Place this token in the `AUGMENT_API_TOKEN` env var in your MCP config

> **Note**: The review-context-mcp `start.sh` uses the Augment SDK which can also authenticate via `~/.augment/session.json` automatically for indexing and search. The `AUGMENT_API_TOKEN` env var is only needed for the `review_search_and_ask` tool.

## Step 8: Verify the Setup

Open VS Code in any project and test:

1. **Skill discovery**: The code-review skill should appear in DietCode's skill list when you ask to "review code" or "plan an implementation"
2. **MCP tools**: In DietCode's chat, the MCP tools should be available:
   - `mcp__review-context__review_status`
   - `mcp__review-context__review_list_sessions`
   - `mcp__code-inference-query__query`
   - `mcp__context7__resolve-library-id`
3. **End-to-end test**: Ask DietCode to review a file in your project

## Troubleshooting

### "No index" errors from review-context

The review-context-mcp needs to index files before searching. The skill handles this automatically, but if you see this error, ensure:
- The Augment SDK can authenticate (check `~/.augment/session.json`)
- The workspace path is absolute (no `~` in paths)

### code-inference-query not found

Ensure the binary is installed and in PATH:
```bash
pip install --user -e ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/code-inference-query
echo $PATH | tr ':' '\n' | grep local
```

### context7 fails to start

Requires Node.js and npx. Verify:
```bash
npx -y @upstash/context7-mcp@latest --help 2>&1 | head -5
```

### MCP payload too large

If you see payload size errors, ensure you're running the latest review-context-mcp (with the 60KB transport budget fix). Rebuild:
```bash
cd ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/review-context-mcp
npm run build
```

### iCloud files not syncing

Force download in Finder: right-click the folder → "Download Now". Or use:
```bash
brctl download ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/review-context-mcp
```

## Alternative Setup (Without iCloud)

If you're not using iCloud Drive, clone the repos to a local path and update the MCP config paths:

```bash
# Clone repos to a local directory
mkdir -p ~/code-review-tools
git clone <review-context-mcp-repo-url> ~/code-review-tools/review-context-mcp
git clone <code-inference-query-repo-url> ~/code-review-tools/code-inference-query

# Install
cd ~/code-review-tools/review-context-mcp && npm install && npm run build
cd ~/code-review-tools/code-inference-query && pip install --user -e .

# Update paths in .vscode/mcp.json to use ~/code-review-tools/ instead of iCloud path
```

Update the `start.sh` PROJ variable or create a wrapper script that sets the correct path.

## File Tree Summary

```
~/.agents/
  skills/
    code-review/
      SKILL.md                          ← DietCode skill (this orchestrates everything)

~/.claude/
  code-review/
    personas/
      claude.md, implementer.md, augment.md, researcher.md
    templates/
      plan.md, debate.md, synthesis.md
    coding-standards.md
    code-inference → ~/Library/.../code-inference  (symlink)

~/Library/Mobile Documents/com~apple~CloudDocs/
  review-context-mcp/                   ← Augment-powered MCP server
    start.sh                            ← Auto-install launcher
    src/index.ts, src/context-manager.ts
    .vscode/mcp.json                    ← MCP config for this workspace
  code-inference-query/                 ← Vector search MCP server (Python)
  code-inference/                       ← Corpus data (markdown reference materials)

<your-project>/
  .vscode/mcp.json                      ← Per-project MCP config (copy from template)
```
