import { EventEmitter } from "events";
import { PluginHost } from "../lib/manager/plugins.js";
import { memoryLogger } from "./logger.js";
import { workspace, writeFiles } from "./workspace.js";

export const fakeServer = () => {
  const sent = [];
  const server = new EventEmitter();
  server.players = new Map();
  server.tell = (player, text) => sent.push(["tell", player, text]);
  server.broadcast = (text) => sent.push(["broadcast", text]);
  server.send = (line) => sent.push(["send", line]);
  server.playerNames = () => [...server.players.keys()];
  server.xuidOf = (name) => server.players.get(name) ?? null;
  server.uptime = () => 3723000;
  return { server, sent };
};

export const pluginRoot = (t, files = {}) => {
  const root = workspace(t);
  writeFiles(root, files);
  return root;
};

export const createHost = (t, { files = {}, admins = ["Admin"], options = {}, services = {}, root = null, directory = null } = {}) => {
  const base = root ?? pluginRoot(t, files);
  const { server, sent } = fakeServer();
  const { logger, lines, has } = memoryLogger();
  const host = new PluginHost({
    root: base,
    directory,
    admins,
    namespace: "mcjs",
    info: { address: "play.example.com", port: 19132, version: "1.26.61.1" },
    options,
    server,
    logger,
    services
  });
  return { host, server, sent, logger, lines, has, root: base };
};

export const command = (name, body = "", extra = "") =>
  `export default { name: ${JSON.stringify(name)}, ${extra} run: async (ctx) => { ${body} } };\n`;
