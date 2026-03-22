import { DirectContext, type File, type IndexingResult } from "@augmentcode/auggie-sdk";
import { readFile, writeFile, rename, unlink, stat } from "fs/promises";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve, relative } from "path";
import { createHash } from "crypto";

const CACHE_DIR = join(
  process.env.HOME ?? "~",
  ".claude",
  "review-cache",
);

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB — SDK limit
const MAX_CACHE_ENTRIES = 500;

interface CachedResult {
  query: string;
  result: string;
  timestamp: number;
  maxOutputLength: number;
}

interface SessionMeta {
  sessionId: string;
  createdAt: number;
  indexedPaths: string[];
  workspaceRoot: string;
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ContextManager {
  private ctx: DirectContext | null = null;
  private resultCache = new Map<string, CachedResult>();
  private sessionId: string | null = null;
  private workspaceRoot: string | null = null;
  private indexingComplete = false;
  private debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  private log(msg: string): void {
    if (this.debug) {
      console.error(`[review-context] ${msg}`);
    }
  }

  private cacheKey(query: string, maxOutputLength: number): string {
    return createHash("sha256")
      .update(`${query}:${maxOutputLength}`)
      .digest("hex")
      .slice(0, 16);
  }

  private sessionPath(id: string): string {
    return join(CACHE_DIR, `${id}.state.json`);
  }

  private sessionMetaPath(id: string): string {
    return join(CACHE_DIR, `${id}.meta.json`);
  }

  private sessionCachePath(id: string): string {
    return join(CACHE_DIR, `${id}.cache.json`);
  }

  /**
   * Lazily create or return the existing DirectContext singleton.
   * If workspaceRoot changes, tear down and recreate.
   */
  private async ensureContext(workspaceRoot: string): Promise<DirectContext> {
    const resolvedRoot = resolve(workspaceRoot);

    if (this.ctx && this.workspaceRoot === resolvedRoot) {
      return this.ctx;
    }

    // Workspace changed or no context yet — tear down and recreate
    if (this.ctx) {
      this.log(`Workspace changed from ${this.workspaceRoot} to ${resolvedRoot}, recreating context`);
      try {
        await this.ctx.clearIndex();
      } catch (err) {
        this.log(`clearIndex failed during workspace change: ${toErrorMessage(err)}`);
      }
      // Reset all derived state — stale cache/session from old workspace must not leak
      this.ctx = null;
      this.sessionId = null;
      this.indexingComplete = false;
      this.resultCache.clear();
    }

    this.ctx = await DirectContext.create({
      debug: this.debug,
      clientUserAgent: "review-context-mcp/0.1.0",
    });
    this.workspaceRoot = resolvedRoot;
    return this.ctx;
  }

  /**
   * Index specific files into the DirectContext singleton.
   * Reuses existing context if workspace hasn't changed. Reads files
   * asynchronously, skips files > 1MB, and clears the result cache.
   */
  async indexFiles(
    paths: string[],
    workspaceRoot: string,
  ): Promise<{ newlyUploaded: string[]; alreadyUploaded: string[]; errors: string[] }> {
    this.indexingComplete = false;
    const ctx = await this.ensureContext(workspaceRoot);

    this.sessionId = createHash("sha256")
      .update(`${Date.now()}:${paths.join(",")}`)
      .digest("hex")
      .slice(0, 12);

    const files: File[] = [];
    const errors: string[] = [];

    // Read files concurrently with size guard
    const readResults = await Promise.allSettled(
      paths.map(async (p) => {
        const absPath = resolve(this.workspaceRoot!, p);
        const fileStat = await stat(absPath);
        if (fileStat.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`exceeds 1MB (${(fileStat.size / 1_000_000).toFixed(1)}MB)`);
        }
        const contents = await readFile(absPath, "utf-8");
        const relPath = relative(this.workspaceRoot!, absPath);
        return { path: relPath, contents } as File;
      }),
    );

    for (let i = 0; i < readResults.length; i++) {
      const result = readResults[i];
      if (result.status === "fulfilled") {
        files.push(result.value);
      } else {
        errors.push(`${paths[i]}: ${toErrorMessage(result.reason)}`);
      }
    }

    if (files.length === 0) {
      throw new Error(`No readable files found. Errors: ${errors.slice(0, 10).join("; ")}`);
    }

    this.log(`Indexing ${files.length} files (${errors.length} errors)`);

    const result: IndexingResult = await ctx.addToIndex(files, {
      waitForIndexing: true,
      timeout: 5 * 60 * 1000,
    });

    // Explicit cache invalidation — index content changed
    this.resultCache.clear();
    this.indexingComplete = true;

    return {
      newlyUploaded: result.newlyUploaded,
      alreadyUploaded: result.alreadyUploaded,
      errors,
    };
  }

  /**
   * Index an entire directory by reading all text files.
   */
  async indexDirectory(
    directory: string,
    globPatterns?: string[],
  ): Promise<{ newlyUploaded: string[]; alreadyUploaded: string[]; fileCount: number }> {
    const { globSync } = await import("glob");

    const absDir = resolve(directory);
    const patterns = globPatterns ?? ["**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,md,json,yaml,yml,toml}"];
    const allFiles: string[] = [];
    for (const pattern of patterns) {
      const matches = globSync(pattern, {
        cwd: absDir,
        nodir: true,
        ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/venv/**", "**/__pycache__/**"],
      });
      allFiles.push(...matches);
    }

    const uniquePaths = [...new Set(allFiles)];
    this.log(`Found ${uniquePaths.length} files matching patterns`);

    return {
      ...(await this.indexFiles(uniquePaths, absDir)),
      fileCount: uniquePaths.length,
    };
  }

  /**
   * Search the indexed codebase. Caches results for reuse across phases.
   */
  async search(
    query: string,
    maxOutputLength = 20000,
  ): Promise<{ result: string; cached: boolean }> {
    if (!this.ctx) {
      throw new Error("No index — call review_index_files or review_index_directory first");
    }
    if (!this.indexingComplete) {
      throw new Error("Indexing has not completed successfully. Call review_index_files to build an index before searching.");
    }

    const key = this.cacheKey(query, maxOutputLength);
    const cached = this.resultCache.get(key);
    if (cached) {
      this.log(`Cache hit for query: ${query.slice(0, 60)}...`);
      return { result: cached.result, cached: true };
    }

    this.log(`Searching: ${query.slice(0, 60)}...`);
    const result = await this.ctx.search(query, { maxOutputLength });

    this.resultCache.set(key, {
      query,
      result,
      timestamp: Date.now(),
      maxOutputLength,
    });

    // Simple cache size threshold
    if (this.resultCache.size > MAX_CACHE_ENTRIES) {
      const firstKey = this.resultCache.keys().next().value;
      if (firstKey !== undefined) this.resultCache.delete(firstKey);
    }

    return { result, cached: false };
  }

  /**
   * Search and ask: combines retrieval with an LLM call via Augment.
   * Requires AUGMENT_API_TOKEN and AUGMENT_API_URL env vars.
   */
  async searchAndAsk(
    query: string,
    prompt?: string,
  ): Promise<string> {
    if (!this.ctx) {
      throw new Error("No index — call review_index_files or review_index_directory first");
    }
    if (!this.indexingComplete) {
      throw new Error("Indexing is still in progress or has not been started.");
    }
    if (!process.env.AUGMENT_API_TOKEN || !process.env.AUGMENT_API_URL) {
      throw new Error(
        "searchAndAsk requires AUGMENT_API_TOKEN and AUGMENT_API_URL environment variables. " +
        "These are read from ~/.augment/session.json by the SDK, but must also be set as env vars for LLM calls.",
      );
    }
    return this.ctx.searchAndAsk(query, prompt);
  }

  getCachedResult(key: string): CachedResult | undefined {
    return this.resultCache.get(key);
  }

  listCachedResults(): Array<{ key: string; query: string; timestamp: number }> {
    return Array.from(this.resultCache.entries()).map(([key, entry]) => ({
      key,
      query: entry.query,
      timestamp: entry.timestamp,
    }));
  }

  /**
   * Save the current session (index state + result cache) to disk.
   * Uses atomic writes (temp + rename) for meta and cache files.
   * Preserves createdAt from existing metadata on re-save.
   */
  async saveSession(sessionId?: string): Promise<string> {
    if (!this.ctx) {
      throw new Error("No active index to save");
    }

    const id = sessionId ?? this.sessionId ?? "default";
    const statePath = this.sessionPath(id);
    const metaPath = this.sessionMetaPath(id);
    const cachePath = this.sessionCachePath(id);

    // Get indexed paths before export (may throw on search-only context)
    let indexedPaths: string[] = [];
    try {
      indexedPaths = this.ctx.getIndexedPaths();
    } catch {
      this.log("getIndexedPaths() failed — saving with empty paths list");
    }

    // Save index state (SDK-controlled write)
    await this.ctx.exportToFile(statePath, { mode: "full" });

    // Preserve createdAt from existing metadata
    let createdAt = Date.now();
    if (existsSync(metaPath)) {
      try {
        const existing: SessionMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
        createdAt = existing.createdAt;
      } catch {
        // Corrupt meta — use current time
      }
    }

    const meta: SessionMeta = {
      sessionId: id,
      createdAt,
      indexedPaths,
      workspaceRoot: this.workspaceRoot ?? "",
    };

    // Atomic writes: temp file + rename
    const metaTmp = `${metaPath}.tmp`;
    const cacheTmp = `${cachePath}.tmp`;
    const cacheEntries = Array.from(this.resultCache.entries());

    await writeFile(metaTmp, JSON.stringify(meta, null, 2));
    await rename(metaTmp, metaPath);

    await writeFile(cacheTmp, JSON.stringify(cacheEntries, null, 2));
    await rename(cacheTmp, cachePath);

    this.log(`Session saved: ${id} (${indexedPaths.length} files, ${cacheEntries.length} cached results)`);
    return id;
  }

  /**
   * Resume a previously saved session.
   * Gracefully handles missing or corrupt meta/cache files.
   */
  async resumeSession(sessionId: string): Promise<{
    indexedFiles: number;
    cachedResults: number;
    workspaceRoot: string;
  }> {
    const statePath = this.sessionPath(sessionId);
    const metaPath = this.sessionMetaPath(sessionId);
    const cachePath = this.sessionCachePath(sessionId);

    if (!existsSync(statePath)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Restore index
    this.ctx = await DirectContext.importFromFile(statePath, {
      debug: this.debug,
      clientUserAgent: "review-context-mcp/0.1.0",
    });
    this.sessionId = sessionId;
    this.indexingComplete = true; // Restored from a completed session

    // Restore metadata (graceful on missing/corrupt)
    let meta: SessionMeta = {
      sessionId,
      createdAt: 0,
      indexedPaths: [],
      workspaceRoot: "",
    };
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      } catch {
        this.log(`Corrupt meta file for session ${sessionId}, using defaults`);
      }
    }
    // Always set workspaceRoot from meta (possibly the default fallback)
    // so it is never left null after a resume
    this.workspaceRoot = meta.workspaceRoot || null;

    // Restore result cache (graceful on missing/corrupt)
    this.resultCache.clear();
    if (existsSync(cachePath)) {
      try {
        const entries: Array<[string, CachedResult]> = JSON.parse(
          readFileSync(cachePath, "utf-8"),
        );
        for (const [key, value] of entries) {
          this.resultCache.set(key, value);
        }
      } catch {
        this.log(`Corrupt cache file for session ${sessionId}, starting with empty cache`);
      }
    }

    this.log(`Session resumed: ${sessionId}`);

    return {
      indexedFiles: meta.indexedPaths.length,
      cachedResults: this.resultCache.size,
      workspaceRoot: meta.workspaceRoot,
    };
  }

  listSessions(): SessionMeta[] {
    const sessions: SessionMeta[] = [];

    try {
      const files = readdirSync(CACHE_DIR);
      for (const file of files) {
        if (file.endsWith(".meta.json")) {
          try {
            const meta: SessionMeta = JSON.parse(
              readFileSync(join(CACHE_DIR, file), "utf-8"),
            );
            sessions.push(meta);
          } catch {
            // Skip corrupt meta files
          }
        }
      }
    } catch {
      // Cache dir doesn't exist or isn't readable
    }

    return sessions.sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    let deleted = false;

    for (const filePath of [
      this.sessionPath(sessionId),
      this.sessionMetaPath(sessionId),
      this.sessionCachePath(sessionId),
    ]) {
      if (existsSync(filePath)) {
        try {
          await unlink(filePath);
          deleted = true;
        } catch {
          // Best-effort cleanup
        }
      }
    }

    return deleted;
  }

  isActive(): boolean {
    return this.ctx !== null;
  }

  getStatus(): {
    active: boolean;
    sessionId: string | null;
    workspaceRoot: string | null;
    indexedFiles: number;
    indexingComplete: boolean;
    cachedResults: number;
  } {
    let indexedFiles = 0;
    if (this.ctx) {
      try {
        indexedFiles = this.ctx.getIndexedPaths().length;
      } catch {
        // search-only import or uninitialized — report 0
      }
    }

    return {
      active: this.ctx !== null,
      sessionId: this.sessionId,
      workspaceRoot: this.workspaceRoot,
      indexedFiles,
      indexingComplete: this.indexingComplete,
      cachedResults: this.resultCache.size,
    };
  }

  async clear(): Promise<void> {
    if (this.ctx) {
      try {
        await this.ctx.clearIndex();
      } catch (err) {
        this.log(`clearIndex failed during clear: ${toErrorMessage(err)}`);
      }
    }
    this.ctx = null;
    this.sessionId = null;
    this.workspaceRoot = null;
    this.indexingComplete = false;
    this.resultCache.clear();
  }
}
