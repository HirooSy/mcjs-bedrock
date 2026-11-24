import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { App, explainFailure } from "../lib/app.js";
import { resolveConfig } from "../lib/engine/config.js";
import { readState } from "../lib/engine/state.js";
import { serverArchive } from "../testkit/archive.js";
import { sendBuffer, startServer } from "../testkit/http.js";
import { memoryLogger } from "../testkit/logger.js";
import { waitFor, workspace } from "../testkit/workspace.js";
import { posixOnly } from "../testkit/helpers.js";
import { logStamp } from "../testkit/helpers.js";

const projectRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bootstrap = async (t, { overrides = {}, scheduler, archive = {}, env = {} } = {}) => {
  const root = workspace(t);
  fs.cpSync(path.join(projectRoot(), "plugins"), path.join(root, "plugins"), { recursive: true });
  fs.cpSync(path.join(projectRoot(), "bridge"), path.join(root, "bridge"), { recursive: true });
  const bytes = serverArchive(archive);
  const { origin, hits } = await startServer(t, (request, response) => sendBuffer(response, bytes));
  const config = resolveConfig({
    eula: true,
    install: { retries: 1, retryDelayMs: 1, timeoutMs: 5000 },
    network: { address: "mc.example.org" },
    commands: { admins: ["Admin"] },
    access: { allowlist: ["Steve"], operators: ["2535440312262399"] },
    backup: { pollMs: 50, holdTimeoutMs: 2000 },
    plugins: { welcome: { delayMs: 10 } },
    ...overrides,
    server: {
      downloadUrl: `${origin}/bedrock-server-1.26.61.1.zip`,
      restartDelayMs: 10,
      stopTimeoutMs: 2000,
      ...(overrides.server ?? {})
    }
  });
  const { logger, lines, has } = memoryLogger();
  const app = new App({ root, config, logger, env, ...(scheduler ? { scheduler } : {}) });
  const holder = { app };
  t.after(() => holder.app.kill());
  const events = [];
  for (const name of ["ready", "stopped", "fatal"]) {
    app.on(name, (payload) => events.push([name, payload]));
  }
  const count = (name) => events.filter(([event]) => event === name).length;
  const received = () => {
    const file = path.join(root, "data", "received.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };
  const tells = () => received().filter((line) => line.startsWith("tellraw"));
  const chat = (player, text) => app.server.write(`__emit ${logStamp()} [Scripting] mcjs:cmd${JSON.stringify({ player, text })}`);
  return { app, root, config, logger, lines, has, hits, events, count, received, tells, chat };
};

const boot = async (context) => {
  await context.app.start();
  await waitFor(() => context.count("ready") === 1, { label: "ready" });
};

test("starting installs the server, writes its configuration and reaches ready", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  assert.equal(fs.existsSync(path.join(s.root, "data")), false);
  await boot(s);
  const data = path.join(s.root, "data");
  assert.ok(fs.existsSync(path.join(data, "bedrock_server")));

  const properties = fs.readFileSync(path.join(data, "server.properties"), "utf8");
  assert.match(properties, /server-port=19132/);
  assert.match(properties, /allow-list=true/);
  assert.match(properties, /level-name=world/);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "allowlist.json"), "utf8")).map((entry) => entry.name), ["Steve"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "permissions.json"), "utf8")), [
    { permission: "operator", xuid: "2535440312262399" }
  ]);

  const manifest = JSON.parse(fs.readFileSync(path.join(data, "development_behavior_packs/mcjs-bridge/manifest.json"), "utf8"));
  assert.deepEqual(manifest.header.min_engine_version, [1, 26, 61]);
  assert.equal(manifest.dependencies[0].version, "2.1.0");
  const settings = fs.readFileSync(path.join(data, "development_behavior_packs/mcjs-bridge/scripts/settings.js"), "utf8");
  assert.match(settings, /"name": "ping"/);
  assert.ok(fs.existsSync(path.join(data, "worlds/world/world_behavior_packs.json")));
  assert.equal(readState(data).install.version, "1.26.61.1");
  assert.equal(s.app.install.changed, true);
});

test("a player command goes through the bridge, the host and back as a tellraw", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  s.chat("Steve", "ping");
  await waitFor(() => s.tells().length === 1, { label: "pong" });
  assert.equal(s.tells()[0], 'tellraw "Steve" {"rawtext":[{"text":"pong"}]}');
});

test("joining players are greeted using the configured address", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  s.app.server.write(`__emit ${logStamp()} Player connected: Steve, xuid: 2535440312262399`);
  await waitFor(() => s.tells().length === 1, { label: "welcome" });
  assert.equal(s.tells()[0], 'tellraw "Steve" {"rawtext":[{"text":"welcome to mc.example.org"}]}');
  assert.ok(s.has("info", "player joined Steve"));
});

test("the players command reflects who is online", posixOnly(), async (t) => {
  const s = await bootstrap(t, { overrides: { plugins: { welcome: { enabled: false } } } });
  await boot(s);
  s.app.server.write(`__emit ${logStamp()} Player connected: Steve, xuid: 2535440312262399`);
  await waitFor(() => s.app.server.playerNames().length === 1);
  s.chat("Steve", "players");
  await waitFor(() => s.tells().length === 1);
  assert.match(s.tells()[0], /online 1: Steve/);
});

test("admin commands are enforced end to end", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  s.chat("Mallory", "cmd op Mallory");
  await waitFor(() => s.tells().length === 1);
  assert.match(s.tells()[0], /no permission/);
  assert.equal(s.received().includes("op Mallory"), false);
  s.chat("Admin", "cmd time set day");
  await waitFor(() => s.received().includes("time set day"), { label: "forwarded command" });
});

test("the backup command creates a backup through the save protocol", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  fs.mkdirSync(path.join(s.root, "data/worlds/world/db"), { recursive: true });
  fs.writeFileSync(path.join(s.root, "data/worlds/world/level.dat"), "level");
  fs.writeFileSync(path.join(s.root, "data/worlds/world/db/000001.ldb"), "table");
  assert.equal(fs.existsSync(path.join(s.root, "backups")), false);
  s.chat("Admin", "backup");
  await waitFor(() => s.tells().some((line) => /saved, \d+ files/.test(line)), { label: "backup reply" });
  const [name] = fs.readdirSync(path.join(s.root, "backups"));
  assert.equal(fs.readFileSync(path.join(s.root, "backups", name, "world/db/000001.ldb"), "utf8"), "table");
  assert.equal(fs.readFileSync(path.join(s.root, "backups", name, "world/level.dat"), "utf8"), "level");
  assert.deepEqual(
    s.received().filter((line) => line.startsWith("save")),
    ["save hold", "save query", "save resume"]
  );
});

test("the restart command restarts the server process", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  s.chat("Admin", "restart");
  await waitFor(() => s.count("ready") === 2, { label: "second ready" });
  assert.equal(s.count("stopped"), 0);
});

test("console input with a slash reaches the server and dot commands reach the plugins", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  await s.app.console("/list");
  await waitFor(() => s.received().includes("list"), { label: "console passthrough" });
  await s.app.console(".ping");
  assert.ok(s.has("info", "pong"));
  await s.app.console(".nonsense");
  assert.ok(s.has("info", "unknown command nonsense"));
});

test("typing stop on the console stops the whole application", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  await s.app.console("stop");
  await waitFor(() => s.count("stopped") === 1, { label: "stopped" });
  assert.equal(s.events.find(([name]) => name === "stopped")[1], 0);
});

test("server output is forwarded to the log without timestamps and can be silenced", posixOnly(), async (t) => {
  const loud = await bootstrap(t);
  await boot(loud);
  await loud.app.console("/hello");
  await waitFor(() => loud.has("info", "Unknown command: hello"), { label: "forwarded line" });
  assert.equal(loud.has("info", "Starting Server"), false);
  assert.ok(loud.has("debug", "Starting Server"));
  const shown = loud.lines.filter((line) => line.level === "info").map((line) => line.message);
  assert.equal(shown.some((message) => /^\[\d{4}-/.test(message)), false);
  assert.equal(shown.some((message) => message.includes("mcjs:cmd")), false);
  const quiet = await bootstrap(t, { overrides: { log: { serverOutput: false } } });
  await boot(quiet);
  await quiet.app.console("/hello");
  await waitFor(() => quiet.received().includes("hello"), { label: "command received" });
  assert.equal(quiet.has("info", "Unknown command: hello"), false);
});

test("a second run reuses the install and does not download again", posixOnly(), async (t) => {
  const first = await bootstrap(t);
  await boot(first);
  await first.app.stop();
  const again = new App({ root: first.root, config: first.config, logger: memoryLogger().logger, env: {} });
  t.after(() => again.kill());
  const ready = new Promise((resolve) => again.once("ready", resolve));
  await again.start();
  await ready;
  assert.equal(again.install.changed, false);
  assert.equal(first.hits.length, 1);
});

test("worlds survive a restart of the application", posixOnly(), async (t) => {
  const first = await bootstrap(t);
  await boot(first);
  fs.mkdirSync(path.join(first.root, "data/worlds/world"), { recursive: true });
  fs.writeFileSync(path.join(first.root, "data/worlds/world/level.dat"), "precious");
  await first.app.stop();
  const again = new App({ root: first.root, config: first.config, logger: memoryLogger().logger, env: {} });
  t.after(() => again.kill());
  const ready = new Promise((resolve) => again.once("ready", resolve));
  await again.start();
  await ready;
  assert.equal(fs.readFileSync(path.join(first.root, "data/worlds/world/level.dat"), "utf8"), "precious");
});

test("scheduled backups are registered from the config and skip a server that is not ready", posixOnly(), async (t) => {
  const tasks = new Map();
  const scheduler = { every: (name, ms, task) => tasks.set(name, { ms, task }), stop: () => tasks.clear() };
  const s = await bootstrap(t, { scheduler, overrides: { backup: { intervalMinutes: 15, pollMs: 50, holdTimeoutMs: 2000 } } });
  await boot(s);
  assert.equal(tasks.get("backup").ms, 15 * 60000);
  fs.mkdirSync(path.join(s.root, "data/worlds/world"), { recursive: true });
  fs.writeFileSync(path.join(s.root, "data/worlds/world/level.dat"), "level");
  await tasks.get("backup").task();
  assert.equal(fs.readdirSync(path.join(s.root, "backups")).length, 1);
});

test("no backup task is scheduled when the interval is zero or backups are disabled", posixOnly(), async (t) => {
  for (const backup of [{ intervalMinutes: 0 }, { enabled: false, intervalMinutes: 30 }]) {
    const tasks = new Map();
    const scheduler = { every: (name, ms, task) => tasks.set(name, { ms, task }), stop: () => {} };
    const s = await bootstrap(t, { scheduler, overrides: { backup } });
    await boot(s);
    assert.equal(tasks.size, 0);
    await s.app.stop();
  }
});

test("a crash loop surfaces as a fatal error and stops the schedule", posixOnly(), async (t) => {
  const stops = { count: 0 };
  const scheduler = { every: () => {}, stop: () => (stops.count += 1) };
  const s = await bootstrap(t, { scheduler, overrides: { server: { maxRestarts: 1, restartWindowMs: 60000 } } });
  await boot(s);
  const before = stops.count;
  s.app.server.write("__crash");
  await waitFor(() => s.count("ready") === 2, { label: "restart" });
  s.app.server.write("__crash");
  await waitFor(() => s.count("fatal") === 1, { label: "fatal" });
  assert.match(s.events.find(([name]) => name === "fatal")[1].message, /giving up/);
  assert.ok(stops.count > before);
});

test("a missing binary with autoInstall disabled fails to start and creates nothing", async (t) => {
  const s = await bootstrap(t, { overrides: { server: { autoInstall: false } } });
  await assert.rejects(s.app.start(), /autoInstall is disabled/);
  assert.equal(fs.existsSync(path.join(s.root, "data")), false);
});

test("stopping an application that never started is harmless", async (t) => {
  const s = await bootstrap(t);
  assert.equal(await s.app.stop(), 0);
  s.app.kill();
});

test("the port allocated by the hosting panel is used automatically", posixOnly(), async (t) => {
  const s = await bootstrap(t, {
    env: { SERVER_PORT: "5497", SERVER_IP: "93.177.64.145" },
    overrides: { network: { address: null, port: null, portV6: null } }
  });
  await boot(s);
  const properties = fs.readFileSync(path.join(s.root, "data/server.properties"), "utf8");
  assert.match(properties, /server-port=5497/);
  assert.match(properties, /server-portv6=5498/);
  assert.ok(s.has("debug", "listening on UDP 5497 (from SERVER_PORT), IPv6 5498"));
  assert.ok(s.has("info", "server ready 93.177.64.145:5497"));
  s.chat("Steve", "info");
  await waitFor(() => s.tells().length === 1);
  assert.match(s.tells()[0], /93\.177\.64\.145:5497 version 1\.26\.61\.1/);
});

test("an explicit port in the config beats the panel allocation", posixOnly(), async (t) => {
  const s = await bootstrap(t, {
    env: { SERVER_PORT: "5497" },
    overrides: { network: { address: "mc.example.org", port: 20000, portV6: 20001 } }
  });
  await boot(s);
  const properties = fs.readFileSync(path.join(s.root, "data/server.properties"), "utf8");
  assert.match(properties, /server-port=20000/);
  assert.match(properties, /server-portv6=20001/);
  assert.ok(s.has("debug", "listening on UDP 20000 (from config), IPv6 20001"));
});

test("without a panel the default bedrock ports are used", posixOnly(), async (t) => {
  const s = await bootstrap(t, { overrides: { network: { address: null, port: null, portV6: null } } });
  await boot(s);
  assert.match(fs.readFileSync(path.join(s.root, "data/server.properties"), "utf8"), /server-port=19132\nserver-portv6=19133/);
  assert.ok(s.has("info", "server ready localhost:19132"));
});

test("a server that exits before it is ready ends in a crash loop with advice", posixOnly(), async (t) => {
  const s = await bootstrap(t, {
    archive: { binaryData: "#!/bin/sh\necho starting\nexit 3\n" },
    overrides: { server: { maxRestarts: 2, restartWindowMs: 60000 } }
  });
  await s.app.start();
  await waitFor(() => s.count("fatal") === 1, { label: "fatal" });
  const message = s.events.find(([name]) => name === "fatal")[1].message;
  assert.match(message, /exited 3 times within 60000ms, giving up \(it never became ready\)/);
  assert.match(message, /missing libcurl4.*x86_64.*node start\.js doctor/);
  assert.equal(s.count("ready"), 0);
});

test("a crash loop after the server was ready carries no startup advice", posixOnly(), async (t) => {
  const s = await bootstrap(t, { overrides: { server: { maxRestarts: 1, restartWindowMs: 60000 } } });
  await boot(s);
  s.app.server.write("__crash");
  await waitFor(() => s.count("ready") === 2);
  s.app.server.write("__crash");
  await waitFor(() => s.count("fatal") === 1);
  const message = s.events.find(([name]) => name === "fatal")[1].message;
  assert.match(message, /giving up$/);
});

test("failures are explained according to their cause", () => {
  assert.match(explainFailure({ code: "ENOEXEC" }), /x86_64/);
  assert.match(explainFailure({ code: "EACCES" }), /noexec/);
  assert.match(explainFailure({ code: "ENOENT" }), /missing/);
  assert.match(explainFailure({ code: "CRASH_LOOP", neverReady: true }), /before it is ready/);
  assert.equal(explainFailure({ code: "CRASH_LOOP", neverReady: false }), null);
  assert.equal(explainFailure({ code: "EPIPE" }), null);
  assert.equal(explainFailure(new Error("plain")), null);
});

test("plain console text is sent to the game as a colored admin message", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  await s.app.console("halo dunia");
  await waitFor(() => s.tells().some((line) => line.includes("halo dunia")), { label: "chat line" });
  const line = s.tells().find((entry) => entry.includes("halo dunia"));
  assert.equal(line, `tellraw @a ${JSON.stringify({ rawtext: [{ text: "\u00a7a[ Admin]\u00a7r \u00a7ehalo dunia" }] })}`);
  assert.ok(s.has("info", "[ Admin] halo dunia"));
  assert.equal(s.received().includes("halo dunia"), false);
});

test("the chat prefix and colors follow the config", posixOnly(), async (t) => {
  const s = await bootstrap(t, { overrides: { chat: { prefix: "[Owner]", prefixColor: "red", messageColor: "white" } } });
  await boot(s);
  await s.app.console("hi");
  await waitFor(() => s.tells().some((line) => line.includes("hi")), { label: "chat line" });
  assert.ok(s.tells().some((line) => line.includes("\u00a7c[Owner]\u00a7r \u00a7fhi")));
});

test("blank console lines are ignored and stop, slash and dot lines are never chat", posixOnly(), async (t) => {
  const s = await bootstrap(t);
  await boot(s);
  assert.equal(await s.app.console("   "), false);
  await s.app.console("/say hi");
  await waitFor(() => s.received().includes("say hi"), { label: "slash command" });
  assert.equal(s.tells().some((line) => line.includes("say hi")), false);
  await s.app.console("STOP");
  await waitFor(() => s.count("stopped") === 1, { label: "stopped" });
});

test("the console cannot chat before the server exists", async (t) => {
  const s = await bootstrap(t);
  assert.equal(await s.app.console("hello"), false);
});
