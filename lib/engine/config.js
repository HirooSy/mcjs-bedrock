import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { colors } from "./chat.js";
import { parseRequest } from "../installer/version.js";
import { defaults } from "./defaults.js";
import { levelRanks } from "./logger.js";

const shapes = Object.freeze({
  namespace: /^[a-z][a-z0-9_]*$/,
  xuid: /^\d{4,20}$/,
  url: /^https?:\/\/\S+$/i,
  scriptApi: /^\d+\.\d+\.\d+(-beta)?$/,
  marker: /^\S+$/
});

const configFiles = Object.freeze(["config.js", "config.json"]);

const sections = Object.freeze([
  "server",
  "install",
  "network",
  "properties",
  "access",
  "packs",
  "commands",
  "bridge",
  "backup",
  "plugins",
  "chat",
  "log"
]);

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const merge = (base, override) => {
  if (!isPlain(base) || !isPlain(override)) {
    return override === undefined ? base : override;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in base ? merge(base[key], value) : value;
  }
  return result;
};

const isInteger = (value, minimum = 0) => Number.isInteger(value) && value >= minimum;
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isPort = (value) => isInteger(value, 1) && value <= 65535;
const isTextList = (list) => Array.isArray(list) && list.every(isText);

const validateAllowEntry = (entry) => {
  if (isText(entry)) {
    return true;
  }
  return (
    isPlain(entry) &&
    isText(entry.name) &&
    (entry.xuid === undefined || shapes.xuid.test(String(entry.xuid))) &&
    (entry.ignoresPlayerLimit === undefined || typeof entry.ignoresPlayerLimit === "boolean")
  );
};

const validate = (config) => {
  const problems = [];
  const expect = (condition, message) => {
    if (!condition) {
      problems.push(message);
    }
  };

  if (!isPlain(config)) {
    return ["config root must be an object"];
  }
  for (const name of sections) {
    expect(isPlain(config[name]), `${name} must be an object`);
  }
  if (problems.length > 0) {
    return problems;
  }

  expect(["production", "development"].includes(config.mode), "mode must be production or development");
  expect(typeof config.eula === "boolean", "eula must be true or false");

  const { server, install, network, properties, access, packs, commands, bridge, backup, plugins, chat, log } = config;

  expect(
    typeof server.version === "string" && parseRequest(server.version) !== null,
    `server.version must be latest, preview, or a version like 1.26.61.1 (got ${JSON.stringify(server.version)})`
  );
  expect(isText(server.directory), "server.directory must be a non-empty path");
  expect(server.binary === null || isText(server.binary), "server.binary must be null or a file name");
  expect(
    server.downloadUrl === null || (typeof server.downloadUrl === "string" && shapes.url.test(server.downloadUrl)),
    "server.downloadUrl must be null or an http(s) url"
  );
  expect(typeof server.autoInstall === "boolean", "server.autoInstall must be a boolean");
  expect(typeof server.autoUpdate === "boolean", "server.autoUpdate must be a boolean");
  expect(isInteger(server.minMemoryMb), "server.minMemoryMb must be a non-negative integer");
  expect(isInteger(server.memoryArenas), "server.memoryArenas must be a non-negative integer");
  expect(typeof server.autoRestart === "boolean", "server.autoRestart must be a boolean");
  expect(isInteger(server.restartDelayMs), "server.restartDelayMs must be a non-negative integer");
  expect(isInteger(server.stopTimeoutMs), "server.stopTimeoutMs must be a non-negative integer");
  expect(isInteger(server.maxRestarts), "server.maxRestarts must be a non-negative integer");
  expect(isInteger(server.restartWindowMs, 1), "server.restartWindowMs must be a positive integer");

  expect(isInteger(install.retries, 1), "install.retries must be at least 1");
  expect(isInteger(install.retryDelayMs), "install.retryDelayMs must be a non-negative integer");
  expect(isInteger(install.connectTimeoutMs, 1), "install.connectTimeoutMs must be a positive integer");
  expect(isInteger(install.stallTimeoutMs, 1), "install.stallTimeoutMs must be a positive integer");
  expect(isInteger(install.timeoutMs, 1), "install.timeoutMs must be a positive integer");
  expect(typeof install.externalTools === "boolean", "install.externalTools must be a boolean");
  expect(install.tempDirectory === null || isText(install.tempDirectory), "install.tempDirectory must be null or a folder path");

  expect(network.address === null || isText(network.address), "network.address must be null (automatic) or a host name");
  expect(network.port === null || isPort(network.port), "network.port must be null (automatic) or a valid port");
  expect(network.portV6 === null || isPort(network.portV6), "network.portV6 must be null (automatic) or a valid port");
  expect(
    network.port === null || network.portV6 === null || network.port !== network.portV6,
    "network.port and network.portV6 must differ"
  );

  for (const [key, value] of Object.entries(properties)) {
    const scalar = ["string", "number", "boolean"].includes(typeof value);
    expect(scalar && !/[\r\n]/.test(String(value)), `properties.${key} must be a single-line string, number or boolean`);
  }
  expect(isText(properties["level-name"]), "properties.level-name is required");
  expect(!/[\\/]/.test(String(properties["level-name"])), "properties.level-name must not contain path separators");

  expect(
    Array.isArray(access.allowlist) && access.allowlist.every(validateAllowEntry),
    "access.allowlist entries must be names or objects with name, optional xuid and ignoresPlayerLimit"
  );
  for (const level of ["operators", "members", "visitors"]) {
    expect(
      Array.isArray(access[level]) && access[level].every((xuid) => shapes.xuid.test(String(xuid))),
      `access.${level} must be a list of xuids`
    );
  }

  expect(
    typeof packs.scriptApiVersion === "string" && shapes.scriptApi.test(packs.scriptApiVersion),
    "packs.scriptApiVersion must look like 2.1.0 or 2.1.0-beta"
  );

  expect(
    typeof commands.namespace === "string" && shapes.namespace.test(commands.namespace),
    "commands.namespace must be lowercase letters, digits and underscores, starting with a letter"
  );
  expect(isTextList(commands.admins), "commands.admins must be a list of gamertags");

  expect(typeof bridge.marker === "string" && shapes.marker.test(bridge.marker), "bridge.marker must be a token without spaces");

  expect(typeof backup.enabled === "boolean", "backup.enabled must be a boolean");
  expect(isInteger(backup.intervalMinutes), "backup.intervalMinutes must be a non-negative integer");
  expect(isInteger(backup.keep, 1), "backup.keep must be at least 1");
  expect(isText(backup.directory), "backup.directory must be a non-empty path");
  expect(isInteger(backup.holdTimeoutMs, 1), "backup.holdTimeoutMs must be a positive integer");
  expect(isInteger(backup.pollMs, 1), "backup.pollMs must be a positive integer");

  for (const [name, options] of Object.entries(plugins)) {
    expect(isPlain(options), `plugins.${name} must be an object`);
  }
  expect(isText(chat.prefix), "chat.prefix must be a non-empty text");
  expect(Object.hasOwn(colors, chat.prefixColor), `chat.prefixColor must be one of ${Object.keys(colors).join(", ")}`);
  expect(Object.hasOwn(colors, chat.messageColor), `chat.messageColor must be one of ${Object.keys(colors).join(", ")}`);
  if (isPlain(plugins.teleport)) {
    expect(isInteger(plugins.teleport.maxPoints, 1), "plugins.teleport.maxPoints must be at least 1");
    expect(isInteger(plugins.teleport.cooldownSeconds), "plugins.teleport.cooldownSeconds must be a non-negative integer");
    expect(isInteger(plugins.teleport.randomRadius, 100), "plugins.teleport.randomRadius must be at least 100");
  }
  if (isPlain(plugins.status)) {
    expect(typeof plugins.status.enabled === "boolean", "plugins.status.enabled must be a boolean");
    expect(isInteger(plugins.status.intervalSeconds, 1), "plugins.status.intervalSeconds must be a positive integer");
    expect(isText(plugins.status.title), "plugins.status.title must be a non-empty text");
  }

  expect(Object.hasOwn(levelRanks, log.level), `log.level must be one of ${Object.keys(levelRanks).join(", ")}`);
  expect(typeof log.serverOutput === "boolean", "log.serverOutput must be a boolean");

  return problems;
};

const wildcards = Object.freeze(["", "0.0.0.0", "::", "[::]"]);

export const resolveNetwork = (config, env = process.env) => {
  const fromEnv = Number.parseInt(env.SERVER_PORT ?? "", 10);
  const envPort = isPort(fromEnv) ? fromEnv : null;
  const port = config.network.port ?? envPort ?? 19132;
  const automatic = config.network.port === null && envPort !== null;
  let portV6 = config.network.portV6 ?? (automatic ? port + 1 : 19133);
  if (portV6 === port || portV6 > 65535) {
    portV6 = port < 65535 ? port + 1 : port - 1;
  }
  const hostFromEnv = typeof env.SERVER_IP === "string" && !wildcards.includes(env.SERVER_IP.trim()) ? env.SERVER_IP.trim() : null;
  return Object.freeze({
    address: config.network.address ?? hostFromEnv ?? "localhost",
    port,
    portV6,
    source: config.network.port !== null ? "config" : envPort !== null ? "SERVER_PORT" : "default"
  });
};

export const resolveConfig = (overrides = {}) => {
  const config = merge(structuredClone(defaults), overrides);
  const problems = validate(config);
  if (problems.length > 0) {
    throw new Error(`invalid config:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
  return config;
};

const readConfigFile = async (location) => {
  if (path.extname(location).toLowerCase() === ".json") {
    try {
      return JSON.parse(fs.readFileSync(location, "utf8"));
    } catch (error) {
      throw new Error(`config ${location} is not valid JSON: ${error.message}`);
    }
  }
  try {
    const loaded = await import(`${pathToFileURL(location).href}?v=${Date.now()}`);
    return loaded.default;
  } catch (error) {
    throw new Error(`config ${location} cannot be loaded: ${error.message}`);
  }
};

export const loadConfig = async (root, file = null, { optional = false } = {}) => {
  const locations = (file ? [file] : configFiles).map((name) => path.resolve(root, name));
  const location = locations.find((candidate) => fs.existsSync(candidate));
  if (!location) {
    if (optional) {
      return resolveConfig({});
    }
    throw new Error(`cannot read config ${locations[0]}: file not found`);
  }
  return resolveConfig(await readConfigFile(location));
};
