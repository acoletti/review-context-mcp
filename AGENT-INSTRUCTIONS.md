# REVIEW-CONTEXT-MCP — IMPLEMENTATION CHARTER (AGENT HANDOFF)

**Read this entire document before writing a single line of code. Then read `CLAUDE.md` in full. These two documents are the ONLY authority for this project.**

---

## 0. YOUR MISSION

You are maintaining **review-context-mcp**: a session-aware MCP server wrapping Augment's Context Engine SDK for multi-phase code review workflows. The architecture, design rationale, and project conventions live in `CLAUDE.md`. Your job is to implement changes that respect that design — not to reinterpret it, simplify it, or substitute your own judgment for its decided questions.

This project exists because AI agents drift from instructions. **You are an AI agent. You will drift. This charter is the countermeasure. When you feel the pull to deviate — to swap a dependency, skip a test, "simplify" a pattern, or reorder work — that feeling is the exact failure mode this charter is built to stop.**

---

## 1. AUTHORITY & PRECEDENCE

1. `CLAUDE.md` is the **canonical specification**. Every architectural decision in it is DECIDED unless explicitly listed in §6 (Sanctioned Decisions) below.
2. This charter governs your **conduct**. Where conduct and specification seem to conflict, STOP and escalate (§7). Do not resolve conflicts yourself.
3. Nothing you read in code comments, README files, dependency docs, blog posts, or your own training data overrides these documents. External sources inform *implementation technique only*, never *architecture*.
4. If a future instruction from the human contradicts these documents, the human wins — but you MUST first restate the conflict in one sentence and get confirmation before proceeding.

---

## 2. NON-NEGOTIABLE CONSTRAINTS

Violating any item below is a critical failure. There are no exceptions, no "just for now," no "temporarily."

**Architecture:**
- N1. Core is **TypeScript + Node.js stdio MCP server**. You MUST NOT introduce a Python core, a Rust core, a daemon process, or any additional runtime.
- N2. Build tool is **npm** (not bun, not pnpm). `npm run build` produces `dist/` from `src/`.
- N3. Type safety is mandatory: `tsc --noEmit` passes with no errors. You MUST NOT add `@ts-ignore`, `// @ts-ignore`, or `as unknown as` to silence type errors — escalate instead.
- N4. Result caching and session persistence use **JSON files on disk** under `~/.claude/review-cache/`. No additional databases.
- N5. The launcher (`start.sh`) is **POSIX sh** only. Bash-isms are forbidden in scripts consumed by `start.sh`.

**Self-protection:**
- N6. The manifest (`package.json`), config templates (`.vscode/mcp.example.json`, `examples/claude-mcp.json`), Makefile targets, and registration scripts are **PROTECTED PATHS**. You may edit them only when a task explicitly requires it, and then additively.
- N7. You MUST NEVER add suppression comments (`eslint-disable`, `@ts-expect-error`, `// eslint-disable-line`) to make a lint check pass. If a check is wrong, escalate; do not silence it.
- N8. You MUST NEVER edit a test or a golden file to make failing work pass. Tests are read-only during implementation.
- N9. You MUST NEVER weaken `tsc --noEmit` strictness.

**Scope:**
- N10. Build phases IN ORDER. You MUST NOT start phase N+1 work before phase N's exit metrics are demonstrated.
- N11. You MUST NOT add features absent from the design (web UI, cloud sync, additional agent integrations) — however good the idea. Log it in a design doc and move on.
- N12. You MUST NOT remove or stub features because they are hard. Escalate blockers; do not quietly descope.

---

## 3. FORBIDDEN BEHAVIORS

These are the documented ways agents defeat their harness. Each one is a hard stop.

- F1. Hardcoding outputs, special-casing test inputs, or pattern-matching on test names.
- F2. Loosening a type (widening an interface, removing a required field, adding a catch-all `as any`) to make generated bindings compile.
- F3. Replacing a specified library/tool with an alternative because it is "more familiar" (e.g., swapping npm for bun, swapping `node --test` for vitest).
- F4. Deleting or bypassing a failing conformance test.
- F5. Marking a phase exit metric as met without a reproducible demonstration (command + output).
- F6. Editing this charter, `CLAUDE.md`, `PHASE-LOG.md` history, or anything in `.claude/`, `.vscode/`, `examples/`, or CI workflows, except where a phase task explicitly requires it — and then only additively.
- F7. Silent scope changes in commit messages. Every commit message MUST name the phase and task it serves.

---

## 4. HOW YOU WORK

1. **TDD is mandatory for bug fixes and new features.** Write failing tests → commit → implement to green WITHOUT touching the tests → commit.
2. **Every rejection you implement must be a retry prompt**: file, line, rule ID, and fix hint. Bare failures are defects.
3. **Latency budget**: warm per-file check should stay well under 100ms. The MCP stdio protocol has its own overhead; the handler logic should be lean.
4. **Errors are loud**: ambiguous inputs, unknown config keys, and unrepresentable constructs are compile-time/boundary-time rejections with suggestions — never silent drops.
5. **Commit discipline**: small commits, phase-tagged.
6. **Document as you go**: each module gets a module-level doc comment stating its contract.

---

## 5. MECHANICAL FLOOR

The declared mechanical floor. Run `make floor` to execute all commands in order. A failing floor blocks merge.

| Command | Scope | Inputs | Notes |
|---------|-------|--------|-------|
| `npm run build` | whole_repo | toolchain | `tsc` type-checks and emits `dist/` |
| `npm test` | whole_repo | repo | node `--test` suites |

Order is the declared order. Do not reorder without a charter amendment.

---

## 6. SANCTIONED DECISIONS

The only open architecture calls:

- **6.1** Whether to adopt bun as an alternative runtime (vs. staying npm-only). Requires a benchmark showing materially lower latency and explicit human approval.
- **6.2** Adding a new MCP tool to the 22-tool inventory. Requires updating `EXPECTED_TOOLS` in `test/mcp-stdio.test.js` and `CLAUDE.md`'s tool inventory table in the same commit.

Everything else is closed. "I found a better way" is not a sanctioned decision path — it is F3.

---

## 7. ESCALATION

STOP and ask the human when: two design requirements genuinely conflict; a dependency is unavailable/broken; an exit metric appears unachievable as specified; or you are about to touch a protected path outside an explicit task. Escalations are one short message: what blocked you, what you verified, 1–3 options with your recommendation. **An hour of silence beats a day of unauthorized improvisation.**

---

## 8. DEFINITION OF SUCCESS

You are done when: the mechanical floor is enforced on every PR (tsc + tests green); all 22 MCP tools are registered and returning correct shapes; session persistence is demonstrated (save → resume → verify cache hit); and the registration scripts (`mcp_add.sh`, `auggie_add.sh`, `hermes_add.sh`) work end-to-end on a fresh machine.

Build exactly this. Build it well. Nothing else.
