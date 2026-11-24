import path from "path";
import readline from "readline";
import { App } from "./app.js";
import { loadConfig } from "./engine/config.js";
import { createLogger } from "./engine/logger.js";
import { diagnose, formatReport } from "./installer/doctor.js";
import { createInstaller } from "./installer/index.js";
import { BackupService, restoreBackup } from "./manager/backup.js";

const commands = Object.freeze({
  start: "run the server, installing or updating it first when needed",
  install: "download and install the server, then exit",
  check: "compare the installed server with the latest available version",
  doctor: "test the connection, disk, cpu and ports, and explain any problem",
  backups: "list stored world backups",
  restore: "restore a world backup by name (stop the server first)",
  help: "show this text"
});

export const usageText = () =>
  [
    "usage: node start.js [command] [--config <file>] [--eula]",
    "",
    ...Object.entries(commands).map(([name, text]) => `  ${name.padEnd(10)}${text}`)
  ].join("\n");

export const parseArgs = (argv) => {
  const options = { config: null, eula: false };
  const positional = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" || arg === "-c") {
      index += 1;
      if (!argv[index]) {
        return { error: `${arg} needs a file name` };
      }
      options.config = argv[index];
    } else if (arg === "--eula") {
      options.eula = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg.startsWith("-")) {
      return { error: `unknown option ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  const [command = "start", ...args] = positional;
  if (help) {
    return { command: "help", args: [], options };
  }
  if (!Object.hasOwn(commands, command)) {
    return { error: `unknown command ${command}` };
  }
  return { command, args, options };
};

const serve = ({ root, config, logger, processRef, env }) =>
  new Promise((resolve) => {
    const app = new App({ root, config, logger, env });
    let signals = 0;
    const input = readline.createInterface({ input: processRef.stdin });
    const finish = (code) => {
      input.close();
      resolve(code);
    };
    const onSignal = () => {
      signals += 1;
      if (signals === 1) {
        logger.info("stopping server, press Ctrl+C again to force");
        app.stop();
      } else {
        app.kill();
      }
    };
    processRef.on("SIGINT", onSignal);
    processRef.on("SIGTERM", onSignal);
    input.on("line", (line) => {
      app.console(line);
    });
    app.on("stopped", (code) => finish(code ?? 1));
    app.on("fatal", (error) => {
      logger.error(error.message);
      app.kill();
      finish(1);
    });
    app.start().catch((error) => {
      logger.error(error.message);
      finish(1);
    });
  });

const acceptedByEnvironment = (env) => /^(true|1|yes)$/i.test(String(env.MCJS_EULA ?? env.EULA ?? ""));

export const run = async (argv, { root, io = console, processRef = process, env = process.env } = {}) => {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.error(parsed.error);
    io.error(usageText());
    return 2;
  }
  if (parsed.command === "help") {
    io.log(usageText());
    return 0;
  }

  let config;
  try {
    config = await loadConfig(root, parsed.options.config, { optional: parsed.options.config === null });
  } catch (error) {
    io.error(error.message);
    return 1;
  }
  const logger = createLogger(config.mode === "development" ? "debug" : config.log.level, io);
  if (config.eula !== true && (parsed.options.eula || acceptedByEnvironment(env))) {
    config = { ...config, eula: true };
  }

  try {
    switch (parsed.command) {
      case "install": {
        const result = await createInstaller({ logger }).ensure(config, root);
        io.log(
          result.changed
            ? `installed ${result.version} at ${result.directory}`
            : `server is up to date at ${result.directory}${result.version ? ` (${result.version})` : ""}`
        );
        return 0;
      }
      case "check": {
        const result = await createInstaller({ logger }).check(config, root);
        io.log(`installed: ${result.installed ? `${result.installed.version} (${result.installed.channel})` : "none"}`);
        io.log(`available: ${result.available.version} (${result.available.channel})`);
        io.log(result.current ? "server is up to date" : "an install or update is needed");
        return 0;
      }
      case "doctor": {
        const report = await diagnose({ config, root, env });
        io.log(formatReport(report));
        return report.failed === 0 ? 0 : 1;
      }
      case "backups": {
        const service = new BackupService({
          server: null,
          directory: path.resolve(root, config.server.directory),
          root: path.resolve(root, config.backup.directory),
          settings: config.backup,
          logger
        });
        const names = service.list();
        io.log(names.length > 0 ? names.join("\n") : "no backups");
        return 0;
      }
      case "restore": {
        const [name] = parsed.args;
        if (!name) {
          io.error("restore needs a backup name, see: node start.js backups");
          return 2;
        }
        const result = restoreBackup({ root, config, name });
        io.log(`restored ${result.restored}${result.previous ? `, previous world kept at ${result.previous}` : ""}`);
        return 0;
      }
      default:
        return await serve({ root, config, logger, processRef, env });
    }
  } catch (error) {
    io.error(error.message);
    return 1;
  }
};
