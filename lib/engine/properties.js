import fs from "fs";
import path from "path";
import { resolveNetwork } from "./config.js";
import { fileNames } from "./paths.js";

export const buildProperties = (config, network = resolveNetwork(config, {})) => {
  const settings = { ...config.properties };
  if (!("allow-list" in settings)) {
    settings["allow-list"] = config.access.allowlist.length > 0;
  }
  settings["server-port"] = network.port;
  settings["server-portv6"] = network.portV6;
  const body = Object.entries(settings)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return `${body}\n`;
};

export const writeProperties = (directory, config, network = resolveNetwork(config, {})) => {
  const target = path.join(directory, fileNames.properties);
  const body = buildProperties(config, network);
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === body) {
    return false;
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, body);
  return true;
};
