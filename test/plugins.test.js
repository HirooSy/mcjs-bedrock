import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { command, createHost } from "../testkit/harness.js";

test("commands and events are loaded from their folders and summarised", async (t) => {
  const { host } = createHost(t, {
    files: {
      "plugins/commands/a.js": command("alpha"),
      "plugins/commands/b.js": command("beta"),
      "plugins/events/e.js": 'export default { name: "e", on: "join", run: async () => {} };\n'
    }
  });
  assert.deepEqual(await host.load(), { commands: 2, events: 1 });
  assert.deepEqual(host.names(), ["alpha", "beta"]);
});

test("a missing plugin folder yields an empty host", async (t) => {
  const { host } = createHost(t);
  assert.deepEqual(await host.load(), { commands: 0, events: 0 });
});

test("aliases resolve to the same command and are described separately", async (t) => {
  const { host, sent } = createHost(t, {
    files: { "plugins/commands/a.js": command("alpha", 'ctx.reply("hit");', 'aliases: ["a1", "a2"], description: "first",') }
  });
  await host.load();
  assert.deepEqual(host.names(), ["alpha"]);
  assert.equal(await host.run({ player: "Steve", text: "a2" }), true);
  assert.deepEqual(sent, [["tell", "Steve", "hit"]]);
  const described = host.describe();
  assert.deepEqual(described.map((entry) => [entry.name, entry.alias]), [["a1", true], ["a2", true], ["alpha", false]]);
  assert.equal(described[0].description, "first");
});

test("command names are case insensitive for the caller", async (t) => {
  const { host, sent } = createHost(t, { files: { "plugins/commands/a.js": command("alpha", 'ctx.reply("ok");') } });
  await host.load();
  assert.equal(await host.run({ player: "Steve", text: "ALPHA" }), true);
  assert.equal(sent.length, 1);
});

test("invalid plugins are skipped with a warning and do not stop the others", async (t) => {
  const { host, has } = createHost(t, {
    files: {
      "plugins/commands/good.js": command("good"),
      "plugins/commands/nameless.js": "export default { run: async () => {} };\n",
      "plugins/commands/norun.js": 'export default { name: "norun" };\n',
      "plugins/commands/badname.js": command("Bad-Name"),
      "plugins/commands/badalias.js": command("fine", "", 'aliases: ["No Good"],'),
      "plugins/commands/syntax.js": "export default {{{\n",
      "plugins/events/badevent.js": 'export default { name: "x", on: "explode", run: async () => {} };\n'
    }
  });
  await host.load();
  assert.deepEqual(host.names(), ["good"]);
  assert.ok(has("warn", "nameless.js skipped"));
  assert.ok(has("warn", "norun.js skipped"));
  assert.ok(has("warn", "badname.js skipped"));
  assert.ok(has("warn", "badalias.js skipped"));
  assert.ok(has("warn", "syntax.js failed to load"));
  assert.ok(has("warn", "badevent.js skipped"));
});

test("duplicate command names keep the first definition and warn", async (t) => {
  const { host, has, sent } = createHost(t, {
    files: {
      "plugins/commands/a.js": command("same", 'ctx.reply("first");'),
      "plugins/commands/b.js": command("same", 'ctx.reply("second");')
    }
  });
  await host.load();
  await host.run({ player: "Steve", text: "same" });
  assert.deepEqual(sent, [["tell", "Steve", "first"]]);
  assert.ok(has("warn", "already defined"));
});

test("arguments are split on whitespace and passed to the command", async (t) => {
  const { host, sent } = createHost(t, { files: { "plugins/commands/a.js": command("echo", 'ctx.reply(ctx.args.join("|"));') } });
  await host.load();
  await host.run({ player: "Steve", text: "  echo   a  b   c " });
  assert.deepEqual(sent, [["tell", "Steve", "a|b|c"]]);
});

test("empty and unknown input is ignored for players", async (t) => {
  const { host, sent, lines } = createHost(t, { files: { "plugins/commands/a.js": command("alpha") } });
  await host.load();
  assert.equal(await host.run({ player: "Steve", text: "" }), false);
  assert.equal(await host.run({ player: "Steve", text: "nothing here" }), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(lines, []);
});

test("admin commands require a listed gamertag, compared case-insensitively", async (t) => {
  const { host, sent } = createHost(t, {
    admins: ["AdminUser"],
    files: { "plugins/commands/a.js": command("secret", 'ctx.reply("done");', "admin: true,") }
  });
  await host.load();
  assert.equal(await host.run({ player: "Mallory", text: "secret" }), false);
  assert.deepEqual(sent, [["tell", "Mallory", "no permission"]]);
  sent.length = 0;
  assert.equal(await host.run({ player: "adminuser", text: "secret" }), true);
  assert.deepEqual(sent, [["tell", "adminuser", "done"]]);
});

test("a player named console gains nothing from the name", async (t) => {
  const { host, sent } = createHost(t, { files: { "plugins/commands/a.js": command("secret", 'ctx.reply("done");', "admin: true,") } });
  await host.load();
  assert.equal(await host.run({ player: "console", text: "secret", origin: "player" }), false);
  assert.deepEqual(sent, [["tell", "console", "no permission"]]);
});

test("console origin is always admin and replies go to the log", async (t) => {
  const { host, sent, lines } = createHost(t, { files: { "plugins/commands/a.js": command("secret", 'ctx.reply("done");', "admin: true,") } });
  await host.load();
  assert.equal(await host.run({ player: "console", text: "secret", origin: "console" }), true);
  assert.deepEqual(sent, []);
  assert.deepEqual(lines, [{ level: "info", message: "done" }]);
});

test("an unknown console command is reported", async (t) => {
  const { host, has } = createHost(t);
  await host.load();
  assert.equal(await host.run({ player: "console", text: "bogus", origin: "console" }), false);
  assert.ok(has("info", "unknown command bogus"));
});

test("a throwing command is logged and does not break the host", async (t) => {
  const { host, has, sent } = createHost(t, {
    files: {
      "plugins/commands/a.js": command("boom", 'throw new Error("kaput");'),
      "plugins/commands/b.js": command("fine", 'ctx.reply("ok");')
    }
  });
  await host.load();
  assert.equal(await host.run({ player: "Steve", text: "boom" }), false);
  assert.ok(has("error", "command boom failed: kaput"));
  assert.equal(await host.run({ player: "Steve", text: "fine" }), true);
  assert.equal(sent.length, 1);
});

test("the context exposes player, xuid, info, players and helpers", async (t) => {
  const { host, server, sent } = createHost(t, {
    files: {
      "plugins/commands/a.js": command(
        "who",
        'ctx.reply(JSON.stringify({ p: ctx.player, x: ctx.xuid, i: ctx.info.address, n: ctx.players, ns: ctx.namespace, q: ctx.qualify("who"), a: ctx.admin, o: ctx.origin }));'
      )
    }
  });
  server.players.set("Steve", "1234567890");
  await host.load();
  await host.run({ player: "Steve", text: "who" });
  assert.deepEqual(JSON.parse(sent[0][2]), {
    p: "Steve",
    x: "1234567890",
    i: "play.example.com",
    n: ["Steve"],
    ns: "mcjs",
    q: "/mcjs:who",
    a: false,
    o: "player"
  });
});

test("usage replies with the qualified command and its usage text", async (t) => {
  const { host, sent } = createHost(t, {
    files: { "plugins/commands/a.js": command("say_it", "ctx.usage();", 'usage: "<text>",') }
  });
  await host.load();
  await host.run({ player: "Steve", text: "say_it" });
  assert.deepEqual(sent, [["tell", "Steve", "usage: /mcjs:say_it <text>"]]);
});

test("tell, broadcast and send reach the server", async (t) => {
  const { host, sent } = createHost(t, {
    files: { "plugins/commands/a.js": command("all", 'ctx.tell("Alex", "hi"); ctx.broadcast("everyone"); ctx.send("list");') }
  });
  await host.load();
  await host.run({ player: "Steve", text: "all" });
  assert.deepEqual(sent, [["tell", "Alex", "hi"], ["broadcast", "everyone"], ["send", "list"]]);
});

test("event handlers run for matching events with the player context", async (t) => {
  const { host, sent } = createHost(t, {
    options: { greeter: { word: "howdy" } },
    files: {
      "plugins/events/greeter.js":
        'export default { name: "greeter", on: "join", run: async (ctx) => { ctx.tell(ctx.player, `${ctx.options.word} ${ctx.player} ${ctx.xuid}`); } };\n',
      "plugins/events/other.js": 'export default { name: "other", on: "leave", run: async (ctx) => { ctx.broadcast("left"); } };\n'
    }
  });
  await host.load();
  await host.event("join", { name: "Steve", xuid: "42" });
  assert.deepEqual(sent, [["tell", "Steve", "howdy Steve 42"]]);
  sent.length = 0;
  await host.event("leave", { name: "Steve", xuid: "42" });
  assert.deepEqual(sent, [["broadcast", "left"]]);
});

test("the ready event has no player", async (t) => {
  const { host, sent } = createHost(t, {
    files: { "plugins/events/r.js": 'export default { name: "r", on: "ready", run: async (ctx) => { ctx.broadcast(String(ctx.player)); } };\n' }
  });
  await host.load();
  await host.event("ready");
  assert.deepEqual(sent, [["broadcast", "null"]]);
});

test("a failing event handler is logged and the others still run", async (t) => {
  const { host, has, sent } = createHost(t, {
    files: {
      "plugins/events/a.js": 'export default { name: "a", on: "join", run: async () => { throw new Error("nope"); } };\n',
      "plugins/events/b.js": 'export default { name: "b", on: "join", run: async (ctx) => { ctx.broadcast("b ran"); } };\n'
    }
  });
  await host.load();
  await host.event("join", { name: "Steve", xuid: null });
  assert.ok(has("error", "event a failed: nope"));
  assert.deepEqual(sent, [["broadcast", "b ran"]]);
});

test("reload picks up edited, added and removed plugins", async (t) => {
  const { host, root, sent } = createHost(t, { files: { "plugins/commands/a.js": command("alpha", 'ctx.reply("v1");') } });
  await host.load();
  await host.run({ player: "Steve", text: "alpha" });
  fs.writeFileSync(path.join(root, "plugins/commands/a.js"), command("alpha", 'ctx.reply("v2");'));
  fs.writeFileSync(path.join(root, "plugins/commands/b.js"), command("beta"));
  await host.load();
  await host.run({ player: "Steve", text: "alpha" });
  assert.deepEqual(sent.map((entry) => entry[2]), ["v1", "v2"]);
  assert.deepEqual(host.names(), ["alpha", "beta"]);
  fs.rmSync(path.join(root, "plugins/commands/b.js"));
  await host.load();
  assert.deepEqual(host.names(), ["alpha"]);
});

test("the reload helper reports when the command set changed", async (t) => {
  const { host, root, sent } = createHost(t, {
    files: {
      "plugins/commands/a.js": command("alpha"),
      "plugins/commands/r.js": command(
        "again",
        'const result = await ctx.reload(); ctx.reply(JSON.stringify(result));'
      )
    }
  });
  await host.load();
  await host.run({ player: "Steve", text: "again" });
  assert.deepEqual(JSON.parse(sent[0][2]), { commands: 2, events: 0, restartRequired: false });
  fs.writeFileSync(path.join(root, "plugins/commands/c.js"), command("gamma"));
  await host.run({ player: "Steve", text: "again" });
  assert.deepEqual(JSON.parse(sent[1][2]), { commands: 3, events: 0, restartRequired: true });
});

test("services are exposed to commands and missing ones fail clearly", async (t) => {
  const { host, sent, has } = createHost(t, {
    services: { backup: async () => ({ name: "b1" }) },
    files: {
      "plugins/commands/a.js": command("b", "const r = await ctx.backup(); ctx.reply(r.name);"),
      "plugins/commands/c.js": command("r", "await ctx.restart();")
    }
  });
  await host.load();
  await host.run({ player: "Steve", text: "b" });
  assert.deepEqual(sent, [["tell", "Steve", "b1"]]);
  await host.run({ player: "Steve", text: "r" });
  assert.ok(has("error", "restart is not available"));
});

test("a signature changes only when the command names change", async (t) => {
  const { host, root } = createHost(t, { files: { "plugins/commands/a.js": command("alpha", "", 'description: "one",') } });
  await host.load();
  const first = host.signature();
  fs.writeFileSync(path.join(root, "plugins/commands/a.js"), command("alpha", "", 'description: "two",'));
  await host.load();
  assert.equal(host.signature(), first);
  fs.writeFileSync(path.join(root, "plugins/commands/b.js"), command("beta"));
  await host.load();
  assert.notEqual(host.signature(), first);
});
