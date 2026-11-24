export const endpoints = Object.freeze({
  api: "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links",
  files: "https://www.minecraft.net/bedrockdedicatedserver"
});

const platforms = Object.freeze({
  linux: Object.freeze({ kind: "Linux", folder: "bin-linux", binary: "bedrock_server" }),
  win32: Object.freeze({ kind: "Windows", folder: "bin-win", binary: "bedrock_server.exe" })
});

const patterns = Object.freeze({
  archive: /bedrock-server-(\d+(?:\.\d+){2,3})\.zip$/,
  preview: /\/bin-(?:linux|win)-preview\//
});

export const platformOf = (name) => {
  const found = platforms[name];
  if (!found) {
    throw new Error(`unsupported platform ${name}: Bedrock Dedicated Server runs on linux and win32 only`);
  }
  return found;
};

export const describeUrl = (url) => {
  const pathname = new URL(url).pathname;
  const match = pathname.match(patterns.archive);
  if (!match) {
    return null;
  }
  return { version: match[1], channel: patterns.preview.test(pathname) ? "preview" : "release" };
};

export const archiveUrl = ({ platform, channel, version, filesUrl = endpoints.files }) =>
  `${filesUrl}/${platform.folder}${channel === "preview" ? "-preview" : ""}/bedrock-server-${version}.zip`;

export const resolveLink = async ({ request, platform, fetchJson, override = null, apiUrl = endpoints.api, filesUrl }) => {
  if (override) {
    const described = describeUrl(override);
    return {
      url: override,
      version: described?.version ?? "custom",
      channel: described?.channel ?? request.channel
    };
  }
  if (request.pin) {
    return {
      url: archiveUrl({ platform, channel: request.channel, version: request.pin, filesUrl }),
      version: request.pin,
      channel: request.channel
    };
  }
  const payload = await fetchJson(apiUrl);
  const kind = `serverBedrock${request.channel === "preview" ? "Preview" : ""}${platform.kind}`;
  const links = payload?.result?.links;
  const link = Array.isArray(links) ? links.find((entry) => entry?.downloadType === kind) : undefined;
  if (!link || typeof link.downloadUrl !== "string") {
    throw new Error(`download API has no ${kind} entry`);
  }
  const described = describeUrl(link.downloadUrl);
  if (!described) {
    throw new Error(`cannot read a version from ${link.downloadUrl}`);
  }
  return { url: link.downloadUrl, version: described.version, channel: request.channel };
};
