import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ContextManager } from "../dist/context-manager.js";

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
