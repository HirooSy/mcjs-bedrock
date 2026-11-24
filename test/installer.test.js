import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { assertWritable, createInstaller } from "../lib/installer/index.js";
import { readState } from "../lib/engine/state.js";
import { createScenario } from "../testkit/scenario.js";
import { posixOnly } from "../testkit/helpers.js";

test("a fresh install downloads, extracts and records the version", async (t) => {
  const s = await createScenario(t);
  assert.equal(fs.existsSync(s.dataDir()), false);
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(result.changed, true);
  assert.equal(result.version, "1.26.61.1");
  assert.equal(result.channel, "release");
  assert.equal(result.binaryPath, path.join(s.dataDir(), "bedrock_server"));
  assert.ok(fs.existsSync(result.binaryPath));
  assert.ok(fs.existsSync(path.join(s.dataDir(), "behavior_packs/vanilla/manifest.json")));
  const state = readState(s.dataDir());
  assert.equal(state.install.version, "1.26.61.1");
  assert.equal(state.installing, null);
  assert.match(state.install.source, /bedrock-server-1\.26\.61\.1\.zip$/);
  assert.deepEqual(s.tmpLeftovers(), []);
  assert.equal(fs.existsSync(`${result.binaryPath}.mcjs-new`), false);
});

test("the installed binary is executable", posixOnly(), async (t) => {
  const s = await createScenario(t);
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(fs.statSync(result.binaryPath).mode & 0o111, 0o111);
});

test("looking up and failing to install never creates the data folder", async (t) => {
  const s = await createScenario(t);
  await s.installer.check(s.config(), s.root);
  assert.equal(fs.existsSync(s.dataDir()), false);
  s.behavior.zip = 500;
  await assert.rejects(s.installer.ensure(s.config(), s.root));
  assert.equal(fs.existsSync(s.dataDir()), false);
  assert.deepEqual(fs.readdirSync(s.root), []);
});

test("the eula must be accepted and nothing is touched or requested otherwise", async (t) => {
  const s = await createScenario(t);
  await assert.rejects(s.installer.ensure(s.config({ eula: false }), s.root), /EULA must be accepted.*minecraft\.net\/en-us\/eula/);
  assert.equal(s.hits.length, 0);
  assert.equal(fs.existsSync(s.dataDir()), false);
});

test("a failed download leaves no data folder and no temporary files", async (t) => {
  const s = await createScenario(t);
  s.behavior.zip = 404;
  await assert.rejects(s.installer.ensure(s.config(), s.root), /404/);
  assert.equal(fs.existsSync(s.dataDir()), false);
  assert.deepEqual(s.tmpLeftovers(), []);
});

test("a download that is not a zip archive is rejected before anything is written", async (t) => {
  const s = await createScenario(t);
  const config = s.config({ server: { downloadUrl: `${s.origin}/api` } });
  await assert.rejects(s.installer.ensure(config, s.root), /not a zip archive/);
  assert.equal(fs.existsSync(s.dataDir()), false);
  assert.deepEqual(s.tmpLeftovers(), []);
});

test("an archive without the server binary is rejected", async (t) => {
  const s = await createScenario(t);
  await assert.rejects(s.installer.ensure(s.config({ server: { binary: "other_binary" } }), s.root), /does not contain other_binary/);
  assert.equal(fs.existsSync(s.dataDir()), false);
});

test("an up to date install makes only the api request", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(result.changed, false);
  assert.equal(result.version, "1.26.61.1");
  assert.equal(s.zipRequests(), 1);
  assert.equal(s.apiRequests(), 2);
});

test("autoUpdate disabled makes no request at all once installed", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  const before = s.hits.length;
  const result = await s.installer.ensure(s.config({ server: { autoUpdate: false } }), s.root);
  assert.equal(result.changed, false);
  assert.equal(s.hits.length, before);
});

test("an update keeps worlds, properties, allowlist, permissions and script config", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  const data = s.dataDir();
  const keep = {
    "worlds/world/db/000001.ldb": "world data",
    "server.properties": "server-name=Mine\n",
    "allowlist.json": '[{"name":"Steve"}]\n',
    "permissions.json": '[{"permission":"operator","xuid":"1234567890"}]\n',
    "config/default/permissions.json": '{"allowed_modules":["@minecraft/server","@minecraft/server-ui"]}\n',
    "behavior_packs/custom/manifest.json": "mine\n"
  };
  for (const [name, content] of Object.entries(keep)) {
    fs.mkdirSync(path.dirname(path.join(data, name)), { recursive: true });
    fs.writeFileSync(path.join(data, name), content);
  }
  s.releases.release = "1.26.62.2";
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(result.changed, true);
  assert.equal(result.version, "1.26.62.2");
  for (const [name, content] of Object.entries(keep)) {
    assert.equal(fs.readFileSync(path.join(data, name), "utf8"), content, name);
  }
  assert.match(fs.readFileSync(path.join(data, "behavior_packs/vanilla/manifest.json"), "utf8"), /1\.26\.62\.2/);
  assert.match(fs.readFileSync(path.join(data, "release-notes.txt"), "utf8"), /1\.26\.62\.2/);
  assert.equal(readState(data).install.version, "1.26.62.2");
});

test("a world shipped inside the archive never overwrites an existing world", async (t) => {
  const s = await createScenario(t, {
    archiveExtra: [
      { name: "worlds/", data: "" },
      { name: "worlds/world/level.dat", data: "shipped" },
      { name: "worlds/other/level.dat", data: "shipped other" }
    ]
  });
  fs.mkdirSync(path.join(s.dataDir(), "worlds/world"), { recursive: true });
  fs.writeFileSync(path.join(s.dataDir(), "worlds/world/level.dat"), "players built this");
  fs.writeFileSync(path.join(s.dataDir(), "bedrock_server"), "old binary");
  fs.writeFileSync(path.join(s.dataDir(), "mcjs.json"), JSON.stringify({ install: { version: "1.0.0.0", channel: "release" } }));
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(result.changed, true);
  assert.equal(fs.readFileSync(path.join(s.dataDir(), "worlds/world/level.dat"), "utf8"), "players built this");
  assert.equal(fs.existsSync(path.join(s.dataDir(), "worlds/other")), false);
});

test("an unreachable api falls back to the installed server with a warning", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  s.behavior.api = 500;
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(result.changed, false);
  assert.equal(result.stale, true);
  assert.equal(result.version, "1.26.61.1");
  assert.ok(s.has("warn", "could not check for updates"));
});

test("an unreachable api on a fresh machine is a clear error", async (t) => {
  const s = await createScenario(t);
  s.behavior.api = 500;
  await assert.rejects(s.installer.ensure(s.config(), s.root), /cannot find a server download/);
  assert.equal(fs.existsSync(s.dataDir()), false);
});

test("a flaky api succeeds after retries", async (t) => {
  const s = await createScenario(t);
  s.behavior.apiFailures = 2;
  const result = await s.installer.ensure(s.config({ install: { retries: 3, retryDelayMs: 1 } }), s.root);
  assert.equal(result.changed, true);
  assert.equal(s.apiRequests(), 3);
  assert.ok(s.has("warn", "lookup failed"));
});

test("an api that keeps failing gives up after the configured retries", async (t) => {
  const s = await createScenario(t);
  s.behavior.apiFailures = 10;
  await assert.rejects(s.installer.ensure(s.config({ install: { retries: 2, retryDelayMs: 1 } }), s.root), /cannot find a server download/);
  assert.equal(s.apiRequests(), 2);
});

test("a pinned version is fetched by name and never re-downloaded", async (t) => {
  const s = await createScenario(t);
  const config = s.config({ server: { version: "1.26.50.2" } });
  const first = await s.installer.ensure(config, s.root);
  assert.equal(first.version, "1.26.50.2");
  assert.equal(s.apiRequests(), 0);
  const before = s.hits.length;
  const second = await s.installer.ensure(config, s.root);
  assert.equal(second.changed, false);
  assert.equal(s.hits.length, before);
});

test("changing the pinned version reinstalls", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config({ server: { version: "1.26.50.2" } }), s.root);
  const result = await s.installer.ensure(s.config({ server: { version: "1.26.51.1" } }), s.root);
  assert.equal(result.changed, true);
  assert.equal(readState(s.dataDir()).install.version, "1.26.51.1");
});

test("switching from release to preview installs the preview build", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  const result = await s.installer.ensure(s.config({ server: { version: "preview" } }), s.root);
  assert.equal(result.changed, true);
  assert.equal(result.channel, "preview");
  assert.equal(result.version, "1.26.70.22");
});

test("a direct download url installs once and reinstalls only when the url changes", async (t) => {
  const s = await createScenario(t);
  const url = (version) => `${s.origin}/custom/bedrock-server-${version}.zip`;
  const first = await s.installer.ensure(s.config({ server: { downloadUrl: url("1.26.40.1") } }), s.root);
  assert.equal(first.version, "1.26.40.1");
  assert.equal(s.apiRequests(), 0);
  const again = await s.installer.ensure(s.config({ server: { downloadUrl: url("1.26.40.1") } }), s.root);
  assert.equal(again.changed, false);
  assert.equal(s.zipRequests(), 1);
  const changed = await s.installer.ensure(s.config({ server: { downloadUrl: url("1.26.41.1") } }), s.root);
  assert.equal(changed.changed, true);
});

test("a binary placed by hand is adopted without any download", async (t) => {
  const s = await createScenario(t);
  fs.mkdirSync(s.dataDir(), { recursive: true });
  fs.writeFileSync(path.join(s.dataDir(), "bedrock_server"), "custom");
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(result.managed, false);
  assert.equal(result.changed, false);
  assert.equal(s.hits.length, 0);
  assert.equal(fs.readFileSync(result.binaryPath, "utf8"), "custom");
});

test("with autoInstall disabled a missing binary is an error and nothing is created", async (t) => {
  const s = await createScenario(t);
  await assert.rejects(s.installer.ensure(s.config({ server: { autoInstall: false } }), s.root), /server\.autoInstall is disabled/);
  assert.equal(fs.existsSync(s.dataDir()), false);
  assert.equal(s.hits.length, 0);
});

test("an interrupted install is repaired on the next run", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  fs.writeFileSync(path.join(s.dataDir(), "mcjs.json"), JSON.stringify({ installing: { version: "1.26.61.1" } }));
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(result.changed, true);
  assert.equal(readState(s.dataDir()).installing, null);
});

test("an update is skipped with a warning when the eula is no longer accepted", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  s.releases.release = "1.26.62.2";
  const result = await s.installer.ensure(s.config({ eula: false }), s.root);
  assert.equal(result.changed, false);
  assert.equal(result.stale, true);
  assert.ok(s.has("warn", "eula is not accepted"));
});

test("windows installs use the exe name", async (t) => {
  const s = await createScenario(t, { platform: "win32" });
  const result = await s.installer.ensure(s.config(), s.root);
  assert.equal(path.basename(result.binaryPath), "bedrock_server.exe");
  assert.ok(fs.existsSync(result.binaryPath));
});

test("unsupported platforms fail before any request", async (t) => {
  const s = await createScenario(t);
  const installer = createInstaller({ logger: s.logger, platform: "darwin", tmpRoot: s.tmpRoot, apiUrl: `${s.origin}/api` });
  await assert.rejects(installer.ensure(s.config(), s.root), /unsupported platform darwin/);
  assert.equal(s.hits.length, 0);
});

test("check compares the installed version with the available one", async (t) => {
  const s = await createScenario(t);
  const before = await s.installer.check(s.config(), s.root);
  assert.equal(before.installed, null);
  assert.equal(before.present, false);
  assert.equal(before.current, false);
  assert.equal(fs.existsSync(s.dataDir()), false);
  await s.installer.ensure(s.config(), s.root);
  const current = await s.installer.check(s.config(), s.root);
  assert.equal(current.current, true);
  assert.deepEqual(current.installed, { version: "1.26.61.1", channel: "release" });
  s.releases.release = "1.26.62.2";
  const outdated = await s.installer.check(s.config(), s.root);
  assert.equal(outdated.current, false);
  assert.equal(outdated.available.version, "1.26.62.2");
});

test("every step of an install is visible in the log", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  assert.ok(s.has("debug", "no server installed yet, looking up the download"));
  assert.ok(s.has("info", "installing bedrock server 1.26.61.1"));
  assert.ok(s.has("debug", "downloading 1.26.61.1 from "));
  assert.ok(s.has("debug", "connecting to 127.0.0.1"));
  assert.ok(s.has("debug", "connected to 127.0.0.1"));
  assert.ok(s.has("info", "downloading 1.26.61.1: finished"));
  assert.ok(s.has("debug", "extracting the archive"));
  assert.ok(s.has("info", "installed bedrock server 1.26.61.1"));
});

test("an unwritable target folder is reported before anything is downloaded", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const s = await createScenario(t);
  fs.chmodSync(s.root, 0o555);
  t.after(() => {
    try {
      fs.chmodSync(s.root, 0o755);
    } catch {}
  });
  await assert.rejects(s.installer.ensure(s.config(), s.root), /cannot write to .*EACCES.*stop and start the server/s);
  assert.equal(s.zipRequests(), 0);
  assert.equal(fs.existsSync(s.dataDir()), false);
});

test("a writable target folder passes the check", async (t) => {
  const s = await createScenario(t);
  assert.doesNotThrow(() => assertWritable(s.dataDir()));
});
