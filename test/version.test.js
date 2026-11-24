import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, engineOf, parseRequest, parseVersion } from "../lib/installer/version.js";

test("requests are classified by channel and pin", () => {
  assert.deepEqual(parseRequest("latest"), { channel: "release", pin: null });
  assert.deepEqual(parseRequest(" Preview "), { channel: "preview", pin: null });
  assert.deepEqual(parseRequest("1.26.61.1"), { channel: "release", pin: "1.26.61.1" });
  assert.deepEqual(parseRequest("1.26.70.22-PREVIEW"), { channel: "preview", pin: "1.26.70.22" });
  assert.deepEqual(parseRequest("1.26.61"), { channel: "release", pin: "1.26.61" });
});

test("invalid requests return null", () => {
  for (const text of ["", "1", "1.2", "1.2.3.4.5", "latest!", "1.2.x", "release"]) {
    assert.equal(parseRequest(text), null, text);
  }
});

test("versions are parsed into numbers", () => {
  assert.deepEqual(parseVersion("1.26.61.1"), [1, 26, 61, 1]);
  assert.equal(parseVersion("custom"), null);
  assert.equal(parseVersion(undefined), null);
});

test("the engine version keeps the first three parts", () => {
  assert.deepEqual(engineOf("1.26.61.1"), [1, 26, 61]);
  assert.deepEqual(engineOf("1.26.61"), [1, 26, 61]);
  assert.equal(engineOf("custom"), null);
  assert.equal(engineOf(null), null);
});

test("versions compare numerically, not lexically", () => {
  assert.equal(compareVersions("1.26.61.1", "1.26.61.1"), 0);
  assert.equal(compareVersions("1.26.100.0", "1.26.61.1"), 1);
  assert.equal(compareVersions("1.21.130.0", "1.26.0.25"), -1);
  assert.equal(compareVersions("1.26.61", "1.26.61.0"), 0);
});
