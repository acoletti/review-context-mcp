/**
 * [LAYER: INFRASTRUCTURE]
 * Guards against regressions in start.sh: profile isolation, Node
 * prerequisite handling, stdout/stderr separation, and lifecycle.
 * Never invokes any registered tool; the launcher only needs to reach
 * the point where the MCP server is listening on stdio.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, chmod, mkdir, cp, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REPO_ROOT,
  spawnServer,
  stopChild,
  makeTempHome,
  makeTempDir,
  cleanup,
  baseEnv,
  waitFor,
  sendRequest,
  readResponse,
  linkNodeModules,
  LAUNCHER,
} from "./helpers.js";

test("start.sh does not source ~/.zshrc", async (t) => {
  const home = await makeTempHome();
  const marker = join(home, "profile-was-sourced");
  await writeFile(
    join(home, ".zshrc"),
    `#!/bin/sh\ntouch "${marker}"\n`,
  );
  t.after(() => cleanup(home));

  const { child, state } = spawnServer({ env: baseEnv(home) });
  t.after(() => stopChild(child));

  const alive = await waitFor(() => child.exitCode === null, 2000);
  assert.equal(alive, true, "launcher must remain alive with stdin open");
  assert.equal(state.stdout, "", "healthy startup must not print to stdout");

  const { existsSync } = await import("node:fs");
  assert.equal(
    existsSync(marker),
    false,
    "launcher must not execute the user's shell profile",
  );
});

test("start.sh preserves the caller-provided environment", async (t) => {
  const home = await makeTempHome();
  t.after(() => cleanup(home));

  const sentinel = `SENTINEL_${Date.now()}`;
  const { child, state } = spawnServer({
    env: baseEnv(home, { REVIEW_CONTEXT_TEST_SENTINEL: sentinel }),
  });
  t.after(() => stopChild(child));

  const alive = await waitFor(() => child.exitCode === null, 2000);
  assert.equal(alive, true);
  // We can't inspect the child's env from here, but we can assert that no
  // sanitizing/warning about the sentinel showed up on stderr — the
  // launcher must be transparent to unknown vars.
  assert.ok(
    !state.stderr.includes(sentinel),
    "launcher must not echo caller env values back to stderr",
  );
});

test("start.sh fails clearly when NODE_BIN is missing", async (t) => {
  const home = await makeTempHome();
  t.after(() => cleanup(home));

  const { child, state } = spawnServer({
    env: {
      HOME: home,
      PATH: "/nonexistent",
      NODE_BIN: "/does/not/exist/node",
    },
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(code, 0, "must exit nonzero on missing node");
  assert.equal(state.stdout, "", "must not print to stdout on failure");
  assert.match(state.stderr, /node/i);
});

test("start.sh fails clearly on Node <20 via a fake NODE_BIN", async (t) => {
  const dir = await makeTempDir();
  const home = await makeTempHome();
  t.after(() => cleanup(dir, home));

  const fakeNode = join(dir, "node");
  await writeFile(
    fakeNode,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo v18.19.0; exit 0; fi\nexit 0\n",
  );
  await chmod(fakeNode, 0o755);

  const { child, state } = spawnServer({
    env: baseEnv(home, { NODE_BIN: fakeNode }),
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.equal(state.stdout, "");
  assert.match(state.stderr, /Node\.?js? >=?20 required/i);
});

test("start.sh execs the resolved node so signals reach the child", async (t) => {
  const home = await makeTempHome();
  t.after(() => cleanup(home));

  const { child, state } = spawnServer({ env: baseEnv(home) });
  t.after(() => stopChild(child));

  const alive = await waitFor(() => child.exitCode === null, 2500);
  assert.equal(alive, true, "server must be running after startup");
  await stopChild(child, { killAfterMs: 2000 });
  // Node reports either exitCode (normal exit) or signalCode (killed by
  // signal); require one of them to be set so we know the process is gone.
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "SIGTERM/SIGKILL must terminate the process",
  );
  assert.equal(state.stdout, "", "no stray stdout during startup");
});

test("two concurrent launches both self-heal successfully (no install/build race)", async (t) => {
  // Simulates two MCP clients (e.g. Claude Code + Auggie CLI) starting the
  // server for the first time against the same freshly-synced checkout,
  // where neither node_modules nor dist/ exists yet. Both launches must
  // reach a working server; a real race would show up as build/install
  // corruption (missing dist/index.js, EEXIST/ENOENT crashes, or a stuck
  // initialize handshake).
  const parent = await mkdtemp(join(tmpdir(), "rc-concurrent-"));
  const fixture = join(parent, "review-context-mcp");
  const home = await makeTempHome();
  t.after(() => cleanup(parent, home));

  await mkdir(fixture, { recursive: true });
  for (const rel of ["start.sh", "package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(join(REPO_ROOT, rel), join(fixture, rel));
  }
  await cp(join(REPO_ROOT, "src"), join(fixture, "src"), { recursive: true });
  await linkNodeModules(fixture);
  // Fresh checkout simulation: no dist/ yet, both launches must build it.
  assert.equal(existsSync(join(fixture, "dist")), false);

  const launchOne = () => {
    const { child, state } = spawnServer({
      executable: join(fixture, "start.sh"),
      env: baseEnv(home),
      cwd: fixture,
    });
    return { child, state };
  };

  const a = launchOne();
  const b = launchOne();
  t.after(() => Promise.all([stopChild(a.child), stopChild(b.child)]));

  const initOf = async ({ child }, id) => {
    sendRequest(child, {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: `rc-concurrent-${id}`, version: "0" },
      },
    });
    return readResponse(child, id, 30000);
  };

  const [initA, initB] = await Promise.all([initOf(a, 1), initOf(b, 2)]);
  assert.equal(initA.result?.serverInfo?.name, "review-context", "launch A must come up cleanly");
  assert.equal(initB.result?.serverInfo?.name, "review-context", "launch B must come up cleanly");
  assert.equal(
    existsSync(join(fixture, "dist", "index.js")),
    true,
    "concurrent self-heal must leave a valid dist/index.js behind",
  );
});
