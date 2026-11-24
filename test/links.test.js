import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveUrl, describeUrl, platformOf, resolveLink } from "../lib/installer/links.js";

const payload = () => ({
  result: {
    links: [
      { downloadType: "serverBedrockWindows", downloadUrl: "https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.61.1.zip" },
      { downloadType: "serverBedrockLinux", downloadUrl: "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.61.1.zip" },
      { downloadType: "serverBedrockPreviewWindows", downloadUrl: "https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.70.22.zip" },
      { downloadType: "serverBedrockPreviewLinux", downloadUrl: "https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.70.22.zip" },
      { downloadType: "serverJar", downloadUrl: "https://piston-data.mojang.com/v1/objects/abc/server.jar" }
    ]
  }
});

const lookup = (request, platformName, extra = {}) =>
  resolveLink({
    request,
    platform: platformOf(platformName),
    fetchJson: async () => payload(),
    ...extra
  });

test("platforms map to download kinds and binary names", () => {
  assert.equal(platformOf("linux").binary, "bedrock_server");
  assert.equal(platformOf("win32").binary, "bedrock_server.exe");
  assert.throws(() => platformOf("darwin"), /unsupported platform darwin/);
});

test("the latest release link is chosen per platform", async () => {
  const linux = await lookup({ channel: "release", pin: null }, "linux");
  assert.deepEqual(linux, {
    url: "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.61.1.zip",
    version: "1.26.61.1",
    channel: "release"
  });
  const windows = await lookup({ channel: "release", pin: null }, "win32");
  assert.match(windows.url, /bin-win\//);
});

test("the preview channel picks the preview links", async () => {
  const preview = await lookup({ channel: "preview", pin: null }, "linux");
  assert.equal(preview.version, "1.26.70.22");
  assert.equal(preview.channel, "preview");
  assert.match(preview.url, /bin-linux-preview/);
});

test("a pinned version builds the url without calling the api", async () => {
  let calls = 0;
  const link = await resolveLink({
    request: { channel: "release", pin: "1.26.50.2" },
    platform: platformOf("linux"),
    fetchJson: async () => {
      calls += 1;
      return payload();
    }
  });
  assert.equal(calls, 0);
  assert.equal(link.url, "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.50.2.zip");
  const preview = await resolveLink({
    request: { channel: "preview", pin: "1.26.70.22" },
    platform: platformOf("win32"),
    fetchJson: async () => payload()
  });
  assert.match(preview.url, /bin-win-preview\/bedrock-server-1\.26\.70\.22\.zip$/);
});

test("an override url skips every lookup and reads the version from the file name", async () => {
  const link = await resolveLink({
    request: { channel: "release", pin: null },
    platform: platformOf("linux"),
    override: "https://mirror.example/files/bedrock-server-1.26.99.0.zip",
    fetchJson: async () => {
      throw new Error("must not be called");
    }
  });
  assert.equal(link.version, "1.26.99.0");
  assert.equal(link.url, "https://mirror.example/files/bedrock-server-1.26.99.0.zip");
});

test("an override with an unrecognised file name is labelled custom", async () => {
  const link = await resolveLink({
    request: { channel: "preview", pin: null },
    platform: platformOf("linux"),
    override: "https://mirror.example/server.zip",
    fetchJson: async () => payload()
  });
  assert.deepEqual(link, { url: "https://mirror.example/server.zip", version: "custom", channel: "preview" });
});

test("missing or malformed api entries produce a clear error", async () => {
  await assert.rejects(
    resolveLink({ request: { channel: "release", pin: null }, platform: platformOf("linux"), fetchJson: async () => ({ result: { links: [] } }) }),
    /no serverBedrockLinux entry/
  );
  await assert.rejects(
    resolveLink({ request: { channel: "release", pin: null }, platform: platformOf("linux"), fetchJson: async () => ({}) }),
    /no serverBedrockLinux entry/
  );
  await assert.rejects(
    resolveLink({
      request: { channel: "release", pin: null },
      platform: platformOf("linux"),
      fetchJson: async () => ({ result: { links: [{ downloadType: "serverBedrockLinux", downloadUrl: "https://x/y/server.zip" }] } })
    }),
    /cannot read a version/
  );
});

test("the api url can be redirected for mirrors", async () => {
  const seen = [];
  await resolveLink({
    request: { channel: "release", pin: null },
    platform: platformOf("linux"),
    apiUrl: "http://127.0.0.1:1/links",
    fetchJson: async (url) => {
      seen.push(url);
      return payload();
    }
  });
  assert.deepEqual(seen, ["http://127.0.0.1:1/links"]);
});

test("describeUrl and archiveUrl are consistent", () => {
  const url = archiveUrl({ platform: platformOf("linux"), channel: "preview", version: "1.26.70.22" });
  assert.deepEqual(describeUrl(url), { version: "1.26.70.22", channel: "preview" });
  assert.equal(describeUrl("https://x/y/other.zip"), null);
});
