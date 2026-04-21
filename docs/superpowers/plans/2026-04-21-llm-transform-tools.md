# LLM Transform Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four LLM-powered MCP tools to the review-context server that offload text transformation from the code-review orchestrator, using `AugmentLanguageModel` from `@augmentcode/auggie-sdk`.

**Architecture:** New `src/llm-client.ts` wraps `AugmentLanguageModel` + Vercel AI SDK `generateText` in a lazy-init singleton. Four new tools registered in `src/index.ts` follow the existing tool pattern (zod schema, async handler, `toErrorMessage` errors). Tests mock the `LlmClient` to avoid live API calls.

**Tech Stack:** TypeScript, `@augmentcode/auggie-sdk` (existing), `ai` (Vercel AI SDK, new dep), `zod` (existing), `node:test` (existing test runner)

**Spec:** `docs/superpowers/specs/2026-04-21-llm-transform-tools-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add `ai` dependency |
| `src/llm-client.ts` | Create | Shared LLM wrapper: credential resolution, `generateText` calls, timeout, model selection |
| `src/index.ts` | Modify (lines 1-10, 614-628) | Import `LlmClient`, register 4 new tools after existing tools |
| `test/llm-client.test.js` | Create | Unit tests for `LlmClient` |
| `test/llm-tools.test.js` | Create | Unit tests for the 4 tool handlers |

---

### Task 1: Add `ai` dependency and verify build

**Files:**
- Modify: `package.json:19` (dependencies block)

- [ ] **Step 1: Install the Vercel AI SDK**

```bash
cd ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/review-context-mcp
npm install ai
```

- [ ] **Step 2: Verify the build still compiles**

```bash
npm run build
```

Expected: Exit 0, no errors.

- [ ] **Step 3: Verify existing tests still pass**

```bash
npm test
```

Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add Vercel AI SDK for LLM transform tools"
```

---

### Task 2: Create `LlmClient` with failing test

**Files:**
- Create: `src/llm-client.ts`
- Create: `test/llm-client.test.js`

- [ ] **Step 1: Write the failing test for LlmClient.generate()**

Create `test/llm-client.test.js`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";

test("LlmClient is importable and constructible", async () => {
  const { LlmClient } = await import("../dist/llm-client.js");
  const client = new LlmClient("sonnet4.5", false);
  assert.ok(client);
});

test("LlmClient.generate() calls generateText with correct model and prompts", async (t) => {
  const { LlmClient } = await import("../dist/llm-client.js");
  const client = new LlmClient("sonnet4.5", false);

  // Mock the internal _generateText to capture what would be sent
  let capturedArgs = null;
  client._generateText = async (args) => {
    capturedArgs = args;
    return { text: "mock response" };
  };
  // Mark as initialized so it skips credential resolution
  client._initialized = true;

  const result = await client.generate(
    "You are a helpful assistant.",
    "Summarize this text.",
    { maxTokens: 500 },
  );

  assert.equal(result, "mock response");
  assert.ok(capturedArgs);
  assert.equal(capturedArgs.maxTokens, 500);
  // System prompt and user content should be in the messages
  const messages = capturedArgs.messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, "You are a helpful assistant.");
  assert.equal(messages[1].role, "user");
  assert.equal(messages[1].content, "Summarize this text.");
});

test("LlmClient.generate() uses per-call model override", async (t) => {
  const { LlmClient } = await import("../dist/llm-client.js");
  const client = new LlmClient("sonnet4.5", false);

  let capturedModel = null;
  client._generateText = async (args) => {
    capturedModel = args.model?.modelId;
    return { text: "ok" };
  };
  client._initialized = true;

  await client.generate("sys", "usr", { model: "haiku4.5" });
  assert.equal(capturedModel, "haiku4.5");
});

test("LlmClient.generate() throws on missing credentials when not initialized", async () => {
  const { LlmClient } = await import("../dist/llm-client.js");
  const client = new LlmClient("sonnet4.5", false);

  // Force credential resolution to fail
  client._resolveCredentials = async () => {
    throw new Error("No credentials found");
  };

  await assert.rejects(
    () => client.generate("sys", "usr"),
    { message: /credentials/i },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build && node --test test/llm-client.test.js
```

Expected: FAIL — `../dist/llm-client.js` does not exist.

- [ ] **Step 3: Write the LlmClient implementation**

Create `src/llm-client.ts`:

```typescript
import { generateText } from "ai";
import {
  AugmentLanguageModel,
  resolveAugmentCredentials,
} from "@augmentcode/auggie-sdk";

export interface LlmGenerateOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.REVIEW_LLM_TIMEOUT_MS ?? "30000",
  10,
);

export class LlmClient {
  private defaultModel: string;
  private debug: boolean;

  // Exposed for test mocking — not part of the public API.
  _initialized = false;
  _apiKey: string | null = null;
  _apiUrl: string | null = null;

  constructor(defaultModel?: string, debug?: boolean) {
    this.defaultModel =
      process.env.REVIEW_LLM_DEFAULT_MODEL ?? defaultModel ?? "sonnet4.5";
    this.debug = debug ?? process.env.REVIEW_LLM_DEBUG === "true";
  }

  private log(msg: string): void {
    if (this.debug) {
      process.stderr.write(`[review-llm] ${msg}\n`);
    }
  }

  /** Override point for tests — replace to skip real credential resolution. */
  async _resolveCredentials(): Promise<{ apiKey: string; apiUrl: string }> {
    // Prefer env vars (already set in start.sh), fall back to SDK resolution
    if (process.env.AUGMENT_API_TOKEN && process.env.AUGMENT_API_URL) {
      return {
        apiKey: process.env.AUGMENT_API_TOKEN,
        apiUrl: process.env.AUGMENT_API_URL,
      };
    }
    const creds = await resolveAugmentCredentials();
    return { apiKey: creds.apiKey, apiUrl: creds.apiUrl };
  }

  private async ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    const { apiKey, apiUrl } = await this._resolveCredentials();
    this._apiKey = apiKey;
    this._apiUrl = apiUrl;
    this._initialized = true;
    this.log("LLM client initialized");
  }

  private buildModel(modelId: string): AugmentLanguageModel {
    return new AugmentLanguageModel(modelId, {
      apiKey: this._apiKey!,
      apiUrl: this._apiUrl!,
      debug: this.debug,
    });
  }

  /** Override point for tests — replace to capture/mock generateText calls. */
  async _generateText(args: {
    model: AugmentLanguageModel;
    messages: Array<{ role: "system" | "user"; content: string }>;
    maxTokens?: number;
    temperature?: number;
    abortSignal?: AbortSignal;
  }): Promise<{ text: string }> {
    return generateText(args);
  }

  async generate(
    systemPrompt: string,
    userContent: string,
    options?: LlmGenerateOptions,
  ): Promise<string> {
    await this.ensureInitialized();

    const modelId = options?.model ?? this.defaultModel;
    const model = this.buildModel(modelId);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.log(`generate: model=${modelId} timeout=${timeoutMs}ms`);
    if (this.debug) {
      this.log(`system prompt (${systemPrompt.length} chars): ${systemPrompt.slice(0, 120)}...`);
      this.log(`user content (${userContent.length} chars): ${userContent.slice(0, 120)}...`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { text } = await this._generateText({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        abortSignal: controller.signal,
      });

      this.log(`response (${text.length} chars)`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && node --test test/llm-client.test.js
```

Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/llm-client.ts test/llm-client.test.js
git commit -m "feat: add LlmClient wrapper for AugmentLanguageModel"
```

---

### Task 3: Register `review_normalize_plans` tool

**Files:**
- Modify: `src/index.ts:1-10` (add import)
- Modify: `src/index.ts:612-614` (add tool registration before `main()`)
- Create: `test/llm-tools.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/llm-tools.test.js`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";

// Shared mock LlmClient factory
function mockLlmClient(responseText) {
  return {
    _initialized: true,
    async generate(systemPrompt, userContent, options) {
      return responseText;
    },
  };
}

test("review_normalize_plans: builds correct prompt and returns parsed JSON", async () => {
  const { createNormalizePlansHandler } = await import("../dist/llm-tools.js");
  const expectedOutput = [
    { agent_name: "Claude", delta: "## Problem\nTest problem" },
    { agent_name: "Implementer", delta: "## Problem\nImpl problem" },
  ];
  const client = mockLlmClient(JSON.stringify(expectedOutput));
  const handler = createNormalizePlansHandler(client);

  const result = await handler({
    plans: [
      { agent_name: "Claude", plan_text: "Full plan text for Claude..." },
      { agent_name: "Implementer", plan_text: "Full plan text for Implementer..." },
    ],
    target_tokens_per_plan: 200,
  });

  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].agent_name, "Claude");
});

test("review_normalize_plans: returns isError on LLM failure", async () => {
  const { createNormalizePlansHandler } = await import("../dist/llm-tools.js");
  const client = {
    _initialized: true,
    async generate() { throw new Error("API rate limited"); },
  };
  const handler = createNormalizePlansHandler(client);

  const result = await handler({
    plans: [{ agent_name: "Claude", plan_text: "plan" }],
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rate limited/i);
});

test("review_normalize_plans: handles non-JSON LLM response gracefully", async () => {
  const { createNormalizePlansHandler } = await import("../dist/llm-tools.js");
  const client = mockLlmClient("Here is a plain text response without JSON");
  const handler = createNormalizePlansHandler(client);

  const result = await handler({
    plans: [{ agent_name: "Claude", plan_text: "plan" }],
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /plain text response/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build && node --test test/llm-tools.test.js
```

Expected: FAIL — `../dist/llm-tools.js` does not exist.

- [ ] **Step 3: Create `src/llm-tools.ts` with the normalize plans handler**

Create `src/llm-tools.ts`:

```typescript
import type { LlmClient } from "./llm-client.js";

export function toErrorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

function tryParseJson(text: string): string {
  const trimmed = text.trim();

  // Strip markdown code fences if present
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  const jsonCandidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return `[WARNING: LLM returned non-JSON output]\n${trimmed}`;
  }
}

export function createNormalizePlansHandler(llm: LlmClient) {
  return async (args: {
    plans: Array<{ agent_name: string; plan_text: string }>;
    target_tokens_per_plan?: number;
    model?: string;
  }) => {
    try {
      const targetTokens = args.target_tokens_per_plan ?? 200;

      const systemPrompt =
        "Extract a compact delta from each implementation plan. " +
        "For each plan, preserve: Problem, Solution, Key files/symbols, " +
        "Implementation steps, Risks/trade-offs, Priority. " +
        "Keep specific filenames, function names, symbols, and constraint language verbatim. " +
        `Target ~${targetTokens} tokens per plan. ` +
        'Return as a JSON array of { "agent_name": "...", "delta": "..." } objects. ' +
        "Return only the JSON array, no other text.";

      const userContent = args.plans
        .map((p) => `## ${p.agent_name}\n\n${p.plan_text}`)
        .join("\n\n---\n\n");

      const result = await llm.generate(systemPrompt, userContent, {
        model: args.model,
        maxTokens: 2000,
        timeoutMs: 60_000,
      });

      return {
        content: [{ type: "text" as const, text: tryParseJson(result) }],
      };
    } catch (err) {
      return toErrorResult(err);
    }
  };
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && node --test test/llm-tools.test.js
```

Expected: All 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/llm-tools.ts test/llm-tools.test.js
git commit -m "feat: add review_normalize_plans handler with tests"
```

---

### Task 4: Add `review_derive_queries` handler

**Files:**
- Modify: `src/llm-tools.ts` (append handler)
- Modify: `test/llm-tools.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/llm-tools.test.js`:

```javascript
test("review_derive_queries: returns structured query array", async () => {
  const { createDeriveQueriesHandler } = await import("../dist/llm-tools.js");
  const expectedOutput = [
    { query: "factory pattern object creation", type: "semantic", rationale: "Find factory patterns" },
    { query: "CC-Py §Functions", type: "citation", rationale: "Check function standards" },
  ];
  const client = mockLlmClient(JSON.stringify(expectedOutput));
  const handler = createDeriveQueriesHandler(client);

  const result = await handler({
    user_request: "Review the authentication module refactor",
    file_paths: ["src/auth/login.py"],
    query_count: 2,
  });

  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, "semantic");
  assert.equal(parsed[1].type, "citation");
});

test("review_derive_queries: defaults to 4 queries when count omitted", async () => {
  const { createDeriveQueriesHandler } = await import("../dist/llm-tools.js");
  let capturedPrompt = null;
  const client = {
    _initialized: true,
    async generate(sys, usr, opts) {
      capturedPrompt = sys;
      return "[]";
    },
  };
  const handler = createDeriveQueriesHandler(client);

  await handler({ user_request: "Review this code" });
  assert.ok(capturedPrompt);
  assert.match(capturedPrompt, /4/);
});
```

- [ ] **Step 2: Run test to verify new tests fail**

```bash
npm run build && node --test test/llm-tools.test.js
```

Expected: New tests FAIL — `createDeriveQueriesHandler` not exported.

- [ ] **Step 3: Add the derive queries handler to `src/llm-tools.ts`**

Append to `src/llm-tools.ts`:

```typescript
export function createDeriveQueriesHandler(llm: LlmClient) {
  return async (args: {
    user_request: string;
    file_paths?: string[];
    query_count?: number;
    model?: string;
  }) => {
    try {
      const queryCount = args.query_count ?? 4;
      const filePaths = args.file_paths ?? [];

      const systemPrompt =
        `Given a code review request and optional file paths, generate ${queryCount} focused search queries. ` +
        "Produce a mix of: semantic queries for codebase search (5-10 word descriptive phrases), " +
        "and citation-style queries for known patterns (using section-sign shorthand like " +
        '"CC-Py §Functions", "FP2e §Protocols", "Google §2.7"). ' +
        'Return as a JSON array of { "query": "...", "type": "semantic"|"citation", "rationale": "..." } objects. ' +
        "Return only the JSON array, no other text.";

      const fileSection = filePaths.length > 0
        ? `\n\nRelevant files:\n${filePaths.map((f) => `- ${f}`).join("\n")}`
        : "";

      const userContent = `## Code Review Request\n\n${args.user_request}${fileSection}`;

      const result = await llm.generate(systemPrompt, userContent, {
        model: args.model,
        maxTokens: 1000,
      });

      return {
        content: [{ type: "text" as const, text: tryParseJson(result) }],
      };
    } catch (err) {
      return toErrorResult(err);
    }
  };
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && node --test test/llm-tools.test.js
```

Expected: All 5 tests pass (3 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/llm-tools.ts test/llm-tools.test.js
git commit -m "feat: add review_derive_queries handler with tests"
```

---

### Task 5: Add `review_summarize_context` handler

**Files:**
- Modify: `src/llm-tools.ts` (append handler)
- Modify: `test/llm-tools.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/llm-tools.test.js`:

```javascript
test("review_summarize_context: returns plain text summary", async () => {
  const { createSummarizeContextHandler } = await import("../dist/llm-tools.js");
  const client = mockLlmClient("This is a concise summary of the documentation.");
  const handler = createSummarizeContextHandler(client);

  const result = await handler({
    text: "A very long document with many details about the API...",
    target_chars: 500,
    context_label: "external documentation",
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /concise summary/);
});

test("review_summarize_context: includes preserve_keywords in prompt", async () => {
  const { createSummarizeContextHandler } = await import("../dist/llm-tools.js");
  let capturedPrompt = null;
  const client = {
    _initialized: true,
    async generate(sys, usr, opts) {
      capturedPrompt = sys;
      return "summary";
    },
  };
  const handler = createSummarizeContextHandler(client);

  await handler({
    text: "some text",
    target_chars: 200,
    preserve_keywords: ["FastAPI", "Pydantic"],
  });

  assert.ok(capturedPrompt);
  assert.match(capturedPrompt, /FastAPI/);
  assert.match(capturedPrompt, /Pydantic/);
});
```

- [ ] **Step 2: Run test to verify new tests fail**

```bash
npm run build && node --test test/llm-tools.test.js
```

Expected: New tests FAIL — `createSummarizeContextHandler` not exported.

- [ ] **Step 3: Add the summarize context handler to `src/llm-tools.ts`**

Append to `src/llm-tools.ts`:

```typescript
export function createSummarizeContextHandler(llm: LlmClient) {
  return async (args: {
    text: string;
    target_chars: number;
    context_label?: string;
    preserve_keywords?: string[];
    model?: string;
  }) => {
    try {
      const label = args.context_label ?? "content";
      const keywords = args.preserve_keywords ?? [];

      const keywordsClause = keywords.length > 0
        ? ` These terms must appear in the summary: ${keywords.join(", ")}.`
        : "";

      const systemPrompt =
        `Summarize the following ${label} to fit within ~${args.target_chars} characters. ` +
        "Preserve technical specificity: keep file paths, function names, API endpoints, " +
        `and version numbers intact.${keywordsClause} ` +
        "Output the summary directly with no wrapper or preamble.";

      const result = await llm.generate(systemPrompt, args.text, {
        model: args.model,
        maxTokens: Math.ceil(args.target_chars / 3),
      });

      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err) {
      return toErrorResult(err);
    }
  };
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && node --test test/llm-tools.test.js
```

Expected: All 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/llm-tools.ts test/llm-tools.test.js
git commit -m "feat: add review_summarize_context handler with tests"
```

---

### Task 6: Add `review_build_persona_digests` handler

**Files:**
- Modify: `src/llm-tools.ts` (append handler)
- Modify: `test/llm-tools.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/llm-tools.test.js`:

```javascript
test("review_build_persona_digests: returns structured digests", async () => {
  const { createBuildPersonaDigestsHandler } = await import("../dist/llm-tools.js");
  const expectedOutput = [
    { agent_name: "Claude", digest: "## Review Focus\nClean architecture..." },
    { agent_name: "Implementer", digest: "## Review Focus\nRuntime behavior..." },
  ];
  const client = mockLlmClient(JSON.stringify(expectedOutput));
  const handler = createBuildPersonaDigestsHandler(client);

  const result = await handler({
    personas: [
      { agent_name: "Claude", persona_text: "Full Claude persona..." },
      { agent_name: "Implementer", persona_text: "Full Implementer persona..." },
    ],
  });

  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].agent_name, "Claude");
});

test("review_build_persona_digests: uses custom sections_to_keep", async () => {
  const { createBuildPersonaDigestsHandler } = await import("../dist/llm-tools.js");
  let capturedPrompt = null;
  const client = {
    _initialized: true,
    async generate(sys, usr, opts) {
      capturedPrompt = sys;
      return "[]";
    },
  };
  const handler = createBuildPersonaDigestsHandler(client);

  await handler({
    personas: [{ agent_name: "Claude", persona_text: "text" }],
    sections_to_keep: ["Review Focus", "Tone"],
  });

  assert.ok(capturedPrompt);
  assert.match(capturedPrompt, /Review Focus/);
  assert.match(capturedPrompt, /Tone/);
  // Should NOT contain the default "Engineering Lens" since custom sections were provided
  assert.doesNotMatch(capturedPrompt, /Engineering Lens/);
});
```

- [ ] **Step 2: Run test to verify new tests fail**

```bash
npm run build && node --test test/llm-tools.test.js
```

Expected: New tests FAIL — `createBuildPersonaDigestsHandler` not exported.

- [ ] **Step 3: Add the persona digests handler to `src/llm-tools.ts`**

Append to `src/llm-tools.ts`:

```typescript
const DEFAULT_PERSONA_SECTIONS = [
  "Review Focus",
  "Engineering Lens",
  "What You Praise",
  "What You Critique",
  "Tone",
];

export function createBuildPersonaDigestsHandler(llm: LlmClient) {
  return async (args: {
    personas: Array<{ agent_name: string; persona_text: string }>;
    sections_to_keep?: string[];
    model?: string;
  }) => {
    try {
      const sections = args.sections_to_keep ?? DEFAULT_PERSONA_SECTIONS;

      const systemPrompt =
        "Extract a compact digest from each persona definition. " +
        `Keep only these sections: ${sections.join(", ")}. ` +
        "Preserve the voice and perspective of each persona. " +
        'Return as a JSON array of { "agent_name": "...", "digest": "..." } objects. ' +
        "Return only the JSON array, no other text.";

      const userContent = args.personas
        .map((p) => `## ${p.agent_name}\n\n${p.persona_text}`)
        .join("\n\n---\n\n");

      const result = await llm.generate(systemPrompt, userContent, {
        model: args.model,
        maxTokens: 2000,
      });

      return {
        content: [{ type: "text" as const, text: tryParseJson(result) }],
      };
    } catch (err) {
      return toErrorResult(err);
    }
  };
}
```

- [ ] **Step 4: Build and run tests**

```bash
npm run build && node --test test/llm-tools.test.js
```

Expected: All 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/llm-tools.ts test/llm-tools.test.js
git commit -m "feat: add review_build_persona_digests handler with tests"
```

---

### Task 7: Register all 4 tools in `src/index.ts`

**Files:**
- Modify: `src/index.ts:1-10` (add imports)
- Modify: `src/index.ts:612-614` (add tool registrations before `main()`)

- [ ] **Step 1: Add imports to the top of `src/index.ts`**

After line 9 (`import { ContextManager, ... } from "./context-manager.js";`), add:

```typescript
import { LlmClient } from "./llm-client.js";
import {
  createNormalizePlansHandler,
  createDeriveQueriesHandler,
  createSummarizeContextHandler,
  createBuildPersonaDigestsHandler,
} from "./llm-tools.js";
```

After line 12 (`const manager = new ContextManager(debug);`), add:

```typescript
const llmDebug = process.env.REVIEW_LLM_DEBUG === "true" || debug;
const llm = new LlmClient(undefined, llmDebug);
```

- [ ] **Step 2: Register `review_normalize_plans` tool**

Before the `// ─── Start the server` comment (line 615), add:

```typescript
// ─── Tool: review_normalize_plans ───────────────────────────────────────
// LLM-powered: extract compact deltas from Phase 2 plans for debate.

server.tool(
  "review_normalize_plans",
  "Extract compact normalized deltas from implementation plans for the debate phase. " +
    "Uses Augment LLM to preserve Problem, Solution, Key files/symbols, Steps, Risks, Priority. " +
    "Requires AUGMENT_API_TOKEN and AUGMENT_API_URL.",
  {
    plans: z
      .array(
        z.object({
          agent_name: z.string().describe("Name of the agent that produced this plan"),
          plan_text: z.string().describe("Full plan text from Phase 2"),
        }),
      )
      .describe("Array of implementation plans to normalize"),
    target_tokens_per_plan: z
      .number()
      .min(50)
      .max(1000)
      .optional()
      .describe("Target token count per compact delta (default: 200)"),
    model: z
      .string()
      .optional()
      .describe("Model override (default: sonnet4.5)"),
  },
  createNormalizePlansHandler(llm),
);
```

- [ ] **Step 3: Register `review_derive_queries` tool**

```typescript
// ─── Tool: review_derive_queries ────────────────────────────────────────
// LLM-powered: generate focused retrieval queries from a user request.

server.tool(
  "review_derive_queries",
  "Generate focused retrieval queries from a code review request. " +
    "Returns a mix of semantic and citation-style queries for codebase search. " +
    "Requires AUGMENT_API_TOKEN and AUGMENT_API_URL.",
  {
    user_request: z
      .string()
      .describe("The verbatim user code review request"),
    file_paths: z
      .array(z.string())
      .optional()
      .describe("Known relevant file paths for additional context"),
    query_count: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Number of queries to generate (default: 4)"),
    model: z
      .string()
      .optional()
      .describe("Model override (default: sonnet4.5)"),
  },
  createDeriveQueriesHandler(llm),
);
```

- [ ] **Step 4: Register `review_summarize_context` tool**

```typescript
// ─── Tool: review_summarize_context ─────────────────────────────────────
// LLM-powered: summarize text to fit a character budget.

server.tool(
  "review_summarize_context",
  "Summarize text to fit a target character budget while preserving technical specificity. " +
    "Keeps file paths, function names, API endpoints, and version numbers intact. " +
    "Requires AUGMENT_API_TOKEN and AUGMENT_API_URL.",
  {
    text: z
      .string()
      .describe("The content to summarize"),
    target_chars: z
      .number()
      .min(50)
      .max(20000)
      .describe("Character budget for the output"),
    context_label: z
      .string()
      .optional()
      .describe('What this text represents, e.g. "external documentation" (default: "content")'),
    preserve_keywords: z
      .array(z.string())
      .optional()
      .describe("Terms that must appear in the summary"),
    model: z
      .string()
      .optional()
      .describe("Model override (default: sonnet4.5)"),
  },
  createSummarizeContextHandler(llm),
);
```

- [ ] **Step 5: Register `review_build_persona_digests` tool**

```typescript
// ─── Tool: review_build_persona_digests ─────────────────────────────────
// LLM-powered: extract compact digests from persona definitions.

server.tool(
  "review_build_persona_digests",
  "Extract compact persona digests from full persona definitions for the debate phase. " +
    "Preserves voice and perspective while keeping only specified sections. " +
    "Requires AUGMENT_API_TOKEN and AUGMENT_API_URL.",
  {
    personas: z
      .array(
        z.object({
          agent_name: z.string().describe("Name of the agent persona"),
          persona_text: z.string().describe("Full persona definition text"),
        }),
      )
      .describe("Array of persona definitions to digest"),
    sections_to_keep: z
      .array(z.string())
      .optional()
      .describe(
        'Sections to extract (default: ["Review Focus", "Engineering Lens", ' +
          '"What You Praise", "What You Critique", "Tone"])',
      ),
    model: z
      .string()
      .optional()
      .describe("Model override (default: sonnet4.5)"),
  },
  createBuildPersonaDigestsHandler(llm),
);
```

- [ ] **Step 6: Build and run all tests**

```bash
npm run build && npm test
```

Expected: All existing tests + all new tests pass. No TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: register 4 LLM transform tools in MCP server"
```

---

### Task 8: End-to-end build verification

**Files:** None modified — verification only.

- [ ] **Step 1: Clean build**

```bash
cd ~/Library/Mobile\ Documents/com\~apple\~CloudDocs/review-context-mcp
rm -rf dist
npm run build
```

Expected: Exit 0, `dist/` contains `llm-client.js`, `llm-client.d.ts`, `llm-tools.js`, `llm-tools.d.ts`, plus existing files.

- [ ] **Step 2: Verify all dist files exist**

```bash
ls dist/llm-client.js dist/llm-client.d.ts dist/llm-tools.js dist/llm-tools.d.ts dist/index.js dist/context-manager.js
```

Expected: All 6 files listed.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass (existing + new).

- [ ] **Step 4: Verify MCP server starts without credentials (non-LLM tools should work)**

```bash
unset AUGMENT_API_TOKEN AUGMENT_API_URL
timeout 3 node dist/index.js 2>&1 || true
```

Expected: Server starts on stdio (or exits cleanly on timeout). No crash from missing LLM credentials.

- [ ] **Step 5: Commit any final adjustments, then tag**

```bash
git add -A
git status
# Only commit if there are changes
git diff --cached --quiet || git commit -m "chore: end-to-end build verification cleanup"
```
