import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, resolveConfig } from "../lib/engine/config.js";
import { defaults } from "../lib/engine/defaults.js";
import { workspace, writeFiles } from "../testkit/workspace.js";

const projectRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const problemsOf = (overrides) => {
  try {
    resolveConfig(overrides);
  } catch (error) {
    return error.message;
  }
  return "";
};

test("an empty config resolves to the defaults", () => {
  assert.deepEqual(resolveConfig({}), JSON.parse(JSON.stringify(defaults)));
});

test("the shipped config.js mirrors the defaults except for its documented overrides and is valid", async () => {
  const shipped = (await import(pathToFileURL(path.join(projectRoot(), "config.js")).href)).default;
  const expected = JSON.parse(JSON.stringify(defaults));
  for (const [section, key] of [["network", "address"], ["server", "version"], ["properties", "gamemode"], ["properties", "force-gamemode"], ["properties", "max-threads"], ["properties", "view-distance"]]) {
    expected[section][key] = shipped[section][key];
  }
  assert.deepEqual(shipped, expected);
  assert.equal(shipped.server.version, "1.26.13.1");
  assert.equal(shipped.properties.gamemode, "creative");
  assert.equal(shipped.eula, true);
  assert.equal(typeof shipped.network.address, "string");
  assert.equal((await loadConfig(projectRoot())).network.address, shipped.network.address);
});

test("the shipped config.js documents the accepted values of every setting", () => {
  const text = fs.readFileSync(path.join(projectRoot(), "config.js"), "utf8");
  assert.match(text, /mode: "production", \/\/ production, development/);
  assert.match(text, /eula: true, \/\/ true, false/);
  const settings = text.split("\n").filter((line) => /^\s+("[\w-]+"|\w+): .*[^{\[]$/.test(line) && !/: [{\[]$/.test(line));
  const bare = settings.filter((line) => !line.includes("//"));
  assert.deepEqual(bare, []);
});

test("the eula is accepted by default", () => {
  assert.equal(resolveConfig({}).eula, true);
});

test("partial overrides merge deeply without losing sibling defaults", () => {
  const config = resolveConfig({ server: { version: "preview" }, properties: { gamemode: "creative" } });
  assert.equal(config.server.version, "preview");
  assert.equal(config.server.directory, "data");
  assert.equal(config.properties.gamemode, "creative");
  assert.equal(config.properties["level-name"], "world");
});

test("resolving never mutates the shared defaults", () => {
  const config = resolveConfig({});
  config.access.operators.push("1234567890");
  config.properties.gamemode = "creative";
  assert.deepEqual(resolveConfig({}).access.operators, []);
  assert.equal(defaults.properties.gamemode, "survival");
});

test("unknown plugin sections and extra properties are preserved", () => {
  const config = resolveConfig({ plugins: { custom: { a: 1 } }, properties: { "level-seed": "42" } });
  assert.deepEqual(config.plugins.custom, { a: 1 });
  assert.equal(config.properties["level-seed"], "42");
});

test("server.version accepts latest, preview and explicit versions", () => {
  for (const version of ["latest", "LATEST", "preview", "1.26.61.1", "1.26.70.22-preview", "1.21.0"]) {
    assert.doesNotThrow(() => resolveConfig({ server: { version } }), version);
  }
});

test("server.version rejects malformed values", () => {
  for (const version of ["", "1.26", "v1.26.61.1", "1.x.0", "stable", 5, null]) {
    assert.match(problemsOf({ server: { version } }), /server\.version/, String(version));
  }
});

test("every problem is reported in one error", () => {
  const message = problemsOf({
    network: { port: 0, portV6: 70000 },
    commands: { namespace: "Bad Name" },
    backup: { keep: 0 }
  });
  assert.match(message, /network\.port must be null/);
  assert.match(message, /network\.portV6 must be null/);
  assert.match(message, /commands\.namespace/);
  assert.match(message, /backup\.keep/);
});

test("ipv4 and ipv6 ports must differ", () => {
  assert.match(problemsOf({ network: { port: 19132, portV6: 19132 } }), /must differ/);
});

test("eula must be a boolean", () => {
  assert.match(problemsOf({ eula: "yes" }), /eula/);
});

test("section values must be objects", () => {
  assert.match(problemsOf({ server: 5 }), /server must be an object/);
  assert.match(problemsOf([]), /config root/);
});

test("properties must be single-line scalars and the level name a plain folder name", () => {
  assert.match(problemsOf({ properties: { "server-name": "a\nb" } }), /server-name/);
  assert.match(problemsOf({ properties: { nested: {} } }), /nested/);
  assert.match(problemsOf({ properties: { "level-name": "../escape" } }), /path separators/);
});

test("access lists are validated", () => {
  assert.match(problemsOf({ access: { operators: ["abc"] } }), /operators/);
  assert.match(problemsOf({ access: { allowlist: [5] } }), /allowlist/);
  assert.doesNotThrow(() =>
    resolveConfig({ access: { allowlist: ["Steve", { name: "Alex", xuid: "2535440312262399" }], operators: ["2535440312262399"] } })
  );
});

test("download url must be http or https", () => {
  assert.match(problemsOf({ server: { downloadUrl: "ftp://host/file.zip" } }), /downloadUrl/);
  assert.doesNotThrow(() => resolveConfig({ server: { downloadUrl: "https://host/bedrock-server-1.26.61.1.zip" } }));
});

test("log level must be a known level", () => {
  assert.match(problemsOf({ log: { level: "loud" } }), /log\.level/);
});

test("script api version must look like a module version", () => {
  assert.match(problemsOf({ packs: { scriptApiVersion: "latest" } }), /scriptApiVersion/);
  assert.doesNotThrow(() => resolveConfig({ packs: { scriptApiVersion: "2.12.0-beta" } }));
});

test("loadConfig reports unreadable and malformed files with the path", async (t) => {
  const root = workspace(t);
  await assert.rejects(loadConfig(root), /cannot read config .*config\.js/);
  writeFiles(root, { "config.json": "{ nope" });
  await assert.rejects(loadConfig(root), /not valid JSON/);
  writeFiles(root, { "config.js": "export default {" });
  await assert.rejects(loadConfig(root), /cannot be loaded/);
});

test("loadConfig honours an alternative file name", async (t) => {
  const root = workspace(t);
  writeFiles(root, { "other.json": JSON.stringify({ network: { address: "example.org" } }) });
  assert.equal((await loadConfig(root, "other.json")).network.address, "example.org");
});

test("loadConfig reads config.js first and falls back to config.json", async (t) => {
  const root = workspace(t);
  writeFiles(root, { "config.json": JSON.stringify({ network: { address: "json.example.org" } }) });
  assert.equal((await loadConfig(root)).network.address, "json.example.org");
  writeFiles(root, { "config.js": 'export default { network: { address: "js.example.org" } };\n' });
  assert.equal((await loadConfig(root)).network.address, "js.example.org");
});

test("a config.js that does not export an object is rejected", async (t) => {
  const root = workspace(t);
  writeFiles(root, { "config.js": "export default 5;\n" });
  await assert.rejects(loadConfig(root), /config root must be an object/);
});

test("status plugin options are validated", () => {
  assert.match(problemsOf({ plugins: { status: { enabled: "yes" } } }), /plugins\.status\.enabled/);
  assert.match(problemsOf({ plugins: { status: { intervalSeconds: 0 } } }), /plugins\.status\.intervalSeconds/);
  assert.match(problemsOf({ plugins: { status: { title: "" } } }), /plugins\.status\.title/);
  assert.doesNotThrow(() => resolveConfig({ plugins: { status: { intervalSeconds: 10 } } }));
});

test("chat options are validated", () => {
  assert.match(problemsOf({ chat: { prefix: "" } }), /chat\.prefix/);
  assert.match(problemsOf({ chat: { prefixColor: "purple" } }), /chat\.prefixColor must be one of/);
  assert.match(problemsOf({ chat: { messageColor: "#fff" } }), /chat\.messageColor/);
  assert.doesNotThrow(() => resolveConfig({ chat: { prefix: "[Owner]", prefixColor: "gold", messageColor: "aqua" } }));
});

test("teleport options are validated", () => {
  assert.match(problemsOf({ plugins: { teleport: { maxPoints: 0 } } }), /plugins\.teleport\.maxPoints/);
  assert.match(problemsOf({ plugins: { teleport: { cooldownSeconds: -1 } } }), /plugins\.teleport\.cooldownSeconds/);
  assert.match(problemsOf({ plugins: { teleport: { randomRadius: 50 } } }), /plugins\.teleport\.randomRadius/);
});
