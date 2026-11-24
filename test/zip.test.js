import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { checksum } from "../lib/installer/crc.js";
import { extractArchive, readEntries, resolveEntryPath } from "../lib/installer/zip.js";
import { listTree, workspace } from "../testkit/workspace.js";
import { createZip } from "../testkit/zip.js";

const archiveOf = (t, entries, options) => {
  const directory = workspace(t);
  const file = path.join(directory, "test.zip");
  fs.writeFileSync(file, createZip(entries, options));
  return { directory, file, out: path.join(directory, "out") };
};

test("the checksum matches the reference implementation", () => {
  const sample = Buffer.from("The quick brown fox jumps over the lazy dog");
  assert.equal(checksum(0, sample), 0x414fa339);
  const random = Buffer.from(Array.from({ length: 5000 }, (_, index) => (index * 31 + 7) & 0xff));
  if (typeof zlib.crc32 === "function") {
    assert.equal(checksum(0, random), zlib.crc32(random));
  }
  assert.equal(checksum(checksum(0, random.subarray(0, 100)), random.subarray(100)), checksum(0, random));
});

test("stored and deflated entries are extracted byte for byte", async (t) => {
  const big = Buffer.from(Array.from({ length: 300000 }, (_, index) => (index * 7) % 251));
  const { file, out } = archiveOf(t, [
    { name: "plain.txt", data: "hello", deflate: false },
    { name: "text/compressed.txt", data: "abc".repeat(1000) },
    { name: "big.bin", data: big }
  ]);
  const result = await extractArchive(file, out);
  assert.equal(result.files, 3);
  assert.equal(fs.readFileSync(path.join(out, "plain.txt"), "utf8"), "hello");
  assert.equal(fs.readFileSync(path.join(out, "text/compressed.txt"), "utf8"), "abc".repeat(1000));
  assert.ok(fs.readFileSync(path.join(out, "big.bin")).equals(big));
});

test("directories and empty files are created", async (t) => {
  const { file, out } = archiveOf(t, [{ name: "empty-dir/" }, { name: "nested/empty.txt", data: "" }]);
  await extractArchive(file, out);
  assert.ok(fs.statSync(path.join(out, "empty-dir")).isDirectory());
  assert.equal(fs.statSync(path.join(out, "nested/empty.txt")).size, 0);
});

test("unix permission bits are applied", { skip: process.platform === "win32" }, async (t) => {
  const { file, out } = archiveOf(t, [
    { name: "run", data: "x", mode: 0o755 },
    { name: "data", data: "x", mode: 0o644 }
  ]);
  await extractArchive(file, out);
  assert.equal(fs.statSync(path.join(out, "run")).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(out, "data")).mode & 0o777, 0o644);
});

test("archives made on windows without unix modes are still extracted", async (t) => {
  const { file, out } = archiveOf(t, [{ name: "a.txt", data: "x", windows: true }]);
  await extractArchive(file, out);
  assert.equal(fs.readFileSync(path.join(out, "a.txt"), "utf8"), "x");
});

test("backslash separators are treated as folders", async (t) => {
  const { file, out } = archiveOf(t, [{ name: "dir\\file.txt", data: "x", windows: true }]);
  await extractArchive(file, out);
  assert.deepEqual(listTree(out), ["dir/file.txt"]);
});

test("symlink entries are skipped instead of written as files", async (t) => {
  const { file, out } = archiveOf(t, [
    { name: "link", data: "/etc/passwd", symlink: true },
    { name: "real.txt", data: "x" }
  ]);
  const result = await extractArchive(file, out);
  assert.equal(result.skipped, 1);
  assert.deepEqual(listTree(out), ["real.txt"]);
});

test("paths that escape the destination are rejected", async (t) => {
  for (const name of ["../evil.txt", "a/../../evil.txt", "/abs.txt", "C:/abs.txt", "..\\evil.txt"]) {
    const { file, out, directory } = archiveOf(t, [{ name, data: "x" }]);
    await assert.rejects(extractArchive(file, out), /unsafe path/, name);
    assert.equal(fs.existsSync(path.join(directory, "evil.txt")), false);
  }
});

test("resolveEntryPath keeps safe names inside the root", () => {
  const root = path.resolve("/tmp/root");
  assert.equal(resolveEntryPath(root, "a/b.txt"), path.join(root, "a", "b.txt"));
  assert.equal(resolveEntryPath(root, "./a//b.txt"), path.join(root, "a", "b.txt"));
  assert.equal(resolveEntryPath(root, "dir/"), path.join(root, "dir"));
  assert.throws(() => resolveEntryPath(root, "a/../../b"), /unsafe/);
});

test("a corrupted checksum is detected", async (t) => {
  const { file, out } = archiveOf(t, [{ name: "a.txt", data: "hello world", crc: 123 }]);
  await assert.rejects(extractArchive(file, out), /corrupt archive entry: a\.txt/);
});

test("flipped payload bytes are detected", async (t) => {
  const { file, out } = archiveOf(t, [{ name: "a.txt", data: "hello world", deflate: false }]);
  const bytes = fs.readFileSync(file);
  const at = bytes.indexOf("hello world");
  bytes[at] = bytes[at] ^ 0xff;
  fs.writeFileSync(file, bytes);
  await assert.rejects(extractArchive(file, out), /corrupt archive entry/);
});

test("encrypted entries are refused", async (t) => {
  const { file, out } = archiveOf(t, [{ name: "a.txt", data: "x", encrypted: true }]);
  await assert.rejects(extractArchive(file, out), /encrypted/);
});

test("files that are not zip archives are refused", async (t) => {
  const directory = workspace(t);
  const file = path.join(directory, "fake.zip");
  fs.writeFileSync(file, "this is not a zip file at all, just plain text of some length");
  await assert.rejects(extractArchive(file, path.join(directory, "out")), /not a zip archive/);
  fs.writeFileSync(file, "tiny");
  await assert.rejects(extractArchive(file, path.join(directory, "out")), /not a zip archive/);
});

test("a truncated archive is refused", async (t) => {
  const { file, out } = archiveOf(t, [{ name: "a.txt", data: "x".repeat(5000) }]);
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, bytes.subarray(0, bytes.length - 30));
  await assert.rejects(extractArchive(file, out));
});

test("an archive comment does not hide the central directory", async (t) => {
  const { file, out } = archiveOf(t, [{ name: "a.txt", data: "x" }], { comment: "built by a tool" });
  await extractArchive(file, out);
  assert.equal(fs.readFileSync(path.join(out, "a.txt"), "utf8"), "x");
});

test("an empty archive extracts to nothing", async (t) => {
  const { file, out } = archiveOf(t, []);
  const result = await extractArchive(file, out);
  assert.equal(result.files, 0);
});

test("readEntries lists names, sizes and modes", (t) => {
  const { file } = archiveOf(t, [{ name: "run", data: "abc", mode: 0o755 }, { name: "dir/" }]);
  const entries = readEntries(file);
  assert.deepEqual(entries.map((entry) => entry.name), ["run", "dir/"]);
  assert.equal(entries[0].size, 3);
  assert.equal(entries[0].mode & 0o777, 0o755);
  assert.equal(entries[1].directory, true);
});

const available = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status === 0;

const sampleTree = (directory) => {
  fs.mkdirSync(path.join(directory, "nested/deeper"), { recursive: true });
  fs.writeFileSync(path.join(directory, "random.bin"), Buffer.from(Array.from({ length: 200000 }, (_, index) => (index * 131 + 17) % 256)));
  fs.writeFileSync(path.join(directory, "text.txt"), "bedrock line\n".repeat(20000));
  fs.writeFileSync(path.join(directory, "empty"), "");
  fs.writeFileSync(path.join(directory, "nested/deeper/file.json"), '{"a":1}');
  fs.writeFileSync(path.join(directory, "run"), "#!/bin/sh\n");
  fs.chmodSync(path.join(directory, "run"), 0o755);
};

const sameTree = (left, right) => {
  const names = listTree(left);
  assert.deepEqual(listTree(right), names);
  for (const name of names) {
    assert.ok(fs.readFileSync(path.join(left, name)).equals(fs.readFileSync(path.join(right, name))), name);
  }
};

test("archives made by the zip command line tool extract identically", { skip: !available("zip", ["-v"]) }, async (t) => {
  const directory = workspace(t);
  const source = path.join(directory, "source");
  sampleTree(source);
  const archive = path.join(directory, "cli.zip");
  assert.equal(spawnSync("zip", ["-qr", archive, "."], { cwd: source }).status, 0);
  await extractArchive(archive, path.join(directory, "out"));
  sameTree(source, path.join(directory, "out"));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(directory, "out/run")).mode & 0o777, 0o755);
  }
});

test("archives made by python zipfile extract identically", { skip: !available("python3", ["-c", "import zipfile"]) }, async (t) => {
  const directory = workspace(t);
  const source = path.join(directory, "source");
  sampleTree(source);
  const archive = path.join(directory, "py.zip");
  const script = [
    "import os, sys, zipfile",
    "source, target = sys.argv[1], sys.argv[2]",
    "with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:",
    "    for root, dirs, files in os.walk(source):",
    "        for name in files:",
    "            full = os.path.join(root, name)",
    "            z.write(full, os.path.relpath(full, source))"
  ].join("\n");
  assert.equal(spawnSync("python3", ["-c", script, source, archive]).status, 0);
  await extractArchive(archive, path.join(directory, "out"));
  sameTree(source, path.join(directory, "out"));
});
