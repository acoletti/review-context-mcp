/**
 * [LAYER: INFRASTRUCTURE]
 */
import { DirectContext, type File, type IndexingResult } from "@augmentcode/auggie-sdk";
import { execFile } from "child_process";
import { readFile, writeFile, rename, unlink, stat, readdir } from "fs/promises";
import { mkdirSync } from "fs";
import { join, resolve, relative } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const CACHE_DIR = join(
  homedir(),
  ".claude",
  "review-cache",
);

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB — SDK limit
const MAX_CACHE_ENTRIES = 500; // FIFO eviction — oldest entry by insertion order
const MAX_BOARD_CACHE_ENTRIES = 50; // FIFO eviction — board contexts are larger per entry
export const MAX_ARTIFACT_CHARS = 100_000; // per artifact
export const MAX_ARTIFACT_TOTAL_CHARS = 500_000; // per session

interface ArtifactEntry {
  value: string;
  metadata?: {
    phase?: number;
    agent_name?: string;
    token_estimate?: number;
  };
  storedAt: number;
}

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
  boardContextCount?: number;
}

interface StructuredSearchChunk {
  id: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  lineCount: number;
  truncated: boolean;
  preview: string;
  snippet: string;
}

interface StructuredSearchResult {
  query: string;
  cached: boolean;
  chunkCount: number;
  chunks: StructuredSearchChunk[];
  rawResult: string;
}

interface IndexingSummary {
  performed: boolean;
  fileCount: number;
  newlyUploaded: string[];
  alreadyUploaded: string[];
  errors: string[];
}

interface BoardPromptInput {
  user_request: string;
  focused_code_excerpts: string;
  augment_retrieval_excerpts: string;
  corpus_reference_excerpts: string;
  applicable_coding_standards: string;
  repository_state: string;
  project_rules: string;
  external_documentation: string;
  external_documentation_summary: string;
  cross_repository_patterns: string;
  cross_repository_patterns_summary: string;
  referenced_file_paths: string[];
}

type BoardContextPhase = "planning" | "debate" | "synthesis";

interface PreparedContextSection {
  key: string;
  label: string;
  body: string;
  priority: number;
  required: boolean;
  mode: "full" | "summary" | "omitted";
}

interface PreparedContextPackage {
  budget_chars: number;
  sections: PreparedContextSection[];
}

interface PreparedBoardContext {
  workspaceRoot: string;
  userRequest: string;
  retrievalQuery: string;
  sessionId: string | null;
  generatedAt: number;
  indexing: IndexingSummary;
  structuredSearch: StructuredSearchResult;
  builderInput: BoardPromptInput;
  preparedContextPackages: Partial<Record<BoardContextPhase, PreparedContextPackage>>;
  artifactMarkdown: string;
}

interface PersistedCaches {
  searchResults: Array<[string, CachedResult]>;
  boardContexts?: Array<[string, PreparedBoardContext]>;
  // Per-session blackboard artifacts. Optional for backward compatibility with
  // session cache files written before artifact persistence was added.
  artifacts?: Array<[string, ArtifactEntry]>;
}

interface PrepareBoardContextOptions {
  workspaceRoot: string;
  userRequest: string;
  paths?: string[];
  retrievalQuery?: string;
  maxOutputLength?: number;
  excerptCharLimit?: number;
  includeLegacyDoc?: boolean;
  budgetCharsPerToken?: number;
  phaseContextTargetTokens?: Partial<Record<BoardContextPhase, number>>;
  sectionSummaryCharLimits?: Record<string, number>;
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: string }).code === "ENOENT";
}

/**
 * Maximum bytes for the MCP tool-result text field.
 *
 * Claude Code imposes a character limit on MCP tool results that includes the
 * JSON envelope wrapping (`[{"type":"text","text":"..."}]`).  The envelope adds
 * ~4-5 KB of overhead from JSON string-escaping (every `"` in the inner JSON
 * becomes `\"`).  We budget 60 KB for the inner payload so the total result
 * stays well under Claude's ~80 K character ceiling even for multi-byte or
 * quote-heavy content.
 *
 * When the payload exceeds this limit after progressive trimming, the server
 * returns a pagination hint and the orchestrator re-calls with offset/limit.
 */
export const TRANSPORT_MAX_BYTES = 60_000;

export interface PaginationMeta {
  total_bytes: number;
  offset: number;
  limit: number;
  has_more: boolean;
  bytes_in_chunk: number;
}

/**
 * Build the MCP transport payload for review_prepare_board_context.
 * Uses planning-phase section bodies for excerpt fields so summarized content
 * is not bypassed by the raw builderInput values.
 *
 * Progressive trimming stages when the serialized result exceeds TRANSPORT_MAX_BYTES:
 *   1. Drop artifact_markdown (derivable from planning sections)
 *   2. Replace remaining builder_input text fields with planning-section summaries
 *   3. Trim structured_search to metadata only (drop chunks array)
 *   4. Drop debate/synthesis packages (planning has the critical data)
 */
export function buildBoardContextPayload(
  context: PreparedBoardContext,
  cached: boolean,
): Record<string, unknown> {
  const { rawResult: _raw, ...structuredSearch } = context.structuredSearch;

  // Always deduplicate builder_input against planning sections.
  // Planning sections may be summarized to fit prompt budgets; raw builder_input
  // fields can be 5-15x larger.  Using the planning bodies consistently keeps
  // the payload compact and prevents envelope-size surprises.
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
    repository_state: getSectionBody(
      "repository_state",
      context.builderInput.repository_state,
    ),
    project_rules: getSectionBody(
      "project_rules",
      context.builderInput.project_rules,
    ),
    corpus_reference_excerpts: getSectionBody(
      "corpus_reference_excerpts",
      context.builderInput.corpus_reference_excerpts,
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

  let bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

  // Stage 1: Drop artifact_markdown (rendering of planning sections)
  if (bytes > TRANSPORT_MAX_BYTES) {
    delete payload.artifact_markdown;
    bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  }

  // Stage 2: Replace builder_input text fields with their planning-section summaries
  if (bytes > TRANSPORT_MAX_BYTES) {
    const bi = payload.builder_input as Record<string, unknown>;
    for (const key of ["repository_state", "project_rules", "corpus_reference_excerpts"]) {
      const section = planSections.find((s) => s.key === key);
      if (section && typeof bi[key] === "string" && (bi[key] as string).length > section.body.length) {
        bi[key] = section.body;
      }
    }
    bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  }

  // Stage 3: Trim structured_search to metadata only
  if (bytes > TRANSPORT_MAX_BYTES) {
    payload.structured_search = {
      query: structuredSearch.query,
      cached: structuredSearch.cached,
      chunkCount: structuredSearch.chunkCount,
    };
    bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  }

  // Stage 4: Drop debate/synthesis packages (planning has the critical data)
  if (bytes > TRANSPORT_MAX_BYTES) {
    const packages = { ...context.preparedContextPackages };
    delete packages.debate;
    delete packages.synthesis;
    payload.prepared_context_packages = packages;
    bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  }

  return payload;
}

/**
 * Paginate a board context payload for chunked retrieval over MCP transport.
 * Serializes the payload as compact JSON and returns the requested byte range
 * inside a pagination envelope.  Offset and limit are byte-based so the
 * transport budget is honored exactly, even for multi-byte UTF-8 content.
 * Chunk boundaries are aligned to UTF-8 character boundaries — callers must
 * use `bytes_in_chunk` (not `limit`) to compute the next offset.
 */
export function paginateBoardContextPayload(
  payload: Record<string, unknown>,
  offset: number,
  limit: number,
): { content: Array<{ type: "text"; text: string }>; pagination: PaginationMeta } {
  const serialized = JSON.stringify(payload);
  const buf = Buffer.from(serialized, "utf8");
  const totalBytes = buf.length;
  const effectiveOffset = Math.min(offset, totalBytes);
  const rawEnd = Math.min(effectiveOffset + limit, totalBytes);

  // Ensure the chunk ends on a complete UTF-8 character boundary
  let safeEnd = rawEnd;
  if (safeEnd < totalBytes && safeEnd > effectiveOffset) {
    let pos = safeEnd - 1;
    while (pos > effectiveOffset && (buf[pos] & 0xC0) === 0x80) {
      pos--;
    }
    const lead = buf[pos];
    let seqLen = 1;
    if ((lead & 0x80) === 0) seqLen = 1;
    else if ((lead & 0xE0) === 0xC0) seqLen = 2;
    else if ((lead & 0xF0) === 0xE0) seqLen = 3;
    else if ((lead & 0xF8) === 0xF0) seqLen = 4;
    if (pos + seqLen > rawEnd) safeEnd = pos;
  }

  const chunk = buf.subarray(effectiveOffset, safeEnd).toString("utf8");
  const bytesInChunk = safeEnd - effectiveOffset;
  const hasMore = safeEnd < totalBytes;

  const pagination: PaginationMeta = {
    total_bytes: totalBytes,
    offset: effectiveOffset,
    limit,
    has_more: hasMore,
    bytes_in_chunk: bytesInChunk,
  };

  const envelope = { _pagination: pagination, chunk };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    pagination,
  };
}

export class ContextManager {
  private ctx: DirectContext | null = null;
  private resultCache = new Map<string, CachedResult>();
  private boardContextCache = new Map<string, PreparedBoardContext>();
  private artifactStore = new Map<string, Map<string, ArtifactEntry>>();
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

  private shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }

  private normalizePaths(paths: string[], workspaceRoot: string): string[] {
    const resolvedRoot = resolve(workspaceRoot);
    return [...new Set(
      paths.map((path) => relative(resolvedRoot, resolve(resolvedRoot, path))),
    )].sort();
  }

  private async pathFingerprint(paths: string[], workspaceRoot: string): Promise<string> {
    const entries = await Promise.all(
      paths.map(async (path) => {
        try {
          const fileStat = await stat(resolve(workspaceRoot, path));
          return `${path}:${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`;
        } catch (err) {
          return `${path}:missing:${toErrorMessage(err)}`;
        }
      }),
    );
    return entries.join("|");
  }

  private parseStructuredChunks(rawResult: string): StructuredSearchChunk[] {
    const pathMatches = [...rawResult.matchAll(/^Path:\s+(.+)$/gm)];
    if (pathMatches.length === 0) {
      const snippet = rawResult.trim();
      if (!snippet) {
        return [];
      }
      return [{
        id: this.shortHash(`raw:${snippet}`),
        path: null,
        startLine: null,
        endLine: null,
        lineCount: 0,
        truncated: snippet.includes("..."),
        preview: snippet.split("\n").find((line) => line.trim() !== "")?.trim() ?? "",
        snippet,
      }];
    }

    return pathMatches.map((match, index) => {
      const path = match[1].trim();
      const sectionStart = (match.index ?? 0) + match[0].length;
      const sectionEnd = index + 1 < pathMatches.length
        ? pathMatches[index + 1].index ?? rawResult.length
        : rawResult.length;
      const body = rawResult.slice(sectionStart, sectionEnd).trim();
      const lines = body.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");

      let startLine: number | null = null;
      let endLine: number | null = null;
      let lineCount = 0;

      for (const line of lines) {
        const lineMatch = line.match(/^\s*(\d+)\t?(.*)$/);
        if (!lineMatch) {
          continue;
        }
        const lineNumber = Number(lineMatch[1]);
        if (startLine === null) {
          startLine = lineNumber;
        }
        endLine = lineNumber;
        lineCount += 1;
      }

      const preview = lines
        .map((line) => line.replace(/^\s*\d+\t?/, "").trim())
        .find((line) => line !== "" && line !== "...") ?? "";

      const snippet = lines.join("\n");
      return {
        id: this.shortHash(`${path}:${startLine ?? "na"}:${endLine ?? "na"}:${snippet}`),
        path,
        startLine,
        endLine,
        lineCount,
        truncated: lines.some((line) => line.trim() === "..."),
        preview,
        snippet,
      };
    });
  }

  private renderStructuredChunks(chunks: StructuredSearchChunk[], maxChunks = 6): string {
    return chunks.slice(0, maxChunks).map((chunk) => {
      const lines = [`Path: ${chunk.path ?? "unknown"}`];
      if (chunk.startLine !== null && chunk.endLine !== null) {
        lines.push(`Lines: ${chunk.startLine}-${chunk.endLine}`);
      }
      lines.push(chunk.snippet);
      return lines.join("\n");
    }).join("\n\n");
  }

  private buildPreparedSection(
    key: string,
    label: string,
    body: string,
    priority: number,
    required = false,
  ): PreparedContextSection {
    return {
      key,
      label,
      body: body.trim(),
      priority,
      required,
      mode: "full",
    };
  }

  private renderPreparedSections(sections: PreparedContextSection[]): string {
    return sections
      .filter((section) => section.body.trim() !== "")
      .map((section) => `## ${section.label}\n${section.body.trim()}`)
      .join("\n\n");
  }

  private compactText(text: string, limit: number): string {
    const stripped = text.trim();
    if (!stripped) {
      return "";
    }
    if (stripped.length <= limit) {
      return stripped;
    }

    const suffix = "\n[... summarized]";
    const available = Math.max(limit - suffix.length, 0);
    return `${stripped.slice(0, available).trimEnd()}${suffix}`;
  }

  private summaryLimit(
    key: string,
    options: PrepareBoardContextOptions,
  ): number {
    return options.sectionSummaryCharLimits?.[key] ?? 600;
  }

  private minimumSummaryLimit(
    key: string,
    options: PrepareBoardContextOptions,
  ): number {
    return Math.max(Math.floor(this.summaryLimit(key, options) / 2), 220);
  }

  private phaseBudgetChars(
    phase: BoardContextPhase,
    options: PrepareBoardContextOptions,
  ): number {
    const phaseTokens = options.phaseContextTargetTokens?.[phase]
      ?? (phase === "planning" ? 5200 : phase === "debate" ? 1400 : 1600);
    const charsPerToken = options.budgetCharsPerToken ?? 4;
    return phaseTokens * charsPerToken;
  }

  private budgetPreparedSections(
    sections: PreparedContextSection[],
    targetChars: number,
    options: PrepareBoardContextOptions,
  ): PreparedContextSection[] {
    const active = sections
      .filter((section) => section.body.trim() !== "")
      .map((section) => ({ ...section }));
    if (active.length === 0 || this.renderPreparedSections(active).length <= targetChars) {
      return active;
    }

    const summarizeSections = (): void => {
      const sorted = [...active].sort((a, b) => {
        if (a.priority === b.priority) {
          return a.label.localeCompare(b.label);
        }
        return b.priority - a.priority;
      });

      for (const section of sorted) {
        const limit = this.summaryLimit(section.key, options);
        if (section.body.length <= limit) {
          continue;
        }
        section.body = this.compactText(section.body, limit);
        section.mode = "summary";
        if (this.renderPreparedSections(active).length <= targetChars) {
          return;
        }
      }
    };

    summarizeSections();
    if (this.renderPreparedSections(active).length <= targetChars) {
      return active;
    }

    const sorted = [...active].sort((a, b) => {
      if (a.priority === b.priority) {
        return a.label.localeCompare(b.label);
      }
      return b.priority - a.priority;
    });

    for (const section of sorted) {
      if (this.renderPreparedSections(active).length <= targetChars) {
        break;
      }
      if (section.required) {
        continue;
      }
      section.body = "";
      section.mode = "omitted";
    }

    for (const section of sorted) {
      if (this.renderPreparedSections(active).length <= targetChars) {
        break;
      }
      const minLimit = this.minimumSummaryLimit(section.key, options);
      if (section.body.length <= minLimit) {
        continue;
      }
      section.body = this.compactText(section.body, minLimit);
      section.mode = "summary";
    }

    return active;
  }

  private sharedSectionsForPhase(
    phase: BoardContextPhase,
    builderInput: BoardPromptInput,
  ): PreparedContextSection[] {
    switch (phase) {
      case "planning":
        return [
          this.buildPreparedSection("user_request", "User Request", builderInput.user_request, 1, true),
          this.buildPreparedSection("focused_code_excerpts", "Focused Code Excerpts", builderInput.focused_code_excerpts, 3),
          this.buildPreparedSection("augment_retrieval_excerpts", "Augment Retrieval Excerpts", builderInput.augment_retrieval_excerpts, 3),
          this.buildPreparedSection("corpus_reference_excerpts", "Corpus Reference Excerpts", builderInput.corpus_reference_excerpts, 4),
          this.buildPreparedSection("applicable_coding_standards", "Applicable Coding Standards", builderInput.applicable_coding_standards, 2, true),
          this.buildPreparedSection("repository_state", "Repository State", builderInput.repository_state, 5),
          this.buildPreparedSection("project_rules", "Project Rules", builderInput.project_rules, 5),
          this.buildPreparedSection("referenced_file_paths", "Referenced File Paths", builderInput.referenced_file_paths.join("\n"), 2, true),
        ];
      case "debate":
        return [
          this.buildPreparedSection("user_request", "User Request", builderInput.user_request, 1, true),
          this.buildPreparedSection("applicable_coding_standards", "Applicable Coding Standards", builderInput.applicable_coding_standards, 2, true),
          this.buildPreparedSection("repository_state", "Repository State", builderInput.repository_state, 4),
          this.buildPreparedSection("referenced_file_paths", "Referenced File Paths", builderInput.referenced_file_paths.join("\n"), 2, true),
        ];
      case "synthesis":
        return [
          this.buildPreparedSection("user_request", "User Request", builderInput.user_request, 1, true),
          this.buildPreparedSection("applicable_coding_standards", "Applicable Coding Standards", builderInput.applicable_coding_standards, 2, true),
          this.buildPreparedSection("repository_state", "Repository State", builderInput.repository_state, 4),
          this.buildPreparedSection("referenced_file_paths", "Referenced File Paths", builderInput.referenced_file_paths.join("\n"), 2, true),
        ];
    }
  }

  private buildPreparedContextPackages(
    builderInput: BoardPromptInput,
    options: PrepareBoardContextOptions,
  ): Partial<Record<BoardContextPhase, PreparedContextPackage>> {
    const phases: BoardContextPhase[] = ["planning", "debate", "synthesis"];
    const packages: Partial<Record<BoardContextPhase, PreparedContextPackage>> = {};

    for (const phase of phases) {
      const budgetChars = this.phaseBudgetChars(phase, options);
      packages[phase] = {
        budget_chars: budgetChars,
        sections: this.budgetPreparedSections(
          this.sharedSectionsForPhase(phase, builderInput),
          budgetChars,
          options,
        ),
      };
    }

    return packages;
  }

  private async buildFocusedCodeExcerpts(
    paths: string[],
    workspaceRoot: string,
    maxChars: number,
  ): Promise<string> {
    let remainingChars = maxChars;
    const sections: string[] = [];

    for (const path of paths) {
      if (remainingChars <= 0) {
        break;
      }

      try {
        const contents = await readFile(resolve(workspaceRoot, path), "utf-8");
        const numberedContents = contents
          .split("\n")
          .map((line, index) => `${String(index + 1).padStart(5)}\t${line}`)
          .join("\n");

        let section = `Path: ${path}\n${numberedContents}`;
        if (section.length > remainingChars) {
          const truncated = section.slice(0, Math.max(remainingChars - 18, 0)).trimEnd();
          section = `${truncated}\n... [truncated]`;
        }

        sections.push(section);
        remainingChars -= section.length + 2;
      } catch (err) {
        const section = `Path: ${path}\n[unreadable] ${toErrorMessage(err)}`;
        if (section.length > remainingChars) {
          break;
        }
        sections.push(section);
        remainingChars -= section.length + 2;
      }
    }

    return sections.join("\n\n");
  }

  private async readOptionalContextFile(workspaceRoot: string, fileName: string): Promise<string> {
    const filePath = join(workspaceRoot, fileName);
    try {
      return await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if (isEnoent(err)) return "";
      return `[unreadable ${fileName}] ${toErrorMessage(err)}`;
    }
  }

  private async collectProjectRules(workspaceRoot: string, includeLegacyDoc: boolean): Promise<string> {
    const sections: string[] = [];
    const agents = await this.readOptionalContextFile(workspaceRoot, "AGENTS.md");
    if (agents) {
      sections.push(`File: AGENTS.md\n${agents}`);
    }

    if (includeLegacyDoc) {
      const claude = await this.readOptionalContextFile(workspaceRoot, "CLAUDE.md");
      if (claude) {
        sections.push(`File: CLAUDE.md\n${claude}`);
      }
    }

    return sections.join("\n\n");
  }

  private async getRepositoryStateSummary(workspaceRoot: string): Promise<string> {
    const status = this.getStatus();
    const lines = [
      `Workspace: ${resolve(workspaceRoot)}`,
      `Session ID: ${status.sessionId ?? "none"}`,
      `Indexed files: ${status.indexedFiles}`,
      `Indexing complete: ${status.indexingComplete}`,
      `Cached search results: ${status.cachedResults}`,
      `Prepared board contexts: ${status.preparedBoardContexts}`,
    ];

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", resolve(workspaceRoot), "status", "--short"],
        { encoding: "utf-8", timeout: 10_000 },
      );
      lines.push("Git status:");
      lines.push(stdout.trim() || "(clean)");
    } catch {
      lines.push("Git status: unavailable");
    }

    return lines.join("\n");
  }

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
      this.boardContextCache.clear();
      this.artifactStore.clear();
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

    // Only generate a new session ID if one isn't already active.
    // ensureContext resets sessionId when workspace changes, so this
    // guard prevents clobbering the ID on repeated indexFiles calls.
    if (!this.sessionId) {
      this.sessionId = createHash("sha256")
        .update(`${Date.now()}:${paths.join(",")}`)
        .digest("hex")
        .slice(0, 12);
    }

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
    this.boardContextCache.clear();
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
  ): Promise<{
    newlyUploaded: string[];
    alreadyUploaded: string[];
    errors: string[];
    fileCount: number;
  }> {
    const { glob } = await import("glob");

    const absDir = resolve(directory);
    const patterns = globPatterns ?? ["**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,md,json,yaml,yml,toml}"];
    const allFiles: string[] = [];
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
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
    while (this.resultCache.size > MAX_CACHE_ENTRIES) {
      const firstKey = this.resultCache.keys().next().value;
      if (firstKey !== undefined) this.resultCache.delete(firstKey);
      else break;
    }

    return { result, cached: false };
  }

  async searchStructured(
    query: string,
    maxOutputLength = 20000,
  ): Promise<StructuredSearchResult> {
    const { result, cached } = await this.search(query, maxOutputLength);
    const chunks = this.parseStructuredChunks(result);

    return {
      query,
      cached,
      chunkCount: chunks.length,
      chunks,
      rawResult: result,
    };
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
        "searchAndAsk requires AUGMENT_API_TOKEN and AUGMENT_API_URL in the MCP server env. " +
        "review_search_and_ask does not use the ~/.augment/session.json fallback used by indexing and semantic search.",
      );
    }
    return this.ctx.searchAndAsk(query, prompt);
  }

  getCachedResult(key: string): CachedResult | undefined {
    return this.resultCache.get(key);
  }

  async prepareBoardContext(options: PrepareBoardContextOptions): Promise<{
    context: PreparedBoardContext;
    cached: boolean;
  }> {
    const workspaceRoot = resolve(options.workspaceRoot);
    const normalizedPaths = this.normalizePaths(options.paths ?? [], workspaceRoot);
    const retrievalQuery = options.retrievalQuery?.trim() || options.userRequest;
    const maxOutputLength = options.maxOutputLength ?? 12000;
    const excerptCharLimit = options.excerptCharLimit ?? 16000;
    const includeLegacyDoc = options.includeLegacyDoc ?? false;
    const fingerprint = await this.pathFingerprint(normalizedPaths, workspaceRoot);
    const cacheKey = this.shortHash(JSON.stringify({
      workspaceRoot,
      userRequest: options.userRequest,
      retrievalQuery,
      paths: normalizedPaths,
      fingerprint,
      maxOutputLength,
      excerptCharLimit,
      includeLegacyDoc,
    }));

    const cachedContext = this.boardContextCache.get(cacheKey);
    if (
      cachedContext &&
      this.workspaceRoot === workspaceRoot &&
      this.indexingComplete
    ) {
      return { context: cachedContext, cached: true };
    }

    let indexing: IndexingSummary;
    if (normalizedPaths.length > 0) {
      const indexingResult = await this.indexFiles(normalizedPaths, workspaceRoot);
      indexing = {
        performed: true,
        fileCount: normalizedPaths.length,
        ...indexingResult,
      };
    } else {
      await this.ensureContext(workspaceRoot);
      if (!this.indexingComplete) {
        throw new Error(
          "No indexed context available for workspace_root. Provide paths to index or resume an existing session first.",
        );
      }
      indexing = {
        performed: false,
        fileCount: this.getStatus().indexedFiles,
        newlyUploaded: [],
        alreadyUploaded: [],
        errors: [],
      };
    }

    const structuredSearch = await this.searchStructured(retrievalQuery, maxOutputLength);
    const focusedCodeExcerpts = normalizedPaths.length > 0
      ? await this.buildFocusedCodeExcerpts(normalizedPaths, workspaceRoot, excerptCharLimit)
      : this.renderStructuredChunks(structuredSearch.chunks, 4);
    const augmentRetrievalExcerpts = this.renderStructuredChunks(structuredSearch.chunks, 8)
      || structuredSearch.rawResult;
    const projectRules = await this.collectProjectRules(workspaceRoot, includeLegacyDoc);
    const repositoryState = await this.getRepositoryStateSummary(workspaceRoot);
    const referencedFilePaths = normalizedPaths.map((path) => resolve(workspaceRoot, path));

    const builderInput: BoardPromptInput = {
      user_request: options.userRequest,
      focused_code_excerpts: focusedCodeExcerpts,
      augment_retrieval_excerpts: augmentRetrievalExcerpts,
      corpus_reference_excerpts: "",
      applicable_coding_standards: "",
      repository_state: repositoryState,
      project_rules: projectRules,
      external_documentation: "",
      external_documentation_summary: "",
      cross_repository_patterns: "",
      cross_repository_patterns_summary: "",
      referenced_file_paths: referencedFilePaths,
    };
    const preparedContextPackages = this.buildPreparedContextPackages(builderInput, options);

    const context: PreparedBoardContext = {
      workspaceRoot,
      userRequest: options.userRequest,
      retrievalQuery,
      sessionId: this.sessionId,
      generatedAt: Date.now(),
      indexing,
      structuredSearch,
      builderInput,
      preparedContextPackages,
      artifactMarkdown: "",
    };

    context.artifactMarkdown = this.buildBoardArtifact(context);
    this.boardContextCache.set(cacheKey, context);

    while (this.boardContextCache.size > MAX_BOARD_CACHE_ENTRIES) {
      const firstKey = this.boardContextCache.keys().next().value;
      if (firstKey !== undefined) this.boardContextCache.delete(firstKey);
      else break;
    }

    return { context, cached: false };
  }

  buildBoardContextPayload(context: PreparedBoardContext, cached: boolean): Record<string, unknown> {
    return buildBoardContextPayload(context, cached);
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
    try {
      const existing: SessionMeta = JSON.parse(await readFile(metaPath, "utf-8"));
      createdAt = existing.createdAt;
    } catch {
      // Missing or corrupt meta — use current time
    }

    const meta: SessionMeta = {
      sessionId: id,
      createdAt,
      indexedPaths,
      workspaceRoot: this.workspaceRoot ?? "",
      boardContextCount: this.boardContextCache.size,
    };

    // Atomic writes: temp file + rename
    const metaTmp = `${metaPath}.tmp`;
    const cacheTmp = `${cachePath}.tmp`;
    // Include this session's blackboard artifacts in the persisted cache so they
    // survive MCP daemon restarts (previously they were in-memory only and lost
    // when the server stopped). Restored in resumeSession.
    const sessionArtifacts = this.artifactStore.get(id);
    const persistedCaches: PersistedCaches = {
      searchResults: Array.from(this.resultCache.entries()),
      boardContexts: Array.from(this.boardContextCache.entries()),
      artifacts: sessionArtifacts ? Array.from(sessionArtifacts.entries()) : [],
    };

    await writeFile(metaTmp, JSON.stringify(meta, null, 2));
    await rename(metaTmp, metaPath);

    await writeFile(cacheTmp, JSON.stringify(persistedCaches, null, 2));
    await rename(cacheTmp, cachePath);

    this.sessionId = id;
    this.log(
      `Session saved: ${id} (${indexedPaths.length} files, ` +
      `${persistedCaches.searchResults.length} cached searches, ` +
      `${persistedCaches.boardContexts?.length ?? 0} board contexts, ` +
      `${persistedCaches.artifacts?.length ?? 0} artifacts)`,
    );
    return id;
  }

  /**
   * Resume a previously saved session.
   * Gracefully handles missing or corrupt meta/cache files.
   */
  async resumeSession(sessionId: string): Promise<{
    indexedFiles: number;
    cachedResults: number;
    boardContextCount: number;
    sessionAge: number;
    workspaceRoot: string;
  }> {
    const statePath = this.sessionPath(sessionId);
    const metaPath = this.sessionMetaPath(sessionId);
    const cachePath = this.sessionCachePath(sessionId);

    // Verify state file exists before attempting import
    try {
      await stat(statePath);
    } catch {
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
    try {
      meta = JSON.parse(await readFile(metaPath, "utf-8"));
    } catch {
      this.log(`Missing or corrupt meta file for session ${sessionId}, using defaults`);
    }
    // Always set workspaceRoot from meta (possibly the default fallback)
    // so it is never left null after a resume
    this.workspaceRoot = meta.workspaceRoot || null;

    // Restore result cache (graceful on missing/corrupt).
    // Map iterates in insertion order (ES2015); FIFO eviction evicts oldest-serialized entry.
    this.resultCache.clear();
    this.boardContextCache.clear();
    // Clear only THIS session's artifacts before restoring (other sessions' artifacts
    // in the in-memory store should be preserved).
    this.artifactStore.delete(sessionId);
    try {
      const parsed: PersistedCaches | Array<[string, CachedResult]> = JSON.parse(
        await readFile(cachePath, "utf-8"),
      );

      const searchEntries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.searchResults)
          ? parsed.searchResults
          : [];
      for (const [key, value] of searchEntries) {
        this.resultCache.set(key, value);
      }

      const boardEntries = !Array.isArray(parsed) && Array.isArray(parsed.boardContexts)
        ? parsed.boardContexts
        : [];
      for (const [key, value] of boardEntries) {
        this.boardContextCache.set(key, value);
      }

      // Restore blackboard artifacts for this session (graceful on missing field
      // for backward compatibility with cache files written before this feature).
      const artifactEntries = !Array.isArray(parsed) && Array.isArray(parsed.artifacts)
        ? parsed.artifacts
        : [];
      if (artifactEntries.length > 0) {
        const bucket = new Map<string, ArtifactEntry>();
        for (const [key, value] of artifactEntries) {
          bucket.set(key, value);
        }
        this.artifactStore.set(sessionId, bucket);
      }
    } catch {
      this.log(`Missing or corrupt cache file for session ${sessionId}, starting with empty cache`);
    }

    // Enforce caps in case limits were lowered since the session was saved
    while (this.resultCache.size > MAX_CACHE_ENTRIES) {
      const firstKey = this.resultCache.keys().next().value;
      if (firstKey !== undefined) this.resultCache.delete(firstKey);
      else break;
    }
    while (this.boardContextCache.size > MAX_BOARD_CACHE_ENTRIES) {
      const firstKey = this.boardContextCache.keys().next().value;
      if (firstKey !== undefined) this.boardContextCache.delete(firstKey);
      else break;
    }

    this.log(`Session resumed: ${sessionId}`);

    return {
      indexedFiles: meta.indexedPaths.length,
      cachedResults: this.resultCache.size,
      boardContextCount: this.boardContextCache.size,
      sessionAge: meta.createdAt > 0 ? Date.now() - meta.createdAt : 0,
      workspaceRoot: this.workspaceRoot ?? "",
    };
  }

  async listSessions(): Promise<SessionMeta[]> {
    const sessions: SessionMeta[] = [];

    try {
      const files = await readdir(CACHE_DIR);
      const metaFiles = files.filter((file: string) => file.endsWith(".meta.json"));
      const results = await Promise.allSettled(
        metaFiles.map(async (file: string) => {
          const meta: SessionMeta = JSON.parse(
            await readFile(join(CACHE_DIR, file), "utf-8"),
          );
          if (meta.sessionId && meta.createdAt) return meta;
          return null;
        }),
      );
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          sessions.push(result.value);
        } else if (result.status === "rejected") {
          this.log(`Skipping unreadable session file: ${toErrorMessage(result.reason)}`);
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
      try {
        await unlink(filePath);
        deleted = true;
      } catch (err) {
        if (!isEnoent(err)) {
          this.log(`Warning: failed to delete ${filePath}: ${toErrorMessage(err)}`);
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
    preparedBoardContexts: number;
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
      preparedBoardContexts: this.boardContextCache.size,
    };
  }

  // ─── Artifact blackboard ─────────────────────────────────────────────

  private sessionTotalChars(sessionId: string): number {
    const bucket = this.artifactStore.get(sessionId);
    if (!bucket) return 0;
    let total = 0;
    for (const entry of bucket.values()) total += entry.value.length;
    return total;
  }

  storeArtifact(
    sessionId: string,
    key: string,
    value: string,
    metadata?: ArtifactEntry["metadata"],
  ): { stored: true; key: string; chars: number } {
    if (value.length > MAX_ARTIFACT_CHARS) {
      throw new Error(
        `Artifact "${key}" exceeds ${MAX_ARTIFACT_CHARS} character limit (${value.length} chars)`,
      );
    }

    let bucket = this.artifactStore.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.artifactStore.set(sessionId, bucket);
    }

    const existingChars = bucket.get(key)?.value.length ?? 0;
    const newTotal = this.sessionTotalChars(sessionId) - existingChars + value.length;
    if (newTotal > MAX_ARTIFACT_TOTAL_CHARS) {
      throw new Error(
        `Session "${sessionId}" would exceed ${MAX_ARTIFACT_TOTAL_CHARS} character artifact limit ` +
        `(current: ${this.sessionTotalChars(sessionId) - existingChars}, adding: ${value.length})`,
      );
    }

    bucket.set(key, { value, metadata, storedAt: Date.now() });
    this.log(`Artifact stored: ${sessionId}/${key} (${value.length} chars)`);
    return { stored: true, key, chars: value.length };
  }

  readArtifacts(
    sessionId: string,
    keys: string[],
  ): { artifacts: Record<string, string | null>; missing: string[] } {
    const bucket = this.artifactStore.get(sessionId);
    const artifacts: Record<string, string | null> = {};
    const missing: string[] = [];

    for (const key of keys) {
      const entry = bucket?.get(key);
      if (entry) {
        artifacts[key] = entry.value;
      } else {
        artifacts[key] = null;
        missing.push(key);
      }
    }

    this.log(`Artifacts read: ${keys.length} requested, ${missing.length} missing`);
    return { artifacts, missing };
  }

  clearArtifacts(
    sessionId: string,
    prefix: string,
  ): { cleared: string[]; count: number } {
    const bucket = this.artifactStore.get(sessionId);
    if (!bucket) return { cleared: [], count: 0 };

    const cleared: string[] = [];
    for (const key of bucket.keys()) {
      if (key.startsWith(prefix)) {
        bucket.delete(key);
        cleared.push(key);
      }
    }

    if (bucket.size === 0) {
      this.artifactStore.delete(sessionId);
    }

    this.log(`Artifacts cleared: ${cleared.length} keys matching "${prefix}"`);
    return { cleared, count: cleared.length };
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
    this.boardContextCache.clear();
    this.artifactStore.clear();
  }
}
