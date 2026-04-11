# Transport Budget Fix for review_prepare_board_context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `review_prepare_board_context` so the MCP transport payload never exceeds 80 KB by ensuring summarized section content from `preparedContextPackages` propagates to `builder_input` and `artifact_markdown`, and adding an end-to-end serialization size test.

**Architecture:** Export a `buildBoardContextPayload` function from `context-manager.ts` that replaces raw `builderInput` excerpt fields with the (possibly summarized) planning-section bodies and rebuilds `artifactMarkdown` from those same sections. `index.ts` calls this function instead of building the payload inline. The test imports this function directly, serializes the payload, and asserts on byte length.

**Tech Stack:** TypeScript, Node.js `node:test`, `@modelcontextprotocol/sdk`, existing test harness (`npm test` = `npm run build && node --test test/*.test.js`)

---

## Root Cause (from real payload analysis)

The 109 KB payload (`mcp-review-context-review_prepare_board_context-1775882426941.txt`) breaks down as:

| Field | Size | Problem |
|-------|------|---------|
| `builder_input.focused_code_excerpts` | 17,357 chars | Full raw content |
| `builder_input.augment_retrieval_excerpts` | 12,418 chars | Full raw — planning section is already 600 chars |
| `prepared_context_packages.planning` | ~19,000 chars | Correct — augment_retrieval summarized to 600 chars |
| `artifact_markdown` | 31,264 chars | Uses raw `builderInput` — has 12,418-char augment section |

`buildBoardArtifact` (context-manager.ts:547) and the inline payload in `index.ts:291` both read from `context.builderInput` (raw), ignoring the already-summarized planning sections. After the fix: `artifact_markdown` and `builder_input` excerpt fields come from planning sections.

---

## File Map

| File | Change |
|------|--------|
| `src/context-manager.ts` | Fix `buildBoardArtifact` to use planning sections; export `buildBoardContextPayload` and `TRANSPORT_MAX_BYTES` |
| `src/index.ts` | Replace inline payload construction at line 291 with `buildBoardContextPayload(context, cached)` |
| `test/context-manager.test.js` | Add transport-size end-to-end test |

---

## Task 1: Write the failing test for transport-size enforcement

**Files:**
- Test: `test/context-manager.test.js` (append after line 276)

- [ ] **Step 1.1: Add failing test**

Append to the bottom of `test/context-manager.test.js`:

```js
test("prepareBoardContext transport payload stays within 80 KB when excerpts are large", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-board-transport-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // Write a file large enough that augment_retrieval_excerpts triggers summarization
  // when combined with focused_code_excerpts under the default planning budget
  await writeFile(join(directory, "big.ts"), "export const x = 1;\n".repeat(500));
  await writeFile(join(directory, "small.ts"), "export const y = 2;\n");

  const manager = new ContextManager(false);
  const stubContext = {
    async addToIndex(files) {
      return {
        newlyUploaded: files.map((f) => f.path),
        alreadyUploaded: [],
      };
    },
    async search() {
      // Return a large retrieval result to force budget pressure
      return [
        "The following code sections were retrieved:",
        "Path: big.ts",
        Array.from({ length: 400 }, (_, i) => `  ${i + 1}\texport const x = 1;`).join("\n"),
      ].join("\n");
    },
  };

  manager.ensureContext = async (workspaceRoot) => {
    manager.ctx = stubContext;
    manager.workspaceRoot = resolve(workspaceRoot);
    return stubContext;
  };

  const { context, cached } = await manager.prepareBoardContext({
    workspaceRoot: directory,
    userRequest: "Review big.ts",
    paths: ["big.ts", "small.ts"],
    retrievalQuery: "export const",
    maxOutputLength: 12000,
    excerptCharLimit: 8000,
    // Keep defaults (5200 planning tokens × 4 chars/token = 20800 budget)
  });

  assert.equal(cached, false);

  // Simulate the payload that index.ts sends over the wire
  const { rawResult: _r, ...structuredSearch } = context.structuredSearch;
  const transportPayload = manager.buildBoardContextPayload(context, cached);
  const serialized = JSON.stringify(transportPayload, null, 2);

  // Must not exceed 80 KB
  const TRANSPORT_MAX_BYTES = 80_000;
  assert.ok(
    serialized.length <= TRANSPORT_MAX_BYTES,
    `Transport payload is ${serialized.length} chars, exceeds ${TRANSPORT_MAX_BYTES} limit. ` +
    `builder_input.augment_retrieval_excerpts=${
      JSON.stringify(transportPayload.builder_input?.augment_retrieval_excerpts ?? "").length
    } chars`,
  );

  // The planning sections' summarized versions must propagate to builder_input
  const planAugmentSection = context.preparedContextPackages.planning?.sections.find(
    (s) => s.key === "augment_retrieval_excerpts",
  );
  if (planAugmentSection && planAugmentSection.mode === "summary") {
    assert.equal(
      transportPayload.builder_input.augment_retrieval_excerpts,
      planAugmentSection.body,
      "builder_input.augment_retrieval_excerpts must use the summarized planning section body",
    );
  }
});
```

- [ ] **Step 1.2: Run test to verify it fails (ContextManager has no buildBoardContextPayload yet)**

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/review-context-mcp
npm test 2>&1 | tail -30
```

Expected output: compile error or `TypeError: manager.buildBoardContextPayload is not a function`

---

## Task 2: Export `TRANSPORT_MAX_BYTES` and `buildBoardContextPayload` from `context-manager.ts`

**Files:**
- Modify: `src/context-manager.ts` (add after line 123, the `toErrorMessage` export)

- [ ] **Step 2.1: Add the constant and the exported function**

Insert after line 123 (the `toErrorMessage` export) in `src/context-manager.ts`:

```typescript
export const TRANSPORT_MAX_BYTES = 80_000;

/**
 * Build the MCP transport payload for review_prepare_board_context.
 * Uses planning-phase section bodies for excerpt fields so summarized content
 * is not bypassed by the raw builderInput values.
 * If the serialized result exceeds TRANSPORT_MAX_BYTES, artifact_markdown is
 * omitted (it is derivable from prepared_context_packages.planning).
 */
export function buildBoardContextPayload(
  context: PreparedBoardContext,
  cached: boolean,
): Record<string, unknown> {
  const { rawResult: _raw, ...structuredSearch } = context.structuredSearch;

  // Resolve excerpt fields from planning sections (may be summarized)
  const planSections = context.preparedContextPackages.planning?.sections ?? [];
  const getSectionBody = (key: string, fallback: string): string => {
    const section = planSections.find((s) => s.key === key);
    return section ? section.body : fallback;
  };

  const builderInput = {
    ...context.builderInput,
    focused_code_excerpts: getSectionBody(
      "focused_code_excerpts",
      context.builderInput.focused_code_excerpts,
    ),
    augment_retrieval_excerpts: getSectionBody(
      "augment_retrieval_excerpts",
      context.builderInput.augment_retrieval_excerpts,
    ),
  };

  const payload: Record<string, unknown> = {
    cached,
    session_id: context.sessionId,
    generated_at: new Date(context.generatedAt).toISOString(),
    workspace_root: context.workspaceRoot,
    indexing: context.indexing,
    structured_search: structuredSearch,
    builder_input: builderInput,
    prepared_context_packages: context.preparedContextPackages,
    artifact_markdown: context.artifactMarkdown,
  };

  // Final transport-size guard: drop artifact_markdown if payload is over budget
  // (artifact_markdown is a rendering of prepared_context_packages.planning sections)
  if (JSON.stringify(payload).length > TRANSPORT_MAX_BYTES) {
    delete payload.artifact_markdown;
  }

  return payload;
}
```

- [ ] **Step 2.2: Make `buildBoardContextPayload` accessible on `ContextManager` for test convenience**

Also add a public method on `ContextManager` that delegates to the exported function (for test import ergonomics without needing to expose internals):

Inside the `ContextManager` class, just after the `prepareBoardContext` method (after line 887), add:

```typescript
buildBoardContextPayload(context: PreparedBoardContext, cached: boolean): Record<string, unknown> {
  return buildBoardContextPayload(context, cached);
}
```

- [ ] **Step 2.3: Build**

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/review-context-mcp
npm run build 2>&1 | tail -20
```

Expected: exits 0 with no TypeScript errors.

---

## Task 3: Fix `buildBoardArtifact` to use planning section bodies

**Files:**
- Modify: `src/context-manager.ts` lines 547–568

- [ ] **Step 3.1: Replace the raw-builderInput rendering with planning-section rendering**

Replace the current `buildBoardArtifact` implementation:

```typescript
// BEFORE (lines 547-568):
private buildBoardArtifact(context: PreparedBoardContext): string {
  const sections = [
    "# Code Review Board Context",
    `## User Request\n${context.builderInput.user_request}`,
    `## Repository State\n${context.builderInput.repository_state}`,
    `## Indexing Summary\n` +
      `Performed: ${context.indexing.performed}\n` +
      `File count: ${context.indexing.fileCount}\n` +
      `Newly uploaded: ${context.indexing.newlyUploaded.length}\n` +
      `Already cached: ${context.indexing.alreadyUploaded.length}\n` +
      `Errors: ${context.indexing.errors.length}`,
    `## Focused Code Excerpts\n${context.builderInput.focused_code_excerpts}`,
    `## Augment Retrieval Excerpts\n${context.builderInput.augment_retrieval_excerpts}`,
    `## Referenced File Paths\n${context.builderInput.referenced_file_paths.join("\n")}`,
  ];

  if (context.builderInput.project_rules) {
    sections.splice(3, 0, `## Project Rules\n${context.builderInput.project_rules}`);
  }

  return sections.join("\n\n");
}
```

Replace with:

```typescript
// AFTER:
private buildBoardArtifact(context: PreparedBoardContext): string {
  // Use planning section bodies so summarized content is not bypassed.
  const planSections = context.preparedContextPackages.planning?.sections ?? [];
  const getSectionBody = (key: string, fallback: string): string => {
    const section = planSections.find((s) => s.key === key);
    return section ? section.body : fallback;
  };

  const sections = [
    "# Code Review Board Context",
    `## User Request\n${context.builderInput.user_request}`,
    `## Repository State\n${context.builderInput.repository_state}`,
    `## Indexing Summary\n` +
      `Performed: ${context.indexing.performed}\n` +
      `File count: ${context.indexing.fileCount}\n` +
      `Newly uploaded: ${context.indexing.newlyUploaded.length}\n` +
      `Already cached: ${context.indexing.alreadyUploaded.length}\n` +
      `Errors: ${context.indexing.errors.length}`,
    `## Focused Code Excerpts\n${getSectionBody("focused_code_excerpts", context.builderInput.focused_code_excerpts)}`,
    `## Augment Retrieval Excerpts\n${getSectionBody("augment_retrieval_excerpts", context.builderInput.augment_retrieval_excerpts)}`,
    `## Referenced File Paths\n${context.builderInput.referenced_file_paths.join("\n")}`,
  ];

  if (context.builderInput.project_rules) {
    sections.splice(3, 0, `## Project Rules\n${context.builderInput.project_rules}`);
  }

  return sections.join("\n\n");
}
```

- [ ] **Step 3.2: Build**

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/review-context-mcp
npm run build 2>&1 | tail -20
```

Expected: exits 0.

---

## Task 4: Update `src/index.ts` to use `buildBoardContextPayload`

**Files:**
- Modify: `src/index.ts` lines 6, 291–302

- [ ] **Step 4.1: Update import in index.ts**

Change line 6 from:

```typescript
import { ContextManager, toErrorMessage } from "./context-manager.js";
```

to:

```typescript
import { ContextManager, toErrorMessage, buildBoardContextPayload } from "./context-manager.js";
```

- [ ] **Step 4.2: Replace inline payload construction**

Replace lines 291–302 in `src/index.ts` (the inline payload block inside `review_prepare_board_context`):

```typescript
// BEFORE (lines 291-302):
      const { rawResult, ...structuredSearch } = context.structuredSearch;
      const payload = {
        cached,
        session_id: context.sessionId,
        generated_at: new Date(context.generatedAt).toISOString(),
        workspace_root: context.workspaceRoot,
        indexing: context.indexing,
        structured_search: structuredSearch,
        builder_input: context.builderInput,
        prepared_context_packages: context.preparedContextPackages,
        artifact_markdown: context.artifactMarkdown,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
```

Replace with:

```typescript
      const payload = buildBoardContextPayload(context, cached);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
```

- [ ] **Step 4.3: Build**

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/review-context-mcp
npm run build 2>&1 | tail -20
```

Expected: exits 0.

---

## Task 5: Run all tests and confirm the new test passes

- [ ] **Step 5.1: Run the full test suite**

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/review-context-mcp
npm test 2>&1
```

Expected output (all 6 tests pass):

```
✓ saveSession updates the active in-memory session id
✓ indexDirectory preserves unreadable file errors in its result
✓ searchAndAsk reports the MCP env requirement when env vars are missing
✓ searchStructured returns reusable chunks and reuses cached raw search results
✓ prepareBoardContext caches reusable board bundles by file fingerprint
✓ prepareBoardContext applies custom prompt budgets to prepared context packages
✓ prepareBoardContext transport payload stays within 80 KB when excerpts are large
```

If any test fails: read the full error output, diagnose, fix. Do not skip the failure.

- [ ] **Step 5.2: Verify the payload improvement numerically**

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/review-context-mcp
node -e "
const { ContextManager, buildBoardContextPayload } = await import('./dist/context-manager.js');
const mgr = new ContextManager(false);
console.log('buildBoardContextPayload exported:', typeof buildBoardContextPayload);
console.log('TRANSPORT_MAX_BYTES:', (await import('./dist/context-manager.js')).TRANSPORT_MAX_BYTES);
" 2>&1
```

Expected: `buildBoardContextPayload exported: function` and `TRANSPORT_MAX_BYTES: 80000`

---

## Task 6: Commit

- [ ] **Step 6.1: Stage and commit**

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/review-context-mcp
git add src/context-manager.ts src/index.ts test/context-manager.test.js
git commit -m "$(cat <<'EOF'
fix: enforce transport budget in review_prepare_board_context responses

buildBoardArtifact and the MCP payload now use planning-section bodies
(which may be summarized) for focused_code_excerpts and augment_retrieval_excerpts
instead of the raw builderInput values. This eliminates the duplication that
produced 109 KB responses even when planning sections were already summarized.

Adds buildBoardContextPayload() exported function and TRANSPORT_MAX_BYTES
constant. An end-to-end test serializes the full payload and asserts it stays
within 80 KB.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|-------------|------|
| Fix `buildBoardArtifact` to use planning sections | Task 3 |
| Fix `builder_input` in payload to use planning sections | Task 2 (buildBoardContextPayload) + Task 4 |
| Enforce transport-size budget | Task 2 (80 KB guard in buildBoardContextPayload) |
| End-to-end test serializing the payload and asserting byte size | Task 1 |
| Ensure summarized section content propagates consistently | Tasks 2, 3 |

**Placeholder scan:** None found.

**Type consistency:**
- `PreparedBoardContext` is defined at line 90 in context-manager.ts — used correctly in both `buildBoardContextPayload` and `buildBoardArtifact`.
- `buildBoardContextPayload` is exported as a standalone function AND delegated from a public method on `ContextManager` (for test access).
- `TRANSPORT_MAX_BYTES` is exported and referenced by the test.

**Expected payload reduction from real payload (109 KB → ~85 KB after fix):**
- `builder_input.augment_retrieval_excerpts`: 12,418 → 600 chars (planning section was summarized)
- `artifact_markdown.Augment Retrieval Excerpts`: 12,418 → 600 chars (same)
- Net savings: ~23,636 chars
- If still over 80 KB, `artifact_markdown` is dropped (additional ~31,264 chars saved)

> **Note on `focused_code_excerpts`:** In the real payload, focused_code_excerpts (17,357 chars) stayed "full" in planning because it fit within the 20,800-char budget. The fix does not change this — the planning section body is the same 17,357 chars — which is correct behaviour.
