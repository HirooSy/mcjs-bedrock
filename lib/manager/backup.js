import fs from "fs";
import path from "path";
import { fileNames } from "../engine/paths.js";
import { stripPrefix } from "../engine/parser.js";

const patterns = Object.freeze({
  stamp: /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/,
  ready: /Data saved\. Files are now ready to be copied/i,
  entry: /(?:^|, )(.+?):(\d+)(?=, |$)/g
});

const isInside = (base, candidate) => candidate === base || candidate.startsWith(base + path.sep);

export const parseFileList = (lines) => {
  for (const raw of lines) {
    const line = stripPrefix(raw).trim();
    if (patterns.ready.test(line)) {
      continue;
    }
    const entries = [...line.matchAll(patterns.entry)].map((match) => ({ path: match[1], length: Number(match[2]) }));
    if (entries.length > 0) {
      return entries;
    }
  }
  return [];
};

export const isBackupName = (name) => patterns.stamp.test(name);

export class BackupService {
  constructor({ server, directory, root, settings, logger, settleMs = 250, clock = () => new Date() }) {
    this.server = server;
    this.directory = directory;
    this.root = root;
    this.settings = settings;
    this.logger = logger;
    this.settleMs = settleMs;
    this.clock = clock;
    this.running = false;
  }

  list() {
    if (!fs.existsSync(this.root)) {
      return [];
    }
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isBackupName(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  freshName() {
    const base = this.clock().toISOString().slice(0, 19).replace(/:/g, "-");
    let name = base;
    for (let suffix = 1; fs.existsSync(path.join(this.root, name)); suffix += 1) {
      name = `${base}-${suffix}`;
    }
    return name;
  }

  async create() {
    if (this.running) {
      throw new Error("a backup is already running");
    }
    if (!this.server.isReady()) {
      throw new Error("server is not running");
    }
    this.running = true;
    const started = Date.now();
    const name = this.freshName();
    const target = path.join(this.root, name);
    try {
      this.server.write("save hold");
      const files = await this.waitForSnapshot();
      const copied = this.copyFiles(files, target);
      this.prune();
      this.logger.info(`backup ${name} saved: ${copied.files} files, ${copied.bytes} bytes`);
      return { name, files: copied.files, bytes: copied.bytes, durationMs: Date.now() - started };
    } catch (error) {
      this.discard(target);
      throw error;
    } finally {
      this.server.write("save resume");
      this.running = false;
    }
  }

  async waitForSnapshot() {
    const deadline = Date.now() + this.settings.holdTimeoutMs;
    while (Date.now() < deadline) {
      const pending = this.server.collect({
        start: (line) => patterns.ready.test(line),
        timeoutMs: this.settings.pollMs,
        settleMs: this.settleMs
      });
      this.server.write("save query");
      try {
        const files = parseFileList(await pending);
        if (files.length === 0) {
          throw new Error("server reported the world as saved but sent no file list");
        }
        return files;
      } catch (error) {
        if (error.code !== "COLLECT_TIMEOUT") {
          throw error;
        }
      }
    }
    throw new Error(`world was not ready for backup within ${this.settings.holdTimeoutMs}ms`);
  }

  copyFiles(files, target) {
    const base = path.resolve(this.directory, fileNames.worlds);
    const output = path.resolve(target);
    let bytes = 0;
    for (const file of files) {
      const source = path.resolve(base, file.path);
      const destination = path.resolve(output, file.path);
      if (!isInside(base, source) || !isInside(output, destination)) {
        throw new Error(`unsafe path in file list: ${file.path}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      const size = fs.statSync(destination).size;
      if (size > file.length) {
        fs.truncateSync(destination, file.length);
      }
      bytes += Math.min(size, file.length);
    }
    return { files: files.length, bytes };
  }

  prune() {
    const names = this.list();
    const surplus = names.slice(0, Math.max(0, names.length - this.settings.keep));
    for (const name of surplus) {
      fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
    }
    return surplus;
  }

  discard(target) {
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(this.root) && fs.readdirSync(this.root).length === 0) {
      fs.rmdirSync(this.root);
    }
  }
}

export const restoreBackup = ({ root, config, name, clock = () => new Date() }) => {
  if (!isBackupName(name)) {
    throw new Error(`invalid backup name ${name}`);
  }
  const level = config.properties["level-name"];
  const source = path.join(path.resolve(root, config.backup.directory), name, level);
  if (!fs.existsSync(source)) {
    throw new Error(`backup ${name} does not contain the world ${level}`);
  }
  const worlds = path.join(path.resolve(root, config.server.directory), fileNames.worlds);
  const target = path.join(worlds, level);
  let previous = null;
  if (fs.existsSync(target)) {
    const stamp = clock().toISOString().slice(0, 19).replace(/:/g, "-");
    previous = `${target}.replaced-${stamp}`;
    fs.renameSync(target, previous);
  }
  fs.mkdirSync(worlds, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  return { restored: name, previous };
};
