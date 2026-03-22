# review-context-mcp

Session-aware MCP server wrapping Augment's Context Engine SDK for multi-phase code review workflows.

## Setup

### 1. Install and build

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/review-context-mcp
npm install
npm run build
```

### 2. Add to Claude Code

Add this to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "review-context": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/amoscoletti/Library/Mobile Documents/com~apple~CloudDocs/review-context-mcp/dist/index.js"
      ],
      "env": {}
    }
  }
}
```

Authentication falls back to `~/.augment/session.json` automatically (created by `auggie login`). No extra env vars needed.

To enable debug logging, add `"REVIEW_CONTEXT_DEBUG": "true"` to the `env` block.

### 3. Verify

Restart Claude Code, then run: `review_status` — should show `Active: false`.

## Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `review_index_files` | Index specific files | Start of code review — index only files relevant to the change |
| `review_index_directory` | Index a whole directory | When the review scope is broad |
| `review_search` | Semantic search with caching | Phase 1 context gathering — results are cached for reuse |
| `review_search_and_ask` | Search + Augment LLM reasoning | Quick architectural questions during review |
| `review_save_session` | Persist index + cache to disk | After Phase 1, so follow-up reviews skip re-indexing |
| `review_resume_session` | Restore a saved session | When re-running a review on the same codebase |
| `review_list_sessions` | List saved sessions | Before resuming to find the right session ID |
| `review_delete_session` | Delete a session | Cleanup old sessions |
| `review_status` | Show current state | Debug / verify setup |
| `review_list_cache` | List cached search results | See what's been queried in the current session |
| `review_clear` | Reset index and cache | Start fresh |

## Architecture

```
Claude Code ──stdio──▶ review-context-mcp
                           │
                           ├─ ContextManager (in-process)
                           │   ├─ DirectContext (Augment SDK)
                           │   │   ├─ addToIndex() → Augment backend
                           │   │   ├─ search() → Augment backend
                           │   │   └─ exportToFile() / importFromFile()
                           │   └─ Result cache (Map, persisted to JSON)
                           │
                           └─ Session storage: ~/.claude/review-cache/
                               ├─ {id}.state.json  (Augment index state)
                               ├─ {id}.meta.json   (session metadata)
                               └─ {id}.cache.json  (cached search results)
```

## Key Design Decisions

- **Selective indexing**: Unlike `codebase-retrieval` which indexes the whole workspace, this server lets you index only the files relevant to a review. Smaller index = more relevant results = fewer tokens.
- **Result caching**: Search results are cached in-memory by query+maxOutputLength hash. Identical queries across phases return instantly from cache.
- **Session persistence**: `exportToFile`/`importFromFile` persists the Augment index state — resuming a session does not re-upload files to the backend.
- **Output size control**: `max_output_length` parameter (1K–80K chars) lets the orchestrator tune result size per phase — smaller for debate rounds, larger for initial context gathering.
