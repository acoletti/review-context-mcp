/**
 * [LAYER: INFRASTRUCTURE]
 * Smoke: prove that the launcher works from a relocated fixture (built
 * fresh in the copy) and from a source-less "dist-only" fixture. Runs
 * offline: dependencies are provided by a symlink to the checkout's
 * already-installed node_modules. Never invokes an MCP tool.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  REPO_ROOT,
  spawnServer,
  stopChild,
  makeTempHome,
  cleanup,
  baseEnv,
  waitFor,
  sendRequest,
  readResponse,
  linkNodeModules,
} from "./helpers.js";

/** Recursively grep JS/map/sh files under root for `needle`. Returns hits. */
async function scanForPath(root, needle) {
  const hits = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!/\.(js|mjs|cjs|map|sh|json)$/.test(e.name)) continue;
      const text = await readFile(abs, "utf8").catch(() => "");
      if (text.includes(needle)) hits.push(abs);
    }
  };
  await walk(root);
  return hits;
}

test("launcher builds and runs from a relocated fixture (path with spaces)", async (t) => {
  // Force a space in the fixture path so shell quoting regressions surface.
  const parent = await mkdtemp(join(tmpdir(), "rc dist "));
  const fixture = join(parent, "review-context-mcp");
  const home = await makeTempHome();
  t.after(() => cleanup(parent, home));

  await mkdir(fixture, { recursive: true });
  for (const rel of ["start.sh", "package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(join(REPO_ROOT, rel), join(fixture, rel));
  }
  await cp(join(REPO_ROOT, "src"), join(fixture, "src"), { recursive: true });
  await linkNodeModules(fixture);
  // Ensure NO dist so the launcher must build one inside the fixture.
  assert.equal(existsSync(join(fixture, "dist")), false);

  const { child, state } = spawnServer({
    executable: join(fixture, "start.sh"),
    env: baseEnv(home),
    cwd: fixture,
  });
  t.after(() => stopChild(child));

  sendRequest(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rc-smoke", version: "0" },
    },
  });
  const init = await readResponse(child, 1, 15000);
  assert.equal(init.result.serverInfo?.name, "review-context");

  const distIndex = join(fixture, "dist", "index.js");
  assert.equal(existsSync(distIndex), true, "fixture must build its own dist");

  // Original checkout path must not leak into copied launcher or built dist.
  const distHits = await scanForPath(join(fixture, "dist"), REPO_ROOT);
  assert.deepEqual(distHits, [], `original checkout path leaked into: ${distHits.join(", ")}`);
  const launcherText = await readFile(join(fixture, "start.sh"), "utf8");
  assert.ok(
    !launcherText.includes(REPO_ROOT),
    "start.sh must resolve its own directory, not hard-code the checkout path",
  );
});

test("launcher runs a source-less built copy (dist only, no src)", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "rc distonly "));
  const fixture = join(parent, "review-context-mcp");
  const home = await makeTempHome();
  t.after(() => cleanup(parent, home));

  await mkdir(fixture, { recursive: true });
  for (const rel of ["start.sh", "package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(join(REPO_ROOT, rel), join(fixture, rel));
  }
  // Ensure the checkout has a fresh dist to copy.
  assert.equal(existsSync(join(REPO_ROOT, "dist", "index.js")), true, "run 'npm run build' first");
  await cp(join(REPO_ROOT, "dist"), join(fixture, "dist"), { recursive: true });
  await linkNodeModules(fixture);
  // Deliberately no src/ in the fixture.
  assert.equal(existsSync(join(fixture, "src")), false);

  const { child } = spawnServer({
    executable: join(fixture, "start.sh"),
    env: baseEnv(home),
    cwd: fixture,
  });
  t.after(() => stopChild(child));

  sendRequest(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rc-smoke-distonly", version: "0" },
    },
  });
  const init = await readResponse(child, 1, 15000);
  assert.equal(init.result.serverInfo?.name, "review-context");
});
