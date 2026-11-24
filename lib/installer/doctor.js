import dns from "dns";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { resolveNetwork } from "../engine/config.js";
import { externalTools, fetchJson, hostOf, identities, probeUrl } from "./download.js";
import { freeSpace } from "./index.js";
import { endpoints, platformOf, resolveLink } from "./links.js";
import { formatBytes } from "./progress.js";
import { parseRequest } from "./version.js";

const needs = Object.freeze({
  temp: 512 * 1048576,
  target: 256 * 1048576
});

const defaultProbes = Object.freeze({
  hasTool: (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).error === undefined,
  libraries: () => spawnSync("ldconfig", ["-p"], { encoding: "utf8" }).stdout ?? ""
});

const result = (name, status, detail) => ({ name, status, detail });

const attempt = async (name, task) => {
  try {
    return await task();
  } catch (error) {
    return result(name, "fail", error.message);
  }
};

const nearestExisting = (directory) => {
  let probe = path.resolve(directory);
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  return probe;
};

const writable = (directory) => {
  try {
    const probe = nearestExisting(directory);
    fs.accessSync(probe, fs.constants.W_OK);
    return fs.statSync(probe).isDirectory();
  } catch {
    return false;
  }
};

const spaceCheck = (name, directory, required, advice) => {
  if (!writable(directory)) {
    return result(name, "fail", `${directory} is not writable`);
  }
  const free = freeSpace(directory);
  if (free === null) {
    return result(name, "ok", `${directory} (free space unknown)`);
  }
  return free < required
    ? result(name, "warn", `${directory} has ${formatBytes(free)} free, about ${formatBytes(required)} is needed; ${advice}`)
    : result(name, "ok", `${directory}, ${formatBytes(free)} free`);
};

export const diagnose = async ({
  config,
  root,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
  fetchImpl = fetch,
  lookup = dns.promises.lookup,
  tmpRoot = null,
  apiUrl = endpoints.api,
  filesUrl = endpoints.files,
  tools = externalTools,
  probes = defaultProbes
}) => {
  const checks = [];
  const add = (entry) => checks.push(entry);

  const major = Number.parseInt(nodeVersion.replace(/^v/, ""), 10);
  let runtime = result("runtime", "ok", `node ${nodeVersion} on ${platform}/${arch}`);
  if (major < 18) {
    runtime = result("runtime", "fail", `node ${nodeVersion} is too old, 18.18 or newer is required`);
  } else if (!["linux", "win32"].includes(platform)) {
    runtime = result("runtime", "fail", `${platform} is not supported, Bedrock Dedicated Server runs on linux and win32`);
  } else if (arch !== "x64") {
    runtime = result("runtime", "warn", `${arch} cpu: Bedrock Dedicated Server is only built for x64 and will probably not start`);
  }
  add(runtime);

  const network = resolveNetwork(config, env);
  add(result("network", "ok", `server will listen on UDP ${network.port} (from ${network.source}), address ${network.address}`));

  add(spaceCheck("temp folder", path.resolve(root, tmpRoot ?? config.install.tempDirectory ?? os.tmpdir()), needs.temp, "set install.tempDirectory to a larger folder"));
  add(spaceCheck("server folder", path.resolve(root, config.server.directory), needs.target, "free some disk space"));

  const hosts = [...new Set([hostOf(apiUrl), hostOf(filesUrl)])];
  for (const host of hosts) {
    add(
      await attempt(`dns ${host}`, async () => {
        const found = await lookup(host.replace(/:\d+$/, ""), { all: true });
        return result(`dns ${host}`, "ok", found.slice(0, 3).map((entry) => entry.address).join(", "));
      })
    );
  }

  let link = null;
  if (["linux", "win32"].includes(platform)) {
    const request = parseRequest(config.server.version);
    add(
      await attempt("download api", async () => {
        link = await resolveLink({
          request,
          platform: platformOf(platform),
          override: config.server.downloadUrl,
          apiUrl,
          filesUrl,
          fetchJson: (url) =>
            fetchJson({ url, fetchImpl, headers: identities[0].headers, connectTimeoutMs: config.install.connectTimeoutMs })
        });
        return result("download api", "ok", `${link.channel} ${link.version} at ${link.url}`);
      })
    );
  }

  if (link) {
    for (const identity of identities) {
      const name = `download ${identity.name}`;
      add(
        await attempt(name, async () => {
          const probe = await probeUrl({
            url: link.url,
            fetchImpl,
            headers: identity.headers,
            connectTimeoutMs: config.install.connectTimeoutMs
          });
          const size = probe.total > 0 ? `, ${formatBytes(probe.total)}` : ", size not announced";
          return result(name, "ok", `status ${probe.status}, first bytes after ${probe.ms}ms${size}`);
        })
      );
    }
    const working = checks.filter((entry) => entry.name.startsWith("download ") && entry.name !== "download api" && entry.status === "ok");
    if (working.length === 0) {
      add(
        result(
          "download verdict",
          "fail",
          `${hostOf(link.url)} did not answer any identity from this network: ask the host to allow it, or set server.downloadUrl to a reachable copy`
        )
      );
    }
  }

  for (const tool of tools) {
    add(
      probes.hasTool(tool.command)
        ? result(`tool ${tool.name}`, "ok", "available as a download fallback")
        : result(`tool ${tool.name}`, "warn", "not installed (only matters if the built in downloader is blocked)")
    );
  }

  if (platform === "linux") {
    add(
      probes.libraries().includes("libcurl.so.4")
        ? result("libcurl4", "ok", "found")
        : result("libcurl4", "warn", "not found: Bedrock Dedicated Server needs libcurl4 on Linux, install it in the container image if the server exits at once")
    );
  }

  return { checks, failed: checks.filter((entry) => entry.status === "fail").length };
};

export const formatReport = ({ checks, failed }) => {
  const labels = { ok: " ok ", warn: "warn", fail: "FAIL" };
  const width = Math.max(...checks.map((entry) => entry.name.length));
  const lines = checks.map((entry) => `[${labels[entry.status]}] ${entry.name.padEnd(width)}  ${entry.detail}`);
  lines.push(failed === 0 ? "no blocking problems found" : `${failed} blocking problem${failed === 1 ? "" : "s"} found`);
  return lines.join("\n");
};
