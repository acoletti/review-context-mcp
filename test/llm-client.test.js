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
  // Mark as initialized with dummy credentials so it skips credential resolution
  client._initialized = true;
  client._apiKey = "test-key";
  client._apiUrl = "https://test.example.com";

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
  client._apiKey = "test-key";
  client._apiUrl = "https://test.example.com";

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
