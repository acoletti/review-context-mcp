/**
 * [LAYER: INFRASTRUCTURE]
 * Real stdio JSON-RPC round-trip against start.sh: initialize +
 * notifications/initialized + tools/list. Asserts server identity and
 * the exact set of registered tool names. Never invokes a tool, so this
 * test does not need Augment credentials, network, or DirectContext.
 *
 * If this list changes, also update README.md's "Tool inventory" table and
 * the pointer comment atop the server registration in src/index.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  spawnServer,
  stopChild,
  makeTempHome,
  cleanup,
  baseEnv,
  sendRequest,
  readResponse,
} from "./helpers.js";

const EXPECTED_TOOLS = [
  "review_build_persona_digests",
  "review_clear",
  "review_clear_artifacts",
  "review_delete_session",
  "review_derive_queries",
  "review_find_research",
  "review_index_directory",
  "review_index_files",
  "review_list_cache",
  "review_list_sessions",
  "review_normalize_plans",
  "review_prepare_board_context",
  "review_read_artifact",
  "review_resume_session",
  "review_save_research",
  "review_save_session",
  "review_search",
  "review_search_and_ask",
  "review_search_structured",
  "review_status",
  "review_store_artifact",
  "review_summarize_context",
].sort();

test("initialize + tools/list returns the exact 22-tool inventory", async (t) => {
  const home = await makeTempHome();
  t.after(() => cleanup(home));

  const { child } = spawnServer({ env: baseEnv(home) });
  t.after(() => stopChild(child));

  // Do not let a broken child hang the test.
  child.once("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      // Attach for debugging; assertion will fail below.
      t.diagnostic(`launcher exited early code=${code} signal=${signal}`);
    }
  });

  sendRequest(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "review-context-mcp-test", version: "0" },
    },
  });
  const initResponse = await readResponse(child, 1, 8000);
  assert.equal(initResponse.jsonrpc, "2.0");
  assert.ok(initResponse.result, "initialize must return a result");
  assert.equal(
    initResponse.result.serverInfo?.name,
    "review-context",
    "server name must be 'review-context'",
  );

  sendRequest(child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });

  sendRequest(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const listResponse = await readResponse(child, 2, 8000);
  assert.ok(listResponse.result?.tools, "tools/list must return tools");
  const names = listResponse.result.tools.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    EXPECTED_TOOLS,
    `tool inventory drifted; update EXPECTED_TOOLS and docs. Got:\n${names.join("\n")}`,
  );
  assert.equal(names.length, 22, "must register exactly 22 tools");
});
