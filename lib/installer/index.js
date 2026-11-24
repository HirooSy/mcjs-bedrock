import fs from "fs";
import os from "os";
import path from "path";
import { fileNames } from "../engine/paths.js";
import { readState, writeState } from "../engine/state.js";
import {
  downloadFile,
  externalTools,
  fetchJson,
  hostOf,
  identities,
  runExternal,
  withRetry
} from "./download.js";
import { platformOf, resolveLink } from "./links.js";
import { createProgress, formatBytes } from "./progress.js";
import { parseRequest } from "./version.js";
import { extractArchive } from "./zip.js";

const preserved = Object.freeze([
  fileNames.worlds,
  fileNames.properties,
  fileNames.allowlist,
  fileNames.permissions,
  fileNames.config
]);

const remote = Object.freeze({
  eula: "https://www.minecraft.net/en-us/eula",
  doctor: 'run "node start.js doctor" to diagnose this connection'
});

const needs = Object.freeze({
  temp: 512 * 1048576,
  target: 256 * 1048576
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const freeSpace = (directory) => {
  try {
    let probe = path.resolve(directory);
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
      probe = path.dirname(probe);
    }
    const stats = fs.statfsSync(probe);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
};

export const assertWritable = (directory) => {
  let probe = path.resolve(directory);
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
  } catch (error) {
    throw new Error(
      `cannot write to ${probe}: ${error.code ?? error.message}. This user does not own the folder or it is read-only. On a hosting panel, stop and start the server once so the panel resets the file ownership, or fix the folder permissions`
    );
  }
};

const copyTree = (source, destination, binaryName) => {
  let copied = 0;
  const walk = (from, to, depth) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const next = path.join(to, entry.name);
      const origin = path.join(from, entry.name);
      if (depth === 0 && preserved.includes(entry.name) && fs.existsSync(next)) {
        continue;
      }
      if (depth === 0 && entry.name === binaryName) {
        continue;
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(next, { recursive: true });
        walk(origin, next, depth + 1);
      } else {
        fs.copyFileSync(origin, next);
        copied += 1;
      }
    }
  };
  fs.mkdirSync(destination, { recursive: true });
  walk(source, destination, 0);
  return copied;
};

const placeBinary = (source, destination) => {
  const staged = `${destination}.mcjs-new`;
  fs.copyFileSync(source, staged);
  if (process.platform !== "win32") {
    fs.chmodSync(staged, 0o755);
  }
  fs.renameSync(staged, destination);
};

export const createInstaller = ({
  logger,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  tmpRoot = null,
  apiUrl,
  filesUrl,
  tools = externalTools,
  spawnImpl,
  pollMs,
  clock = Date.now
}) => {
  const locate = (config, root) => {
    const target = platformOf(platform);
    const directory = path.resolve(root, config.server.directory);
    const binaryName = config.server.binary ?? target.binary;
    return { target, directory, binaryName, binaryPath: path.join(directory, binaryName) };
  };

  const resolve = (config, place, request) =>
    withRetry({
      attempts: config.install.retries,
      delayMs: config.install.retryDelayMs,
      onRetry: (error, attempt) => logger.warn(`lookup failed (${error.message}), retry ${attempt}`),
      task: (attempt) =>
        resolveLink({
          request,
          platform: place.target,
          override: config.server.downloadUrl,
          apiUrl,
          filesUrl,
          fetchJson: (url) =>
            fetchJson({
              url,
              fetchImpl,
              headers: identities[(attempt - 1) % identities.length].headers,
              connectTimeoutMs: config.install.connectTimeoutMs
            })
        })
    });

  const report = (place, install, changed, extra = {}) => ({
    directory: place.directory,
    binaryPath: place.binaryPath,
    version: install?.version ?? null,
    channel: install?.channel ?? null,
    managed: Boolean(install),
    changed,
    ...extra
  });

  const requireEula = (config) => {
    if (config.eula !== true) {
      throw new Error(
        `the Minecraft EULA must be accepted before the server is downloaded: read ${remote.eula} and set eula: true in config.js (or start with --eula)`
      );
    }
  };

  const warnResources = (place, base) => {
    if (arch !== "x64") {
      logger.warn(`this machine is ${arch}, but Bedrock Dedicated Server is only built for x64: the server will probably not start`);
    }
    const temp = freeSpace(base);
    if (temp !== null && temp < needs.temp) {
      logger.warn(`only ${formatBytes(temp)} free in ${base}, installing needs about ${formatBytes(needs.temp)}; set install.tempDirectory to a larger folder`);
    }
    const target = freeSpace(place.directory);
    if (target !== null && target < needs.target) {
      logger.warn(`only ${formatBytes(target)} free for ${place.directory}, the server needs about ${formatBytes(needs.target)}`);
    }
  };

  const download = async (config, link, staging) => {
    const archive = path.join(staging, "server.zip");
    const host = hostOf(link.url);
    const settings = config.install;
    const failures = [];
    const info = (message) => logger.info(message);
    const detail = (message) => logger.debug(message);

    logger.debug(`downloading ${link.version} from ${link.url}`);

    const attempt = async (name, run) => {
      fs.rmSync(archive, { force: true });
      logger.debug(`connecting to ${host} (${name})`);
      const progress = createProgress({ log: info, label: `downloading ${link.version}`, clock });
      try {
        const bytes = await run(progress);
        progress.finish(bytes);
        return { done: true };
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        if (error.code === "UNAVAILABLE") {
          logger.debug(`${error.message}, skipped`);
        } else {
          logger.warn(`download via ${name} failed: ${error.message}`);
        }
        return { done: false, fatal: error.retryable === false ? error : null };
      }
    };

    for (let index = 0; index < settings.retries; index += 1) {
      const identity = identities[index % identities.length];
      const outcome = await attempt(`node ${identity.name}`, (progress) =>
        downloadFile({
          url: link.url,
          target: archive,
          fetchImpl,
          headers: identity.headers,
          connectTimeoutMs: settings.connectTimeoutMs,
          stallTimeoutMs: settings.stallTimeoutMs,
          timeoutMs: settings.timeoutMs,
          onResponse: ({ total, encoded }) =>
            detail(`connected to ${host}: ${total > 0 ? formatBytes(total) : "size not announced"}${encoded ? `, ${encoded} encoded` : ""}`),
          onProgress: progress.update
        })
      );
      if (outcome.done) {
        return archive;
      }
      if (outcome.fatal) {
        throw outcome.fatal.status === 404
          ? new Error(`server ${link.version} was not found at ${link.url} (404): check server.version`)
          : outcome.fatal;
      }
      if (index < settings.retries - 1) {
        await pause(settings.retryDelayMs);
      }
    }

    if (settings.externalTools) {
      for (const tool of tools) {
        const outcome = await attempt(tool.name, (progress) =>
          runExternal({
            tool,
            url: link.url,
            target: archive,
            identity: identities[0],
            connectTimeoutMs: settings.connectTimeoutMs,
            stallTimeoutMs: settings.stallTimeoutMs,
            onProgress: progress.update,
            spawnImpl,
            pollMs
          })
        );
        if (outcome.done) {
          return archive;
        }
      }
    }

    throw new Error(`could not download ${link.url} with any method:\n${failures.map((line) => `  - ${line}`).join("\n")}\n${remote.doctor}`);
  };

  const install = async (config, root, place, link) => {
    assertWritable(place.directory);
    const base = path.resolve(root, tmpRoot ?? config.install.tempDirectory ?? os.tmpdir());
    warnResources(place, base);
    let staging;
    try {
      fs.mkdirSync(base, { recursive: true });
      staging = fs.mkdtempSync(path.join(base, "mcjs-"));
    } catch (error) {
      throw new Error(`cannot create a temporary folder in ${base}: ${error.message} (set install.tempDirectory)`);
    }
    try {
      logger.info(`installing bedrock server ${link.version} (${link.channel})`);
      const archive = await download(config, link, staging);
      logger.debug("extracting the archive");
      const extracted = path.join(staging, "extract");
      const summary = await extractArchive(archive, extracted);
      const staged = path.join(extracted, place.binaryName);
      if (!fs.existsSync(staged)) {
        throw new Error(`archive does not contain ${place.binaryName}`);
      }
      writeState(place.directory, { installing: { version: link.version, startedAt: new Date().toISOString() } });
      copyTree(extracted, place.directory, place.binaryName);
      placeBinary(staged, place.binaryPath);
      const record = {
        version: link.version,
        channel: link.channel,
        platform,
        source: link.url,
        installedAt: new Date().toISOString()
      };
      writeState(place.directory, { install: record, installing: null });
      logger.info(`installed bedrock server ${link.version}`);
      logger.debug(`${summary.files} files written to ${place.directory}`);
      return record;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  };

  const ensure = async (config, root) => {
    const place = locate(config, root);
    const request = parseRequest(config.server.version);
    const state = readState(place.directory);
    const recorded = state.install ?? null;
    const present = fs.existsSync(place.binaryPath);

    if (present && !recorded && !state.installing) {
      logger.debug(`using existing server binary ${place.binaryPath}`);
      return report(place, null, false);
    }
    if (!config.server.autoInstall) {
      if (!present) {
        throw new Error(`server binary not found: ${place.binaryPath} (server.autoInstall is disabled)`);
      }
      return report(place, recorded, false);
    }

    const intact = present && recorded && !state.installing;
    if (intact && config.server.downloadUrl && recorded.source === config.server.downloadUrl) {
      return report(place, recorded, false);
    }
    if (intact && !config.server.downloadUrl && request.pin) {
      if (recorded.version === request.pin && recorded.channel === request.channel) {
        return report(place, recorded, false);
      }
    }
    if (intact && !config.server.downloadUrl && !request.pin) {
      if (recorded.channel === request.channel && !config.server.autoUpdate) {
        return report(place, recorded, false);
      }
    }

    if (!intact) {
      requireEula(config);
    }

    logger.debug(intact ? `checking for a newer server (installed ${recorded.version})` : "no server installed yet, looking up the download");
    let link;
    try {
      link = await resolve(config, place, request);
    } catch (error) {
      if (intact) {
        logger.warn(`could not check for updates (${error.message}), using installed ${recorded.version}`);
        return report(place, recorded, false, { stale: true });
      }
      throw new Error(`cannot find a server download: ${error.message}\n${remote.doctor}`);
    }

    if (intact && recorded.channel === link.channel && recorded.version === link.version && !config.server.downloadUrl) {
      logger.debug(`server ${recorded.version} is up to date`);
      return report(place, recorded, false);
    }
    if (intact && config.eula !== true) {
      logger.warn(`update to ${link.version} is available but eula is not accepted, keeping ${recorded.version}`);
      return report(place, recorded, false, { stale: true });
    }
    requireEula(config);

    const record = await install(config, root, place, link);
    return report(place, record, true);
  };

  const check = async (config, root) => {
    const place = locate(config, root);
    const request = parseRequest(config.server.version);
    const recorded = readState(place.directory).install ?? null;
    const link = await resolve(config, place, request);
    return {
      binaryPath: place.binaryPath,
      present: fs.existsSync(place.binaryPath),
      installed: recorded ? { version: recorded.version, channel: recorded.channel } : null,
      available: { version: link.version, channel: link.channel, url: link.url },
      current: Boolean(recorded) && recorded.version === link.version && recorded.channel === link.channel
    };
  };

  return Object.freeze({ ensure, check, locate, resolve });
};
