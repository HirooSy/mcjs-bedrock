import fs from "fs";
import os from "os";
import path from "path";
import { fileNames } from "../engine/paths.js";
import { readState, writeState } from "../engine/state.js";
import { extractArchive } from "../installer/zip.js";

const names = Object.freeze({
  pluginRoot: "plugins",
  bridgeRoot: "bridge",
  manifest: "manifest.json",
  scripts: "scripts",
  settings: "settings.js",
  bridge: "mcjs-bridge",
  scriptModule: "@minecraft/server"
});

const packKinds = Object.freeze([
  Object.freeze({
    key: "resource",
    source: "resourcepacks",
    target: "development_resource_packs",
    index: "world_resource_packs.json"
  }),
  Object.freeze({
    key: "behavior",
    source: "behaviorpacks",
    target: "development_behavior_packs",
    index: "world_behavior_packs.json"
  })
]);

const archiveTypes = Object.freeze([".mcpack", ".zip", ".mcaddon"]);

const listEntries = (dir) => {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || archiveTypes.includes(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => Number(a.isDirectory() ? 0 : 1) - Number(b.isDirectory() ? 0 : 1) || a.name.localeCompare(b.name));
};

const safeName = (text) => text.replace(/[^A-Za-z0-9._-]+/g, "_");

const packRoots = (directory) => {
  if (fs.existsSync(path.join(directory, names.manifest))) {
    return [directory];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, names.manifest)))
    .map((entry) => path.join(directory, entry.name))
    .sort();
};

const kindOfPack = (folder, fallback) => {
  try {
    const modules = JSON.parse(fs.readFileSync(path.join(folder, names.manifest), "utf8")).modules ?? [];
    return modules.some((entry) => entry.type === "resources") ? "resource" : "behavior";
  } catch {
    return fallback;
  }
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const readList = (file) => {
  try {
    const parsed = readJson(file);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeJson = (file, data) => {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

const loadManifest = (folder, logger, label = path.basename(folder)) => {
  try {
    const manifest = readJson(path.join(folder, names.manifest));
    const header = manifest?.header;
    const valid = header && typeof header.uuid === "string" && Array.isArray(header.version);
    if (!valid) {
      throw new Error("header.uuid and header.version are required");
    }
    return manifest;
  } catch (error) {
    logger.warn(`pack ${label} skipped: ${error.message}`);
    return null;
  }
};

const patchManifest = (manifest, config, engineVersion) => {
  if (engineVersion) {
    manifest.header.min_engine_version = engineVersion;
  }
  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.module_name === names.scriptModule) {
      dependency.version = config.packs.scriptApiVersion;
    }
  }
  return manifest;
};

const writeSettings = (scriptsDir, config, commands) => {
  const settings = {
    marker: config.bridge.marker,
    namespace: config.commands.namespace,
    commands,
    status: config.plugins.status ?? {}
  };
  fs.writeFileSync(path.join(scriptsDir, names.settings), `export default ${JSON.stringify(settings, null, 2)};\n`);
};

const collectCandidates = async ({ root, config, stage, logger }) => {
  const candidates = [];
  const bridge = path.join(root, names.bridgeRoot);
  if (fs.existsSync(path.join(bridge, names.manifest))) {
    candidates.push({ kind: "behavior", name: names.bridge, folder: bridge, internal: true });
  }
  for (const kind of packKinds) {
    const sourceDir = path.join(root, names.pluginRoot, kind.source);
    for (const entry of listEntries(sourceDir)) {
      const from = path.join(sourceDir, entry.name);
      if (entry.isDirectory()) {
        candidates.push({ kind: kind.key, name: entry.name, folder: from });
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const base = safeName(path.basename(entry.name, path.extname(entry.name)));
      const extracted = path.join(await stage(), `${kind.key}-${base}`);
      try {
        await extractArchive(from, extracted);
      } catch (error) {
        logger.warn(`pack ${entry.name} skipped: ${error.message}`);
        continue;
      }
      const roots = packRoots(extracted);
      if (roots.length === 0) {
        logger.warn(`pack ${entry.name} skipped: manifest.json not found in the archive`);
      }
      for (const folder of roots) {
        candidates.push({
          kind: extension === ".mcaddon" ? kindOfPack(folder, kind.key) : kind.key,
          name: roots.length === 1 ? base : `${base}_${safeName(path.basename(folder))}`,
          folder
        });
      }
    }
  }
  return candidates;
};

export const syncPacks = async ({ root, directory, config, engineVersion = null, commands = [], logger }) => {
  const worldDir = path.join(directory, fileNames.worlds, config.properties["level-name"]);
  fs.mkdirSync(worldDir, { recursive: true });
  const previous = readState(directory).packs ?? {};
  const managed = {};
  let staging = null;
  const stage = async () => {
    staging ??= fs.mkdtempSync(path.join(path.resolve(root, config.install.tempDirectory ?? os.tmpdir()), "mcjs-packs-"));
    return staging;
  };

  try {
    const candidates = await collectCandidates({ root, config, stage, logger });
    const claimed = new Set();
    for (const kind of packKinds) {
      const targetDir = path.join(directory, kind.target);
      const before = previous[kind.key] ?? [];
      const entries = [];
      fs.mkdirSync(targetDir, { recursive: true });

      for (const candidate of candidates.filter((item) => item.kind === kind.key)) {
        const manifest = loadManifest(candidate.folder, logger, candidate.name);
        if (!manifest) {
          continue;
        }
        const identity = `${kind.key}:${candidate.name}`;
        if (claimed.has(identity) || entries.some((entry) => entry.uuid === manifest.header.uuid)) {
          logger.warn(`pack ${candidate.name} skipped: name or uuid already used by another pack`);
          continue;
        }
        claimed.add(identity);
        patchManifest(manifest, config, engineVersion);
        const to = path.join(targetDir, candidate.name);
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(candidate.folder, to, { recursive: true });
        writeJson(path.join(to, names.manifest), manifest);
        const scriptsDir = path.join(to, names.scripts);
        if (candidate.internal && fs.existsSync(scriptsDir)) {
          writeSettings(scriptsDir, config, commands);
        }
        entries.push({ folder: candidate.name, uuid: manifest.header.uuid, version: manifest.header.version });
      }

      for (const stale of before) {
        if (!entries.some((entry) => entry.folder === stale.folder)) {
          fs.rmSync(path.join(targetDir, stale.folder), { recursive: true, force: true });
        }
      }

      const indexFile = path.join(worldDir, kind.index);
      const known = new Set([...before.map((item) => item.uuid), ...entries.map((item) => item.uuid)]);
      const retained = readList(indexFile).filter((item) => !known.has(item.pack_id));
      writeJson(indexFile, [...retained, ...entries.map((entry) => ({ pack_id: entry.uuid, version: entry.version }))]);
      managed[kind.key] = entries.map(({ folder, uuid }) => ({ folder, uuid }));
    }
  } finally {
    if (staging) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  writeState(directory, { packs: managed });
  return managed;
};
