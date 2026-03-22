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

## Benefits vs. `codebase-retrieval` Alone

### Token and Credit Savings

| Scenario | `codebase-retrieval` | `review-context` | Improvement |
|----------|---------------------|-------------------|-------------|
| Phase 1 context gathering (2-3 queries) | 2-3 Augment API calls (~20K chars each) | Same on first run | Baseline |
| Phase 3 debate (repeat queries) | 2-3 more API calls if re-queried | `[CACHED]` — instant, 0 API cost | ~40-70 credits saved per query |
| Follow-up review (same codebase) | Full re-index + re-query | `resume_session` — skip indexing, restore cache | ~80% faster, ~120-210 credits saved |
| Debate phase result size | No control — default size | `max_output_length: 10000` for focused queries | ~30-50% fewer tokens in debate prompts |
| MCP overhead | N/A | ~50-100 tokens per tool call (~1-1.5K total) | Small fixed cost |

**Net result**: Marginally positive on a single review (cache hits + output control), significantly positive on iterative reviews (session resume is the main win).

### Workflow Improvements

1. **Iterative review cycles** — Review, fix, re-review without re-gathering context. Session resume restores the index and all cached search results instantly.

2. **Selective indexing** — On large repos, `codebase-retrieval` indexes everything and returns noisy results from unrelated files. `review_index_files` indexes only the files under review, producing higher-relevance results.

3. **Output size tuning** — The orchestrator can request 20K chars for initial context gathering but 10K for debate rounds where agents already have the code in their plans. This reduces the 7x context duplication problem across the 4-phase workflow.

4. **Augment credit efficiency** — Each cached query saves 40-70 Augment credits. A full 4-phase review with 2-3 repeated queries across phases saves ~120-210 credits. On a team with pooled credits, this compounds.

5. **Session continuity** — Saved sessions persist across Claude Code restarts. Start a review in one session, come back later, resume where you left off.

### What This Does NOT Do

- Does not extend the effective context window — Augment's retrieval returns the same semantic chunks regardless of which MCP wraps it.
- Does not replace `codebase-retrieval` for general-purpose queries — this is purpose-built for the multi-phase `/code-review` workflow.
- Does not reduce first-run latency — initial indexing and first queries take the same time as `codebase-retrieval`.
