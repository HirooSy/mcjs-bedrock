import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serverArchive } from "../testkit/archive.js";
import { sendBuffer, startServer } from "../testkit/http.js";
import { waitFor, workspace, writeFiles } from "../testkit/workspace.js";
import { posixOnly } from "../testkit/helpers.js";

const projectRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const installProject = async (t, { config = {}, archive = {} } = {}) => {
  const root = workspace(t);
  for (const entry of ["start.js", "package.json", "lib", "plugins"]) {
    fs.cpSync(path.join(projectRoot(), entry), path.join(root, entry), { recursive: true });
  }
  const bytes = serverArchive(archive);
  const { origin, hits } = await startServer(t, (request, response) => sendBuffer(response, bytes));
  writeFiles(root, {
    "config.json": JSON.stringify({
      eula: true,
      install: { retries: 1, retryDelayMs: 1, timeoutMs: 5000 },
      ...config,
      server: { downloadUrl: `${origin}/bedrock-server-1.26.61.1.zip`, stopTimeoutMs: 3000, ...(config.server ?? {}) }
    })
  });
  return { root, hits };
};

const launch = (t, root, args = []) => {
  const child = spawn(process.execPath, ["start.js", ...args], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const output = { text: "" };
  child.stdout.on("data", (chunk) => (output.text += chunk));
  child.stderr.on("data", (chunk) => (output.text += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill("SIGKILL"));
  return { child, output, exited };
};

test("the process installs on first run, serves console commands and exits cleanly on SIGINT", posixOnly(), async (t) => {
  const { root, hits } = await installProject(t);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
  const { child, output, exited } = launch(t, root);
  await waitFor(() => output.text.includes("server ready"), { timeoutMs: 15000, label: "ready line" });
  assert.ok(fs.existsSync(path.join(root, "data/bedrock_server")));
  assert.match(output.text, /installing bedrock server 1\.26\.61\.1/);
  child.stdin.write(".players\n");
  await waitFor(() => output.text.includes("no players online"), { label: "console reply" });
  child.stdin.write("list\n");
  const received = path.join(root, "data/received.log");
  await waitFor(() => fs.existsSync(received) && fs.readFileSync(received, "utf8").includes("list"), { label: "passthrough" });
  child.kill("SIGINT");
  const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 10000))]);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.match(output.text, /stopping server/);
  assert.equal(hits.length, 1);
});

test("SIGTERM also stops gracefully", posixOnly(), async (t) => {
  const { root } = await installProject(t);
  const { child, output, exited } = launch(t, root);
  await waitFor(() => output.text.includes("server ready"), { timeoutMs: 15000, label: "ready line" });
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("a second SIGINT force-kills a server that ignores stop", posixOnly(), async (t) => {
  const { root } = await installProject(t, { archive: { args: ["--ignore-stop"] }, config: { server: { stopTimeoutMs: 60000 } } });
  const { child, output, exited } = launch(t, root);
  await waitFor(() => output.text.includes("server ready"), { timeoutMs: 15000, label: "ready line" });
  child.kill("SIGINT");
  await waitFor(() => output.text.includes("press Ctrl+C again"), { label: "first signal handled" });
  child.kill("SIGINT");
  const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 10000))]);
  assert.deepEqual(result, { code: 1, signal: null });
});

test("without the eula the process exits 1 and creates no data folder", posixOnly(), async (t) => {
  const { root, hits } = await installProject(t, { config: { eula: false } });
  const { output, exited } = launch(t, root);
  const result = await exited;
  assert.equal(result.code, 1);
  assert.match(output.text, /EULA must be accepted/);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
  assert.equal(hits.length, 0);
});

test("invalid arguments exit 2", async (t) => {
  const { root } = await installProject(t);
  const { output, exited } = launch(t, root, ["--bogus"]);
  assert.equal((await exited).code, 2);
  assert.match(output.text, /unknown option --bogus/);
});

test("the install and check commands work as separate processes", posixOnly(), async (t) => {
  const { root } = await installProject(t);
  const install = launch(t, root, ["install"]);
  assert.equal((await install.exited).code, 0);
  assert.match(install.output.text, /installed 1\.26\.61\.1/);
  const check = launch(t, root, ["check"]);
  assert.equal((await check.exited).code, 0);
  assert.match(check.output.text, /server is up to date/);
});
