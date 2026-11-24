import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../lib/engine/logger.js";

const sink = () => {
  const seen = [];
  const push = (method) => (text) => seen.push([method, text]);
  return { seen, output: { log: push("log"), warn: push("warn"), error: push("error") } };
};

test("messages at or above the threshold are written with the level and no timestamp", () => {
  const { seen, output } = sink();
  const logger = createLogger("warn", output);
  logger.error("bad");
  logger.warn("careful");
  logger.info("hidden");
  logger.debug("hidden");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(([, text]) => text), ["[ error ] bad", "[ warn ] careful"]);
  assert.deepEqual(seen.map(([method]) => method), ["error", "warn"]);
});

test("debug level writes everything", () => {
  const { seen, output } = sink();
  const logger = createLogger("debug", output);
  logger.info("a");
  logger.debug("b");
  assert.deepEqual(seen.map(([method]) => method), ["log", "log"]);
});

test("an unknown level falls back to info", () => {
  const { seen, output } = sink();
  const logger = createLogger("nonsense", output);
  logger.info("shown");
  logger.debug("hidden");
  assert.equal(seen.length, 1);
});
