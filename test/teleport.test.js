import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseLine } from "../lib/engine/parser.js";
import { createHost } from "../testkit/harness.js";
import { workspace } from "../testkit/workspace.js";

const projectRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const setup = async (t, options = {}) => {
  const directory = workspace(t);
  const context = createHost(t, { root: projectRoot(), directory, options: { teleport: { cooldownSeconds: 0, ...options } } });
  await context.host.load();
  context.server.players.set("Steve", "2535440312262399");
  return { ...context, directory };
};

const here = Object.freeze({ x: 10.5, y: 64, z: -20.25, dimension: "overworld" });

const say = async (context, text, { player = "Steve", at = here, origin = "player" } = {}) => {
  context.sent.length = 0;
  await context.host.run({ player, text, at, origin, xuid: context.server.players.get(player) ?? null });
  return context.sent.map((entry) => entry.at(-1));
};

const stored = (context) => JSON.parse(fs.readFileSync(path.join(context.directory, "mcjs-plugins/teleport.json"), "utf8"));

test("settp saves the position and tp sends the player back with a console command", async (t) => {
  const context = await setup(t);
  assert.deepEqual(await say(context, "settp base"), ["tp point base saved"]);
  assert.deepEqual(stored(context), { 2535440312262399: { base: { x: 10.5, y: 64, z: -20.25, dimension: "overworld" } } });
  assert.deepEqual(await say(context, "tp base", { at: { ...here, x: 500 } }), ["execute in overworld run tp \"Steve\" 10.5 64 -20.25", "teleporting to base"]);
});

test("a tp point remembers its dimension", async (t) => {
  const context = await setup(t);
  await say(context, "settp portal", { at: { x: 1, y: 70, z: 2, dimension: "nether" } });
  const [command] = await say(context, "tp portal");
  assert.equal(command, 'execute in nether run tp "Steve" 1 70 2');
});

test("the name defaults to home and is case insensitive", async (t) => {
  const context = await setup(t);
  await say(context, "settp");
  assert.deepEqual(Object.keys(stored(context)["2535440312262399"]), ["home"]);
  assert.equal((await say(context, "tp HOME"))[1], "teleporting to home");
});

test("warp is an alias of tp", async (t) => {
  const context = await setup(t);
  await say(context, "settp base");
  assert.equal((await say(context, "warp base"))[1], "teleporting to base");
});

test("settp overwrites a point of the same name without using up the limit", async (t) => {
  const context = await setup(t, { maxPoints: 1 });
  await say(context, "settp base");
  assert.deepEqual(await say(context, "settp base", { at: { ...here, x: 99 } }), ["tp point base saved"]);
  assert.equal(stored(context)["2535440312262399"].base.x, 99);
});

test("settp stops at the configured number of points", async (t) => {
  const context = await setup(t, { maxPoints: 2 });
  await say(context, "settp a");
  await say(context, "settp b");
  assert.deepEqual(await say(context, "settp c"), ["limit of 2 tp points reached, remove one with /mcjs:deltp <name>"]);
  assert.deepEqual(Object.keys(stored(context)["2535440312262399"]), ["a", "b"]);
});

test("tp points belong to the player who saved them", async (t) => {
  const context = await setup(t);
  context.server.players.set("Alex", "999");
  await say(context, "settp base");
  assert.deepEqual(await say(context, "tp base", { player: "Alex" }), ["no tp points yet, save one with /mcjs:settp [name]"]);
});

test("an unknown tp point lists the ones the player has", async (t) => {
  const context = await setup(t);
  await say(context, "settp b");
  await say(context, "settp a");
  assert.deepEqual(await say(context, "tp nope"), ["no tp point named nope, yours: a, b"]);
});

test("deltp removes a point and reports a missing one", async (t) => {
  const context = await setup(t);
  await say(context, "settp base");
  assert.deepEqual(await say(context, "deltp base"), ["tp point base deleted"]);
  assert.deepEqual(stored(context)["2535440312262399"], {});
  assert.deepEqual(await say(context, "deltp base"), ["no tp points yet, save one with /mcjs:settp [name]"]);
});

test("names that could clash with object internals or break commands are refused", async (t) => {
  const context = await setup(t);
  for (const name of ["__proto__", "a\"b", "way-too-long-name-for-this", "-x"]) {
    assert.deepEqual(await say(context, `settp ${name}`), ["a name uses 1 to 16 letters, digits, - or _"], name);
  }
  assert.equal(fs.existsSync(path.join(context.directory, "mcjs-plugins/teleport.json")), false);
});

test("names such as constructor are ordinary points", async (t) => {
  const context = await setup(t);
  assert.deepEqual(await say(context, "tp constructor"), ["no tp points yet, save one with /mcjs:settp [name]"]);
  await say(context, "settp constructor");
  assert.equal((await say(context, "tp constructor"))[1], "teleporting to constructor");
});

test("player names with quotes are escaped in console commands", async (t) => {
  const context = await setup(t);
  context.server.players.set('We"ird', "1");
  await say(context, "settp base", { player: 'We"ird' });
  assert.equal((await say(context, "tp base", { player: 'We"ird' }))[0], 'execute in overworld run tp "We\\"ird" 10.5 64 -20.25');
});

test("settp needs the position sent by the bridge", async (t) => {
  const context = await setup(t);
  assert.match((await say(context, "settp base", { at: null }))[0], /position is unavailable/);
});

test("the commands are for players only", async (t) => {
  const context = await setup(t);
  for (const name of ["settp", "tp", "deltp", "rtp"]) {
    assert.deepEqual(await say(context, name, { origin: "console", player: null, at: null }), []);
  }
  assert.equal(context.lines.filter(({ message }) => message.includes("only be used in game")).length, 4);
});

test("rtp spreads the player around the world origin in the overworld", async (t) => {
  const context = await setup(t, { randomRadius: 1500 });
  assert.deepEqual(await say(context, "rtp"), ['execute in overworld run spreadplayers 0 0 1 1500 "Steve"', "looking for a random spot"]);
});

test("rtp is refused outside the overworld", async (t) => {
  const context = await setup(t);
  assert.deepEqual(await say(context, "rtp", { at: { ...here, dimension: "the_end" } }), ["random teleport only works in the overworld"]);
});

test("tp and rtp share a cooldown", async (t) => {
  const context = await setup(t, { cooldownSeconds: 30 });
  const now = mock.method(Date, "now", () => 1000000);
  t.after(() => now.mock.restore());
  await say(context, "settp base");
  assert.equal((await say(context, "tp base"))[1], "teleporting to base");
  now.mock.mockImplementation(() => 1010000);
  assert.deepEqual(await say(context, "rtp"), ["wait 20s before teleporting again"]);
  now.mock.mockImplementation(() => 1030000);
  assert.equal((await say(context, "rtp"))[1], "looking for a random spot");
});

test("the position sent by the bridge reaches the plugin through the parser", () => {
  const line = `mcjs:cmd${JSON.stringify({ player: "Steve", text: "settp a", at: { x: 1, y: 2, z: 3, dimension: "overworld" } })}`;
  assert.deepEqual(parseLine(line, "mcjs:cmd").at, { x: 1, y: 2, z: 3, dimension: "overworld" });
  const broken = `mcjs:cmd${JSON.stringify({ player: "Steve", text: "settp a", at: { x: "1" } })}`;
  assert.equal("at" in parseLine(broken, "mcjs:cmd"), false);
});
