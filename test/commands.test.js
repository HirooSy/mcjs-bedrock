import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHost } from "../testkit/harness.js";

const projectRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bundled = async (t, extra = {}) => {
  const context = createHost(t, { root: projectRoot(), ...extra });
  await context.host.load();
  return context;
};

const say = async (context, text, player = "Steve") => {
  context.sent.length = 0;
  await context.host.run({ player, text });
  return context.sent.map((entry) => entry.at(-1));
};

test("all bundled commands load", async (t) => {
  const { host } = await bundled(t);
  assert.deepEqual(host.names(), ["backup", "broadcast", "cmd", "deltp", "help", "info", "ping", "players", "reload", "restart", "rtp", "settp", "tp", "uptime"]);
});

test("ping answers pong", async (t) => {
  assert.deepEqual(await say(await bundled(t), "ping"), ["pong"]);
});

test("info shows address, port and version", async (t) => {
  assert.deepEqual(await say(await bundled(t), "info"), ["play.example.com:19132 version 1.26.61.1"]);
});

test("players lists names or says nobody is online, and online is an alias", async (t) => {
  const context = await bundled(t);
  assert.deepEqual(await say(context, "players"), ["no players online"]);
  context.server.players.set("Steve", "1");
  context.server.players.set("Alex", "2");
  assert.deepEqual(await say(context, "online"), ["online 2: Steve, Alex"]);
});

test("uptime is formatted in days, hours, minutes and seconds", async (t) => {
  assert.deepEqual(await say(await bundled(t), "uptime"), ["server uptime 1h 2m 3s"]);
});

test("help hides admin commands and aliases from regular players", async (t) => {
  const [text] = await say(await bundled(t), "help");
  const lines = text.split("\n");
  assert.ok(lines.includes("/mcjs:ping - check that the manager is responding"));
  assert.ok(lines.some((line) => line.startsWith("/mcjs:players")));
  assert.equal(lines.some((line) => line.startsWith("/mcjs:online")), false);
  assert.equal(lines.some((line) => line.startsWith("/mcjs:cmd")), false);
  assert.equal(lines.some((line) => line.startsWith("/mcjs:backup")), false);
});

test("help shows admin commands to admins", async (t) => {
  const [text] = await say(await bundled(t), "help", "Admin");
  assert.ok(text.split("\n").some((line) => line.startsWith("/mcjs:cmd")));
  assert.ok(text.split("\n").some((line) => line.startsWith("/mcjs:backup")));
});

test("broadcast sends the message with the sender and explains its usage", async (t) => {
  const context = await bundled(t);
  await say(context, "broadcast hello there", "Admin");
  assert.deepEqual(context.sent, [["broadcast", "[Admin] hello there"]]);
  assert.deepEqual(await say(context, "broadcast", "Admin"), ["usage: /mcjs:broadcast <message>"]);
});

test("cmd forwards a console command and explains its usage", async (t) => {
  const context = await bundled(t);
  await say(context, "cmd time set day", "Admin");
  assert.deepEqual(context.sent, [["send", "time set day"]]);
  assert.deepEqual(await say(context, "cmd", "Admin"), ["usage: /mcjs:cmd <server command>"]);
});

test("admin commands are refused for everyone else", async (t) => {
  const context = await bundled(t);
  for (const name of ["cmd stop", "broadcast hi", "reload", "backup", "restart"]) {
    assert.deepEqual(await say(context, name), ["no permission"], name);
  }
});

test("reload reports how many commands and events were loaded", async (t) => {
  const context = await bundled(t);
  assert.deepEqual(await say(context, "reload", "Admin"), ["reloaded 14 commands and 1 events"]);
});

test("backup reports progress, success and failure", async (t) => {
  let outcome = { name: "2026-11-04T06-39-00", files: 12 };
  const context = await bundled(t, {
    services: {
      backup: async () => {
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      }
    }
  });
  assert.deepEqual(await say(context, "backup", "Admin"), ["backup started", "backup 2026-11-04T06-39-00 saved, 12 files"]);
  outcome = new Error("server is not running");
  assert.deepEqual(await say(context, "backup", "Admin"), ["backup started", "backup failed: server is not running"]);
});

test("restart announces itself before restarting", async (t) => {
  let restarted = 0;
  const context = await bundled(t, {
    services: {
      restart: async () => {
        restarted += 1;
      }
    }
  });
  assert.deepEqual(await say(context, "restart", "Admin"), ["restarting the server"]);
  assert.equal(restarted, 1);
});

test("the welcome event greets joining players after the configured delay", async (t) => {
  const context = await bundled(t, { options: { welcome: { delayMs: 30, message: "hi {player}, welcome to {address}" } } });
  const started = Date.now();
  await context.host.event("join", { name: "Steve", xuid: "1" });
  assert.ok(Date.now() - started >= 25);
  assert.deepEqual(context.sent, [["tell", "Steve", "hi Steve, welcome to play.example.com"]]);
});

test("the welcome event can be disabled and has sensible defaults", async (t) => {
  const disabled = await bundled(t, { options: { welcome: { enabled: false, delayMs: 0 } } });
  await disabled.host.event("join", { name: "Steve", xuid: "1" });
  assert.deepEqual(disabled.sent, []);
  const quick = await bundled(t, { options: { welcome: { delayMs: 0 } } });
  await quick.host.event("join", { name: "Alex", xuid: "2" });
  assert.deepEqual(quick.sent, [["tell", "Alex", "welcome to play.example.com"]]);
});
