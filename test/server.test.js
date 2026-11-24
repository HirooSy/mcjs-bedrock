import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BedrockServer } from "../lib/engine/server.js";
import { fakeServerPath } from "../testkit/archive.js";
import { memoryLogger } from "../testkit/logger.js";
import { waitFor, workspace } from "../testkit/workspace.js";
import { logStamp } from "../testkit/helpers.js";

const create = (t, { args = [], binaryPath = process.execPath, ...extra } = {}) => {
  const holder = { server: null };
  t.after(() => holder.server?.kill());
  const runDir = workspace(t);
  const { logger, has, lines } = memoryLogger();
  const server = new BedrockServer({
    binaryPath,
    args: binaryPath === process.execPath ? [fakeServerPath(), ...args] : args,
    runDir,
    marker: "mcjs:cmd",
    autoRestart: false,
    restartDelayMs: 10,
    stopTimeoutMs: 2000,
    maxRestarts: 0,
    restartWindowMs: 60000,
    logger,
    ...extra
  });
  holder.server = server;
  const received = () => {
    const file = path.join(runDir, "received.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };
  const events = [];
  for (const name of ["ready", "join", "leave", "chat", "stopped", "fatal", "restarting", "exit"]) {
    server.on(name, (payload) => events.push([name, payload]));
  }
  const names = () => events.map(([name]) => name);
  return { server, runDir, logger, has, lines, received, events, names };
};

test("the ready event fires and the server version is captured", async (t) => {
  const { server, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"), { label: "ready" });
  assert.equal(server.isReady(), true);
  assert.equal(server.version, "1.26.61.1");
  assert.equal(server.isRunning(), true);
});

test("a server that never reports ready is running but not ready", async (t) => {
  const { server } = create(t, { args: ["--never-ready"] });
  server.start();
  await waitFor(() => server.isRunning());
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(server.isReady(), false);
});

test("join and leave lines maintain the player list with xuids", async (t) => {
  const { server, names, events } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  server.write(`__emit ${logStamp()} Player connected: Steve, xuid: 2535440312262399`);
  server.write(`__emit ${logStamp()} Player connected: Alex, xuid: 2535440312262400`);
  await waitFor(() => server.playerNames().length === 2, { label: "two players" });
  assert.deepEqual(server.playerNames().sort(), ["Alex", "Steve"]);
  assert.equal(server.xuidOf("Steve"), "2535440312262399");
  assert.equal(server.xuidOf("Nobody"), null);
  server.write(`__emit ${logStamp()} Player disconnected: Steve, xuid: 2535440312262399`);
  await waitFor(() => server.playerNames().length === 1);
  assert.deepEqual(server.playerNames(), ["Alex"]);
  assert.deepEqual(events.find(([name]) => name === "join")[1], { name: "Steve", xuid: "2535440312262399" });
  assert.deepEqual(events.find(([name]) => name === "leave")[1], { name: "Steve", xuid: "2535440312262399" });
});

test("bridge messages are emitted as chat events", async (t) => {
  const { server, events, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  server.write(`__emit ${logStamp()} [Scripting] mcjs:cmd${JSON.stringify({ player: "Steve", text: "ping" })}`);
  await waitFor(() => names().includes("chat"));
  assert.deepEqual(events.find(([name]) => name === "chat")[1], { player: "Steve", text: "ping" });
});

test("malformed bridge messages are logged and ignored", async (t) => {
  const { server, has, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  server.write("__emit mcjs:cmd{oops");
  await waitFor(() => has("warn", "malformed bridge message"), { label: "warning" });
  assert.equal(names().includes("chat"), false);
});

test("tell and broadcast send tellraw with escaped selectors and json text", async (t) => {
  const { server, received, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  server.tell('Odd "Name" \\', 'line one\nline "two"');
  server.broadcast("hello all");
  await waitFor(() => received().length >= 2);
  const [tell, broadcast] = received();
  assert.equal(tell, 'tellraw "Odd \\"Name\\" \\\\" {"rawtext":[{"text":"line one\\nline \\"two\\""}]}');
  assert.equal(broadcast, 'tellraw @a {"rawtext":[{"text":"hello all"}]}');
});

test("control characters cannot smuggle a second command", async (t) => {
  const { server, received, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  server.write("say hi\nstop");
  server.send("say again\r\nop Mallory");
  await waitFor(() => received().length >= 2);
  assert.deepEqual(received(), ["say hi stop", "say again op Mallory"]);
  assert.equal(server.isRunning(), true);
});

test("write reports whether the server could accept the line", (t) => {
  const { server } = create(t);
  assert.equal(server.write("anything"), false);
});

test("stop sends the stop command, resolves with the exit code and emits stopped", async (t) => {
  const { server, names, received } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  const code = await server.stop();
  assert.equal(code, 0);
  assert.ok(received().includes("stop"));
  assert.ok(names().includes("stopped"));
  assert.equal(server.isRunning(), false);
  assert.deepEqual(server.playerNames(), []);
});

test("typing stop on the console routes through the graceful path", async (t) => {
  const { server, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  server.send("stop");
  await waitFor(() => names().includes("stopped"), { label: "stopped" });
});

test("calling stop twice returns the same pending stop", async (t) => {
  const { server, names, events } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  const first = server.stop();
  const second = server.stop();
  assert.equal(first, second);
  await first;
  assert.equal(events.filter(([name]) => name === "stopped").length, 1);
});

test("stopping a server that is not running still reports stopped", async (t) => {
  const { server, names } = create(t);
  assert.equal(await server.stop(), 0);
  assert.deepEqual(names(), ["stopped"]);
});

test("a server that ignores stop is killed after the timeout", async (t) => {
  const { server, names, has } = create(t, { args: ["--ignore-stop"], stopTimeoutMs: 150 });
  server.start();
  await waitFor(() => names().includes("ready"));
  await server.stop();
  assert.ok(has("warn", "did not stop in time"));
  assert.ok(names().includes("stopped"));
});

test("kill terminates the process immediately and prevents a restart", async (t) => {
  const { server, names } = create(t, { args: ["--ignore-stop"], autoRestart: true });
  server.start();
  await waitFor(() => names().includes("ready"));
  server.kill();
  await waitFor(() => names().includes("stopped"), { label: "stopped" });
  assert.equal(names().includes("restarting"), false);
});

test("without autoRestart a crash ends in stopped with the exit code", async (t) => {
  const { server, names, events } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  server.write("__crash");
  await waitFor(() => names().includes("stopped"));
  assert.equal(events.find(([name]) => name === "stopped")[1], 1);
});

test("with autoRestart a crash starts the server again", async (t) => {
  const { server, names, events, has } = create(t, { autoRestart: true, maxRestarts: 3 });
  server.start();
  await waitFor(() => names().includes("ready"));
  server.write("__crash");
  await waitFor(() => names().filter((name) => name === "ready").length === 2, { label: "second ready" });
  assert.ok(names().includes("restarting"));
  assert.deepEqual(events.find(([name]) => name === "restarting")[1], { code: 1, attempt: 1 });
  assert.ok(has("warn", "restarting"));
  assert.equal(names().includes("stopped"), false);
});

test("a crash loop gives up with a fatal error", async (t) => {
  const { server, names, events } = create(t, { autoRestart: true, maxRestarts: 2, restartWindowMs: 60000 });
  server.start();
  for (let round = 0; round < 3; round += 1) {
    await waitFor(() => names().filter((name) => name === "ready").length === round + 1, { label: `ready ${round + 1}` });
    server.write("__crash");
  }
  await waitFor(() => names().includes("fatal"), { label: "fatal" });
  assert.match(events.find(([name]) => name === "fatal")[1].message, /3 times within 60000ms/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(names().filter((name) => name === "ready").length, 3);
});

test("old crashes outside the window do not count toward the limit", async (t) => {
  const { server, names } = create(t, { autoRestart: true, maxRestarts: 1, restartWindowMs: 1 });
  server.start();
  for (let round = 0; round < 3; round += 1) {
    await waitFor(() => names().filter((name) => name === "ready").length === round + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    server.write("__crash");
  }
  await waitFor(() => names().filter((name) => name === "ready").length === 4);
  assert.equal(names().includes("fatal"), false);
});

test("stopping during the restart delay cancels the restart", async (t) => {
  const { server, names } = create(t, { autoRestart: true, maxRestarts: 5, restartDelayMs: 500 });
  server.start();
  await waitFor(() => names().includes("ready"));
  server.write("__crash");
  await waitFor(() => names().includes("restarting"));
  await server.stop();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(names().filter((name) => name === "ready").length, 1);
  assert.ok(names().includes("stopped"));
});

test("restart stops the process and starts a fresh one without emitting stopped", async (t) => {
  const { server, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  server.write(`__emit ${logStamp()} Player connected: Steve, xuid: 1234567890`);
  await waitFor(() => server.playerNames().length === 1);
  await server.restart();
  await waitFor(() => names().filter((name) => name === "ready").length === 2, { label: "second ready" });
  assert.equal(names().includes("stopped"), false);
  assert.deepEqual(server.playerNames(), []);
  assert.equal(server.isReady(), true);
});

test("restart on a stopped server simply starts it", async (t) => {
  const { server, names } = create(t);
  await server.restart();
  await waitFor(() => names().includes("ready"));
});

test("starting twice is refused", async (t) => {
  const { server, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  assert.throws(() => server.start(), /already running/);
});

test("a missing binary is reported as fatal", async (t) => {
  const { server, names, events } = create(t, { binaryPath: path.join(workspace(t), "does-not-exist") });
  server.start();
  await waitFor(() => names().includes("fatal"), { label: "fatal" });
  assert.match(events.find(([name]) => name === "fatal")[1].message, /ENOENT/);
  assert.equal(server.isRunning(), false);
});

test("uptime counts while running and resets afterwards", async (t) => {
  const { server, names } = create(t);
  assert.equal(server.uptime(), 0);
  server.start();
  await waitFor(() => names().includes("ready"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(server.uptime() >= 20);
  await server.stop();
  assert.equal(server.uptime(), 0);
});

test("collect gathers the lines that follow a start match", async (t) => {
  const { server, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  const pending = server.collect({ start: (line) => line.includes("BEGIN"), timeoutMs: 1000, settleMs: 50 });
  server.write("__emit before");
  server.write("__emit BEGIN one");
  server.write("__emit two");
  const lines = await pending;
  assert.deepEqual(lines, ["BEGIN one", "two"]);
});

test("collect times out when the start line never arrives and cleans up its listener", async (t) => {
  const { server, names } = create(t);
  server.start();
  await waitFor(() => names().includes("ready"));
  const listeners = server.listenerCount("line");
  await assert.rejects(server.collect({ start: () => false, timeoutMs: 50 }), (error) => error.code === "COLLECT_TIMEOUT");
  assert.equal(server.listenerCount("line"), listeners);
});

test("stderr output is surfaced as warnings", async (t) => {
  const runDir = workspace(t);
  const { logger, has } = memoryLogger();
  const server = new BedrockServer({
    binaryPath: process.execPath,
    args: ["-e", "console.error('boom'); setTimeout(() => {}, 200)"],
    runDir,
    marker: "mcjs:cmd",
    autoRestart: false,
    restartDelayMs: 1,
    stopTimeoutMs: 100,
    maxRestarts: 0,
    restartWindowMs: 1000,
    logger
  });
  t.after(() => server.kill());
  server.start();
  await waitFor(() => has("warn", "boom"), { label: "stderr warning" });
});

test("the server process gets a limited number of malloc arenas to use less memory", { skip: process.platform === "win32" }, async (t) => {
  const readEnv = (options, env) => {
    const server = new BedrockServer({
      binaryPath: process.execPath,
      args: ["-e", "process.stdout.write(String(process.env.MALLOC_ARENA_MAX))"],
      runDir: workspace(t),
      marker: "mcjs:cmd",
      autoRestart: false,
      restartDelayMs: 10,
      stopTimeoutMs: 2000,
      maxRestarts: 0,
      restartWindowMs: 60000,
      logger: memoryLogger().logger,
      ...options
    });
    return new Promise((resolve) => {
      let text = "";
      const previous = process.env.MALLOC_ARENA_MAX;
      if (env === undefined) {
        delete process.env.MALLOC_ARENA_MAX;
      } else {
        process.env.MALLOC_ARENA_MAX = env;
      }
      server.start();
      if (previous === undefined) {
        delete process.env.MALLOC_ARENA_MAX;
      } else {
        process.env.MALLOC_ARENA_MAX = previous;
      }
      server.child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      server.once("exit", () => resolve(text));
    });
  };
  assert.equal(await readEnv({ memoryArenas: 2 }), "2");
  assert.equal(await readEnv({ memoryArenas: 0 }), "undefined");
  assert.equal(await readEnv({ memoryArenas: 2 }, "8"), "8");
});
