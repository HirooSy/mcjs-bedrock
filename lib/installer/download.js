import { spawn } from "child_process";
import fs from "fs";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

export class DownloadError extends Error {
  constructor(message, { status = 0, retryable = false, code = "" } = {}) {
    super(message);
    this.name = "DownloadError";
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

const profile = (name, headers) => Object.freeze({ name, headers: Object.freeze(headers) });

export const identities = Object.freeze([
  profile("browser", {
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    accept: "*/*",
    "accept-language": "*",
    "accept-encoding": "identity"
  }),
  profile("plain", {
    "user-agent": "Mozilla/5.0",
    "accept-language": "*",
    "accept-encoding": "identity"
  }),
  profile("named", {
    "user-agent": "mcjs/2.0",
    "accept-language": "*",
    "accept-encoding": "identity"
  })
]);

export const externalTools = Object.freeze([
  Object.freeze({
    name: "curl",
    command: "curl",
    args: ({ url, target, identity, connectTimeoutMs }) => [
      "-fsSL",
      "--http1.1",
      "--connect-timeout",
      String(Math.max(1, Math.ceil(connectTimeoutMs / 1000))),
      "-A",
      identity.headers["user-agent"],
      "-H",
      "Accept-Language: *",
      "-o",
      target,
      url
    ]
  }),
  Object.freeze({
    name: "wget",
    command: "wget",
    args: ({ url, target, identity, connectTimeoutMs }) => [
      "-q",
      "--tries=1",
      `--timeout=${Math.max(1, Math.ceil(connectTimeoutMs / 1000))}`,
      "-U",
      identity.headers["user-agent"],
      "--header=Accept-Language: *",
      "-O",
      target,
      url
    ]
  })
]);

const isRetryableStatus = (status) => status === 408 || status === 429 || status >= 500;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

export const hostOf = (url) => new URL(url).host;

export const describeError = (error) => {
  const cause = error?.cause;
  const detail = cause?.code ?? cause?.message ?? error?.code ?? error?.message ?? String(error);
  return String(detail);
};

export const withRetry = async ({ attempts, delayMs, task, onRetry }) => {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      failure = error;
      if (error.retryable === false || attempt === attempts) {
        break;
      }
      if (onRetry) {
        onRetry(error, attempt);
      }
      await pause(delayMs * attempt);
    }
  }
  throw failure;
};

const guard = (limits) => {
  const controller = new AbortController();
  const timers = { connect: null, stall: null, total: null };
  const fail = (message, code) => {
    controller.abort(new DownloadError(message, { retryable: true, code }));
  };
  const clear = () => {
    for (const key of Object.keys(timers)) {
      clearTimeout(timers[key]);
    }
  };
  const arm = (name, ms, message, code) => {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(() => fail(message, code), ms);
  };
  const rethrow = (error) => {
    if (controller.signal.aborted && controller.signal.reason instanceof DownloadError) {
      return controller.signal.reason;
    }
    if (error instanceof DownloadError) {
      return error;
    }
    return new DownloadError(`${limits.host}: ${describeError(error)}`, { retryable: true, code: "NETWORK" });
  };
  return { controller, arm, clear, rethrow, timers };
};

const openResponse = async ({ url, fetchImpl, headers, state }) => {
  const response = await fetchImpl(url, { headers, redirect: "follow", signal: state.controller.signal });
  clearTimeout(state.timers.connect);
  if (!response.ok) {
    if (response.body) {
      await response.body.cancel().catch(() => {});
    }
    throw new DownloadError(`${url} responded with status ${response.status}`, {
      status: response.status,
      retryable: isRetryableStatus(response.status),
      code: "STATUS"
    });
  }
  return response;
};

export const fetchJson = async ({ url, fetchImpl, headers, connectTimeoutMs }) => {
  const host = hostOf(url);
  const state = guard({ host });
  state.arm("total", connectTimeoutMs, `${host} did not answer within ${seconds(connectTimeoutMs)}`, "HEADER_TIMEOUT");
  try {
    const response = await openResponse({ url, fetchImpl, headers: { accept: "application/json", ...headers }, state });
    return await response.json();
  } catch (error) {
    throw state.rethrow(error);
  } finally {
    state.clear();
  }
};

export const downloadFile = async ({
  url,
  target,
  fetchImpl,
  headers,
  connectTimeoutMs,
  stallTimeoutMs,
  timeoutMs,
  onResponse,
  onProgress
}) => {
  const host = hostOf(url);
  const state = guard({ host });
  state.arm("total", timeoutMs, `download from ${host} exceeded ${seconds(timeoutMs)}`, "TOTAL_TIMEOUT");
  state.arm("connect", connectTimeoutMs, `${host} sent no response within ${seconds(connectTimeoutMs)}`, "HEADER_TIMEOUT");
  try {
    const response = await openResponse({ url, fetchImpl, headers, state });
    const encoded = response.headers.get("content-encoding");
    const expected = encoded ? 0 : Number(response.headers.get("content-length")) || 0;
    if (onResponse) {
      onResponse({ status: response.status, total: expected, encoded: encoded ?? null });
    }
    const rearm = () => state.arm("stall", stallTimeoutMs, `${host} sent no data for ${seconds(stallTimeoutMs)}`, "STALL");
    rearm();
    let received = 0;
    const meter = new Transform({
      transform(chunk, encoding, done) {
        received += chunk.length;
        rearm();
        if (onProgress) {
          onProgress(received, expected);
        }
        done(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(target), { signal: state.controller.signal });
    if (received === 0) {
      throw new DownloadError(`${host} returned an empty file`, { retryable: true, code: "EMPTY" });
    }
    if (expected > 0 && received !== expected) {
      throw new DownloadError(`incomplete download: received ${received} of ${expected} bytes`, { retryable: true, code: "SHORT" });
    }
    return received;
  } catch (error) {
    throw state.rethrow(error);
  } finally {
    state.clear();
  }
};

export const probeUrl = async ({ url, fetchImpl, headers, connectTimeoutMs, clock = Date.now }) => {
  const host = hostOf(url);
  const state = guard({ host });
  state.arm("total", connectTimeoutMs, `${host} sent no data within ${seconds(connectTimeoutMs)}`, "HEADER_TIMEOUT");
  const started = clock();
  try {
    const response = await openResponse({ url, fetchImpl, headers: { ...headers, range: "bytes=0-1023" }, state });
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => {});
    const range = response.headers.get("content-range");
    const total = range ? Number(range.split("/")[1]) || 0 : Number(response.headers.get("content-length")) || 0;
    return {
      status: response.status,
      ms: clock() - started,
      bytes: first.value ? first.value.length : 0,
      total,
      encoded: response.headers.get("content-encoding")
    };
  } catch (error) {
    throw state.rethrow(error);
  } finally {
    state.clear();
  }
};

export const runExternal = ({
  tool,
  url,
  target,
  identity,
  connectTimeoutMs,
  stallTimeoutMs,
  onProgress,
  spawnImpl = spawn,
  pollMs = 1000
}) =>
  new Promise((resolve, reject) => {
    const child = spawnImpl(tool.command, tool.args({ url, target, identity, connectTimeoutMs }), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let settled = false;
    let stderr = "";
    let size = 0;
    let poll = null;
    let lastGrowth = Date.now();
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else {
        resolve(value);
      }
    };
    poll = setInterval(() => {
      const current = fs.existsSync(target) ? fs.statSync(target).size : 0;
      if (current > size) {
        size = current;
        lastGrowth = Date.now();
        if (onProgress) {
          onProgress(size, 0);
        }
      }
      const allowed = size === 0 ? connectTimeoutMs + stallTimeoutMs : stallTimeoutMs;
      if (Date.now() - lastGrowth > allowed) {
        finish(new DownloadError(`${tool.name} made no progress for ${seconds(allowed)}`, { retryable: true, code: "STALL" }));
      }
    }, pollMs);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-400);
    });
    child.on("error", (error) => {
      finish(
        error.code === "ENOENT"
          ? new DownloadError(`${tool.name} is not installed`, { code: "UNAVAILABLE" })
          : new DownloadError(`${tool.name}: ${error.message}`, { retryable: true })
      );
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        finish(new DownloadError(`${tool.name} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`, { retryable: true }));
        return;
      }
      const final = fs.existsSync(target) ? fs.statSync(target).size : 0;
      finish(final > 0 ? null : new DownloadError(`${tool.name} produced an empty file`, { retryable: true }), final);
    });
  });
