import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/engine/config.js";
import { BedrockServer } from "../lib/engine/server.js";
import { BackupService, isBackupName, parseFileList, restoreBackup } from "../lib/manager/backup.js";
import { fakeServerPath } from "../testkit/archive.js";
import { memoryLogger } from "../testkit/logger.js";
import { listTree, waitFor, workspace, writeFiles } from "../testkit/workspace.js";

const worldFiles = (level = "world") => ({
  [`worlds/${level}/level.dat`]: "level-data-0123456789",
  [`worlds/${level}/levelname.txt`]: level,
  [`worlds/${level}/db/CURRENT`]: "MANIFEST-000005\n",
  [`worlds/${level}/db/000005.ldb`]: "x".repeat(400)
});

const fixedClock = (seconds = 0) => {
  let tick = seconds;
  return () => new Date(Date.UTC(2026, 10, 4, 6, 39, 0) + 1000 * tick++);
};

const setup = async (t, { args = [], files = worldFiles(), settings = {}, clock = fixedClock(), level = "world" } = {}) => {
  const holder = { server: null };
  t.after(() => holder.server?.kill());
  const directory = workspace(t);
  const backupRoot = path.join(workspace(t), "backups");
  writeFiles(directory, files);
  const { logger, has } = memoryLogger();
  const server = new BedrockServer({
    binaryPath: process.execPath,
    args: [fakeServerPath(), `--level=${level}`, ...args],
    runDir: directory,
    marker: "mcjs:cmd",
    autoRestart: false,
    restartDelayMs: 10,
    stopTimeoutMs: 2000,
    maxRestarts: 0,
    restartWindowMs: 1000,
    logger
  });
  holder.server = server;
  const config = resolveConfig({ backup: { holdTimeoutMs: 800, pollMs: 80, keep: 3, ...settings } });
  const service = new BackupService({ server, directory, root: backupRoot, settings: config.backup, logger, settleMs: 30, clock });
  const received = () => {
    const file = path.join(directory, "received.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };
  server.start();
  await waitFor(() => server.isReady(), { label: "server ready" });
  return { server, service, directory, backupRoot, received, has, config };
};

test("a backup follows the hold, query, copy, resume protocol", async (t) => {
  const { service, backupRoot, received, directory } = await setup(t);
  assert.equal(fs.existsSync(backupRoot), false);
  const result = await service.create();
  assert.equal(result.name, "2026-11-04T06-39-00");
  assert.equal(result.files, 4);
  await waitFor(() => received().length === 3, { label: "save resume" });
  assert.deepEqual(received(), ["save hold", "save query", "save resume"]);
  assert.deepEqual(listTree(path.join(backupRoot, result.name)), [
    "world/db/000005.ldb",
    "world/db/CURRENT",
    "world/level.dat",
    "world/levelname.txt"
  ]);
  for (const file of listTree(path.join(backupRoot, result.name))) {
    assert.ok(
      fs.readFileSync(path.join(backupRoot, result.name, file)).equals(fs.readFileSync(path.join(directory, "worlds", file)))
    );
  }
  assert.equal(result.bytes, 21 + 5 + 16 + 400);
});

test("polling continues until the server reports the world as ready", async (t) => {
  const { service, received } = await setup(t, { args: ["--query-delay=2"] });
  await service.create();
  await waitFor(() => received().at(-1) === "save resume", { label: "save resume" });
  assert.equal(received().filter((line) => line === "save query").length, 3);
});

test("copies are truncated to the lengths the server reported", async (t) => {
  const { service, backupRoot } = await setup(t, { args: ["--shrink=10"] });
  const result = await service.create();
  assert.equal(fs.statSync(path.join(backupRoot, result.name, "world/db/000005.ldb")).size, 390);
  assert.equal(fs.statSync(path.join(backupRoot, result.name, "world/level.dat")).size, 11);
});

test("worlds with spaces in their name are backed up", async (t) => {
  const { service, backupRoot } = await setup(t, { files: worldFiles("My World"), level: "My World" });
  const result = await service.create();
  assert.ok(fs.existsSync(path.join(backupRoot, result.name, "My World/level.dat")));
});

test("a world that never becomes ready fails, resumes saving and leaves no backup folder", async (t) => {
  const { service, backupRoot, received } = await setup(t, { args: ["--no-save"], settings: { holdTimeoutMs: 300 } });
  await assert.rejects(service.create(), /not ready for backup within 300ms/);
  await waitFor(() => received().at(-1) === "save resume", { label: "save resume" });
  assert.equal(fs.existsSync(backupRoot), false);
  assert.equal(service.running, false);
});

test("a failed backup removes only its own folder", async (t) => {
  const { service, backupRoot, received } = await setup(t, { args: ["--ghost"] });
  writeFiles(backupRoot, { "2026-01-01T00-00-00/world/level.dat": "older" });
  await assert.rejects(service.create(), /ENOENT/);
  assert.deepEqual(fs.readdirSync(backupRoot), ["2026-01-01T00-00-00"]);
  await waitFor(() => received().at(-1) === "save resume", { label: "save resume" });
});

test("a second backup cannot start while one is running", async (t) => {
  const { service } = await setup(t, { args: ["--query-delay=2"] });
  const first = service.create();
  await assert.rejects(service.create(), /already running/);
  await first;
  assert.equal(service.running, false);
});

test("a backup needs a ready server", async (t) => {
  const { service, server } = await setup(t);
  await server.stop();
  await assert.rejects(service.create(), /server is not running/);
});

test("only the newest backups are kept", async (t) => {
  const { service } = await setup(t, { settings: { keep: 2 } });
  const names = [];
  for (let round = 0; round < 4; round += 1) {
    names.push((await service.create()).name);
  }
  assert.deepEqual(service.list(), names.slice(-2));
});

test("backups taken in the same second get distinct names", async (t) => {
  const { service } = await setup(t, { clock: () => new Date(Date.UTC(2026, 10, 4, 6, 39, 0)) });
  const names = [(await service.create()).name, (await service.create()).name, (await service.create()).name];
  assert.deepEqual(names, ["2026-11-04T06-39-00", "2026-11-04T06-39-00-1", "2026-11-04T06-39-00-2"]);
  assert.deepEqual(service.list(), names);
});

test("list ignores unrelated folders and works before any backup exists", async (t) => {
  const { service, backupRoot } = await setup(t);
  assert.deepEqual(service.list(), []);
  writeFiles(backupRoot, { "notes/readme.txt": "x", "2026-11-04T06-39-00/world/level.dat": "x" });
  assert.deepEqual(service.list(), ["2026-11-04T06-39-00"]);
});

test("file lists are parsed from timestamped server output", () => {
  const lines = [
    "[2026-11-04 06:39:00:100 INFO] Data saved. Files are now ready to be copied.",
    "[2026-11-04 06:39:00:101 INFO] world/db/000005.ldb:400, world/level.dat:21, My World/db/CURRENT:16"
  ];
  assert.deepEqual(parseFileList(lines), [
    { path: "world/db/000005.ldb", length: 400 },
    { path: "world/level.dat", length: 21 },
    { path: "My World/db/CURRENT", length: 16 }
  ]);
  assert.deepEqual(parseFileList(["Data saved. Files are now ready to be copied."]), []);
  assert.deepEqual(parseFileList([]), []);
});

test("paths that escape the worlds folder are refused", async (t) => {
  const { service, directory, backupRoot } = await setup(t);
  const target = path.join(backupRoot, "attempt");
  assert.throws(() => service.copyFiles([{ path: "../server.properties", length: 5 }], target), /unsafe path/);
  assert.throws(() => service.copyFiles([{ path: "../../etc/passwd", length: 5 }], target), /unsafe path/);
  assert.equal(fs.existsSync(path.join(directory, "server.properties")), false);
});

test("backup names are validated", () => {
  assert.equal(isBackupName("2026-11-04T06-39-00"), true);
  assert.equal(isBackupName("2026-11-04T06-39-00-2"), true);
  assert.equal(isBackupName("../2026-11-04T06-39-00"), false);
  assert.equal(isBackupName("latest"), false);
});

test("restore replaces the world and keeps the previous one next to it", async (t) => {
  const { service, directory, config, backupRoot } = await setup(t);
  const { name } = await service.create();
  fs.writeFileSync(path.join(directory, "worlds/world/level.dat"), "changed after backup");
  const root = path.dirname(backupRoot);
  const result = restoreBackup({ root, config: { ...config, backup: { ...config.backup, directory: backupRoot }, server: { ...config.server, directory } }, name });
  assert.equal(fs.readFileSync(path.join(directory, "worlds/world/level.dat"), "utf8"), "level-data-0123456789");
  assert.match(path.basename(result.previous), /^world\.replaced-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  assert.equal(fs.readFileSync(path.join(result.previous, "level.dat"), "utf8"), "changed after backup");
});

test("restore works when no world exists yet", async (t) => {
  const { service, directory, config, backupRoot } = await setup(t);
  const { name } = await service.create();
  fs.rmSync(path.join(directory, "worlds"), { recursive: true });
  const root = path.dirname(backupRoot);
  const result = restoreBackup({ root, config: { ...config, backup: { ...config.backup, directory: backupRoot }, server: { ...config.server, directory } }, name });
  assert.equal(result.previous, null);
  assert.ok(fs.existsSync(path.join(directory, "worlds/world/level.dat")));
});

test("restore rejects bad names and backups without the world", async (t) => {
  const { config, backupRoot } = await setup(t);
  const root = path.dirname(backupRoot);
  const local = { ...config, backup: { ...config.backup, directory: backupRoot } };
  assert.throws(() => restoreBackup({ root, config: local, name: "../x" }), /invalid backup name/);
  assert.throws(() => restoreBackup({ root, config: local, name: "2026-01-01T00-00-00" }), /does not contain the world world/);
});
