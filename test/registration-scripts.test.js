/**
 * [LAYER: INFRASTRUCTURE]
 * Exercise scripts/mcp_add.sh, scripts/mcp_remove.sh, scripts/auggie_add.sh,
 * scripts/auggie_remove.sh against fake `claude` / `auggie` binaries that
 * record their argv, plus scripts/hermes_add.sh against a temp Hermes
 * config.yaml. Verifies scope handling, --replace, absolute
 * launcher path, env forwarding, redaction of secrets in user-facing
 * output, and failure propagation. Never writes to the user's real
 * config.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { REPO_ROOT, makeTempDir, makeTempHome, cleanup } from "./helpers.js";

const run = promisify(execFile);

/** Write a fake CLI at `dir/name` that logs argv to a file and exits 0. */
async function installFakeCli(dir, name, logPath, { exitCode = 0 } = {}) {
  const path = join(dir, name);
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${logPath}"
echo "fake ${name} received: $*"
exit ${exitCode}
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

async function runScript(script, { env = {}, expectFailure = false } = {}) {
  try {
    return await run(script, [], { env, cwd: REPO_ROOT });
  } catch (err) {
    if (!expectFailure) throw err;
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code };
  }
}

test("mcp_add.sh forwards scope, absolute launcher path, and env vars", async (t) => {
  const bin = await makeTempDir("rc-fakebin-");
  const home = await makeTempHome();
  t.after(() => cleanup(bin, home));

  const argvLog = join(bin, "argv.txt");
  await installFakeCli(bin, "claude", argvLog);

  const token = "SECRET_TOKEN_ABCDEFG";
  const { stdout } = await runScript(join(REPO_ROOT, "scripts", "mcp_add.sh"), {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      MCP_SCOPE: "user",
      AUGMENT_API_TOKEN: token,
    },
  });

  const argv = (await readFile(argvLog, "utf8")).trim().split("\n");
  assert.deepEqual(argv.slice(0, 4), ["mcp", "add", "review-context", "-s"]);
  assert.equal(argv[4], "user");
  assert.ok(argv.includes("-e"), "must forward env vars via -e");
  assert.ok(
    argv.some((a) => a === `AUGMENT_API_TOKEN=${token}`),
    "token must reach the fake CLI",
  );
  assert.ok(argv.at(-1)?.endsWith("/start.sh"), "final arg must be absolute start.sh path");

  assert.ok(!stdout.includes(token), "user-facing preview must redact the token");
  assert.ok(stdout.includes("AUGMENT_API_TOKEN=***"), "must show redaction placeholder");
});

test("mcp_add.sh rejects an invalid MCP_SCOPE", async (t) => {
  const bin = await makeTempDir("rc-fakebin-");
  const home = await makeTempHome();
  t.after(() => cleanup(bin, home));
  await installFakeCli(bin, "claude", join(bin, "unused.txt"));

  const result = await runScript(join(REPO_ROOT, "scripts", "mcp_add.sh"), {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      MCP_SCOPE: "bogus",
    },
    expectFailure: true,
  });
  assert.match(result.stderr, /MCP_SCOPE=.*not valid/);
});

test("mcp_remove.sh calls claude with the requested scope", async (t) => {
  const bin = await makeTempDir("rc-fakebin-");
  const home = await makeTempHome();
  t.after(() => cleanup(bin, home));
  const argvLog = join(bin, "argv.txt");
  await installFakeCli(bin, "claude", argvLog);

  await runScript(join(REPO_ROOT, "scripts", "mcp_remove.sh"), {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      MCP_SCOPE: "project",
    },
  });
  const argv = (await readFile(argvLog, "utf8")).trim().split("\n");
  assert.deepEqual(argv, ["mcp", "remove", "review-context", "-s", "project"]);
});

test("auggie_add.sh maps AUGGIE_SCOPE and passes --replace", async (t) => {
  const bin = await makeTempDir("rc-fakebin-");
  const home = await makeTempHome();
  t.after(() => cleanup(bin, home));
  const argvLog = join(bin, "argv.txt");
  await installFakeCli(bin, "auggie", argvLog);

  await runScript(join(REPO_ROOT, "scripts", "auggie_add.sh"), {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      AUGGIE_SCOPE: "project",
    },
  });
  const argv = (await readFile(argvLog, "utf8")).trim().split("\n");
  assert.deepEqual(argv.slice(0, 4), ["mcp", "add", "review-context", "--project"]);
  assert.ok(argv.includes("--command"));
  assert.ok(argv.includes("--replace"));
  const cmdIdx = argv.indexOf("--command");
  assert.ok(argv[cmdIdx + 1].endsWith("/start.sh"));
});

test("auggie_add.sh propagates a failing downstream exit status", async (t) => {
  const bin = await makeTempDir("rc-fakebin-");
  const home = await makeTempHome();
  t.after(() => cleanup(bin, home));
  await installFakeCli(bin, "auggie", join(bin, "argv.txt"), { exitCode: 42 });

  const result = await runScript(join(REPO_ROOT, "scripts", "auggie_add.sh"), {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
    },
    expectFailure: true,
  });
  assert.equal(result.code, 42, "must propagate downstream exit status");
});

test("scrub_secrets redacts output without ever invoking python3", async (t) => {
  // scrub_secrets is implemented with `sed` (POSIX-guaranteed) so it must
  // work identically even when `python3` on PATH is broken/absent — this
  // guards against a regression back to a python3 dependency.
  const bin = await makeTempDir("rc-fakebin-");
  const home = await makeTempHome();
  t.after(() => cleanup(bin, home));

  const token = "SECRET_NO_PY3_XYZ";
  const echoedOutput = `fake claude received config with AUGMENT_API_TOKEN=${token} embedded`;

  // A python3 stub that always fails loudly if invoked, proving scrub_secrets
  // never shells out to it.
  const brokenPython3 = join(bin, "python3");
  await writeFile(
    brokenPython3,
    `#!/usr/bin/env bash\necho "python3 must not be invoked by scrub_secrets" >&2\nexit 1\n`,
  );
  await chmod(brokenPython3, 0o755);

  // Fake `claude` echoes back the "saved" config, including the secret,
  // exactly like the real CLI does — this is what scrub_secrets must catch.
  const fakeClaude = join(bin, "claude");
  await writeFile(fakeClaude, `#!/usr/bin/env bash\necho "${echoedOutput}"\nexit 0\n`);
  await chmod(fakeClaude, 0o755);

  const { stdout } = await runScript(join(REPO_ROOT, "scripts", "mcp_add.sh"), {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      MCP_SCOPE: "user",
      AUGMENT_API_TOKEN: token,
    },
  });

  assert.ok(!stdout.includes(token), "downstream CLI echo must be scrubbed of the secret");
  assert.ok(stdout.includes("***"), "scrubbed output must contain the redaction placeholder");
});

// ---------------------------------------------------------------------------
// Hermes Agent registration (scripts/hermes_add.sh + scripts/hermes_add.py)
//
// Hermes has no `mcp add` CLI, so the registrar splices ~/.hermes/config.yaml
// directly. These tests run it against throwaway configs — never the real one.
// The registrar needs a Python that can import ruamel.yaml or yaml; resolve
// one from the Hermes venv or PATH, and skip (not fail) when unavailable so
// the suite still passes on machines without Hermes/PyYAML.
// ---------------------------------------------------------------------------

async function resolveRegistrarPython() {
  const candidates = [
    process.env.HERMES_PYTHON,
    join(homedir(), ".hermes", "hermes-agent", "venv", "bin", "python"),
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await run(candidate, ["-c", "import ruamel.yaml"], {});
      return candidate;
    } catch {}
    try {
      await run(candidate, ["-c", "import yaml"], {});
      return candidate;
    } catch {}
  }
  return null;
}

const BASE_HERMES_CONFIG = `agent:
  model: some-model
mcp_servers:
  pre-existing:
    command: /bin/echo
    enabled: true
display:
  theme: dark
`;

async function makeHermesConfig(dir, content = BASE_HERMES_CONFIG) {
  const configPath = join(dir, "config.yaml");
  await writeFile(configPath, content);
  return configPath;
}

function hermesEnv(configPath, py, extras = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    HERMES_CONFIG: configPath,
    HERMES_PYTHON: py,
    NODE_BIN: "/fake/bin/node",
    ...extras,
  };
}

test("hermes_add.sh registers the server with NODE_BIN pinned, preserving other entries", async (t) => {
  const py = await resolveRegistrarPython();
  if (!py) return t.skip("no python with a YAML library available");
  const dir = await makeTempDir("rc-hermes-");
  t.after(() => cleanup(dir));
  const configPath = await makeHermesConfig(dir);

  const token = "SECRET_HERMES_TOKEN_123";
  const { stdout } = await runScript(join(REPO_ROOT, "scripts", "hermes_add.sh"), {
    env: hermesEnv(configPath, py, { AUGMENT_API_TOKEN: token }),
  });

  const written = await readFile(configPath, "utf8");
  assert.ok(written.includes("  review-context:"), "entry must be added under mcp_servers");
  assert.ok(
    written.includes(`command: ${join(REPO_ROOT, "start.sh")}`),
    "command must be the absolute start.sh path",
  );
  assert.ok(written.includes('NODE_BIN: "/fake/bin/node"'), "NODE_BIN must be pinned in env");
  assert.ok(written.includes(`AUGMENT_API_TOKEN: "${token}"`), "token must reach the config");
  assert.ok(written.includes("pre-existing:"), "pre-existing servers must survive");
  assert.ok(written.includes("theme: dark"), "unrelated config must survive");

  assert.ok(!stdout.includes(token), "user-facing invocation log must redact the token");
  assert.ok(stdout.includes("AUGMENT_API_TOKEN=***"), "must show redaction placeholder");
});

test("hermes_add.sh is idempotent and --remove restores the original config", async (t) => {
  const py = await resolveRegistrarPython();
  if (!py) return t.skip("no python with a YAML library available");
  const dir = await makeTempDir("rc-hermes-");
  t.after(() => cleanup(dir));
  const configPath = await makeHermesConfig(dir);
  const env = hermesEnv(configPath, py);

  const script = join(REPO_ROOT, "scripts", "hermes_add.sh");
  await runScript(script, { env });
  const afterAdd = await readFile(configPath, "utf8");

  const { stdout: secondAdd } = await runScript(script, { env });
  assert.match(secondAdd, /unchanged/, "re-add must report unchanged");
  assert.equal(await readFile(configPath, "utf8"), afterAdd, "re-add must not rewrite");

  // --remove must splice the entry back out, leaving everything else intact.
  await run(script, ["--remove"], { env, cwd: REPO_ROOT });
  assert.equal(
    await readFile(configPath, "utf8"),
    BASE_HERMES_CONFIG,
    "add+remove round-trip must be lossless",
  );
});

test("hermes_add.sh skips cleanly when Hermes is not installed", async (t) => {
  const dir = await makeTempDir("rc-hermes-");
  t.after(() => cleanup(dir));

  const { stdout } = await runScript(join(REPO_ROOT, "scripts", "hermes_add.sh"), {
    env: hermesEnv(join(dir, "missing-config.yaml"), "python3"),
  });
  assert.match(stdout, /skipping registration/, "must skip, not fail, without Hermes");
});
