import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { createStorage } from "./storage.js";

const names = Object.freeze({
  pluginRoot: "plugins",
  commands: "commands",
  events: "events"
});

const shapes = Object.freeze({
  identifier: /^[a-z][a-z0-9_]*$/,
  eventNames: Object.freeze(["join", "leave", "ready"])
});

const isIdentifier = (value) => typeof value === "string" && shapes.identifier.test(value);

const isCommand = (plugin) =>
  Boolean(plugin) &&
  isIdentifier(plugin.name) &&
  typeof plugin.run === "function" &&
  (plugin.aliases === undefined || (Array.isArray(plugin.aliases) && plugin.aliases.every(isIdentifier)));

const isEvent = (plugin) =>
  Boolean(plugin) &&
  typeof plugin.name === "string" &&
  plugin.name.length > 0 &&
  typeof plugin.run === "function" &&
  shapes.eventNames.includes(plugin.on);

const loadModules = async (dir, stamp, logger) => {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const modules = [];
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .sort();
  for (const file of files) {
    const url = `${pathToFileURL(path.join(dir, file)).href}?v=${stamp}`;
    try {
      const mod = await import(url);
      for (const plugin of [mod.default].flat()) {
        modules.push({ file, plugin });
      }
    } catch (error) {
      logger.warn(`plugin ${file} failed to load: ${error.message}`);
    }
  }
  return modules;
};

const unavailable = (name) => () => Promise.reject(new Error(`${name} is not available`));

export class PluginHost {
  constructor({ root, directory = null, admins, namespace, info, options = {}, server, logger, services = {} }) {
    this.root = root;
    this.directory = directory;
    this.admins = new Set(admins.map((name) => name.toLowerCase()));
    this.namespace = namespace;
    this.info = info;
    this.options = options;
    this.server = server;
    this.logger = logger;
    this.services = services;
    this.commands = new Map();
    this.events = new Map();
    this.loads = 0;
  }

  async load() {
    this.loads += 1;
    const stamp = `${Date.now()}-${this.loads}`;
    const base = path.join(this.root, names.pluginRoot);
    const commands = new Map();
    const events = new Map();

    for (const { file, plugin } of await loadModules(path.join(base, names.commands), stamp, this.logger)) {
      if (!isCommand(plugin)) {
        this.logger.warn(`plugin ${file} skipped: name (lowercase letters, digits, underscores) and run are required`);
        continue;
      }
      for (const key of [plugin.name, ...(plugin.aliases ?? [])]) {
        if (commands.has(key)) {
          this.logger.warn(`plugin ${file} skipped command ${key}: already defined by ${commands.get(key).name}`);
          continue;
        }
        commands.set(key, plugin);
      }
    }

    for (const { file, plugin } of await loadModules(path.join(base, names.events), stamp, this.logger)) {
      if (!isEvent(plugin)) {
        this.logger.warn(`plugin ${file} skipped: name, on (join, leave or ready) and run are required`);
        continue;
      }
      events.set(plugin.on, [...(events.get(plugin.on) ?? []), plugin]);
    }

    this.commands = commands;
    this.events = events;
    return { commands: this.names().length, events: [...events.values()].flat().length };
  }

  names() {
    return [...new Set([...this.commands.values()].map((plugin) => plugin.name))].sort();
  }

  describe() {
    return [...this.commands.entries()]
      .map(([key, plugin]) => ({
        name: key,
        description: typeof plugin.description === "string" ? plugin.description : plugin.name,
        admin: plugin.admin === true,
        alias: key !== plugin.name
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  signature() {
    return JSON.stringify(this.describe().map((entry) => entry.name));
  }

  isAdmin(player, origin) {
    return origin === "console" || this.admins.has(String(player).toLowerCase());
  }

  qualify(name) {
    return `/${this.namespace}:${name}`;
  }

  context({ player, xuid = null, origin = "player", plugin = null, args = [], at = null }) {
    const fromConsole = origin === "console";
    const reply = (text) => (fromConsole ? this.logger.info(String(text)) : this.server.tell(player, text));
    return {
      player,
      xuid: xuid ?? (player ? this.server.xuidOf(player) : null),
      origin,
      at,
      admin: this.isAdmin(player, origin),
      args,
      info: this.info,
      namespace: this.namespace,
      options: plugin ? (this.options[plugin.section ?? plugin.name] ?? {}) : {},
      storage: (name = plugin?.section ?? plugin?.name) => {
        if (this.directory === null) {
          throw new Error("storage is not available");
        }
        return createStorage(this.directory, name);
      },
      players: this.server.playerNames(),
      commands: this.describe(),
      qualify: (name) => this.qualify(name),
      reply,
      usage: () => reply(`usage: ${this.qualify(plugin?.name ?? "")} ${plugin?.usage ?? ""}`.trim()),
      tell: (target, text) => this.server.tell(target, text),
      broadcast: (text) => this.server.broadcast(text),
      send: (line) => this.server.send(line),
      log: this.logger,
      uptime: () => this.server.uptime(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      reload: async () => {
        const before = this.signature();
        const summary = await this.load();
        return { ...summary, restartRequired: before !== this.signature() };
      },
      backup: this.services.backup ?? unavailable("backup"),
      restart: this.services.restart ?? unavailable("restart")
    };
  }

  async run({ player, text, origin = "player", xuid = null, at = null }) {
    const [name = "", ...args] = String(text).trim().split(/\s+/);
    const command = this.commands.get(name.toLowerCase());
    if (!command) {
      if (origin === "console" && name) {
        this.logger.info(`unknown command ${name}`);
      }
      return false;
    }
    const context = this.context({ player, xuid, origin, plugin: command, args, at });
    if (command.admin && !context.admin) {
      this.server.tell(player, "no permission");
      return false;
    }
    try {
      await command.run(context);
      return true;
    } catch (error) {
      this.logger.error(`command ${name} failed: ${error.message}`);
      return false;
    }
  }

  event(name, payload = {}) {
    const handlers = this.events.get(name) ?? [];
    return Promise.all(
      handlers.map((plugin) =>
        Promise.resolve()
          .then(() => plugin.run(this.context({ player: payload.name ?? null, xuid: payload.xuid ?? null, plugin })))
          .catch((error) => this.logger.error(`event ${plugin.name} failed: ${error.message}`))
      )
    );
  }
}
