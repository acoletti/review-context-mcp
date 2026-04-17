#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ContextManager, toErrorMessage, buildBoardContextPayload, paginateBoardContextPayload, TRANSPORT_MAX_BYTES } from "./context-manager.js";

const debug = process.env.REVIEW_CONTEXT_DEBUG === "true";
const manager = new ContextManager(debug);

function formatAge(ms: number): string {
  if (ms <= 0) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

const server = new McpServer({
  name: "review-context",
  version: "0.1.0",
});

// ─── Tool: review_index_files ────────────────────────────────────────────
// Selectively index specific files into Augment's context engine.
// Use this when you know exactly which files are relevant to the review.

server.tool(
  "review_index_files",
  "Index specific files into Augment's context engine for search. " +
    "Use this at the start of a code review to build a targeted index. " +
    "Files are read from disk and uploaded to Augment's backend for semantic search.",
  {
    paths: z
      .array(z.string())
      .describe("File paths to index (absolute or relative to workspace_root)"),
    workspace_root: z
      .string()
      .describe("Absolute path to the workspace/repository root directory"),
  },
  async ({ paths, workspace_root }) => {
    try {
      const result = await manager.indexFiles(paths, workspace_root);
      const summary = [
        `Indexed ${result.newlyUploaded.length} new files, ${result.alreadyUploaded.length} already cached.`,
      ];
      if (result.errors.length > 0) {
        summary.push(`Errors (${result.errors.length}): ${result.errors.join("; ")}`);
      }
      return {
        content: [{ type: "text" as const, text: summary.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_index_directory ────────────────────────────────────────
// Index an entire directory with glob pattern filtering.

server.tool(
  "review_index_directory",
  "Index all matching files in a directory into Augment's context engine. " +
    "Defaults to common source file extensions. Excludes node_modules, dist, .git, etc. " +
    "Unreadable or oversized files are reported in the response summary.",
  {
    directory: z.string().describe("Absolute path to the directory to index"),
    patterns: z
      .array(z.string())
      .optional()
      .describe(
        "Glob patterns to match (default: common source extensions). " +
          'Example: ["src/**/*.ts", "tests/**/*.py"]',
      ),
  },
  async ({ directory, patterns }) => {
    try {
      const result = await manager.indexDirectory(directory, patterns ?? undefined);
      const summary = [
        `Indexed ${result.fileCount} files from ${directory}. ` +
          `${result.newlyUploaded.length} new, ${result.alreadyUploaded.length} already cached.`,
      ];
      if (result.errors.length > 0) {
        summary.push(`Errors (${result.errors.length}): ${result.errors.join("; ")}`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: summary.join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_search ─────────────────────────────────────────────────
// Semantic search with output size control and automatic result caching.

server.tool(
  "review_search",
  "Search the indexed codebase using natural language. Returns formatted code " +
    "snippets with file paths and line numbers. Results are cached for reuse " +
    "across code review phases. Requires review_index_files or review_index_directory first.",
  {
    query: z.string().describe("Natural language search query describing what code you need"),
    max_output_length: z
      .number()
      .min(1000)
      .max(80000)
      .optional()
      .describe("Maximum character length of results (default: 20000, max: 80000). " +
        "Use lower values for focused queries, higher for broad context gathering."),
  },
  async ({ query, max_output_length }) => {
    try {
      const { result, cached } = await manager.search(query, max_output_length ?? 20000);
      const prefix = cached ? "[CACHED] " : "";
      return {
        content: [{ type: "text" as const, text: `${prefix}${result}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_search_structured ──────────────────────────────────────
// Structured search output for workflows that want reusable chunks.

server.tool(
  "review_search_structured",
  "Search the indexed codebase and return structured chunks with file paths, " +
    "line ranges, previews, and stable chunk IDs. Use this when an orchestrator " +
    "wants reusable retrieval artifacts instead of one large formatted text blob.",
  {
    query: z.string().describe("Natural language search query describing what code you need"),
    max_output_length: z
      .number()
      .min(1000)
      .max(80000)
      .optional()
      .describe("Maximum character length of results to request before chunk parsing."),
    include_raw: z
      .boolean()
      .optional()
      .describe("Include the raw formatted search result alongside structured chunks."),
  },
  async ({ query, max_output_length, include_raw }) => {
    try {
      const result = await manager.searchStructured(query, max_output_length ?? 20000);
      const payload = include_raw
        ? result
        : {
            ...result,
            rawResult: undefined,
          };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_search_and_ask ─────────────────────────────────────────
// Combined search + LLM reasoning via Augment's backend.

server.tool(
  "review_search_and_ask",
  "Search the indexed codebase and ask Augment's LLM a question about the results. " +
    "Combines semantic retrieval with AI reasoning in a single call. " +
    "Useful for getting quick answers about code patterns or architecture. " +
    "Requires AUGMENT_API_TOKEN and AUGMENT_API_URL in the MCP server env.",
  {
    query: z.string().describe("Search query to find relevant code"),
    prompt: z
      .string()
      .optional()
      .describe("Question to ask about the search results (defaults to the query itself)"),
  },
  async ({ query, prompt }) => {
    try {
      const result = await manager.searchAndAsk(query, prompt ?? undefined);
      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_prepare_board_context ──────────────────────────────────
// Build a reusable context bundle for code-review-board style workflows.

server.tool(
  "review_prepare_board_context",
  "Prepare a reusable context bundle for multi-agent review workflows. " +
    "Optionally indexes the provided files, runs a focused retrieval query, " +
    "captures repository state, and returns JSON fields ready to feed into the code-review-board prompt builder. " +
    "Prepared bundles are cached and persisted with saved sessions.",
  {
    workspace_root: z
      .string()
      .describe("Absolute path to the workspace/repository root directory"),
    user_request: z
      .string()
      .describe("The review-board user request to preserve verbatim in the bundle"),
    paths: z
      .array(z.string())
      .optional()
      .describe("Changed or target file paths (absolute or relative to workspace_root). " +
        "If omitted, uses the current indexed workspace state."),
    retrieval_query: z
      .string()
      .optional()
      .describe("Focused semantic retrieval query to run (defaults to user_request)"),
    max_output_length: z
      .number()
      .min(1000)
      .max(80000)
      .optional()
      .describe("Maximum character length for the retrieval pass."),
    excerpt_char_limit: z
      .number()
      .min(1000)
      .max(40000)
      .optional()
      .describe("Maximum character budget for focused code excerpts."),
    budget_chars_per_token: z
      .number()
      .min(1)
      .max(16)
      .optional()
      .describe("Approximate characters-per-token ratio used to derive prompt-ready phase budgets."),
    phase_context_target_tokens: z
      .object({
        planning: z.number().min(100).max(20000).optional(),
        debate: z.number().min(100).max(20000).optional(),
        synthesis: z.number().min(100).max(20000).optional(),
      })
      .optional()
      .describe("Optional prompt budget targets, in tokens, for planning/debate/synthesis shared context packages."),
    section_summary_char_limits: z
      .record(z.string(), z.number().min(100).max(20000))
      .optional()
      .describe("Optional per-section character limits used when summarizing prompt-ready phase packages."),
    include_legacy_doc: z
      .boolean()
      .optional()
      .describe("Include CLAUDE.md in project_rules when present."),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe("Character offset for paginated retrieval. When provided with limit, " +
        "returns a chunk of the serialized payload instead of the full result. " +
        "Use this to retrieve large payloads that exceed the transport token limit."),
    limit: z
      .number()
      .min(1000)
      .max(40000)
      .optional()
      .describe("Maximum characters to return per chunk (default: 40000, max: 40000). " +
        "Use with offset for paginated retrieval of large payloads."),
  },
  async ({
    workspace_root,
    user_request,
    paths,
    retrieval_query,
    max_output_length,
    excerpt_char_limit,
    budget_chars_per_token,
    phase_context_target_tokens,
    section_summary_char_limits,
    include_legacy_doc,
    offset,
    limit,
  }) => {
    try {
      const { context, cached } = await manager.prepareBoardContext({
        workspaceRoot: workspace_root,
        userRequest: user_request,
        paths: paths ?? [],
        retrievalQuery: retrieval_query ?? undefined,
        maxOutputLength: max_output_length ?? undefined,
        excerptCharLimit: excerpt_char_limit ?? undefined,
        budgetCharsPerToken: budget_chars_per_token ?? undefined,
        phaseContextTargetTokens: phase_context_target_tokens ?? undefined,
        sectionSummaryCharLimits: section_summary_char_limits ?? undefined,
        includeLegacyDoc: include_legacy_doc ?? undefined,
      });

      // Paginated path: build payload (with progressive trimming) and return the requested chunk
      if (offset !== undefined || limit !== undefined) {
        const fullPayload = buildBoardContextPayload(context, cached);
        const { content } = paginateBoardContextPayload(
          fullPayload,
          offset ?? 0,
          limit ?? 40000,
        );
        return { content };
      }

      // Standard path: build trimmed payload (compact JSON for consistent size measurement)
      const payload = buildBoardContextPayload(context, cached);
      const serialized = JSON.stringify(payload);
      const serializedBytes = Buffer.byteLength(serialized, "utf8");

      if (debug) {
        const pretty = JSON.stringify(payload, null, 2);
        process.stderr.write(`[review-context] board payload: ${serializedBytes} bytes (${pretty.length} chars pretty)\n`);
      }

      // If payload still exceeds transport budget after trimming, return pagination hint
      if (serializedBytes > TRANSPORT_MAX_BYTES) {
        const hint = {
          _pagination_required: true,
          payload_bytes: serializedBytes,
          suggested_limit: 40000,
          message: "Payload exceeds transport limit after trimming. " +
            "Re-call with offset=0 and limit=40000 to retrieve in chunks, " +
            "then increment offset by bytes_in_chunk until has_more is false.",
          cached,
          session_id: context.sessionId,
          workspace_root: context.workspaceRoot,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(hint) }],
        };
      }

      return {
        content: [{ type: "text" as const, text: serialized }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_save_session ───────────────────────────────────────────
// Persist index + cache to disk for later resumption.

server.tool(
  "review_save_session",
  "Save the current index and cached search results to disk. " +
    "Use this after Phase 1 of a code review so subsequent reviews " +
    "of the same codebase can skip re-indexing.",
  {
    session_id: z
      .string()
      .optional()
      .describe("Custom session ID (auto-generated if omitted)"),
  },
  async ({ session_id }) => {
    try {
      const id = await manager.saveSession(session_id ?? undefined);
      const status = manager.getStatus();
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Session saved: ${id}\n` +
              `  Workspace: ${status.workspaceRoot ?? "unknown"}\n` +
              `  Indexed files: ${status.indexedFiles}\n` +
              `  Cached results: ${status.cachedResults}\n` +
              `  Board contexts: ${status.preparedBoardContexts}\n` +
              `\nTo resume: review_resume_session({ session_id: "${id}" })`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_resume_session ─────────────────────────────────────────
// Restore a previously saved session.

server.tool(
  "review_resume_session",
  "Resume a previously saved review session. Restores the index " +
    "and cached search results without re-indexing. Use review_list_sessions " +
    "to see available sessions.",
  {
    session_id: z.string().describe("Session ID to resume"),
  },
  async ({ session_id }) => {
    try {
      const info = await manager.resumeSession(session_id);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Session resumed: ${session_id}\n` +
              `  Workspace: ${info.workspaceRoot}\n` +
              `  Indexed files: ${info.indexedFiles}\n` +
              `  Cached results: ${info.cachedResults}\n` +
              `  Board contexts: ${info.boardContextCount}\n` +
              `  Session age: ${formatAge(info.sessionAge)}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_list_sessions ──────────────────────────────────────────

server.tool(
  "review_list_sessions",
  "List all saved review sessions with their metadata.",
  {},
  async () => {
    try {
      const sessions = await manager.listSessions();
      if (sessions.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No saved sessions found." }],
        };
      }

      const lines = sessions.map((s) => {
        const age = formatAge(Date.now() - s.createdAt);
        const boards = s.boardContextCount ?? 0;
        return `  ${s.sessionId} | ${age} | ${s.indexedPaths.length} files | ${boards} boards | ${s.workspaceRoot}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Saved sessions:\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_delete_session ─────────────────────────────────────────

server.tool(
  "review_delete_session",
  "Delete a saved review session and its cached data.",
  {
    session_id: z.string().describe("Session ID to delete"),
  },
  async ({ session_id }) => {
    try {
      const deleted = await manager.deleteSession(session_id);
      return {
        content: [
          {
            type: "text" as const,
            text: deleted
              ? `Session ${session_id} deleted.`
              : `Session ${session_id} not found.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_status ─────────────────────────────────────────────────

server.tool(
  "review_status",
  "Show the current state of the review context: active index, session ID, " +
    "number of indexed files, cached search results, and prepared board contexts.",
  {},
  async () => {
    try {
      const status = manager.getStatus();
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Active: ${status.active}\n` +
              `Session ID: ${status.sessionId ?? "none"}\n` +
              `Workspace: ${status.workspaceRoot ?? "none"}\n` +
              `Indexed files: ${status.indexedFiles}\n` +
              `Indexing complete: ${status.indexingComplete}\n` +
              `Cached results: ${status.cachedResults}\n` +
              `Prepared board contexts: ${status.preparedBoardContexts}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_list_cache ─────────────────────────────────────────────

server.tool(
  "review_list_cache",
  "List all cached search results from the current session. " +
    "Shows query text and cache key for each result.",
  {},
  async () => {
    try {
      const entries = manager.listCachedResults();
      if (entries.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No cached results." }],
        };
      }

      const lines = entries.map((e) => {
        const date = new Date(e.timestamp).toISOString();
        return `  ${e.key} | ${date} | ${e.query.slice(0, 80)}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Cached results (${entries.length}):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: review_clear ──────────────────────────────────────────────────

server.tool(
  "review_clear",
  "Clear the current index and all cached results. " +
    "Does not delete saved sessions on disk.",
  {},
  async () => {
    try {
      await manager.clear();
      return {
        content: [{ type: "text" as const, text: "Index and cache cleared." }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Start the server ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (debug) {
    console.error("[review-context] MCP server started on stdio");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
