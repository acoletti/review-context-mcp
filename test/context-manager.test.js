/**
 * [LAYER: INFRASTRUCTURE]
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";
import { ContextManager, buildBoardContextPayload, paginateBoardContextPayload, TRANSPORT_MAX_BYTES } from "../dist/context-manager.js";

const CACHE_DIR = join(homedir(), ".claude", "review-cache");

test("saveSession updates the active in-memory session id", async (t) => {
  const manager = new ContextManager(false);
  const sessionId = `test-session-${randomUUID()}`;
  const statePath = join(CACHE_DIR, `${sessionId}.state.json`);
  const metaPath = join(CACHE_DIR, `${sessionId}.meta.json`);
  const cachePath = join(CACHE_DIR, `${sessionId}.cache.json`);

  t.after(async () => {
    await Promise.all([
      rm(statePath, { force: true }),
      rm(metaPath, { force: true }),
      rm(cachePath, { force: true }),
    ]);
  });

  manager.ctx = {
    async exportToFile(path) {
      writeFileSync(path, "{}");
    },
    getIndexedPaths() {
      return ["src/index.ts"];
    },
  };
  manager.workspaceRoot = "/tmp/workspace";
  manager.sessionId = "stale-session";

  const savedId = await manager.saveSession(sessionId);

  assert.equal(savedId, sessionId);
  assert.equal(manager.getStatus().sessionId, sessionId);
  assert.equal(existsSync(metaPath), true);
});

test("indexDirectory preserves unreadable file errors in its result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-context-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, "keep.ts"), "export const keep = true;\n");
  await writeFile(join(directory, "too-large.ts"), "a".repeat(1_000_001));

  const manager = new ContextManager(false);
  const stubContext = {
    async addToIndex(files) {
      return {
        newlyUploaded: files.map((file) => file.path),
        alreadyUploaded: [],
      };
    },
  };

  manager.ensureContext = async (workspaceRoot) => {
    manager.ctx = stubContext;
    manager.workspaceRoot = resolve(workspaceRoot);
    return stubContext;
  };

  const result = await manager.indexDirectory(directory, ["**/*.ts"]);

  assert.equal(result.fileCount, 2);
  assert.deepEqual(result.newlyUploaded, ["keep.ts"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /too-large\.ts/);
  assert.match(result.errors[0], /exceeds 1MB/);
});

test("searchAndAsk reports the MCP env requirement when env vars are missing", async (t) => {
  const previousToken = process.env.AUGMENT_API_TOKEN;
  const previousUrl = process.env.AUGMENT_API_URL;

  t.after(() => {
    if (previousToken === undefined) {
      delete process.env.AUGMENT_API_TOKEN;
    } else {
      process.env.AUGMENT_API_TOKEN = previousToken;
    }

    if (previousUrl === undefined) {
      delete process.env.AUGMENT_API_URL;
    } else {
      process.env.AUGMENT_API_URL = previousUrl;
    }
  });

  delete process.env.AUGMENT_API_TOKEN;
  delete process.env.AUGMENT_API_URL;

  const manager = new ContextManager(false);
  manager.ctx = {
    async searchAndAsk() {
      return "unused";
    },
  };
  manager.indexingComplete = true;

  await assert.rejects(
    () => manager.searchAndAsk("query"),
    /AUGMENT_API_TOKEN and AUGMENT_API_URL in the MCP server env/,
  );
});

test("searchStructured returns reusable chunks and reuses cached raw search results", async () => {
  const manager = new ContextManager(false);
  let searchCalls = 0;

  manager.ctx = {
    async search() {
      searchCalls += 1;
      return [
        "The following code sections were retrieved:",
        "Path: src/alpha.ts",
        "    10\texport const alpha = 1;",
        "    11\texport const beta = 2;",
        "",
        "Path: src/beta.ts",
        "     1\tconst gamma = 3;",
      ].join("\n");
    },
  };
  manager.indexingComplete = true;

  const first = await manager.searchStructured("find exports", 20000);
  const second = await manager.searchStructured("find exports", 20000);

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(searchCalls, 1);
  assert.equal(first.chunkCount, 2);
  assert.equal(first.chunks[0].path, "src/alpha.ts");
  assert.equal(first.chunks[0].startLine, 10);
  assert.equal(first.chunks[0].endLine, 11);
  assert.match(first.chunks[0].preview, /alpha/);
});

test("prepareBoardContext caches reusable board bundles by file fingerprint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-board-context-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, "keep.ts"), "export const keep = true;\n");

  const manager = new ContextManager(false);
  let indexCalls = 0;
  let searchCalls = 0;
  const stubContext = {
    async addToIndex(files) {
      indexCalls += 1;
      return {
        newlyUploaded: files.map((file) => file.path),
        alreadyUploaded: [],
      };
    },
    async search() {
      searchCalls += 1;
      return [
        "The following code sections were retrieved:",
        "Path: keep.ts",
        "     1\texport const keep = true;",
      ].join("\n");
    },
  };

  manager.ensureContext = async (workspaceRoot) => {
    manager.ctx = stubContext;
    manager.workspaceRoot = resolve(workspaceRoot);
    return stubContext;
  };

  const first = await manager.prepareBoardContext({
    workspaceRoot: directory,
    userRequest: "Review keep.ts",
    paths: ["keep.ts"],
    retrievalQuery: "keep export",
    maxOutputLength: 12000,
    excerptCharLimit: 4000,
  });
  const second = await manager.prepareBoardContext({
    workspaceRoot: directory,
    userRequest: "Review keep.ts",
    paths: ["keep.ts"],
    retrievalQuery: "keep export",
    maxOutputLength: 12000,
    excerptCharLimit: 4000,
  });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(indexCalls, 1);
  assert.equal(searchCalls, 1);
  assert.deepEqual(first.context.builderInput.referenced_file_paths, [resolve(directory, "keep.ts")]);
  assert.match(first.context.builderInput.focused_code_excerpts, /Path: keep\.ts/);
  assert.match(first.context.builderInput.augment_retrieval_excerpts, /keep\.ts/);
  assert.equal(first.context.preparedContextPackages.planning.budget_chars, 20800);
  assert.match(
    first.context.preparedContextPackages.planning.sections[0].body,
    /Review keep\.ts/,
  );
  assert.match(first.context.artifactMarkdown, /Code Review Board Context/);
});

test("prepareBoardContext applies custom prompt budgets to prepared context packages", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-board-budget-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, "keep.ts"), "export const keep = true;\n".repeat(200));

  const manager = new ContextManager(false);
  const stubContext = {
    async addToIndex(files) {
      return {
        newlyUploaded: files.map((file) => file.path),
        alreadyUploaded: [],
      };
    },
    async search() {
      return [
        "The following code sections were retrieved:",
        "Path: keep.ts",
        "     1\texport const keep = true;",
      ].join("\n");
    },
  };

  manager.ensureContext = async (workspaceRoot) => {
    manager.ctx = stubContext;
    manager.workspaceRoot = resolve(workspaceRoot);
    return stubContext;
  };

  const result = await manager.prepareBoardContext({
    workspaceRoot: directory,
    userRequest: "Review keep.ts",
    paths: ["keep.ts"],
    retrievalQuery: "keep export",
    maxOutputLength: 12000,
    excerptCharLimit: 4000,
    budgetCharsPerToken: 2,
    phaseContextTargetTokens: {
      planning: 600,
      debate: 300,
      synthesis: 320,
    },
    sectionSummaryCharLimits: {
      focused_code_excerpts: 200,
      augment_retrieval_excerpts: 200,
    },
  });

  assert.equal(result.context.preparedContextPackages.planning.budget_chars, 1200);
  assert.equal(result.context.preparedContextPackages.debate.budget_chars, 600);
  assert.equal(result.context.preparedContextPackages.synthesis.budget_chars, 640);
  assert.ok(
    result.context.preparedContextPackages.planning.sections.some(
      (section) => section.mode === "summary" || section.mode === "omitted",
    ),
  );
});

test("prepareBoardContext transport payload stays within 80 KB when excerpts are large", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-board-transport-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // Write files large enough that augment_retrieval_excerpts triggers summarization
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
  });

  assert.equal(cached, false);

  // Simulate the payload that index.ts sends over the wire
  const transportPayload = manager.buildBoardContextPayload(context, cached);
  const serialized = JSON.stringify(transportPayload, null, 2);

  // Use the same byte-based compact-JSON guard as production (buildBoardContextPayload).
  const compactBytes = Buffer.byteLength(JSON.stringify(transportPayload), "utf8");
  assert.ok(
    compactBytes <= TRANSPORT_MAX_BYTES,
    `Transport payload is ${compactBytes} bytes, exceeds ${TRANSPORT_MAX_BYTES} limit. ` +
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

test("listSessions returns sessions sorted by createdAt descending", async (t) => {
  const sessionDir = join(CACHE_DIR);
  const id1 = `test-list-${randomUUID()}`;
  const id2 = `test-list-${randomUUID()}`;

  t.after(async () => {
    await Promise.all([
      rm(join(sessionDir, `${id1}.meta.json`), { force: true }),
      rm(join(sessionDir, `${id2}.meta.json`), { force: true }),
    ]);
  });

  await writeFile(join(sessionDir, `${id1}.meta.json`), JSON.stringify({
    sessionId: id1, createdAt: 1000, indexedPaths: [], workspaceRoot: "/tmp",
  }));
  await writeFile(join(sessionDir, `${id2}.meta.json`), JSON.stringify({
    sessionId: id2, createdAt: 2000, indexedPaths: ["a.ts"], workspaceRoot: "/tmp",
  }));

  const manager = new ContextManager(false);
  const sessions = await manager.listSessions();
  const ids = sessions.map((s) => s.sessionId);
  assert.ok(ids.includes(id1));
  assert.ok(ids.includes(id2));
  const idx1 = ids.indexOf(id1);
  const idx2 = ids.indexOf(id2);
  assert.ok(idx2 < idx1, "newer session (id2) should come before older (id1)");
});

test("listSessions skips corrupt meta files gracefully", async (t) => {
  const id = `test-corrupt-${randomUUID()}`;
  const metaPath = join(CACHE_DIR, `${id}.meta.json`);

  t.after(async () => {
    await rm(metaPath, { force: true });
  });

  await writeFile(metaPath, "not valid json{{{");

  const manager = new ContextManager(false);
  const sessions = await manager.listSessions();
  const ids = sessions.map((s) => s.sessionId);
  assert.ok(!ids.includes(id), "corrupt meta should be skipped");
});

test("resumeSession with empty workspaceRoot in meta stores null internally", async (t) => {
  const sessionId = `test-empty-ws-${randomUUID()}`;
  const statePath = join(CACHE_DIR, `${sessionId}.state.json`);
  const metaPath = join(CACHE_DIR, `${sessionId}.meta.json`);
  const cachePath = join(CACHE_DIR, `${sessionId}.cache.json`);

  t.after(async () => {
    await Promise.all([
      rm(statePath, { force: true }),
      rm(metaPath, { force: true }),
      rm(cachePath, { force: true }),
    ]);
  });

  writeFileSync(statePath, "{}");
  await writeFile(metaPath, JSON.stringify({
    sessionId, createdAt: Date.now(), indexedPaths: [], workspaceRoot: "",
  }));
  await writeFile(cachePath, JSON.stringify({ searchResults: [], boardContexts: [] }));

  const manager = new ContextManager(false);
  manager.ctx = null;

  // Stub importFromFile to avoid real SDK call
  const origImport = (await import("@augmentcode/auggie-sdk")).DirectContext.importFromFile;
  const { DirectContext } = await import("@augmentcode/auggie-sdk");
  DirectContext.importFromFile = async () => ({ getIndexedPaths: () => [] });

  t.after(() => { DirectContext.importFromFile = origImport; });

  const info = await manager.resumeSession(sessionId);
  assert.equal(info.workspaceRoot, "", "returned workspaceRoot should be empty string");
  assert.equal(manager.getStatus().workspaceRoot, null, "internal workspaceRoot should be null");
});

test("resultCache evicts oldest entries via FIFO when exceeding limit", async () => {
  const manager = new ContextManager(false);
  let callCount = 0;

  manager.ctx = {
    async search(query) {
      callCount += 1;
      return `result for ${query}`;
    },
  };
  manager.indexingComplete = true;

  // Pre-populate the result cache to just below the 500 limit
  for (let i = 0; i < 500; i++) {
    manager.resultCache.set(`prefill-${i}`, {
      query: `query-${i}`,
      result: `result-${i}`,
      timestamp: Date.now(),
      maxOutputLength: 20000,
    });
  }
  assert.equal(manager.resultCache.size, 500);

  // Trigger 3 new searches — each should evict the oldest entry
  await manager.search("overflow-a", 20000);
  await manager.search("overflow-b", 20000);
  await manager.search("overflow-c", 20000);

  assert.equal(manager.resultCache.size, 500, "cache should stay at 500");
  assert.equal(callCount, 3, "should have made 3 real search calls");

  // The 3 oldest prefilled entries should have been evicted
  assert.ok(!manager.resultCache.has("prefill-0"), "oldest entry should be evicted");
  assert.ok(!manager.resultCache.has("prefill-1"), "second oldest should be evicted");
  assert.ok(!manager.resultCache.has("prefill-2"), "third oldest should be evicted");

  // The newer entries should still be present
  assert.ok(manager.resultCache.has("prefill-499"), "newest prefilled entry should remain");
});

test("boardContextCache evicts oldest entry when exceeding limit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-board-eviction-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(directory, "a.ts"), "export const a = 1;\n");

  const manager = new ContextManager(false);
  const stubContext = {
    async addToIndex(files) {
      return { newlyUploaded: files.map((f) => f.path), alreadyUploaded: [] };
    },
    async search() {
      return "Path: a.ts\n     1\texport const a = 1;";
    },
  };

  manager.ensureContext = async (workspaceRoot) => {
    manager.ctx = stubContext;
    manager.workspaceRoot = resolve(workspaceRoot);
    return stubContext;
  };

  // Fill cache with unique requests to create distinct cache keys
  for (let i = 0; i < 52; i++) {
    await manager.prepareBoardContext({
      workspaceRoot: directory,
      userRequest: `Review request ${i}`,
      paths: ["a.ts"],
      maxOutputLength: 12000,
      excerptCharLimit: 4000,
    });
  }

  const status = manager.getStatus();
  assert.ok(
    status.preparedBoardContexts <= 50,
    `Board cache should be capped at 50, got ${status.preparedBoardContexts}`,
  );
});

test("deleteSession does not throw on non-existent session", async () => {
  const id = `test-delete-missing-${randomUUID()}`;
  const manager = new ContextManager(false);
  const result = await manager.deleteSession(id);
  assert.equal(result, false, "should return false when no files existed");
});

test("listSessions returns partial results when one meta file is unreadable", async (t) => {
  const goodId = `test-partial-good-${randomUUID()}`;
  const badId = `test-partial-bad-${randomUUID()}`;
  const goodPath = join(CACHE_DIR, `${goodId}.meta.json`);
  const badPath = join(CACHE_DIR, `${badId}.meta.json`);

  await writeFile(goodPath, JSON.stringify({
    sessionId: goodId, createdAt: 1000, indexedPaths: [], workspaceRoot: "/tmp",
  }));
  await writeFile(badPath, JSON.stringify({
    sessionId: badId, createdAt: 2000, indexedPaths: [], workspaceRoot: "/tmp",
  }));
  await chmod(badPath, 0o000);

  t.after(async () => {
    await chmod(badPath, 0o644).catch(() => {});
    await Promise.all([rm(goodPath, { force: true }), rm(badPath, { force: true })]);
  });

  const manager = new ContextManager(false);
  const sessions = await manager.listSessions();
  const ids = sessions.map((s) => s.sessionId);
  assert.ok(ids.includes(goodId), "readable session should be returned");
  assert.ok(!ids.includes(badId), "unreadable session should be skipped");
});

// ─── Pagination and progressive trimming tests ─────────────────────────────

test("paginateBoardContextPayload returns correct chunk and pagination metadata (byte-based)", () => {
  const payload = { data: "a".repeat(5000), extra: "b".repeat(3000) };
  const serialized = JSON.stringify(payload);
  const totalBytes = Buffer.byteLength(serialized, "utf8");

  // First chunk
  const first = paginateBoardContextPayload(payload, 0, 4000);
  assert.equal(first.content.length, 1);
  assert.equal(first.content[0].type, "text");
  assert.equal(first.pagination.total_bytes, totalBytes);
  assert.equal(first.pagination.offset, 0);
  assert.equal(first.pagination.limit, 4000);
  assert.equal(first.pagination.has_more, true);
  assert.equal(first.pagination.bytes_in_chunk, 4000);

  const firstEnvelope = JSON.parse(first.content[0].text);
  assert.equal(Buffer.byteLength(firstEnvelope.chunk, "utf8"), 4000);

  // Reconstruct full payload from chunks using bytes_in_chunk
  let reconstructed = "";
  let offset = 0;
  const chunkSize = 4000;
  while (true) {
    const page = paginateBoardContextPayload(payload, offset, chunkSize);
    const env = JSON.parse(page.content[0].text);
    reconstructed += env.chunk;
    if (!env._pagination.has_more) break;
    offset += env._pagination.bytes_in_chunk;
  }
  assert.equal(reconstructed, serialized, "reconstructed payload must match original serialization");
});

test("paginateBoardContextPayload clamps offset past end of data", () => {
  const payload = { small: "test" };

  const result = paginateBoardContextPayload(payload, 99999, 4000);
  assert.equal(result.pagination.has_more, false);
  assert.equal(result.pagination.bytes_in_chunk, 0);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.chunk, "");
});

test("paginateBoardContextPayload returns empty chunk at exact byte boundary", () => {
  const payload = { data: "hello world" };
  const totalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

  const result = paginateBoardContextPayload(payload, totalBytes, 4000);
  assert.equal(result.pagination.total_bytes, totalBytes);
  assert.equal(result.pagination.offset, totalBytes);
  assert.equal(result.pagination.has_more, false);
  assert.equal(result.pagination.bytes_in_chunk, 0);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.chunk, "");
});

test("Zod .int() rejects fractional byte offsets", () => {
  const schema = z.number().int().min(0);
  assert.throws(() => schema.parse(1.5), /int/i);
  assert.throws(() => schema.parse(999.9), /int/i);
  assert.equal(schema.parse(0), 0);
  assert.equal(schema.parse(40000), 40000);
});

test("buildBoardContextPayload Stage 4 drops debate/synthesis and recomputes bytes", () => {
  const context = {
    workspaceRoot: "/tmp/test",
    userRequest: "test",
    retrievalQuery: "test",
    sessionId: "test-session",
    generatedAt: Date.now(),
    indexing: { performed: true, fileCount: 1, newlyUploaded: [], alreadyUploaded: [], errors: [] },
    structuredSearch: {
      query: "test",
      cached: false,
      chunkCount: 0,
      chunks: [],
      rawResult: "",
    },
    builderInput: {
      user_request: "test",
      focused_code_excerpts: "x".repeat(15000),
      augment_retrieval_excerpts: "y".repeat(10000),
      corpus_reference_excerpts: "",
      applicable_coding_standards: "",
      repository_state: "",
      project_rules: "",
      external_documentation: "",
      external_documentation_summary: "",
      cross_repository_patterns: "",
      cross_repository_patterns_summary: "",
      referenced_file_paths: [],
    },
    preparedContextPackages: {
      planning: {
        budget_chars: 20800,
        sections: [
          { key: "user_request", label: "User Request", body: "test", priority: 1, required: true, mode: "full" },
          { key: "focused_code_excerpts", label: "Excerpts", body: "x".repeat(15000), priority: 3, required: false, mode: "full" },
          { key: "augment_retrieval_excerpts", label: "Augment", body: "y".repeat(10000), priority: 3, required: false, mode: "full" },
        ],
      },
      debate: {
        budget_chars: 5600,
        sections: [
          { key: "debate_context", label: "Debate", body: "d".repeat(25000), priority: 1, required: true, mode: "full" },
        ],
      },
      synthesis: {
        budget_chars: 6400,
        sections: [
          { key: "synthesis_context", label: "Synthesis", body: "s".repeat(25000), priority: 1, required: true, mode: "full" },
        ],
      },
    },
    artifactMarkdown: "a".repeat(5000),
  };

  const payload = buildBoardContextPayload(context, false);
  const compactBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

  // Stage 4 should have fired — debate/synthesis absent, planning preserved
  assert.equal(payload.prepared_context_packages.debate, undefined);
  assert.equal(payload.prepared_context_packages.synthesis, undefined);
  assert.ok(payload.prepared_context_packages.planning !== undefined);

  // Compact bytes should be within transport budget after Stage 4 trimming
  assert.ok(
    compactBytes <= TRANSPORT_MAX_BYTES,
    `Stage 4 trimmed payload (${compactBytes} bytes) should fit within ${TRANSPORT_MAX_BYTES}`,
  );
});

test("buildBoardContextPayload replaces builder_input excerpt fields with planning section bodies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-board-trim-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // Create files large enough to trigger planning-section summarization
  const bigContent = "export const x = 1;\n".repeat(2000);
  await writeFile(join(directory, "huge.ts"), bigContent);
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
      return [
        "The following code sections were retrieved:",
        "Path: huge.ts",
        Array.from({ length: 800 }, (_, i) => `  ${i + 1}\texport const x = 1;`).join("\n"),
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
    userRequest: "Review huge.ts",
    paths: ["huge.ts", "small.ts"],
    retrievalQuery: "export const",
    maxOutputLength: 40000,
    excerptCharLimit: 30000,
  });

  const payload = buildBoardContextPayload(context, cached);

  // builder_input excerpt fields should use planning-section bodies (may be summarized)
  const rawSize = JSON.stringify(context.builderInput).length;
  const trimmedSize = JSON.stringify(payload.builder_input).length;
  assert.ok(
    trimmedSize <= rawSize,
    `trimmed builder_input (${trimmedSize}) should be <= raw (${rawSize})`,
  );

  // Verify planning section bodies are used for excerpt fields
  const planFocused = context.preparedContextPackages.planning?.sections.find(
    (s) => s.key === "focused_code_excerpts",
  );
  if (planFocused) {
    assert.equal(
      payload.builder_input.focused_code_excerpts,
      planFocused.body,
      "focused_code_excerpts should use planning section body",
    );
  }
});

test("buildBoardContextPayload drops structured_search chunks when oversized", () => {
  // Construct a synthetic PreparedBoardContext large enough that stages 1-2
  // are insufficient and stage 3 (drop chunks) must trigger.
  // Each chunk has ~3000 chars of snippet × 50 chunks = ~150KB of chunk data.
  const largeChunks = Array.from({ length: 50 }, (_, i) => ({
    id: `chunk-${i}`,
    path: `src/file-${i}.ts`,
    startLine: 1,
    endLine: 100,
    lineCount: 100,
    truncated: false,
    preview: "export const x = 1;",
    snippet: "export const x = 1;\n".repeat(150),
  }));

  const context = {
    workspaceRoot: "/tmp/test",
    userRequest: "test",
    retrievalQuery: "test",
    sessionId: "test-session",
    generatedAt: Date.now(),
    indexing: { performed: true, fileCount: 2, newlyUploaded: [], alreadyUploaded: [], errors: [] },
    structuredSearch: {
      query: "test",
      cached: false,
      chunkCount: largeChunks.length,
      chunks: largeChunks,
      rawResult: "x".repeat(30000),
    },
    builderInput: {
      user_request: "test",
      focused_code_excerpts: "x".repeat(20000),
      augment_retrieval_excerpts: "y".repeat(10000),
      corpus_reference_excerpts: "",
      applicable_coding_standards: "",
      repository_state: "z".repeat(5000),
      project_rules: "w".repeat(5000),
      external_documentation: "",
      external_documentation_summary: "",
      cross_repository_patterns: "",
      cross_repository_patterns_summary: "",
      referenced_file_paths: ["/tmp/test/a.ts"],
    },
    preparedContextPackages: {
      planning: {
        budget_chars: 20800,
        sections: [
          { key: "user_request", label: "User Request", body: "test", priority: 1, required: true, mode: "full" },
          { key: "focused_code_excerpts", label: "Focused Code Excerpts", body: "x".repeat(600), priority: 3, required: false, mode: "summary" },
          { key: "augment_retrieval_excerpts", label: "Augment Retrieval Excerpts", body: "y".repeat(600), priority: 3, required: false, mode: "summary" },
          { key: "repository_state", label: "Repository State", body: "z".repeat(600), priority: 5, required: false, mode: "summary" },
          { key: "project_rules", label: "Project Rules", body: "w".repeat(600), priority: 5, required: false, mode: "summary" },
          { key: "referenced_file_paths", label: "Referenced File Paths", body: "/tmp/test/a.ts", priority: 2, required: true, mode: "full" },
        ],
      },
      debate: { budget_chars: 5600, sections: [] },
      synthesis: { budget_chars: 6400, sections: [] },
    },
    artifactMarkdown: "# large artifact\n" + "content\n".repeat(1000),
  };

  const payload = buildBoardContextPayload(context, false);

  // structured_search should have been trimmed to metadata only
  const ss = payload.structured_search;
  assert.ok(ss, "structured_search should exist");
  assert.ok(!ss.chunks, "structured_search.chunks should be dropped after trimming");
  assert.equal(ss.chunkCount, 50, "structured_search.chunkCount should be preserved");
  assert.equal(ss.query, "test", "structured_search.query should be preserved");
});

test("buildBoardContextPayload does not mutate the cached context object", () => {
  // Build a context that will trigger at least Stage 1 (drop artifact_markdown)
  const context = {
    workspaceRoot: "/tmp/test",
    userRequest: "test",
    retrievalQuery: "test",
    sessionId: "test-session",
    generatedAt: Date.now(),
    indexing: { performed: true, fileCount: 1, newlyUploaded: [], alreadyUploaded: [], errors: [] },
    structuredSearch: {
      query: "test",
      cached: false,
      chunkCount: 1,
      chunks: [{ id: "c1", path: "a.ts", startLine: 1, endLine: 10, lineCount: 10, truncated: false, preview: "x", snippet: "x".repeat(500) }],
      rawResult: "raw",
    },
    builderInput: {
      user_request: "test",
      focused_code_excerpts: "x".repeat(10000),
      augment_retrieval_excerpts: "y".repeat(5000),
      corpus_reference_excerpts: "c".repeat(3000),
      applicable_coding_standards: "",
      repository_state: "z".repeat(5000),
      project_rules: "w".repeat(5000),
      external_documentation: "",
      external_documentation_summary: "",
      cross_repository_patterns: "",
      cross_repository_patterns_summary: "",
      referenced_file_paths: ["/tmp/test/a.ts"],
    },
    preparedContextPackages: {
      planning: {
        budget_chars: 20800,
        sections: [
          { key: "user_request", label: "User Request", body: "test", priority: 1, required: true, mode: "full" },
          { key: "focused_code_excerpts", label: "Excerpts", body: "x".repeat(600), priority: 3, required: false, mode: "summary" },
        ],
      },
      debate: { budget_chars: 5600, sections: [] },
      synthesis: { budget_chars: 6400, sections: [] },
    },
    artifactMarkdown: "# artifact\n" + "content\n".repeat(2000),
  };

  // Snapshot original values before calling buildBoardContextPayload
  const originalExcerpts = context.builderInput.focused_code_excerpts;
  const originalChunks = context.structuredSearch.chunks.length;
  const originalArtifact = context.artifactMarkdown;
  const hasDebate = "debate" in context.preparedContextPackages;

  buildBoardContextPayload(context, false);

  // Verify the cached context was not mutated
  assert.equal(context.builderInput.focused_code_excerpts, originalExcerpts,
    "builderInput.focused_code_excerpts must not be mutated");
  assert.equal(context.structuredSearch.chunks.length, originalChunks,
    "structuredSearch.chunks must not be mutated");
  assert.equal(context.artifactMarkdown, originalArtifact,
    "artifactMarkdown must not be mutated");
  assert.equal("debate" in context.preparedContextPackages, hasDebate,
    "preparedContextPackages.debate must not be deleted");
});

test("paginateBoardContextPayload handles multi-byte Unicode content correctly (byte-based)", () => {
  // Payload with CJK characters: each char is 3 bytes in UTF-8
  const payload = { data: "\u4e16\u754c".repeat(2000), ascii: "hello" };
  const serialized = JSON.stringify(payload);
  const totalBytes = Buffer.byteLength(serialized, "utf8");

  // Byte-based pagination: 2000-byte limit holds fewer CJK chars than ASCII chars
  const first = paginateBoardContextPayload(payload, 0, 2000);
  assert.equal(first.pagination.total_bytes, totalBytes);
  assert.equal(first.pagination.offset, 0);
  assert.equal(first.pagination.limit, 2000);

  const firstEnvelope = JSON.parse(first.content[0].text);
  const firstChunkBytes = Buffer.byteLength(firstEnvelope.chunk, "utf8");
  assert.ok(firstChunkBytes <= 2000,
    `chunk byte length (${firstChunkBytes}) should not exceed limit (2000)`);
  assert.ok(firstEnvelope.chunk.length < 2000,
    "chunk char length should be less than limit due to multi-byte chars");
  assert.equal(first.pagination.bytes_in_chunk, firstChunkBytes);

  // Reconstruct using bytes_in_chunk for offset advancement
  let reconstructed = "";
  let offset = 0;
  const chunkSize = 2000;
  while (true) {
    const page = paginateBoardContextPayload(payload, offset, chunkSize);
    const env = JSON.parse(page.content[0].text);
    reconstructed += env.chunk;
    if (!env._pagination.has_more) break;
    offset += env._pagination.bytes_in_chunk;
  }
  const parsed = JSON.parse(reconstructed);
  assert.equal(parsed.data, "\u4e16\u754c".repeat(2000),
    "multi-byte content must survive byte-based pagination round-trip");
});

// ─── Serialization guard regression + metadata enrichment tests ─────────

test("buildBoardContextPayload compact JSON fits within transport budget even if pretty-printed would exceed it", () => {
  // Many small structured chunks create significant pretty-print overhead
  const manyChunks = Array.from({ length: 200 }, (_, i) => ({
    id: `chunk-${i}`,
    path: `src/file-${i}.ts`,
    startLine: i * 10 + 1,
    endLine: i * 10 + 10,
    lineCount: 10,
    truncated: false,
    preview: `export const x${i} = ${i};`,
    snippet: `export const x${i} = ${i};\nconst y${i} = x${i} + 1;\n`,
  }));

  const context = {
    workspaceRoot: "/tmp/test",
    userRequest: "test",
    retrievalQuery: "test",
    sessionId: "test-session",
    generatedAt: Date.now(),
    indexing: { performed: true, fileCount: 200, newlyUploaded: [], alreadyUploaded: [], errors: [] },
    structuredSearch: {
      query: "test",
      cached: false,
      chunkCount: manyChunks.length,
      chunks: manyChunks,
      rawResult: "raw",
    },
    builderInput: {
      user_request: "test",
      focused_code_excerpts: "x".repeat(8000),
      augment_retrieval_excerpts: "y".repeat(6000),
      corpus_reference_excerpts: "",
      applicable_coding_standards: "",
      repository_state: "z".repeat(2000),
      project_rules: "w".repeat(2000),
      external_documentation: "",
      external_documentation_summary: "",
      cross_repository_patterns: "",
      cross_repository_patterns_summary: "",
      referenced_file_paths: Array.from({ length: 50 }, (_, i) => `/tmp/test/file${i}.ts`),
    },
    preparedContextPackages: {
      planning: {
        budget_chars: 20800,
        sections: [
          { key: "user_request", label: "User Request", body: "test", priority: 1, required: true, mode: "full" },
          { key: "focused_code_excerpts", label: "Excerpts", body: "x".repeat(8000), priority: 3, required: false, mode: "full" },
          { key: "augment_retrieval_excerpts", label: "Augment", body: "y".repeat(6000), priority: 3, required: false, mode: "full" },
        ],
      },
      debate: { budget_chars: 5600, sections: [] },
      synthesis: { budget_chars: 6400, sections: [] },
    },
    artifactMarkdown: "",
  };

  const payload = buildBoardContextPayload(context, false);
  const compact = JSON.stringify(payload);
  const pretty = JSON.stringify(payload, null, 2);
  const compactBytes = Buffer.byteLength(compact, "utf8");

  // Compact should fit within transport budget
  assert.ok(
    compactBytes <= TRANSPORT_MAX_BYTES,
    `Compact payload (${compactBytes} bytes) should fit within ${TRANSPORT_MAX_BYTES}`,
  );

  // Pretty-printed should always be larger than compact due to structural indentation
  assert.ok(
    pretty.length > compact.length,
    `Pretty-printed (${pretty.length}) should be larger than compact (${compact.length})`,
  );
});

test("resumeSession returns boardContextCount and sessionAge", async (t) => {
  const id = `test-resume-enriched-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "review-resume-enriched-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    const manager2 = new ContextManager(false);
    await manager2.deleteSession(id);
  });

  await writeFile(join(directory, "a.ts"), "export const a = 1;\n");

  const manager = new ContextManager(false);
  const stubContext = {
    async addToIndex(files) {
      return { newlyUploaded: files.map((f) => f.path), alreadyUploaded: [] };
    },
    async search() { return "results"; },
    getIndexedPaths() { return ["a.ts"]; },
    async exportToFile(path) { await writeFile(path, "{}"); },
  };

  manager.ensureContext = async (workspaceRoot) => {
    manager.ctx = stubContext;
    manager.workspaceRoot = resolve(workspaceRoot);
    return stubContext;
  };
  await manager.ensureContext(directory);

  // Prepare a board context so it gets cached
  await manager.prepareBoardContext({
    workspaceRoot: directory,
    userRequest: "test",
    paths: ["a.ts"],
    maxOutputLength: 12000,
    excerptCharLimit: 4000,
  });

  await manager.saveSession(id);

  // Resume in a fresh manager — stub importFromFile to avoid hitting real Augment SDK
  const { DirectContext } = await import("@augmentcode/auggie-sdk");
  const origImport = DirectContext.importFromFile;
  DirectContext.importFromFile = async () => stubContext;
  t.after(() => { DirectContext.importFromFile = origImport; });

  const manager2 = new ContextManager(false);
  const info = await manager2.resumeSession(id);

  assert.equal(typeof info.boardContextCount, "number", "boardContextCount should be a number");
  assert.ok(info.boardContextCount >= 1, `boardContextCount should be >= 1, got ${info.boardContextCount}`);
  assert.equal(typeof info.sessionAge, "number", "sessionAge should be a number");
  assert.ok(info.sessionAge >= 0, "sessionAge should be non-negative");
});

test("listSessions includes boardContextCount from meta.json", async (t) => {
  const id = `test-list-boards-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "review-list-boards-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    const mgr = new ContextManager(false);
    await mgr.deleteSession(id);
  });

  // Write a meta.json with boardContextCount
  const metaPath = join(homedir(), ".claude", "review-cache", `${id}.meta.json`);
  const statePath = join(homedir(), ".claude", "review-cache", `${id}.state.json`);
  await writeFile(metaPath, JSON.stringify({
    sessionId: id,
    createdAt: Date.now() - 3600000, // 1 hour ago
    indexedPaths: ["a.ts"],
    workspaceRoot: directory,
    boardContextCount: 3,
  }));
  await writeFile(statePath, "{}"); // dummy state file

  const manager = new ContextManager(false);
  const sessions = await manager.listSessions();
  const found = sessions.find((s) => s.sessionId === id);

  assert.ok(found, `session ${id} should appear in list`);
  assert.equal(found.boardContextCount, 3, "boardContextCount should be preserved from meta.json");
});

test("listSessions handles old meta.json without boardContextCount", async (t) => {
  const id = `test-list-old-meta-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "review-list-old-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    const mgr = new ContextManager(false);
    await mgr.deleteSession(id);
  });

  // Write an old-format meta.json WITHOUT boardContextCount
  const metaPath = join(homedir(), ".claude", "review-cache", `${id}.meta.json`);
  const statePath = join(homedir(), ".claude", "review-cache", `${id}.state.json`);
  await writeFile(metaPath, JSON.stringify({
    sessionId: id,
    createdAt: Date.now(),
    indexedPaths: ["b.ts"],
    workspaceRoot: directory,
  }));
  await writeFile(statePath, "{}");

  const manager = new ContextManager(false);
  const sessions = await manager.listSessions();
  const found = sessions.find((s) => s.sessionId === id);

  assert.ok(found, `session ${id} should appear in list`);
  assert.equal(found.boardContextCount, undefined, "boardContextCount should be undefined for old sessions");
});
