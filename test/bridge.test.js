import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConfig } from "../lib/engine/config.js";
import { parseLine } from "../lib/engine/parser.js";
import { syncPacks } from "../lib/manager/packs.js";
import { createHost } from "../testkit/harness.js";
import { memoryLogger } from "../testkit/logger.js";
import { workspace } from "../testkit/workspace.js";

const projectRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const stubModule = () => `
  export const CommandPermissionLevel = { Any: "any" };
  export const CustomCommandParamType = { String: "string" };
  export const CustomCommandStatus = { Success: "success", Failure: "failure" };
  export const DisplaySlotId = { Sidebar: "sidebar" };
  export const ObjectiveSortOrder = { Descending: "descending" };
  export const world = {
    scoreboard: {
      getObjective: () => undefined,
      addObjective: (id, title) => { const board = { id, title, scores: {}, setScore: (name, value) => { board.scores[name] = value; } }; globalThis.bridgeBoard = board; return board; },
      setObjectiveAtDisplaySlot: (slot, options) => { globalThis.bridgeSlot = [slot, options.sortOrder]; }
    },
    getAllPlayers: () => [{}, {}]
  };
  export const system = {
    currentTick: 0,
    runInterval: (callback, ticks) => { globalThis.bridgeInterval = { callback, ticks }; },
    beforeEvents: { startup: { subscribe: (callback) => { globalThis.bridgeStartup = callback; } } }
  };
`;

const loadBridge = async (t, { config = resolveConfig({}), commands }) => {
  const directory = path.join(workspace(t), "data");
  const host = createHost(t, { root: projectRoot() }).host;
  await host.load();
  const described = commands ?? host.describe().map(({ name, description }) => ({ name, description }));
  await syncPacks({ root: projectRoot(), directory, config, engineVersion: [1, 26, 61], commands: described, logger: memoryLogger().logger });
  const scripts = path.join(directory, "development_behavior_packs/mcjs-bridge/scripts");
  const original = fs.readFileSync(path.join(scripts, "main.js"), "utf8");
  const stubUrl = `data:text/javascript,${encodeURIComponent(stubModule())}`;
  const patched = original.replace('"@minecraft/server"', JSON.stringify(stubUrl));
  assert.notEqual(patched, original);
  const entry = path.join(scripts, "main.under-test.mjs");
  fs.writeFileSync(entry, patched);
  delete globalThis.bridgeStartup;
  delete globalThis.bridgeInterval;
  await import(`${pathToFileURL(entry).href}?v=${Date.now()}-${Math.random()}`);
  assert.equal(typeof globalThis.bridgeStartup, "function");
  const registered = [];
  globalThis.bridgeStartup({ customCommandRegistry: { registerCommand: (definition, callback) => registered.push({ definition, callback }) } });
  return { registered, config, scripts };
};

const player = (name = "Steve") => ({ sourceEntity: { typeId: "minecraft:player", name } });

test("one custom command is registered for every host command and alias", async (t) => {
  const { registered } = await loadBridge(t, {});
  const names = registered.map(({ definition }) => definition.name).sort();
  assert.deepEqual(names, [
    "mcjs:backup",
    "mcjs:broadcast",
    "mcjs:cmd",
    "mcjs:deltp",
    "mcjs:help",
    "mcjs:info",
    "mcjs:online",
    "mcjs:ping",
    "mcjs:players",
    "mcjs:reload",
    "mcjs:restart",
    "mcjs:rtp",
    "mcjs:settp",
    "mcjs:tp",
    "mcjs:uptime",
    "mcjs:warp"
  ]);
});

test("registered commands need no cheats and accept up to eight words", async (t) => {
  const { registered } = await loadBridge(t, {});
  for (const { definition } of registered) {
    assert.equal(definition.cheatsRequired, false);
    assert.equal(definition.permissionLevel, "any");
    assert.equal(typeof definition.description, "string");
    assert.deepEqual(
      definition.optionalParameters.map((parameter) => parameter.name),
      ["arg1", "arg2", "arg3", "arg4", "arg5", "arg6", "arg7", "arg8"]
    );
    assert.ok(definition.optionalParameters.every((parameter) => parameter.type === "string"));
  }
});

test("the configured namespace and marker are honoured", async (t) => {
  const config = resolveConfig({ commands: { namespace: "srv" }, bridge: { marker: "tag:cmd" } });
  const { registered } = await loadBridge(t, { config, commands: [{ name: "ping", description: "check" }] });
  assert.deepEqual(registered.map(({ definition }) => definition.name), ["srv:ping"]);
  const log = mock.method(console, "log", () => {});
  t.after(() => log.mock.restore());
  registered[0].callback(player());
  assert.ok(String(log.mock.calls[0].arguments[0]).startsWith("tag:cmd{"));
});

test("a player running a command emits a line the host parser understands", async (t) => {
  const { registered } = await loadBridge(t, {});
  const log = mock.method(console, "log", () => {});
  t.after(() => log.mock.restore());
  const broadcast = registered.find(({ definition }) => definition.name === "mcjs:broadcast");
  const result = broadcast.callback(player("Alex"), "hello", "big", undefined, "world", undefined);
  assert.deepEqual(result, { status: "success" });
  const line = log.mock.calls[0].arguments[0];
  assert.deepEqual(parseLine(`[2026-11-04 08:49:08:469 INFO] [Scripting] ${line}`, "mcjs:cmd"), {
    type: "chat",
    player: "Alex",
    text: "broadcast hello big world"
  });
});

test("a command without arguments sends just its name", async (t) => {
  const { registered } = await loadBridge(t, {});
  const log = mock.method(console, "log", () => {});
  t.after(() => log.mock.restore());
  registered.find(({ definition }) => definition.name === "mcjs:ping").callback(player());
  assert.equal(parseLine(log.mock.calls[0].arguments[0], "mcjs:cmd").text, "ping");
});

test("player names and arguments containing quotes survive the round trip", async (t) => {
  const { registered } = await loadBridge(t, {});
  const log = mock.method(console, "log", () => {});
  t.after(() => log.mock.restore());
  registered.find(({ definition }) => definition.name === "mcjs:cmd").callback(player('We"ird\\Name'), 'say "hi"');
  assert.deepEqual(parseLine(log.mock.calls[0].arguments[0], "mcjs:cmd"), {
    type: "chat",
    player: 'We"ird\\Name',
    text: 'cmd say "hi"'
  });
});

test("commands run from a block or the console are refused and emit nothing", async (t) => {
  const { registered } = await loadBridge(t, {});
  const log = mock.method(console, "log", () => {});
  t.after(() => log.mock.restore());
  const ping = registered.find(({ definition }) => definition.name === "mcjs:ping");
  assert.deepEqual(ping.callback({ sourceEntity: undefined }), { status: "failure", message: "players only" });
  assert.deepEqual(ping.callback({ sourceEntity: { typeId: "minecraft:zombie", name: "Zed" } }), {
    status: "failure",
    message: "players only"
  });
  assert.equal(log.mock.calls.length, 0);
});

test("the generated settings module sits next to the script and imports nothing", async (t) => {
  const { scripts } = await loadBridge(t, {});
  const text = fs.readFileSync(path.join(scripts, "settings.js"), "utf8");
  assert.ok(text.startsWith("export default {"));
  assert.equal(/\bimport\b/.test(text), false);
  assert.match(text, /"namespace": "mcjs"/);
  assert.match(text, /"marker": "mcjs:cmd"/);
});

test("the bridge starts the status sidebar with the generated settings", async (t) => {
  await loadBridge(t, { config: resolveConfig({ plugins: { status: { intervalSeconds: 3 } } }) });
  assert.equal(globalThis.bridgeInterval.ticks, 60);
  globalThis.bridgeInterval.callback();
  assert.equal(globalThis.bridgeBoard, undefined);
});

test("a disabled status plugin starts nothing", async (t) => {
  await loadBridge(t, { config: resolveConfig({ plugins: { status: { enabled: false } } }) });
  assert.equal(globalThis.bridgeInterval, undefined);
});

test("a command carries the position of the player who ran it", async (t) => {
  const { registered } = await loadBridge(t, {});
  const log = mock.method(console, "log", () => {});
  t.after(() => log.mock.restore());
  const sender = {
    typeId: "minecraft:player",
    name: "Steve",
    location: { x: 10.123, y: 64, z: -3.456 },
    dimension: { id: "minecraft:nether" }
  };
  registered.find(({ definition }) => definition.name === "mcjs:settp").callback({ sourceEntity: sender }, "base");
  assert.deepEqual(parseLine(log.mock.calls[0].arguments[0], "mcjs:cmd"), {
    type: "chat",
    player: "Steve",
    text: "settp base",
    at: { x: 10.12, y: 64, z: -3.46, dimension: "nether" }
  });
});
