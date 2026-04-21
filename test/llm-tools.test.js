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

// ─── review_normalize_plans ─────────────────────────────────────────────

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

// ─── review_derive_queries ──────────────────────────────────────────────

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

// ─── review_summarize_context ───────────────────────────────────────────

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

// ─── review_build_persona_digests ───────────────────────────────────────

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
