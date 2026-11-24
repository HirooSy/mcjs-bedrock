import { EventEmitter } from "events";
import os from "os";
import path from "path";
import { resolveNetwork } from "./engine/config.js";
import { writeProperties } from "./engine/properties.js";
import { BedrockServer } from "./engine/server.js";
import { formatChat } from "./engine/chat.js";
import { isNoise, readOutput } from "./engine/parser.js";
import { createInstaller } from "./installer/index.js";
import { engineOf } from "./installer/version.js";
import { writeAccess } from "./manager/access.js";
import { BackupService } from "./manager/backup.js";
import { syncPacks } from "./manager/packs.js";
import { PluginHost } from "./manager/plugins.js";
import { createScheduler } from "./manager/scheduler.js";

export const explainFailure = (error) => {
  if (error.code === "ENOEXEC") {
    return "the server binary cannot run on this machine: Bedrock Dedicated Server needs an x86_64 cpu (run: node start.js doctor)";
  }
  if (error.code === "EACCES") {
    return "the server binary is not executable: check that the folder is not mounted noexec and that the file permissions allow running it";
  }
  if (error.code === "ENOENT") {
    return "the server binary or one of its loader libraries is missing (run: node start.js doctor)";
  }
  if (error.code === "CRASH_LOOP" && error.neverReady) {
    return "the server exits before it is ready, read its output above; common causes are a missing libcurl4, a cpu that is not x86_64, or too little memory (run: node start.js doctor)";
  }
  return null;
};

export class App extends EventEmitter {
  constructor({
    root,
    config,
    logger,
    installer = createInstaller({ logger }),
    scheduler = createScheduler({ logger }),
    serverArgs = [],
    env = process.env
  }) {
    super();
    this.root = root;
    this.config = config;
    this.logger = logger;
    this.installer = installer;
    this.scheduler = scheduler;
    this.serverArgs = serverArgs;
    this.env = env;
    this.network = null;
    this.server = null;
    this.plugins = null;
    this.backups = null;
    this.install = null;
  }

  checkMemory() {
    const totalMb = Math.round(os.totalmem() / (1024 * 1024));
    if (totalMb < this.config.server.minMemoryMb) {
      this.logger.warn(`system memory ${totalMb}MB is below the ${this.config.server.minMemoryMb}MB minimum`);
    }
  }

  async start() {
    const { config, logger } = this;
    this.install = await this.installer.ensure(config, this.root);
    const { directory, binaryPath } = this.install;
    this.checkMemory();
    if (this.install.version) {
      logger.info(`bedrock server ${this.install.version}`);
    }

    this.network = resolveNetwork(config, this.env);
    const { network } = this;
    logger.debug(`listening on UDP ${network.port} (from ${network.source}), IPv6 ${network.portV6}`);
    const info = Object.freeze({
      address: network.address,
      port: network.port,
      version: this.install.version ?? config.server.version
    });

    const server = new BedrockServer({
      binaryPath,
      args: this.serverArgs,
      runDir: directory,
      marker: config.bridge.marker,
      autoRestart: config.server.autoRestart,
      restartDelayMs: config.server.restartDelayMs,
      stopTimeoutMs: config.server.stopTimeoutMs,
      maxRestarts: config.server.maxRestarts,
      restartWindowMs: config.server.restartWindowMs,
      memoryArenas: config.server.memoryArenas,
      logger
    });

    const backups = new BackupService({
      server,
      directory,
      root: path.resolve(this.root, config.backup.directory),
      settings: config.backup,
      logger
    });

    const plugins = new PluginHost({
      root: this.root,
      directory,
      admins: config.commands.admins,
      namespace: config.commands.namespace,
      options: config.plugins,
      info,
      server,
      logger,
      services: {
        backup: () => backups.create(),
        restart: () => server.restart()
      }
    });
    await plugins.load();

    writeProperties(directory, config, network);
    writeAccess(directory, config);
    await syncPacks({
      root: this.root,
      directory,
      config,
      engineVersion: engineOf(this.install.version),
      commands: plugins.describe().map(({ name, description }) => ({ name, description })),
      logger
    });

    this.server = server;
    this.plugins = plugins;
    this.backups = backups;
    this.wire();
    this.schedule();
    server.start();
  }

  wire() {
    const { server, plugins, logger, network } = this;
    const { config } = this;
    server.on("line", (line) => {
      if (!config.log.serverOutput || line.includes(config.bridge.marker)) {
        return;
      }
      const { level, text } = readOutput(line);
      if (text.length > 0) {
        logger[isNoise(text) ? "debug" : level](text);
      }
    });
    server.on("chat", ({ player, text, at }) => {
      plugins.run({ player, text, at, origin: "player" });
    });
    server.on("join", (payload) => {
      logger.info(`player joined ${payload.name}`);
      plugins.event("join", payload);
    });
    server.on("leave", (payload) => {
      logger.info(`player left ${payload.name}`);
      plugins.event("leave", payload);
    });
    server.on("ready", () => {
      logger.info(`server ready ${network.address}:${network.port}`);
      plugins.event("ready");
      this.emit("ready");
    });
    server.on("fatal", (error) => {
      this.scheduler.stop();
      const hint = explainFailure(error);
      this.emit("fatal", hint ? new Error(`${error.message}\n${hint}`) : error);
    });
    server.on("stopped", (code) => {
      this.scheduler.stop();
      this.emit("stopped", code);
    });
  }

  schedule() {
    const { backup } = this.config;
    if (backup.enabled && backup.intervalMinutes > 0) {
      this.scheduler.every("backup", backup.intervalMinutes * 60000, async () => {
        if (this.server.isReady()) {
          await this.backups.create();
        }
      });
    }
  }

  console(line) {
    const text = String(line).trim();
    if (text.length === 0 || !this.server) {
      return Promise.resolve(false);
    }
    if (text.startsWith(".")) {
      return this.plugins.run({ player: "console", text: text.slice(1), origin: "console" });
    }
    if (text.startsWith("/") || text.toLowerCase() === "stop") {
      this.server.send(text.replace(/^\//, ""));
      return Promise.resolve(true);
    }
    const sent = this.server.broadcast(formatChat(this.config.chat, text));
    if (sent) {
      this.logger.info(`${this.config.chat.prefix} ${text}`);
    } else {
      this.logger.warn("server is not running, the message was not sent");
    }
    return Promise.resolve(sent);
  }

  stop() {
    this.scheduler.stop();
    return this.server ? this.server.stop() : Promise.resolve(0);
  }

  kill() {
    this.scheduler.stop();
    if (this.server) {
      this.server.kill();
    }
  }
}
