/**
 * [LAYER: INFRASTRUCTURE]
 * Exercise scripts/mcp_add.sh, scripts/mcp_remove.sh, scripts/auggie_add.sh,
 * scripts/auggie_remove.sh against fake `claude` / `auggie` binaries that
 * record their argv. Verifies scope handling, --replace, absolute
 * launcher path, env forwarding, redaction of secrets in user-facing
 * output, and failure propagation. Never writes to the user's real
 * config.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
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
