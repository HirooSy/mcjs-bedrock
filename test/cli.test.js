import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseArgs, run, usageText } from "../lib/cli.js";
import { serverArchive } from "../testkit/archive.js";
import { sendBuffer, startServer } from "../testkit/http.js";
import { workspace, writeFiles } from "../testkit/workspace.js";
import { nativeOnly } from "../testkit/helpers.js";

const capture = () => {
  const out = [];
  const err = [];
  return { out, err, io: { log: (text) => out.push(String(text)), warn: (text) => out.push(String(text)), error: (text) => err.push(String(text)) } };
};

const project = async (t, overrides = {}) => {
  const root = workspace(t);
  const { origin, hits } = await startServer(t, (request, response) => sendBuffer(response, serverArchive()));
  const config = {
    eula: true,
    install: { retries: 1, retryDelayMs: 1, timeoutMs: 5000 },
    server: { downloadUrl: `${origin}/bedrock-server-1.26.61.1.zip` },
    ...overrides
  };
  writeFiles(root, { "config.json": JSON.stringify(config) });
  return { root, hits, origin };
};

test("no arguments means start", () => {
  assert.deepEqual(parseArgs([]), { command: "start", args: [], options: { config: null, eula: false } });
});

test("commands, arguments and the config option are parsed", () => {
  assert.deepEqual(parseArgs(["restore", "2026-11-04T06-39-00", "--config", "other.json"]), {
    command: "restore",
    args: ["2026-11-04T06-39-00"],
    options: { config: "other.json", eula: false }
  });
  assert.equal(parseArgs(["-c", "x.json", "install"]).options.config, "x.json");
});

test("the eula flag is recognised anywhere", () => {
  assert.equal(parseArgs(["--eula"]).options.eula, true);
  assert.equal(parseArgs(["install", "--eula"]).options.eula, true);
  assert.equal(parseArgs(["install"]).options.eula, false);
});

test("help flags win over any command", () => {
  assert.equal(parseArgs(["install", "--help"]).command, "help");
  assert.equal(parseArgs(["-h"]).command, "help");
});

test("bad input is reported as an error", () => {
  assert.match(parseArgs(["--bogus"]).error, /unknown option --bogus/);
  assert.match(parseArgs(["fly"]).error, /unknown command fly/);
  assert.match(parseArgs(["--config"]).error, /needs a file name/);
  assert.match(parseArgs(["constructor"]).error, /unknown command/);
});

test("usage lists every command", () => {
  for (const name of ["start", "install", "check", "doctor", "backups", "restore", "help", "--eula"]) {
    assert.ok(usageText().includes(name), name);
  }
});

test("help prints usage and exits 0", async () => {
  const { io, out } = capture();
  assert.equal(await run(["help"], { root: "/nonexistent", io }), 0);
  assert.match(out.join("\n"), /usage: node start\.js/);
});

test("an unknown command exits 2 with usage on stderr", async () => {
  const { io, err } = capture();
  assert.equal(await run(["fly"], { root: "/nonexistent", io }), 2);
  assert.match(err.join("\n"), /unknown command fly/);
  assert.match(err.join("\n"), /usage:/);
});

test("a missing explicit config and an invalid config exit 1 with a readable message", async (t) => {
  const root = workspace(t);
  const first = capture();
  assert.equal(await run(["install", "--config", "nothing.json"], { root, io: first.io, env: {} }), 1);
  assert.match(first.err.join("\n"), /cannot read config .*nothing\.json/);
  writeFiles(root, { "config.json": JSON.stringify({ network: { port: 0 } }) });
  const second = capture();
  assert.equal(await run(["install"], { root, io: second.io, env: {} }), 1);
  assert.match(second.err.join("\n"), /network\.port must be null/);
});

test("without any config file the defaults are used and the eula is already accepted", async (t) => {
  const root = workspace(t);
  const { io, err } = capture();
  const { origin } = await startServer(t, (request, response) => sendBuffer(response, serverArchive()));
  writeFiles(root, { "config.js": `export default { server: { downloadUrl: "${origin}/bedrock-server-1.26.61.1.zip" }, install: { retries: 1, retryDelayMs: 1, timeoutMs: 5000 } };\n` });
  assert.equal(await run(["install"], { root, io, env: {} }), 0);
  assert.equal(err.length, 0);
});

test("the eula can be accepted with a flag or an environment variable", nativeOnly(), async (t) => {
  for (const [argv, env] of [[["install", "--eula"], {}], [["install"], { EULA: "TRUE" }], [["install"], { MCJS_EULA: "yes" }]]) {
    const { root, hits } = await project(t, { eula: false });
    const { io } = capture();
    assert.equal(await run(argv, { root, io, env }), 0, JSON.stringify([argv, env]));
    assert.equal(hits.length, 1);
  }
});

test("an environment value other than true does not accept the eula", async (t) => {
  const { root, hits } = await project(t, { eula: false });
  const { io, err } = capture();
  assert.equal(await run(["install"], { root, io, env: { EULA: "false", MCJS_EULA: "" } }), 1);
  assert.match(err.join("\n"), /EULA must be accepted/);
  assert.equal(hits.length, 0);
});

test("install downloads the server and a second run reports it up to date", nativeOnly(), async (t) => {
  const { root, hits } = await project(t);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
  const first = capture();
  assert.equal(await run(["install"], { root, io: first.io, env: {} }), 0);
  assert.match(first.out.join("\n"), /installed 1\.26\.61\.1 at .*data/);
  assert.ok(fs.existsSync(path.join(root, "data", process.platform === "win32" ? "bedrock_server.exe" : "bedrock_server")));
  const second = capture();
  assert.equal(await run(["install"], { root, io: second.io, env: {} }), 0);
  assert.match(second.out.join("\n"), /up to date.*1\.26\.61\.1/);
  assert.equal(hits.length, 1);
});

test("install refuses without the eula and creates nothing", nativeOnly(), async (t) => {
  const { root, hits } = await project(t, { eula: false });
  const { io, err } = capture();
  assert.equal(await run(["install"], { root, io }), 1);
  assert.match(err.join("\n"), /EULA must be accepted/);
  assert.equal(hits.length, 0);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});

test("check reports the installed and available versions", nativeOnly(), async (t) => {
  const { root } = await project(t);
  const before = capture();
  assert.equal(await run(["check"], { root, io: before.io }), 0);
  assert.match(before.out.join("\n"), /installed: none/);
  assert.match(before.out.join("\n"), /available: 1\.26\.61\.1 \(release\)/);
  assert.match(before.out.join("\n"), /an install or update is needed/);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
  await run(["install"], { root, io: capture().io });
  const after = capture();
  await run(["check"], { root, io: after.io });
  assert.match(after.out.join("\n"), /installed: 1\.26\.61\.1 \(release\)/);
  assert.match(after.out.join("\n"), /server is up to date/);
});

test("backups lists stored backups and says when there are none", async (t) => {
  const { root } = await project(t);
  const empty = capture();
  assert.equal(await run(["backups"], { root, io: empty.io }), 0);
  assert.deepEqual(empty.out, ["no backups"]);
  writeFiles(root, {
    "backups/2026-11-04T06-39-00/world/level.dat": "x",
    "backups/2026-11-05T06-39-00/world/level.dat": "x"
  });
  const listed = capture();
  await run(["backups"], { root, io: listed.io });
  assert.deepEqual(listed.out, ["2026-11-04T06-39-00\n2026-11-05T06-39-00"]);
});

test("restore needs a name and restores the named backup", async (t) => {
  const { root } = await project(t);
  const missing = capture();
  assert.equal(await run(["restore"], { root, io: missing.io }), 2);
  writeFiles(root, {
    "backups/2026-11-04T06-39-00/world/level.dat": "from backup",
    "data/worlds/world/level.dat": "current"
  });
  const { io, out } = capture();
  assert.equal(await run(["restore", "2026-11-04T06-39-00"], { root, io }), 0);
  assert.match(out.join("\n"), /restored 2026-11-04T06-39-00, previous world kept at/);
  assert.equal(fs.readFileSync(path.join(root, "data/worlds/world/level.dat"), "utf8"), "from backup");
  const bad = capture();
  assert.equal(await run(["restore", "../escape"], { root, io: bad.io }), 1);
  assert.match(bad.err.join("\n"), /invalid backup name/);
});

test("an alternative config file is used", nativeOnly(), async (t) => {
  const { root, origin } = await project(t);
  writeFiles(root, {
    "alt.json": JSON.stringify({ eula: true, server: { downloadUrl: `${origin}/bedrock-server-1.26.99.0.zip`, directory: "alt-data" } })
  });
  assert.equal(await run(["install", "--config", "alt.json"], { root, io: capture().io }), 0);
  assert.ok(fs.existsSync(path.join(root, "alt-data")));
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});

test("doctor prints a report and exits 1 when something blocks the install", async (t) => {
  const { root } = await project(t, { server: { downloadUrl: "http://127.0.0.1:9/bedrock-server-1.26.61.1.zip" } });
  const { io, out } = capture();
  const code = await run(["doctor"], { root, io, env: {} });
  assert.equal(code, 1);
  assert.match(out.join("\n"), /\[ ok \] runtime/);
  assert.match(out.join("\n"), /blocking problems? found/);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});
