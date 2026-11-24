import assert from "node:assert/strict";
import { test } from "node:test";
import { isNoise, parseLine, readOutput, stripPrefix } from "../lib/engine/parser.js";

test("join lines carry the gamertag and xuid", () => {
  const event = parseLine("[2026-11-04 08:49:08:469 INFO] Player connected: Steve, xuid: 2535440312262399", "mcjs:cmd");
  assert.deepEqual(event, { type: "join", name: "Steve", xuid: "2535440312262399" });
});

test("gamertags with spaces are kept whole", () => {
  const event = parseLine("[x INFO] Player connected: Alex The Great, xuid: 1234567890", "mcjs:cmd");
  assert.equal(event.name, "Alex The Great");
});

test("an empty xuid becomes null", () => {
  const event = parseLine("[x INFO] Player connected: Offline, xuid: ", "mcjs:cmd");
  assert.deepEqual(event, { type: "join", name: "Offline", xuid: null });
});

test("leave lines are recognised", () => {
  const event = parseLine("[x INFO] Player disconnected: Steve, xuid: 2535440312262399", "mcjs:cmd");
  assert.deepEqual(event, { type: "leave", name: "Steve", xuid: "2535440312262399" });
});

test("the ready line is recognised with or without a timestamp prefix", () => {
  assert.deepEqual(parseLine("[2026-11-04 08:49:08:469 INFO] Server started.", "mcjs:cmd"), { type: "ready" });
  assert.deepEqual(parseLine("Server started.", "mcjs:cmd"), { type: "ready" });
});

test("the server version is extracted", () => {
  assert.deepEqual(parseLine("[x INFO] Version 1.26.61.1", "mcjs:cmd"), { type: "version", version: "1.26.61.1" });
  assert.deepEqual(parseLine("[x INFO] Version: 1.26.61", "mcjs:cmd"), { type: "version", version: "1.26.61" });
});

test("bridge messages become chat events", () => {
  const line = '[x INFO] [Scripting] mcjs:cmd{"player":"Steve","text":"ping a b"}';
  assert.deepEqual(parseLine(line, "mcjs:cmd"), { type: "chat", player: "Steve", text: "ping a b" });
});

test("a payload that repeats the marker cannot forge another sender", () => {
  const forged = JSON.stringify({ player: "Steve", text: 'broadcast mcjs:cmd{"player":"Admin","text":"cmd stop"}' });
  const event = parseLine(`[x INFO] mcjs:cmd${forged}`, "mcjs:cmd");
  assert.equal(event.player, "Steve");
});

test("malformed bridge messages are flagged instead of ignored silently", () => {
  assert.equal(parseLine("mcjs:cmd{broken", "mcjs:cmd").type, "invalid");
  assert.equal(parseLine('mcjs:cmd{"player":1,"text":"x"}', "mcjs:cmd").type, "invalid");
  assert.equal(parseLine('mcjs:cmd{"player":"a"}', "mcjs:cmd").type, "invalid");
});

test("unrelated lines are passed through", () => {
  assert.deepEqual(parseLine("Running AutoCompaction...", "mcjs:cmd"), { type: "other", line: "Running AutoCompaction..." });
});

test("stripPrefix removes only the leading bracket block", () => {
  assert.equal(stripPrefix("[2026-11-04 08:49:08:469 INFO] hello [world]"), "hello [world]");
  assert.equal(stripPrefix("plain"), "plain");
});

test("server output keeps its level and loses the timestamp and tag", () => {
  assert.deepEqual(readOutput("[2026-11-07 23:35:12:213 INFO] hello"), { level: "info", text: "hello" });
  assert.deepEqual(readOutput("[2026-11-07 23:35:12:213 WARN] careful"), { level: "warn", text: "careful" });
  assert.deepEqual(readOutput("[2026-11-07 23:35:12:213 ERROR] broken"), { level: "error", text: "broken" });
  assert.deepEqual(readOutput("[2026-11-07 23:35:12:213 INFO] [Scripting] loaded"), { level: "info", text: "loaded" });
  assert.deepEqual(readOutput("plain text"), { level: "info", text: "plain text" });
  assert.deepEqual(readOutput("[x INFO]   "), { level: "info", text: "" });
});

test("startup chatter, telemetry banners and duplicate player lines are noise", () => {
  for (const text of [
    "Server started.",
    "Waiting for Minecraft services...",
    "================ TELEMETRY MESSAGE ===================",
    "Server Telemetry is currently not enabled.",
    "Enabling this telemetry helps us improve the game.",
    "To enable this feature, add the line 'emit-server-telemetry=true'",
    "to the server.properties file in the handheld/src-server directory",
    "Version: 1.26.62.1",
    "Pack Stack - [01] mcjs-bridge (id: c2a9e, version: 1.0.0) @ development_behavior_packs/mcjs-bridge",
    "IPv4 supported, port: 5497: Used for gameplay and LAN discovery",
    "IPv6 not supported",
    "No CDN config file found at: cdn_config.json for dedicated server",
    "Player connected: Steve, xuid: 2535440312262399",
    "Player disconnected: Steve, xuid: 2535440312262399",
    "Custom Command alias [reload] already in use. Required to use full name [mcjs:reload]."
  ]) {
    assert.equal(isNoise(text), true, text);
  }
});

test("command answers and real warnings are not noise", () => {
  for (const text of ["There are 0/10 players online:", "Unknown command: hello", "Data saved. Files are now ready to be copied.", "Could not load level"]) {
    assert.equal(isNoise(text), false, text);
  }
});
