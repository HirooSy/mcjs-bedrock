import fs from "fs";
import path from "path";
import { resolveConfig } from "../lib/engine/config.js";
import { createInstaller } from "../lib/installer/index.js";
import { serverArchive } from "./archive.js";
import { sendBuffer, startServer } from "./http.js";
import { memoryLogger } from "./logger.js";
import { workspace } from "./workspace.js";

export const createScenario = async (t, { overrides = {}, platform = "linux", archiveExtra = [], installerOptions = {} } = {}) => {
  const root = workspace(t);
  const tmpRoot = workspace(t);
  const { logger, lines, has } = memoryLogger();
  const releases = { release: "1.26.61.1", preview: "1.26.70.22" };
  const behavior = { api: 200, zip: 200, apiFailures: 0, tarpit: () => false, stallFirst: 0 };
  const agents = [];
  const archives = new Map();

  const archiveFor = (version) => {
    if (!archives.has(version)) {
      archives.set(
        version,
        serverArchive({ marker: version, binary: platform === "win32" ? "bedrock_server.exe" : "bedrock_server", extra: archiveExtra })
      );
    }
    return archives.get(version);
  };

  const { origin, hits } = await startServer(t, (request, response) => {
    if (request.url === "/api") {
      if (behavior.apiFailures > 0) {
        behavior.apiFailures -= 1;
        response.writeHead(503);
        response.end();
        return;
      }
      if (behavior.api !== 200) {
        response.writeHead(behavior.api);
        response.end();
        return;
      }
      const kind = platform === "win32" ? "Windows" : "Linux";
      const folder = platform === "win32" ? "bin-win" : "bin-linux";
      const body = {
        result: {
          links: [
            { downloadType: `serverBedrock${kind}`, downloadUrl: `${origin}/${folder}/bedrock-server-${releases.release}.zip` },
            { downloadType: `serverBedrockPreview${kind}`, downloadUrl: `${origin}/${folder}-preview/bedrock-server-${releases.preview}.zip` }
          ]
        }
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    const match = request.url.match(/bedrock-server-([\d.]+)\.zip$/);
    if (!match || behavior.zip !== 200) {
      response.writeHead(behavior.zip === 200 ? 404 : behavior.zip);
      response.end();
      return;
    }
    agents.push(request.headers["user-agent"]);
    if (behavior.tarpit(request.headers)) {
      return;
    }
    const bytes = archiveFor(match[1]);
    if (behavior.stallFirst > 0) {
      behavior.stallFirst -= 1;
      response.writeHead(200, { "content-length": bytes.length });
      response.write(bytes.subarray(0, 100));
      return;
    }
    sendBuffer(response, bytes);
  });

  const config = (extra = {}) =>
    resolveConfig({
      eula: true,
      ...overrides,
      ...extra,
      install: {
        retries: 2,
        retryDelayMs: 1,
        connectTimeoutMs: 2000,
        stallTimeoutMs: 2000,
        timeoutMs: 8000,
        externalTools: false,
        ...(overrides.install ?? {}),
        ...(extra.install ?? {})
      },
      server: { ...(overrides.server ?? {}), ...(extra.server ?? {}) }
    });

  const installer = createInstaller({ logger, platform, tmpRoot, apiUrl: `${origin}/api`, filesUrl: origin, pollMs: 20, ...installerOptions });

  const zipRequests = () => hits.filter((hit) => hit.url.endsWith(".zip")).length;
  const apiRequests = () => hits.filter((hit) => hit.url === "/api").length;
  const dataDir = () => path.join(root, "data");
  const tmpLeftovers = () => fs.readdirSync(tmpRoot);

  return { root, tmpRoot, logger, lines, has, releases, behavior, agents, origin, hits, config, installer, zipRequests, apiRequests, dataDir, tmpLeftovers };
};
