# LLM Transform Tools for review-context MCP

**Date**: 2026-04-21
**Status**: Design approved, pending implementation

## Summary

Add four LLM-powered tools to the review-context MCP server that offload structured text transformation work from the code-review orchestrator. Uses `AugmentLanguageModel` from `@augmentcode/auggie-sdk` via the Vercel AI SDK's `generateText` for bounded, single-shot LLM calls. Default model: `sonnet4.5` with per-call override.

## Motivation

The code-review orchestrator (Claude Code) currently handles all text transformation inline: deriving search queries from user requests, summarizing external documentation, extracting normalized plan deltas, and building persona digests. These are deterministic-shaped tasks (structured input, structured output) that consume orchestrator context window and add manual complexity to the workflow. Pushing them server-side reduces orchestrator token usage, simplifies the command file, and makes each transform independently testable and cacheable.

## Architecture

### New files

```
src/
  llm-client.ts        (new — shared LLM wrapper)
  context-manager.ts   (existing, unchanged)
  index.ts             (existing, new tool registrations added)
```

### Dependency additions

- `ai` (Vercel AI SDK) — provides `generateText` for `AugmentLanguageModel`

No other new dependencies. `@augmentcode/auggie-sdk` already exports `AugmentLanguageModel` and `resolveAugmentCredentials`.

## LlmClient — shared infrastructure

A thin wrapper around `AugmentLanguageModel` + `generateText`.

### Construction
- Lazy initialization — credentials resolved on first `generate()` call via `resolveAugmentCredentials()`
- Reuses `AUGMENT_API_TOKEN` / `AUGMENT_API_URL` env vars already passed to the MCP server
- Server starts normally if credentials are missing; LLM tools return clear errors, non-LLM tools are unaffected

### Interface

```typescript
interface LlmGenerateOptions {
  model?: string;        // override default model
  maxTokens?: number;    // max output tokens
  temperature?: number;  // sampling temperature
}

class LlmClient {
  constructor(defaultModel?: string, debug?: boolean);
  async generate(
    systemPrompt: string,
    userContent: string,
    options?: LlmGenerateOptions,
  ): Promise<string>;
}
```

### Configuration (env vars)

| Env var | Default | Purpose |
|---------|---------|---------|
| `AUGMENT_API_TOKEN` | (required for LLM) | API authentication |
| `AUGMENT_API_URL` | (required for LLM) | API endpoint |
| `REVIEW_LLM_DEFAULT_MODEL` | `sonnet4.5` | Default model for all LLM tools |
| `REVIEW_LLM_TIMEOUT_MS` | `30000` | Per-call timeout in ms |
| `REVIEW_LLM_DEBUG` | `false` | Log prompts/responses to stderr |

## Tool designs

All four tools follow the same pattern: validate input, build system prompt from template, call `LlmClient.generate()`, return result. Each uses the existing `toErrorMessage` error pattern.

### Tool 1: `review_normalize_plans`

**Purpose**: Takes raw Phase 2 plan outputs and produces the Normalized Plan Delta Packet for Phase 3 debate.

**Input schema**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `plans` | `{ agent_name: string, plan_text: string }[]` | yes | | Array of 4 plan outputs |
| `target_tokens_per_plan` | `number` | no | `200` | Compact target per delta |
| `model` | `string` | no | server default | Model override |

**System prompt template**:
> Extract a compact delta from each implementation plan. For each plan, preserve: Problem, Solution, Key files/symbols, Implementation steps, Risks/trade-offs, Priority. Keep specific filenames, function names, symbols, and constraint language verbatim. Target ~{target_tokens_per_plan} tokens per plan. Return as a JSON array of `{ "agent_name": "...", "delta": "..." }` objects.

**Output**: JSON string — array of `{ agent_name, delta }`.

**Timeout**: 60s (processes 4 plans).

### Tool 2: `review_derive_queries`

**Purpose**: Turn a user's code review request into focused retrieval queries.

**Input schema**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `user_request` | `string` | yes | | Verbatim user request |
| `file_paths` | `string[]` | no | `[]` | Known relevant files |
| `query_count` | `number` | no | `4` | Number of queries to generate |
| `model` | `string` | no | server default | Model override |

**System prompt template**:
> Given a code review request and optional file paths, generate {query_count} focused search queries. Produce a mix of: semantic queries for codebase search (5-10 word descriptive phrases), and citation-style queries for known patterns (using section-sign shorthand like "CC-Py §Functions"). Return as a JSON array of `{ "query": "...", "type": "semantic"|"citation", "rationale": "..." }` objects.

**Output**: JSON string — array of query objects.

### Tool 3: `review_summarize_context`

**Purpose**: General-purpose text summarization with a character budget.

**Input schema**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | `string` | yes | | Content to summarize |
| `target_chars` | `number` | yes | | Character budget for output |
| `context_label` | `string` | no | `"content"` | What this text represents |
| `preserve_keywords` | `string[]` | no | `[]` | Terms that must survive summarization |
| `model` | `string` | no | server default | Model override |

**System prompt template**:
> Summarize the following {context_label} to fit within ~{target_chars} characters. Preserve technical specificity: keep file paths, function names, API endpoints, and version numbers intact. {If preserve_keywords: "These terms must appear in the summary: {keywords}."} Output the summary directly with no wrapper or preamble.

**Output**: Plain text string.

### Tool 4: `review_build_persona_digests`

**Purpose**: Extract compact persona digests from full persona files for Phase 3 debate.

**Input schema**:
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `personas` | `{ agent_name: string, persona_text: string }[]` | yes | | Array of persona definitions |
| `sections_to_keep` | `string[]` | no | `["Review Focus", "Engineering Lens", "What You Praise", "What You Critique", "Tone"]` | Sections to extract |
| `model` | `string` | no | server default | Model override |

**System prompt template**:
> Extract a compact digest from each persona definition. Keep only these sections: {sections_to_keep}. Preserve the voice and perspective of each persona. Return as a JSON array of `{ "agent_name": "...", "digest": "..." }` objects.

**Output**: JSON string — array of digest objects.

## Orchestrator integration

### Phase 1 changes (Context Gathering)

Current: orchestrator manually formulates 2-3 search queries from user request.
New:
1. Call `review_derive_queries` with verbatim user request + known file paths
2. Use returned queries to drive `mcp__codebase-retrieval`, `mcp__code-inference-query`, Tavily/Context7
3. Call `review_summarize_context` on external doc results and cross-repo patterns before embedding in board bundle

### Phase 3 prep changes (Debate)

Current: orchestrator reads 4 full plans and manually extracts delta packets and persona digests.
New:
1. Call `review_normalize_plans` with 4 raw plan outputs
2. Call `review_build_persona_digests` with 4 persona texts
3. Embed returned deltas + digests directly into debate prompts

### Unchanged

- Phase 2 (Independent Planning) — sub-agent calls, no change
- Phase 4 (Synthesis) — sub-agent call, no change

## Error handling

- **Missing credentials**: LLM tools return `isError: true` with message `"LLM unavailable: Augment credentials not configured. Non-LLM tools remain functional."` Server does not crash.
- **LLM call failure** (network, rate limit, model error): Tool returns `isError: true` with error detail. Orchestrator falls back to its current manual approach for that step.
- **Timeout**: Default 30s per call (60s for `review_normalize_plans`). Configurable via `REVIEW_LLM_TIMEOUT_MS`.
- **Invalid JSON output from LLM**: Tools that expect JSON output attempt `JSON.parse` on the result. If parsing fails, return the raw text with a warning prefix so the orchestrator can still use it or retry.

## Testing

### Unit tests (`test/llm-client.test.js`)
- Mock `generateText` import to verify: prompt construction, model selection, timeout handling, error propagation, credential resolution fallback

### Tool tests (`test/llm-tools.test.js`)
- Mock `LlmClient` to verify per-tool: schema validation, prompt template interpolation, output parsing, JSON parse error handling

### Integration (manual, not in `npm test`)
- Smoke test script calling each tool with real Augment API credentials
- Verifies end-to-end: credential resolution, model availability, output quality

## Future considerations

- **Caching**: LLM tool outputs could be cached by input hash (same pattern as `resultCache`). Not in v1 — validate the tools work first.
- **Streaming**: `AugmentLanguageModel` supports `doStream`. Not needed for these bounded transforms, but available if latency becomes an issue.
- **Additional operations**: The pattern is extensible — new tools follow the same `LlmClient.generate()` + system prompt template pattern.
