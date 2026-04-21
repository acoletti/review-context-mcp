import type { LlmClient } from "./llm-client.js";

// TODO: Consolidate with toErrorMessage() in context-manager.ts — identical
// ErrorResult shape, maintenance risk if error formatting changes in one but not the other.
export function toErrorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

interface ParseResult {
  ok: boolean;
  text: string;
}

function tryParseJson(text: string): ParseResult {
  const trimmed = text.trim();

  // Non-anchored: handles LLM responses with conversational framing around fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonCandidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate);
    return { ok: true, text: JSON.stringify(parsed, null, 2) };
  } catch {
    return { ok: false, text: trimmed };
  }
}

const MAX_OUTPUT_TOKENS = 8192;

export function createNormalizePlansHandler(llm: LlmClient) {
  return async (args: {
    plans: Array<{ agent_name: string; plan_text: string }>;
    target_tokens_per_plan?: number;
    model?: string;
  }) => {
    try {
      const targetTokens = args.target_tokens_per_plan ?? 200;

      const systemPrompt =
        "Extract a compact delta from each implementation plan. " +
        "For each plan, preserve: Problem, Solution, Key files/symbols, " +
        "Implementation steps, Risks/trade-offs, Priority. " +
        "Keep specific filenames, function names, symbols, and constraint language verbatim. " +
        `Target ~${targetTokens} tokens per plan. ` +
        'Return as a JSON array of { "agent_name": "...", "delta": "..." } objects. ' +
        "Return only the JSON array, no other text.";

      const userContent = args.plans
        .map((p) => `## ${p.agent_name}\n\n${p.plan_text}`)
        .join("\n\n---\n\n");

      const result = await llm.generate(systemPrompt, userContent, {
        model: args.model,
        maxTokens: 2000,
        timeoutMs: 60_000,
      });

      const parsed = tryParseJson(result);
      if (!parsed.ok) {
        return toErrorResult(`LLM returned non-JSON output: ${parsed.text.slice(0, 200)}`);
      }
      return {
        content: [{ type: "text" as const, text: parsed.text }],
      };
    } catch (err) {
      return toErrorResult(err);
    }
  };
}

export function createDeriveQueriesHandler(llm: LlmClient) {
  return async (args: {
    user_request: string;
    file_paths?: string[];
    query_count?: number;
    model?: string;
  }) => {
    try {
      const queryCount = args.query_count ?? 4;
      const filePaths = args.file_paths ?? [];

      const systemPrompt =
        `Given a code review request and optional file paths, generate ${queryCount} focused search queries. ` +
        "Produce a mix of: semantic queries for codebase search (5-10 word descriptive phrases), " +
        "and citation-style queries for known patterns (using section-sign shorthand like " +
        '"CC-Py §Functions", "FP2e §Protocols", "Google §2.7"). ' +
        'Return as a JSON array of { "query": "...", "type": "semantic"|"citation", "rationale": "..." } objects. ' +
        "Return only the JSON array, no other text.";

      const fileSection = filePaths.length > 0
        ? `\n\nRelevant files:\n${filePaths.map((f) => `- ${f}`).join("\n")}`
        : "";

      const userContent = `## Code Review Request\n\n${args.user_request}${fileSection}`;

      const result = await llm.generate(systemPrompt, userContent, {
        model: args.model,
        maxTokens: 1000,
      });

      const parsed = tryParseJson(result);
      if (!parsed.ok) {
        return toErrorResult(`LLM returned non-JSON output: ${parsed.text.slice(0, 200)}`);
      }
      return {
        content: [{ type: "text" as const, text: parsed.text }],
      };
    } catch (err) {
      return toErrorResult(err);
    }
  };
}

export function createSummarizeContextHandler(llm: LlmClient) {
  return async (args: {
    text: string;
    target_chars: number;
    context_label?: string;
    preserve_keywords?: string[];
    model?: string;
  }) => {
    try {
      const label = args.context_label ?? "content";
      const keywords = args.preserve_keywords ?? [];

      const keywordsClause = keywords.length > 0
        ? ` These terms must appear in the summary: ${keywords.join(", ")}.`
        : "";

      const systemPrompt =
        `Summarize the following ${label} to fit within ~${args.target_chars} characters. ` +
        "Preserve technical specificity: keep file paths, function names, API endpoints, " +
        `and version numbers intact.${keywordsClause} ` +
        "Output the summary directly with no wrapper or preamble.";

      const result = await llm.generate(systemPrompt, args.text, {
        model: args.model,
        maxTokens: Math.min(Math.ceil(args.target_chars / 3), MAX_OUTPUT_TOKENS),
        timeoutMs: 45_000,
      });

      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err) {
      return toErrorResult(err);
    }
  };
}

const DEFAULT_PERSONA_SECTIONS = [
  "Review Focus",
  "Engineering Lens",
  "What You Praise",
  "What You Critique",
  "Tone",
];

export function createBuildPersonaDigestsHandler(llm: LlmClient) {
  return async (args: {
    personas: Array<{ agent_name: string; persona_text: string }>;
    sections_to_keep?: string[];
    model?: string;
  }) => {
    try {
      const sections = args.sections_to_keep ?? DEFAULT_PERSONA_SECTIONS;

      const systemPrompt =
        "Extract a compact digest from each persona definition. " +
        `Keep only these sections: ${sections.join(", ")}. ` +
        "Preserve the voice and perspective of each persona. " +
        'Return as a JSON array of { "agent_name": "...", "digest": "..." } objects. ' +
        "Return only the JSON array, no other text.";

      const userContent = args.personas
        .map((p) => `## ${p.agent_name}\n\n${p.persona_text}`)
        .join("\n\n---\n\n");

      const result = await llm.generate(systemPrompt, userContent, {
        model: args.model,
        maxTokens: 2000,
        timeoutMs: 45_000,
      });

      const parsed = tryParseJson(result);
      if (!parsed.ok) {
        return toErrorResult(`LLM returned non-JSON output: ${parsed.text.slice(0, 200)}`);
      }
      return {
        content: [{ type: "text" as const, text: parsed.text }],
      };
    } catch (err) {
      return toErrorResult(err);
    }
  };
}
