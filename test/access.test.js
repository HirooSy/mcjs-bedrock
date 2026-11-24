import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/engine/config.js";
import { writeAccess } from "../lib/manager/access.js";
import { workspace, writeFiles } from "../testkit/workspace.js";

const read = (directory, name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));

test("nothing is written when nothing is configured", (t) => {
  const directory = workspace(t);
  assert.deepEqual(writeAccess(directory, resolveConfig({})), { allowlist: 0, permissions: 0 });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("allowlist names and objects become allowlist entries", (t) => {
  const directory = workspace(t);
  const config = resolveConfig({
    access: { allowlist: ["Steve", { name: "Alex", xuid: "2535440312262399", ignoresPlayerLimit: true }] }
  });
  assert.deepEqual(writeAccess(directory, config), { allowlist: 2, permissions: 0 });
  assert.deepEqual(read(directory, "allowlist.json"), [
    { ignoresPlayerLimit: false, name: "Steve" },
    { ignoresPlayerLimit: true, name: "Alex", xuid: "2535440312262399" }
  ]);
});

test("existing allowlist entries are kept and updated by name, ignoring case", (t) => {
  const directory = workspace(t);
  writeFiles(directory, {
    "allowlist.json": JSON.stringify([
      { ignoresPlayerLimit: false, name: "Manual", xuid: "111111111" },
      { ignoresPlayerLimit: false, name: "steve" }
    ])
  });
  writeAccess(directory, resolveConfig({ access: { allowlist: [{ name: "Steve", xuid: "2535440312262399" }, "New"] } }));
  const list = read(directory, "allowlist.json");
  assert.equal(list.length, 3);
  assert.deepEqual(list.find((entry) => entry.name === "Manual"), { ignoresPlayerLimit: false, name: "Manual", xuid: "111111111" });
  assert.equal(list.find((entry) => entry.name === "steve").xuid, "2535440312262399");
  assert.ok(list.some((entry) => entry.name === "New"));
});

test("permission levels are written by xuid", (t) => {
  const directory = workspace(t);
  const config = resolveConfig({
    access: { operators: ["1111111111"], members: ["2222222222"], visitors: ["3333333333"] }
  });
  assert.deepEqual(writeAccess(directory, config), { allowlist: 0, permissions: 3 });
  assert.deepEqual(read(directory, "permissions.json"), [
    { permission: "operator", xuid: "1111111111" },
    { permission: "member", xuid: "2222222222" },
    { permission: "visitor", xuid: "3333333333" }
  ]);
});

test("existing permissions are preserved and changed levels are updated", (t) => {
  const directory = workspace(t);
  writeFiles(directory, {
    "permissions.json": JSON.stringify([
      { permission: "operator", xuid: "9999999999" },
      { permission: "visitor", xuid: "1111111111" }
    ])
  });
  writeAccess(directory, resolveConfig({ access: { operators: ["1111111111"] } }));
  assert.deepEqual(read(directory, "permissions.json"), [
    { permission: "operator", xuid: "9999999999" },
    { permission: "operator", xuid: "1111111111" }
  ]);
});

test("running twice produces the same files", (t) => {
  const directory = workspace(t);
  const config = resolveConfig({ access: { allowlist: ["Steve"], operators: ["1111111111"] } });
  writeAccess(directory, config);
  const before = [read(directory, "allowlist.json"), read(directory, "permissions.json")];
  writeAccess(directory, config);
  assert.deepEqual([read(directory, "allowlist.json"), read(directory, "permissions.json")], before);
});

test("a corrupt existing file is replaced rather than crashing", (t) => {
  const directory = workspace(t);
  writeFiles(directory, { "allowlist.json": "{ not json" });
  writeAccess(directory, resolveConfig({ access: { allowlist: ["Steve"] } }));
  assert.equal(read(directory, "allowlist.json").length, 1);
});
