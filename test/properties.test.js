import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/engine/config.js";
import { buildProperties, writeProperties } from "../lib/engine/properties.js";
import { workspace } from "../testkit/workspace.js";

const parse = (body) =>
  Object.fromEntries(
    body
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );

test("ports and scalar values are serialised", () => {
  const body = parse(buildProperties(resolveConfig({ network: { port: 20000, portV6: 20001 } })));
  assert.equal(body["server-port"], "20000");
  assert.equal(body["server-portv6"], "20001");
  assert.equal(body["online-mode"], "true");
  assert.equal(body["force-gamemode"], "false");
  assert.equal(body["max-players"], "10");
});

test("the allow list is switched on when entries are configured", () => {
  assert.equal(parse(buildProperties(resolveConfig({})))["allow-list"], "false");
  assert.equal(parse(buildProperties(resolveConfig({ access: { allowlist: ["Steve"] } })))["allow-list"], "true");
});

test("an explicit allow-list property wins over the automatic value", () => {
  const config = resolveConfig({ access: { allowlist: ["Steve"] }, properties: { "allow-list": false } });
  assert.equal(parse(buildProperties(config))["allow-list"], "false");
});

test("the file is written once and left alone when unchanged", (t) => {
  const directory = workspace(t);
  const config = resolveConfig({});
  assert.equal(writeProperties(directory, config), true);
  const file = path.join(directory, "server.properties");
  const before = fs.statSync(file).mtimeMs;
  assert.equal(writeProperties(directory, config), false);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(writeProperties(directory, resolveConfig({ properties: { gamemode: "creative" } })), true);
  assert.match(fs.readFileSync(file, "utf8"), /gamemode=creative/);
});
