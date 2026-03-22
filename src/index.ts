#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ContextManager, toErrorMessage } from "./context-manager.js";

const debug = process.env.REVIEW_CONTEXT_DEBUG === "true";
const manager = new ContextManager(debug);

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
    "Defaults to common source file extensions. Excludes node_modules, dist, .git, etc.",
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
      return {
        content: [
          {
            type: "text" as const,
            text: `Indexed ${result.fileCount} files from ${directory}. ` +
              `${result.newlyUploaded.length} new, ${result.alreadyUploaded.length} already cached.`,
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

// ─── Tool: review_search_and_ask ─────────────────────────────────────────
// Combined search + LLM reasoning via Augment's backend.

server.tool(
  "review_search_and_ask",
  "Search the indexed codebase and ask Augment's LLM a question about the results. " +
    "Combines semantic retrieval with AI reasoning in a single call. " +
    "Useful for getting quick answers about code patterns or architecture.",
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
      return {
        content: [
          {
            type: "text" as const,
            text: `Session saved: ${id}. Use review_resume_session with this ID to restore.`,
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
              `  Indexed files: ${info.indexedFiles}\n` +
              `  Cached results: ${info.cachedResults}\n` +
              `  Workspace: ${info.workspaceRoot}`,
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
    const sessions = manager.listSessions();
    if (sessions.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No saved sessions found." }],
      };
    }

    const lines = sessions.map((s) => {
      const date = new Date(s.createdAt).toISOString();
      return `  ${s.sessionId} | ${date} | ${s.indexedPaths.length} files | ${s.workspaceRoot}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Saved sessions:\n${lines.join("\n")}`,
        },
      ],
    };
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
    "number of indexed files, and cached results.",
  {},
  async () => {
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
            `Cached results: ${status.cachedResults}`,
        },
      ],
    };
  },
);

// ─── Tool: review_list_cache ─────────────────────────────────────────────

server.tool(
  "review_list_cache",
  "List all cached search results from the current session. " +
    "Shows query text and cache key for each result.",
  {},
  async () => {
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
