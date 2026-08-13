/**
 * [LAYER: INFRASTRUCTURE]
 * Small Node-built-in helpers shared by launcher/MCP/registration tests.
 * Rule of thumb: no external test dependency. Everything here uses
 * node:child_process, node:fs/promises, node:os, node:path, node:readline.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(HERE);
export const LAUNCHER = join(REPO_ROOT, "start.sh");

/** Wait up to `ms` for `predicate` to return truthy; poll every 25ms. */
export async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Spawn `start.sh` (or a caller-provided executable) with a bounded env
 * and controlled HOME. Returns { child, stdout, stderr } where stdout/
 * stderr are string buffers appended to as bytes arrive.
 */
export function spawnServer({
  executable = LAUNCHER,
  args = [],
  env = {},
  cwd = REPO_ROOT,
} = {}) {
  const child = spawn(executable, args, {
    cwd,
    env: { ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  return { child, state };
}

/**
 * Terminate a child politely with SIGTERM, escalate to SIGKILL after
 * `killAfterMs`. Resolves once the child has exited (or the timeout
 * hits).
 */
export async function stopChild(child, { killAfterMs = 2000 } = {}) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill("SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, killAfterMs);
  await exited;
  clearTimeout(timer);
}

/** Send a single JSON-RPC frame (newline-delimited) to the child. */
export function sendRequest(child, message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

/**
 * Read one JSON-RPC response frame with `id === expectedId` from the
 * child's stdout stream. Rejects after `timeoutMs` regardless of what
 * other frames may have arrived.
 */
export function readResponse(child, expectedId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error(`timed out waiting for response id=${expectedId}`));
    }, timeoutMs);
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (parsed && parsed.id === expectedId) {
        clearTimeout(timer);
        rl.close();
        resolve(parsed);
      }
    });
    rl.on("close", () => {
      clearTimeout(timer);
    });
  });
}

/** Fresh temp HOME so no test writes into the user's real ~/.claude. */
export async function makeTempHome(prefix = "review-context-home-") {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Fresh temp working directory. */
export async function makeTempDir(prefix = "review-context-tmp-") {
  return mkdtemp(join(tmpdir(), prefix));
}

/** rm -rf, ignoring missing paths. */
export async function cleanup(...paths) {
  await Promise.all(
    paths.filter(Boolean).map((p) => rm(p, { recursive: true, force: true })),
  );
}

/** Baseline env for isolated tests: PATH + HOME only, no leaked secrets. */
export function baseEnv(home, extras = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    ...extras,
  };
}

/** Reflect that we linked the checkout's node_modules into a fixture. */
export async function linkNodeModules(fixtureRoot) {
  const target = join(REPO_ROOT, "node_modules");
  if (!existsSync(target)) {
    throw new Error(`checkout has no node_modules at ${target}; run 'make install' first`);
  }
  await symlink(target, join(fixtureRoot, "node_modules"), "dir");
}

export { mkdir, writeFile, cp, symlink, existsSync };
