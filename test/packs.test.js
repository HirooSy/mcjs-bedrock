import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/engine/config.js";
import { readState } from "../lib/engine/state.js";
import { syncPacks } from "../lib/manager/packs.js";
import { createZip } from "../testkit/zip.js";
import { memoryLogger } from "../testkit/logger.js";
import { workspace, writeFiles } from "../testkit/workspace.js";

const manifest = (uuid, extra = {}) =>
  JSON.stringify({
    format_version: 2,
    header: { name: "pack", uuid, version: [1, 0, 0], min_engine_version: [1, 0, 0] },
    modules: [],
    ...extra
  });

const bridge = (uuid = "11111111-1111-4111-8111-111111111111") =>
  manifest(uuid, { dependencies: [{ module_name: "@minecraft/server", version: "1.0.0-beta" }] });

const layout = (t, files) => {
  const root = workspace(t);
  const directory = path.join(workspace(t), "data");
  writeFiles(root, files);
  return { root, directory };
};

const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));

const sync = async (setup, { config = resolveConfig({}), engineVersion = [1, 26, 61], commands = [] } = {}) => {
  const { logger, has } = memoryLogger();
  const managed = await syncPacks({ ...setup, config, engineVersion, commands, logger });
  return { managed, has };
};

test("packs are copied into the development folders and indexed for the world", async (t) => {
  const setup = layout(t, {
    "plugins/resourcepacks/res/manifest.json": manifest("22222222-2222-4222-8222-222222222222"),
    "plugins/resourcepacks/res/textures/a.png": "png",
    "plugins/behaviorpacks/beh/manifest.json": manifest("33333333-3333-4333-8333-333333333333")
  });
  await sync(setup);
  const { directory } = setup;
  assert.ok(fs.existsSync(path.join(directory, "development_resource_packs/res/textures/a.png")));
  assert.ok(fs.existsSync(path.join(directory, "development_behavior_packs/beh/manifest.json")));
  assert.deepEqual(readJson(directory, "worlds/world/world_resource_packs.json"), [
    { pack_id: "22222222-2222-4222-8222-222222222222", version: [1, 0, 0] }
  ]);
  assert.deepEqual(readJson(directory, "worlds/world/world_behavior_packs.json"), [
    { pack_id: "33333333-3333-4333-8333-333333333333", version: [1, 0, 0] }
  ]);
});

test("the world folder follows level-name", async (t) => {
  const setup = layout(t, { "plugins/behaviorpacks/beh/manifest.json": manifest("33333333-3333-4333-8333-333333333333") });
  await sync(setup, { config: resolveConfig({ properties: { "level-name": "My World" } }) });
  assert.ok(fs.existsSync(path.join(setup.directory, "worlds/My World/world_behavior_packs.json")));
});

test("manifests get the installed engine version and the configured script api version", async (t) => {
  const setup = layout(t, { "bridge/manifest.json": bridge() });
  await sync(setup, { config: resolveConfig({ packs: { scriptApiVersion: "2.3.0" } }), engineVersion: [1, 26, 61] });
  const written = readJson(setup.directory, "development_behavior_packs/mcjs-bridge/manifest.json");
  assert.deepEqual(written.header.min_engine_version, [1, 26, 61]);
  assert.equal(written.dependencies[0].version, "2.3.0");
});

test("without a known engine version the manifest value is left alone", async (t) => {
  const setup = layout(t, { "plugins/behaviorpacks/beh/manifest.json": manifest("33333333-3333-4333-8333-333333333333") });
  await sync(setup, { engineVersion: null });
  assert.deepEqual(readJson(setup.directory, "development_behavior_packs/beh/manifest.json").header.min_engine_version, [1, 0, 0]);
});

test("the source manifests are never modified", async (t) => {
  const setup = layout(t, { "bridge/manifest.json": bridge() });
  const before = fs.readFileSync(path.join(setup.root, "bridge/manifest.json"), "utf8");
  await sync(setup);
  assert.equal(fs.readFileSync(path.join(setup.root, "bridge/manifest.json"), "utf8"), before);
});

test("the bridge receives generated settings with marker, namespace and commands", async (t) => {
  const setup = layout(t, {
    "bridge/manifest.json": bridge(),
    "bridge/scripts/main.js": "export {};\n"
  });
  await sync(setup, {
    config: resolveConfig({ bridge: { marker: "tag:cmd" }, commands: { namespace: "srv" } }),
    commands: [{ name: "ping", description: "check" }]
  });
  const file = path.join(setup.directory, "development_behavior_packs/mcjs-bridge/scripts/settings.js");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^export default /);
  const parsed = JSON.parse(text.replace(/^export default /, "").replace(/;\s*$/, ""));
  assert.deepEqual(parsed, {
    marker: "tag:cmd",
    namespace: "srv",
    commands: [{ name: "ping", description: "check" }],
    status: { enabled: true, intervalSeconds: 2, title: "server" }
  });
});

test("only the bridge pack receives settings", async (t) => {
  const setup = layout(t, {
    "plugins/behaviorpacks/other/manifest.json": manifest("44444444-4444-4444-8444-444444444444"),
    "plugins/behaviorpacks/other/scripts/main.js": "export {};\n"
  });
  await sync(setup);
  assert.equal(fs.existsSync(path.join(setup.directory, "development_behavior_packs/other/scripts/settings.js")), false);
});

test("packs with unreadable or incomplete manifests are skipped with a warning", async (t) => {
  const setup = layout(t, {
    "plugins/behaviorpacks/good/manifest.json": manifest("33333333-3333-4333-8333-333333333333"),
    "plugins/behaviorpacks/broken/manifest.json": "{ nope",
    "plugins/behaviorpacks/nouuid/manifest.json": JSON.stringify({ header: { version: [1, 0, 0] } }),
    "plugins/behaviorpacks/empty/readme.txt": "no manifest"
  });
  const { managed, has } = await sync(setup);
  assert.deepEqual(managed.behavior.map((entry) => entry.folder), ["good"]);
  assert.ok(has("warn", "pack broken skipped"));
  assert.ok(has("warn", "pack nouuid skipped"));
  assert.ok(has("warn", "pack empty skipped"));
  assert.equal(fs.existsSync(path.join(setup.directory, "development_behavior_packs/broken")), false);
});

test("foreign entries in the world index survive and managed ones are not duplicated", async (t) => {
  const setup = layout(t, { "plugins/behaviorpacks/beh/manifest.json": manifest("33333333-3333-4333-8333-333333333333") });
  writeFiles(setup.directory, {
    "worlds/world/world_behavior_packs.json": JSON.stringify([{ pack_id: "foreign-pack", version: [2, 0, 0] }])
  });
  await sync(setup);
  await sync(setup);
  const index = readJson(setup.directory, "worlds/world/world_behavior_packs.json");
  assert.deepEqual(index.map((entry) => entry.pack_id).sort(), ["33333333-3333-4333-8333-333333333333", "foreign-pack"]);
});

test("a foreign pack folder inside the development folder is left alone", async (t) => {
  const setup = layout(t, { "plugins/behaviorpacks/beh/manifest.json": manifest("33333333-3333-4333-8333-333333333333") });
  writeFiles(setup.directory, { "development_behavior_packs/hand-made/manifest.json": "mine" });
  await sync(setup);
  assert.equal(fs.readFileSync(path.join(setup.directory, "development_behavior_packs/hand-made/manifest.json"), "utf8"), "mine");
});

test("a pack removed from plugins is removed from the server and the index", async (t) => {
  const setup = layout(t, {
    "plugins/behaviorpacks/keep/manifest.json": manifest("33333333-3333-4333-8333-333333333333"),
    "plugins/behaviorpacks/drop/manifest.json": manifest("55555555-5555-4555-8555-555555555555")
  });
  await sync(setup);
  fs.rmSync(path.join(setup.root, "plugins/behaviorpacks/drop"), { recursive: true });
  const { managed } = await sync(setup);
  assert.deepEqual(managed.behavior.map((entry) => entry.folder), ["keep"]);
  assert.equal(fs.existsSync(path.join(setup.directory, "development_behavior_packs/drop")), false);
  const index = readJson(setup.directory, "worlds/world/world_behavior_packs.json");
  assert.deepEqual(index.map((entry) => entry.pack_id), ["33333333-3333-4333-8333-333333333333"]);
});

test("files deleted from a source pack disappear from the copy", async (t) => {
  const setup = layout(t, {
    "plugins/behaviorpacks/beh/manifest.json": manifest("33333333-3333-4333-8333-333333333333"),
    "plugins/behaviorpacks/beh/old.json": "{}"
  });
  await sync(setup);
  fs.rmSync(path.join(setup.root, "plugins/behaviorpacks/beh/old.json"));
  await sync(setup);
  assert.equal(fs.existsSync(path.join(setup.directory, "development_behavior_packs/beh/old.json")), false);
});

test("managed packs are recorded in the state file", async (t) => {
  const setup = layout(t, {
    "plugins/resourcepacks/res/manifest.json": manifest("22222222-2222-4222-8222-222222222222"),
    "plugins/behaviorpacks/beh/manifest.json": manifest("33333333-3333-4333-8333-333333333333")
  });
  await sync(setup);
  assert.deepEqual(readState(setup.directory).packs, {
    resource: [{ folder: "res", uuid: "22222222-2222-4222-8222-222222222222" }],
    behavior: [{ folder: "beh", uuid: "33333333-3333-4333-8333-333333333333" }]
  });
});

test("the state keeps the install record when packs are written", async (t) => {
  const setup = layout(t, { "plugins/behaviorpacks/beh/manifest.json": manifest("33333333-3333-4333-8333-333333333333") });
  writeFiles(setup.directory, { "mcjs.json": JSON.stringify({ install: { version: "1.26.61.1" } }) });
  await sync(setup);
  assert.equal(readState(setup.directory).install.version, "1.26.61.1");
});

test("the packs shipped with the project are valid and distinct", async (t) => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const directory = path.join(workspace(t), "data");
  const { managed } = await sync({ root, directory });
  assert.deepEqual(managed.behavior.map((entry) => entry.folder), ["mcjs-bridge"]);
  assert.deepEqual(managed.resource, []);
  const ids = [...managed.behavior, ...managed.resource].map((entry) => entry.uuid);
  assert.equal(new Set(ids).size, ids.length);
});

const uuids = Object.freeze({
  one: "66666666-6666-4666-8666-666666666666",
  two: "77777777-7777-4777-8777-777777777777",
  three: "88888888-8888-4888-8888-888888888888"
});

const resourceManifest = (uuid) => manifest(uuid, { modules: [{ type: "resources", uuid: "99999999-9999-4999-8999-999999999999", version: [1, 0, 0] }] });

const behaviorManifest = (uuid) => manifest(uuid, { modules: [{ type: "data", uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", version: [1, 0, 0] }] });

const putArchive = (root, relative, entries) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, createZip(entries));
};

test("a .mcpack with the manifest at its root is loaded", async (t) => {
  const setup = layout(t, {});
  putArchive(setup.root, "plugins/behaviorpacks/cool.mcpack", [
    { name: "manifest.json", data: manifest(uuids.one) },
    { name: "scripts/main.js", data: "export {};\n" }
  ]);
  const { managed } = await sync(setup);
  assert.deepEqual(managed.behavior, [{ folder: "cool", uuid: uuids.one }]);
  assert.ok(fs.existsSync(path.join(setup.directory, "development_behavior_packs/cool/scripts/main.js")));
  assert.deepEqual(readJson(setup.directory, "worlds/world/world_behavior_packs.json"), [{ pack_id: uuids.one, version: [1, 0, 0] }]);
});

test("a .zip whose pack sits inside one folder is loaded", async (t) => {
  const setup = layout(t, {});
  putArchive(setup.root, "plugins/resourcepacks/looks.zip", [
    { name: "looks/", data: "" },
    { name: "looks/manifest.json", data: manifest(uuids.two) },
    { name: "looks/textures/a.png", data: "png" }
  ]);
  const { managed } = await sync(setup);
  assert.deepEqual(managed.resource, [{ folder: "looks", uuid: uuids.two }]);
  assert.ok(fs.existsSync(path.join(setup.directory, "development_resource_packs/looks/textures/a.png")));
});

test("a .mcaddon is sorted into behavior and resource packs by their modules", async (t) => {
  const setup = layout(t, {});
  putArchive(setup.root, "plugins/behaviorpacks/addon.mcaddon", [
    { name: "addon_BP/manifest.json", data: behaviorManifest(uuids.one) },
    { name: "addon_RP/manifest.json", data: resourceManifest(uuids.two) }
  ]);
  const { managed } = await sync(setup);
  assert.deepEqual(managed.behavior, [{ folder: "addon_addon_BP", uuid: uuids.one }]);
  assert.deepEqual(managed.resource, [{ folder: "addon_addon_RP", uuid: uuids.two }]);
});

test("folders, archives and the readme can sit side by side", async (t) => {
  const setup = layout(t, {
    "plugins/behaviorpacks/README.md": "notes",
    "plugins/behaviorpacks/plain/manifest.json": manifest(uuids.one),
    "plugins/behaviorpacks/notes.txt": "ignored"
  });
  putArchive(setup.root, "plugins/behaviorpacks/zipped.zip", [{ name: "manifest.json", data: manifest(uuids.two) }]);
  const { managed } = await sync(setup);
  assert.deepEqual(managed.behavior.map((entry) => entry.folder), ["plain", "zipped"]);
});

test("a broken archive or one without a manifest is skipped with a warning", async (t) => {
  const setup = layout(t, { "plugins/behaviorpacks/broken.mcpack": "not a zip at all", "plugins/behaviorpacks/good/manifest.json": manifest(uuids.one) });
  putArchive(setup.root, "plugins/behaviorpacks/empty.zip", [{ name: "readme.txt", data: "nothing" }]);
  const { managed, has } = await sync(setup);
  assert.deepEqual(managed.behavior.map((entry) => entry.folder), ["good"]);
  assert.ok(has("warn", "pack broken.mcpack skipped"));
  assert.ok(has("warn", "pack empty.zip skipped: manifest.json not found"));
});

test("two packs with the same name or uuid are not loaded twice", async (t) => {
  const setup = layout(t, { "plugins/behaviorpacks/same/manifest.json": manifest(uuids.one) });
  putArchive(setup.root, "plugins/behaviorpacks/same.zip", [{ name: "manifest.json", data: manifest(uuids.two) }]);
  putArchive(setup.root, "plugins/behaviorpacks/copy.zip", [{ name: "manifest.json", data: manifest(uuids.one) }]);
  const { managed, has } = await sync(setup);
  assert.deepEqual(managed.behavior, [{ folder: "same", uuid: uuids.one }]);
  assert.ok(has("warn", "pack same skipped: name or uuid already used"));
  assert.ok(has("warn", "pack copy skipped: name or uuid already used"));
});

test("a removed archive is removed from the server and the index", async (t) => {
  const setup = layout(t, {});
  putArchive(setup.root, "plugins/behaviorpacks/gone.mcpack", [{ name: "manifest.json", data: manifest(uuids.one) }]);
  await sync(setup);
  fs.rmSync(path.join(setup.root, "plugins/behaviorpacks/gone.mcpack"));
  await sync(setup);
  assert.equal(fs.existsSync(path.join(setup.directory, "development_behavior_packs/gone")), false);
  assert.deepEqual(readJson(setup.directory, "worlds/world/world_behavior_packs.json"), []);
});

test("archives are unpacked in a temporary folder that is removed afterwards", async (t) => {
  const setup = layout(t, {});
  const temp = workspace(t);
  putArchive(setup.root, "plugins/behaviorpacks/cool.mcpack", [{ name: "manifest.json", data: manifest(uuids.one) }]);
  await sync(setup, { config: resolveConfig({ install: { tempDirectory: temp } }) });
  assert.deepEqual(fs.readdirSync(temp), []);
});

test("an archive with an unsafe path is rejected", async (t) => {
  const setup = layout(t, {});
  putArchive(setup.root, "plugins/behaviorpacks/evil.zip", [{ name: "../escape.txt", data: "x" }, { name: "manifest.json", data: manifest(uuids.one) }]);
  const { managed, has } = await sync(setup);
  assert.deepEqual(managed.behavior, []);
  assert.ok(has("warn", "pack evil.zip skipped: unsafe path in archive"));
});

test("the bridge always loads from the bridge folder and wins over a user pack of the same name", async (t) => {
  const setup = layout(t, {
    "bridge/manifest.json": bridge(uuids.one),
    "plugins/behaviorpacks/mcjs-bridge/manifest.json": manifest(uuids.two)
  });
  const { managed, has } = await sync(setup);
  assert.deepEqual(managed.behavior, [{ folder: "mcjs-bridge", uuid: uuids.one }]);
  assert.ok(has("warn", "pack mcjs-bridge skipped"));
});

test("the shipped plugin pack folders only hold their readme", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  for (const folder of ["behaviorpacks", "resourcepacks"]) {
    assert.deepEqual(fs.readdirSync(path.join(root, "plugins", folder)), ["README.md"]);
  }
});
