import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { freeSpace } from "../lib/installer/index.js";
import { identities } from "../lib/installer/download.js";
import { serverArchive } from "../testkit/archive.js";
import { nativeOnly } from "../testkit/helpers.js";
import { createScenario } from "../testkit/scenario.js";
import { workspace } from "../testkit/workspace.js";

const fast = () => ({ install: { retries: 3, connectTimeoutMs: 150, stallTimeoutMs: 150 } });

const copyingTool = (directory, archivePath) => {
  const script = path.join(directory, "copy-tool.mjs");
  fs.writeFileSync(script, `import fs from "node:fs"; fs.copyFileSync(${JSON.stringify(archivePath)}, process.argv[3]);`);
  return { name: "copytool", command: process.execPath, args: ({ url, target }) => [script, url, target] };
};

test("a host that ignores one identity is bypassed by the next one", async (t) => {
  const s = await createScenario(t);
  s.behavior.tarpit = (headers) => headers["user-agent"] === identities[0].headers["user-agent"];
  const result = await s.installer.ensure(s.config(fast()), s.root);
  assert.equal(result.changed, true);
  assert.deepEqual(s.agents, [identities[0].headers["user-agent"], identities[1].headers["user-agent"]]);
  assert.ok(s.has("warn", "download via node browser failed: 127.0.0.1"));
  assert.ok(s.has("warn", "sent no response within"));
  assert.ok(s.has("debug", "connecting to 127.0.0.1:"));
  assert.ok(fs.existsSync(path.join(s.dataDir(), "bedrock_server")));
  assert.deepEqual(s.tmpLeftovers(), []);
});

test("the third identity is reached when the first two are ignored", async (t) => {
  const s = await createScenario(t);
  s.behavior.tarpit = (headers) => headers["user-agent"] !== identities[2].headers["user-agent"];
  await s.installer.ensure(s.config(fast()), s.root);
  assert.equal(s.agents.length, 3);
  assert.equal(s.agents.at(-1), "mcjs/2.0");
});

test("a download that stalls halfway is retried and completes", async (t) => {
  const s = await createScenario(t);
  s.behavior.stallFirst = 1;
  const result = await s.installer.ensure(s.config(fast()), s.root);
  assert.equal(result.changed, true);
  assert.equal(s.zipRequests(), 2);
  assert.ok(s.has("warn", "sent no data for"));
});

test("the first download request uses the browser identity and never the bot style agent", async (t) => {
  const s = await createScenario(t);
  await s.installer.ensure(s.config(), s.root);
  assert.equal(s.agents[0], identities[0].headers["user-agent"]);
  assert.equal(/compatible|\+https?:/.test(s.agents[0]), false);
  const apiHit = s.hits.find((hit) => hit.url === "/api");
  assert.equal(apiHit.headers["accept-encoding"], "identity");
});

test("an external tool takes over when every node attempt is ignored", nativeOnly(), async (t) => {
  const tools = workspace(t);
  const archive = path.join(tools, "server.zip");
  fs.writeFileSync(archive, serverArchive());
  const s = await createScenario(t, { installerOptions: { tools: [copyingTool(tools, archive)] } });
  s.behavior.tarpit = () => true;
  const result = await s.installer.ensure(s.config({ install: { retries: 2, connectTimeoutMs: 120, stallTimeoutMs: 120, externalTools: true } }), s.root);
  assert.equal(result.changed, true);
  assert.equal(s.zipRequests(), 2);
  assert.ok(s.has("debug", "connecting to 127.0.0.1"));
  assert.ok(s.lines.some((line) => line.message.includes("(copytool)")));
  assert.ok(fs.existsSync(path.join(s.dataDir(), "bedrock_server")));
});

test("when every method fails the error lists each one and points to doctor", nativeOnly(), async (t) => {
  const missing = { name: "ghost", command: path.join(workspace(t), "no-such-tool"), args: () => [] };
  const s = await createScenario(t, { installerOptions: { tools: [missing] } });
  s.behavior.tarpit = () => true;
  await assert.rejects(
    s.installer.ensure(s.config({ install: { retries: 2, connectTimeoutMs: 100, stallTimeoutMs: 100, externalTools: true } }), s.root),
    (error) => {
      assert.match(error.message, /could not download .*bedrock-server-1\.26\.61\.1\.zip with any method/);
      assert.match(error.message, /- node browser: .*sent no response within/);
      assert.match(error.message, /- node plain: .*sent no response within/);
      assert.match(error.message, /- ghost: ghost is not installed/);
      assert.match(error.message, /node start\.js doctor/);
      return true;
    }
  );
  assert.equal(fs.existsSync(s.dataDir()), false);
  assert.deepEqual(s.tmpLeftovers(), []);
});

test("external tools are not used when they are disabled", async (t) => {
  const marker = { used: false };
  const tool = { name: "never", command: process.execPath, args: () => (marker.used = true) && [] };
  const s = await createScenario(t, { installerOptions: { tools: [tool] } });
  s.behavior.tarpit = () => true;
  await assert.rejects(s.installer.ensure(s.config({ install: { retries: 1, connectTimeoutMs: 100, externalTools: false } }), s.root));
  assert.equal(marker.used, false);
});

test("a missing version fails at once with a pointer to server.version", async (t) => {
  const s = await createScenario(t);
  s.behavior.zip = 404;
  await assert.rejects(s.installer.ensure(s.config({ server: { version: "1.26.1.1" } }), s.root), /1\.26\.1\.1 was not found at .*\(404\): check server\.version/);
  assert.equal(s.zipRequests(), 1);
  assert.equal(s.hits.length, 1);
});

test("an unreachable api on a fresh machine also points to doctor", async (t) => {
  const s = await createScenario(t);
  s.behavior.apiFailures = 10;
  await assert.rejects(s.installer.ensure(s.config(), s.root), /cannot find a server download: .*\nrun "node start\.js doctor"/);
});

test("the api lookup rotates identities too", async (t) => {
  const s = await createScenario(t);
  s.behavior.apiFailures = 1;
  await s.installer.ensure(s.config({ install: { retries: 3 } }), s.root);
  const apiAgents = s.hits.filter((hit) => hit.url === "/api").map((hit) => hit.headers["user-agent"]);
  assert.deepEqual(apiAgents.slice(0, 2), [identities[0].headers["user-agent"], identities[1].headers["user-agent"]]);
});

test("an unsupported cpu architecture is reported before installing", async (t) => {
  const s = await createScenario(t, { installerOptions: { arch: "arm64" } });
  await s.installer.ensure(s.config(), s.root);
  assert.ok(s.has("warn", "this machine is arm64, but Bedrock Dedicated Server is only built for x64"));
  const quiet = await createScenario(t);
  await quiet.installer.ensure(quiet.config(), quiet.root);
  assert.equal(quiet.lines.some((line) => line.message.includes("only built for x64")), false);
});

test("freeSpace reports a number for existing and not yet existing folders", (t) => {
  const directory = workspace(t);
  assert.ok(freeSpace(directory) > 0);
  assert.ok(freeSpace(path.join(directory, "not", "created", "yet")) > 0);
});

test("a custom temp directory is created and used", async (t) => {
  const s = await createScenario(t, { installerOptions: { tmpRoot: null } });
  const custom = path.join(workspace(t), "scratch", "nested");
  const result = await s.installer.ensure(s.config({ install: { tempDirectory: custom } }), s.root);
  assert.equal(result.changed, true);
  assert.ok(fs.existsSync(custom));
  assert.deepEqual(fs.readdirSync(custom), []);
});

test("an unusable temp directory fails with an actionable message and creates no data folder", async (t) => {
  const s = await createScenario(t, { installerOptions: { tmpRoot: null } });
  const blocker = path.join(workspace(t), "file");
  fs.writeFileSync(blocker, "x");
  await assert.rejects(
    s.installer.ensure(s.config({ install: { tempDirectory: path.join(blocker, "inside") } }), s.root),
    /cannot create a temporary folder in .*\(set install\.tempDirectory\)/
  );
  assert.equal(fs.existsSync(s.dataDir()), false);
});

test("a partial file from a failed attempt is never mistaken for a finished download", nativeOnly(), async (t) => {
  const noop = { name: "noop", command: process.execPath, args: () => ["-e", "process.exit(0)"] };
  const s = await createScenario(t, { installerOptions: { tools: [noop] } });
  s.behavior.stallFirst = 1;
  await assert.rejects(
    s.installer.ensure(s.config({ install: { retries: 1, connectTimeoutMs: 150, stallTimeoutMs: 150, externalTools: true } }), s.root),
    (error) => {
      assert.match(error.message, /- node browser: .*sent no data for/);
      assert.match(error.message, /- noop: noop produced an empty file/);
      return true;
    }
  );
  assert.equal(fs.existsSync(s.dataDir()), false);
});
