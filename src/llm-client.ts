import { generateText } from "ai";
import {
  AugmentLanguageModel,
  resolveAugmentCredentials,
} from "@augmentcode/auggie-sdk";

export interface LlmGenerateOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.REVIEW_LLM_TIMEOUT_MS ?? "30000",
  10,
);

export class LlmClient {
  private defaultModel: string;
  private debug: boolean;

  // Exposed for test mocking — not part of the public API.
  _initialized = false;
  _apiKey: string | null = null;
  _apiUrl: string | null = null;

  constructor(defaultModel?: string, debug?: boolean) {
    this.defaultModel =
      process.env.REVIEW_LLM_DEFAULT_MODEL ?? defaultModel ?? "claude-sonnet-4-5";
    this.debug = debug ?? process.env.REVIEW_LLM_DEBUG === "true";
  }

  private log(msg: string): void {
    if (this.debug) {
      process.stderr.write(`[review-llm] ${msg}\n`);
    }
  }

  /** Override point for tests — replace to skip real credential resolution. */
  async _resolveCredentials(): Promise<{ apiKey: string; apiUrl: string }> {
    // Prefer env vars (already set in start.sh), fall back to SDK resolution
    if (process.env.AUGMENT_API_TOKEN && process.env.AUGMENT_API_URL) {
      return {
        apiKey: process.env.AUGMENT_API_TOKEN,
        apiUrl: process.env.AUGMENT_API_URL,
      };
    }
    const creds = await resolveAugmentCredentials();
    return { apiKey: creds.apiKey, apiUrl: creds.apiUrl };
  }

  private async ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    const { apiKey, apiUrl } = await this._resolveCredentials();
    this._apiKey = apiKey;
    this._apiUrl = apiUrl;
    this._initialized = true;
    this.log("LLM client initialized");
  }

  private buildModel(modelId: string): AugmentLanguageModel {
    return new AugmentLanguageModel(modelId, {
      apiKey: this._apiKey!,
      apiUrl: this._apiUrl!,
      debug: this.debug,
    });
  }

  /** Override point for tests — replace to capture/mock generateText calls. */
  async _generateText(args: {
    model: AugmentLanguageModel;
    messages: Array<{ role: "system" | "user"; content: string }>;
    maxOutputTokens?: number;
    temperature?: number;
    abortSignal?: AbortSignal;
  }): Promise<{ text: string }> {
    // @ts-expect-error — Dual-package type mismatch: @ai-sdk/provider@3.0.8
    // (transitive from auggie-sdk) vs ai@5 internal @ai-sdk/provider@2.0.1.
    // Both define LanguageModelV2 identically but TypeScript treats them as
    // incompatible nominal types. Safe at runtime (ai@5 uses duck-typing).
    return generateText(args);
  }

  async generate(
    systemPrompt: string,
    userContent: string,
    options?: LlmGenerateOptions,
  ): Promise<string> {
    await this.ensureInitialized();

    const modelId = options?.model ?? this.defaultModel;
    const model = this.buildModel(modelId);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.log(`generate: model=${modelId} timeout=${timeoutMs}ms`);
    if (this.debug) {
      this.log(`system prompt (${systemPrompt.length} chars): ${systemPrompt.slice(0, 120)}...`);
      this.log(`user content (${userContent.length} chars): ${userContent.slice(0, 120)}...`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { text } = await this._generateText({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        maxOutputTokens: options?.maxTokens,
        temperature: options?.temperature,
        abortSignal: controller.signal,
      });

      this.log(`response (${text.length} chars)`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}
