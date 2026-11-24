import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import {
  DownloadError,
  describeError,
  downloadFile,
  externalTools,
  fetchJson,
  identities,
  probeUrl,
  runExternal,
  withRetry
} from "../lib/installer/download.js";
import { createProgress, formatBytes } from "../lib/installer/progress.js";
import { sendBuffer, startServer } from "../testkit/http.js";
import { nativeOnly } from "../testkit/helpers.js";
import { workspace } from "../testkit/workspace.js";

const options = (directory, url, extra = {}) => ({
  url,
  target: path.join(directory, "file.bin"),
  fetchImpl: fetch,
  headers: { "user-agent": "mcjs-test" },
  connectTimeoutMs: 5000,
  stallTimeoutMs: 5000,
  timeoutMs: 10000,
  ...extra
});

test("a file is downloaded with progress and the request headers", async (t) => {
  const directory = workspace(t);
  const body = Buffer.alloc(200000, 7);
  const { origin, hits } = await startServer(t, (request, response) => sendBuffer(response, body));
  const progress = [];
  const responses = [];
  const bytes = await downloadFile(
    options(directory, `${origin}/a.zip`, {
      onProgress: (received, total) => progress.push([received, total]),
      onResponse: (info) => responses.push(info)
    })
  );
  assert.equal(bytes, body.length);
  assert.ok(fs.readFileSync(path.join(directory, "file.bin")).equals(body));
  assert.equal(hits[0].headers["user-agent"], "mcjs-test");
  assert.equal(progress.at(-1)[0], body.length);
  assert.equal(progress.at(-1)[1], body.length);
  assert.deepEqual(responses, [{ status: 200, total: body.length, encoded: null }]);
});

test("redirects are followed", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, (request, response) => {
    if (request.url === "/old") {
      response.writeHead(302, { location: "/new" });
      response.end();
      return;
    }
    sendBuffer(response, Buffer.from("payload"));
  });
  await downloadFile(options(directory, `${origin}/old`));
  assert.equal(fs.readFileSync(path.join(directory, "file.bin"), "utf8"), "payload");
});

test("a 404 is not retryable", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, (request, response) => {
    response.writeHead(404);
    response.end("missing");
  });
  await assert.rejects(downloadFile(options(directory, `${origin}/x`)), (error) => {
    assert.ok(error instanceof DownloadError);
    assert.equal(error.status, 404);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("server errors are marked retryable", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, (request, response) => {
    response.writeHead(503);
    response.end();
  });
  await assert.rejects(downloadFile(options(directory, `${origin}/x`)), (error) => error.retryable === true && error.status === 503);
});

test("a server that never answers fails fast with a clear header timeout", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, () => {});
  const started = Date.now();
  await assert.rejects(downloadFile(options(directory, `${origin}/x`, { connectTimeoutMs: 150 })), (error) => {
    assert.equal(error.code, "HEADER_TIMEOUT");
    assert.equal(error.retryable, true);
    assert.match(error.message, /sent no response within/);
    return true;
  });
  assert.ok(Date.now() - started < 2000);
});

test("data that stops flowing mid download is detected as a stall", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, (request, response) => {
    response.writeHead(200, { "content-length": 1000000 });
    response.write(Buffer.alloc(1000));
  });
  const started = Date.now();
  await assert.rejects(downloadFile(options(directory, `${origin}/x`, { stallTimeoutMs: 150 })), (error) => {
    assert.equal(error.code, "STALL");
    assert.match(error.message, /sent no data for/);
    return true;
  });
  assert.ok(Date.now() - started < 3000);
});

test("headers that arrive without any body are detected as a stall", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, (request, response) => {
    response.writeHead(200, { "content-length": 1000000 });
    response.flushHeaders();
  });
  const started = Date.now();
  await assert.rejects(downloadFile(options(directory, `${origin}/x`, { stallTimeoutMs: 150 })), (error) => {
    assert.equal(error.code, "STALL");
    assert.match(error.message, /sent no data for/);
    return true;
  });
  assert.ok(Date.now() - started < 3000);
});

test("the overall limit stops a download that keeps trickling", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, (request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write("x"), 20);
    response.on("close", () => clearInterval(timer));
  });
  await assert.rejects(downloadFile(options(directory, `${origin}/x`, { timeoutMs: 300, stallTimeoutMs: 5000 })), (error) => error.code === "TOTAL_TIMEOUT");
});

test("a body shorter than content-length is reported", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, (request, response) => {
    response.writeHead(200, { "content-length": 1000 });
    response.write("short");
    response.destroy();
  });
  await assert.rejects(downloadFile(options(directory, `${origin}/x`)), (error) => error.retryable === true);
});

test("an empty body is an error and an unannounced size still downloads", async (t) => {
  const directory = workspace(t);
  const { origin } = await startServer(t, (request, response) => {
    if (request.url === "/empty") {
      response.writeHead(200, { "content-length": 0 });
      response.end();
      return;
    }
    response.writeHead(200);
    response.write("chunk one ");
    response.end("chunk two");
  });
  await assert.rejects(downloadFile(options(directory, `${origin}/empty`)), (error) => error.code === "EMPTY");
  const responses = [];
  await downloadFile(options(directory, `${origin}/chunked`, { onResponse: (info) => responses.push(info) }));
  assert.equal(fs.readFileSync(path.join(directory, "file.bin"), "utf8"), "chunk one chunk two");
  assert.equal(responses[0].total, 0);
});

test("a refused connection becomes a readable retryable error", async (t) => {
  const directory = workspace(t);
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(downloadFile(options(directory, `http://127.0.0.1:${port}/x`)), (error) => {
    assert.ok(error instanceof DownloadError);
    assert.equal(error.retryable, true);
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}: ECONNREFUSED`));
    return true;
  });
});

test("fetchJson parses a payload and rejects invalid bodies and silent servers", async (t) => {
  const { origin } = await startServer(t, (request, response) => {
    if (request.url === "/silent") {
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/ok" ? '{"result":{"links":[]}}' : "<html>");
  });
  const base = { fetchImpl: fetch, headers: {}, connectTimeoutMs: 5000 };
  assert.deepEqual(await fetchJson({ ...base, url: `${origin}/ok` }), { result: { links: [] } });
  await assert.rejects(fetchJson({ ...base, url: `${origin}/bad` }), (error) => error.retryable === true);
  await assert.rejects(fetchJson({ ...base, url: `${origin}/silent`, connectTimeoutMs: 120 }), (error) => error.code === "HEADER_TIMEOUT");
});

test("every identity asks for an uncompressed body and none looks like a bot", () => {
  assert.equal(identities.length, 3);
  for (const identity of identities) {
    assert.equal(identity.headers["accept-encoding"], "identity");
    assert.equal(identity.headers["accept-language"], "*");
    assert.equal(/compatible|bot|curl|wget|node/i.test(identity.headers["user-agent"]), false, identity.name);
  }
  assert.equal(new Set(identities.map((identity) => identity.headers["user-agent"])).size, 3);
});

test("the identity headers actually reach the server", async (t) => {
  const directory = workspace(t);
  const { origin, hits } = await startServer(t, (request, response) => sendBuffer(response, Buffer.from("ok")));
  await downloadFile(options(directory, `${origin}/x`, { headers: identities[1].headers }));
  assert.equal(hits[0].headers["user-agent"], "Mozilla/5.0");
  assert.equal(hits[0].headers["accept-encoding"], "identity");
});

test("probeUrl reads the first bytes with a range request and reports timings", async (t) => {
  const { origin, hits } = await startServer(t, (request, response) => {
    response.writeHead(206, { "content-range": "bytes 0-1023/5000000", "content-length": 1024 });
    response.end(Buffer.alloc(1024));
  });
  const result = await probeUrl({ url: `${origin}/x`, fetchImpl: fetch, headers: identities[0].headers, connectTimeoutMs: 2000 });
  assert.equal(result.status, 206);
  assert.equal(result.total, 5000000);
  assert.ok(result.bytes > 0);
  assert.equal(hits[0].headers.range, "bytes=0-1023");
  const silent = await startServer(t, () => {});
  await assert.rejects(probeUrl({ url: `${silent.origin}/x`, fetchImpl: fetch, headers: {}, connectTimeoutMs: 100 }), (error) => error.code === "HEADER_TIMEOUT");
});

test("describeError digs out the useful part of a failure", () => {
  assert.equal(describeError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), "ENOTFOUND");
  assert.equal(describeError(new Error("plain")), "plain");
  assert.equal(describeError("text"), "text");
});

test("withRetry retries until the task succeeds", async () => {
  let attempts = 0;
  const notes = [];
  const result = await withRetry({
    attempts: 3,
    delayMs: 1,
    onRetry: (error, attempt) => notes.push([error.message, attempt]),
    task: async (attempt) => {
      attempts += 1;
      if (attempt < 3) {
        throw new Error(`fail ${attempt}`);
      }
      return "done";
    }
  });
  assert.equal(result, "done");
  assert.equal(attempts, 3);
  assert.deepEqual(notes, [["fail 1", 1], ["fail 2", 2]]);
});

test("withRetry gives up after the last attempt and surfaces the last error", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry({
      attempts: 2,
      delayMs: 1,
      task: async () => {
        attempts += 1;
        throw new Error(`fail ${attempts}`);
      }
    }),
    /fail 2/
  );
  assert.equal(attempts, 2);
});

test("withRetry stops immediately on a non-retryable error", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry({
      attempts: 5,
      delayMs: 1,
      task: async () => {
        attempts += 1;
        throw new DownloadError("gone", { status: 404, retryable: false });
      }
    }),
    /gone/
  );
  assert.equal(attempts, 1);
});

test("progress lines are throttled and show percentage, rate and totals", () => {
  const lines = [];
  let now = 1000000;
  const progress = createProgress({ log: (line) => lines.push(line), label: "get", intervalMs: 2000, clock: () => now });
  progress.update(1048576, 10485760);
  now += 500;
  progress.update(2097152, 10485760);
  now += 2000;
  progress.update(5242880, 10485760);
  now += 100;
  progress.finish(10485760);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^get: 1\.0 MB of 10\.0 MB \(10%\) at .*\/s$/);
  assert.match(lines[1], /^get: 5\.0 MB of 10\.0 MB \(50%\)/);
  assert.match(lines[2], /^get: finished 10\.0 MB in 2\.6s$/);
});

test("progress without a known total still reports bytes", () => {
  const lines = [];
  const progress = createProgress({ log: (line) => lines.push(line), label: "get", clock: () => 5000 });
  progress.update(3 * 1048576, 0);
  assert.match(lines[0], /^get: 3\.0 MB at /);
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(0), "0 KB");
});

const stubTool = (directory, body) => {
  const script = path.join(directory, "tool.mjs");
  fs.writeFileSync(script, body);
  return {
    name: "stub",
    command: process.execPath,
    args: ({ url, target }) => [script, url, target]
  };
};

test("an external tool downloads the file and reports growth", nativeOnly(), async (t) => {
  const directory = workspace(t);
  const tool = stubTool(
    directory,
    `import fs from "node:fs"; fs.writeFileSync(process.argv[3], "part"); setTimeout(() => { fs.appendFileSync(process.argv[3], "ial"); }, 250);`
  );
  const sizes = [];
  const target = path.join(directory, "out.bin");
  const bytes = await runExternal({
    tool,
    url: "http://example.invalid/x",
    target,
    identity: identities[0],
    connectTimeoutMs: 1000,
    stallTimeoutMs: 1000,
    pollMs: 40,
    onProgress: (size) => sizes.push(size)
  });
  assert.equal(bytes, 7);
  assert.equal(fs.readFileSync(target, "utf8"), "partial");
  assert.ok(sizes.length >= 1);
});

test("an external tool that fails, stalls or is missing produces a clear error", nativeOnly(), async (t) => {
  const directory = workspace(t);
  const target = path.join(directory, "out.bin");
  const common = { url: "http://example.invalid/x", target, identity: identities[0], connectTimeoutMs: 100, stallTimeoutMs: 100, pollMs: 20 };
  const failing = stubTool(directory, `process.stderr.write("denied"); process.exit(22);`);
  await assert.rejects(runExternal({ ...common, tool: failing }), /stub exited with code 22: denied/);
  const hanging = stubTool(directory, `setTimeout(() => {}, 60000);`);
  await assert.rejects(runExternal({ ...common, tool: hanging }), (error) => error.code === "STALL");
  const empty = stubTool(directory, `process.exit(0);`);
  await assert.rejects(runExternal({ ...common, tool: empty }), /empty file/);
  const missing = { name: "ghost", command: path.join(directory, "no-such-tool"), args: () => [] };
  await assert.rejects(runExternal({ ...common, tool: missing }), (error) => error.code === "UNAVAILABLE" && /not installed/.test(error.message));
});

test("the built in external tools pass the identity and the url", () => {
  const settings = { url: "https://host/file.zip", target: "/tmp/out.zip", identity: identities[1], connectTimeoutMs: 20000 };
  const [curl, wget] = externalTools;
  const curlArgs = curl.args(settings);
  assert.equal(curlArgs[curlArgs.indexOf("-A") + 1], "Mozilla/5.0");
  assert.ok(curlArgs.includes("--http1.1"));
  assert.equal(curlArgs[curlArgs.indexOf("--connect-timeout") + 1], "20");
  assert.equal(curlArgs.at(-1), "https://host/file.zip");
  const wgetArgs = wget.args(settings);
  assert.ok(wgetArgs.includes("--timeout=20"));
  assert.equal(wgetArgs[wgetArgs.indexOf("-U") + 1], "Mozilla/5.0");
  assert.equal(wgetArgs.at(-1), "https://host/file.zip");
});

test("a flaky server succeeds through the retry wrapper", async (t) => {
  const directory = workspace(t);
  const { origin, hits } = await startServer(t, (request, response, count) => {
    if (count < 3) {
      response.writeHead(500);
      response.end();
      return;
    }
    sendBuffer(response, Buffer.from("finally"));
  });
  await withRetry({ attempts: 3, delayMs: 1, task: () => downloadFile(options(directory, `${origin}/x`)) });
  assert.equal(hits.length, 3);
  assert.equal(fs.readFileSync(path.join(directory, "file.bin"), "utf8"), "finally");
});
