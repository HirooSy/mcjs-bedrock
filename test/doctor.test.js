import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/engine/config.js";
import { diagnose, formatReport } from "../lib/installer/doctor.js";
import { createScenario } from "../testkit/scenario.js";
import { workspace } from "../testkit/workspace.js";

const healthy = () => ({ hasTool: () => true, libraries: () => "libcurl.so.4 => /usr/lib/libcurl.so.4" });

const lookupOk = async () => [{ address: "20.1.2.3", family: 4 }, { address: "2603::1", family: 6 }];

const run = async (t, { config = {}, tarpit = null, apiDown = false, ...extra } = {}) => {
  const s = await createScenario(t);
  if (tarpit) {
    s.behavior.tarpit = tarpit;
  }
  if (apiDown) {
    s.behavior.apiFailures = 99;
  }
  const resolved = s.config({ install: { connectTimeoutMs: 200, stallTimeoutMs: 200 }, ...config });
  const report = await diagnose({
    config: resolved,
    root: s.root,
    env: {},
    fetchImpl: fetch,
    lookup: lookupOk,
    tmpRoot: s.tmpRoot,
    apiUrl: `${s.origin}/api`,
    filesUrl: s.origin,
    probes: healthy(),
    ...extra
  });
  return { s, report, byName: (name) => report.checks.find((entry) => entry.name === name) };
};

test("a healthy environment passes every check", async (t) => {
  const { report, byName } = await run(t);
  assert.equal(report.failed, 0);
  assert.equal(byName("runtime").status, "ok");
  assert.match(byName("download api").detail, /release 1\.26\.61\.1 at http:\/\/127\.0\.0\.1:\d+\/bin-linux\//);
  for (const name of ["download browser", "download plain", "download named"]) {
    assert.equal(byName(name).status, "ok", name);
    assert.match(byName(name).detail, /status 200, first bytes after \d+ms, .* KB|MB/);
  }
  assert.equal(byName("tool curl").status, "ok");
  assert.equal(byName("libcurl4").status, "ok");
  const dns = report.checks.filter((entry) => entry.name.startsWith("dns "));
  assert.ok(dns.length >= 1);
  assert.ok(dns.every((entry) => entry.status === "ok" && entry.detail === "20.1.2.3, 2603::1"));
});

test("doctor never creates the data folder", async (t) => {
  const { s } = await run(t);
  assert.equal(fs.existsSync(s.dataDir()), false);
});

test("an identity that the host ignores is reported while the others pass", async (t) => {
  const { report, byName } = await run(t, { tarpit: (headers) => headers["user-agent"] === "Mozilla/5.0" });
  assert.equal(byName("download browser").status, "ok");
  assert.equal(byName("download plain").status, "fail");
  assert.match(byName("download plain").detail, /sent no data within/);
  assert.equal(byName("download named").status, "ok");
  assert.equal(report.checks.some((entry) => entry.name === "download verdict"), false);
  assert.equal(report.failed, 1);
});

test("a host that ignores every identity produces a verdict with advice", async (t) => {
  const { report, byName } = await run(t, { tarpit: () => true });
  assert.equal(byName("download verdict").status, "fail");
  assert.match(byName("download verdict").detail, /did not answer any identity from this network.*server\.downloadUrl/);
  assert.equal(report.failed, 4);
});

test("an unreachable api is a failure and skips the download probes", async (t) => {
  const { report, byName } = await run(t, { apiDown: true });
  assert.equal(byName("download api").status, "fail");
  assert.equal(report.checks.some((entry) => entry.name.startsWith("download ") && entry.name !== "download api"), false);
});

test("dns failures are reported per host", async (t) => {
  const { byName, report } = await run(t, {
    lookup: async (host) => {
      throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    }
  });
  const dns = report.checks.filter((entry) => entry.name.startsWith("dns "));
  assert.ok(dns.length >= 1);
  assert.ok(dns.every((entry) => entry.status === "fail" && /ENOTFOUND/.test(entry.detail)));
  assert.equal(byName("runtime").status, "ok");
});

test("an unsupported platform and an old node are blocking, arm is only a warning", async (t) => {
  const mac = await run(t, { platform: "darwin" });
  assert.equal(mac.byName("runtime").status, "fail");
  assert.match(mac.byName("runtime").detail, /darwin is not supported/);
  assert.equal(mac.report.checks.some((entry) => entry.name === "download api"), false);
  const old = await run(t, { nodeVersion: "v16.20.0" });
  assert.match(old.byName("runtime").detail, /too old/);
  const arm = await run(t, { arch: "arm64" });
  assert.equal(arm.byName("runtime").status, "warn");
  assert.match(arm.byName("runtime").detail, /only built for x64/);
});

test("the listening port and its source are shown, including the panel allocation", async (t) => {
  const plain = await run(t);
  assert.match(plain.byName("network").detail, /UDP 19132 \(from default\)/);
  const panel = await run(t, { env: { SERVER_PORT: "5497", SERVER_IP: "93.177.64.145" } });
  assert.match(panel.byName("network").detail, /UDP 5497 \(from SERVER_PORT\), address 93\.177\.64\.145/);
});

test("missing fallback tools and libcurl are warnings, not failures", async (t) => {
  const { report, byName } = await run(t, { probes: { hasTool: () => false, libraries: () => "" } });
  assert.equal(byName("tool curl").status, "warn");
  assert.equal(byName("tool wget").status, "warn");
  assert.equal(byName("libcurl4").status, "warn");
  assert.match(byName("libcurl4").detail, /needs libcurl4/);
  assert.equal(report.failed, 0);
});

test("an unwritable temp folder is a failure", async (t) => {
  const blocker = path.join(workspace(t), "file");
  fs.writeFileSync(blocker, "x");
  const { byName } = await run(t, { tmpRoot: path.join(blocker, "inside") });
  assert.equal(byName("temp folder").status, "fail");
  assert.match(byName("temp folder").detail, /not writable/);
});

test("a download url override is probed instead of the api", async (t) => {
  const s = await createScenario(t);
  const config = s.config({ server: { downloadUrl: `${s.origin}/custom/bedrock-server-1.26.40.1.zip` }, install: { connectTimeoutMs: 300 } });
  const report = await diagnose({ config, root: s.root, env: {}, lookup: lookupOk, tmpRoot: s.tmpRoot, apiUrl: `${s.origin}/api`, filesUrl: s.origin, probes: healthy() });
  assert.match(report.checks.find((entry) => entry.name === "download api").detail, /1\.26\.40\.1/);
  assert.equal(s.apiRequests(), 0);
});

test("the report is aligned and ends with a summary", async (t) => {
  const { report } = await run(t);
  const text = formatReport(report);
  const lines = text.split("\n");
  assert.match(lines[0], /^\[ ok \] runtime /);
  assert.equal(lines.at(-1), "no blocking problems found");
  const failing = formatReport({ checks: [{ name: "a", status: "fail", detail: "x" }, { name: "bb", status: "warn", detail: "y" }], failed: 1 });
  assert.match(failing, /^\[FAIL\] a {3}x$/m);
  assert.match(failing, /^\[warn\] bb {2}y$/m);
  assert.match(failing, /1 blocking problem found$/);
  assert.match(formatReport({ checks: [{ name: "a", status: "fail", detail: "x" }], failed: 2 }), /2 blocking problems found$/);
});

test("the default configuration is accepted by the checker", async (t) => {
  const report = await diagnose({
    config: resolveConfig({}),
    root: workspace(t),
    env: {},
    lookup: lookupOk,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    probes: healthy()
  });
  assert.ok(report.checks.length >= 8);
  assert.equal(report.checks.find((entry) => entry.name === "download api").status, "fail");
});
