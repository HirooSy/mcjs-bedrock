import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, classifyConstant, topLevelConstants } from "../testkit/source.js";

const projectRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const collect = (directory, extensions) => {
  const found = [];
  const skip = ["node_modules", "data", "backups", ".git"];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skip.includes(entry.name)) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collect(full, extensions));
    } else if (extensions.includes(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found.sort();
};

const sources = () => collect(projectRoot(), [".js"]).map((file) => ({ file: path.relative(projectRoot(), file), text: fs.readFileSync(file, "utf8") }));

const documents = () =>
  collect(projectRoot(), [".js", ".json", ".md"]).map((file) => ({
    file: path.relative(projectRoot(), file),
    text: fs.readFileSync(file, "utf8")
  }));

test("the project contains source files to check", () => {
  assert.ok(sources().length > 40);
});

test("no source file contains a comment except the shipped config", () => {
  const offenders = sources().filter(({ file }) => file !== "config.js").flatMap(({ file, text }) => analyze(text).comments.map((comment) => `${file}:${comment.line} ${comment.text}`));
  assert.deepEqual(offenders, []);
});

test("no file contains an emoji or pictograph", () => {
  const offenders = documents().filter(({ text }) => /\p{Extended_Pictographic}/u.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("no constant is declared in full uppercase", () => {
  const offenders = sources().flatMap(({ file, text }) => {
    const { code } = analyze(text);
    return [...code.matchAll(/\b(?:const|let|var)\s+([A-Z][A-Z0-9_]+)\b/g)].map((match) => `${file} ${match[1]}`);
  });
  assert.deepEqual(offenders, []);
});

test("module level constants are definitions or groups of at least two values", () => {
  const offenders = sources().flatMap(({ file, text }) => {
    const { code } = analyze(text);
    return topLevelConstants(code).flatMap((constant) => {
      const kind = classifyConstant(constant.init);
      if (kind.kind === "definition" || (kind.kind === "group" && kind.members >= 2)) {
        return [];
      }
      return [`${file}:${constant.line} ${constant.name} = ${constant.init.slice(0, 60)}`];
    });
  });
  assert.deepEqual(offenders, []);
});

test("the analyzer itself recognises each violation", () => {
  assert.equal(analyze("const a = 1; // note").comments.length, 1);
  assert.equal(analyze("/* block */ const a = 1;").comments.length, 1);
  assert.equal(analyze('const a = "// not a comment";').comments.length, 0);
  assert.equal(analyze("const a = /\\/\\//;").comments.length, 0);
  assert.equal(analyze("const a = `${`//`}`;").comments.length, 0);
  assert.equal(classifyConstant("5").kind, "value");
  assert.equal(classifyConstant("/r/").kind, "value");
  assert.equal(classifyConstant("Object.freeze({ one: 1 })").members, 1);
  assert.equal(classifyConstant("Object.freeze({ a: 1, b: 2 })").members, 2);
  assert.equal(classifyConstant("Object.freeze([1, 2, 3])").members, 3);
  assert.equal(classifyConstant("(value) => value").kind, "definition");
  assert.equal(classifyConstant("async () => {}").kind, "definition");
  assert.equal(classifyConstant("class A {}").kind, "definition");
  assert.equal(classifyConstant('(root, file = "") => { return 1; }').kind, "definition");
  assert.equal(classifyConstant("({ a = fetch, b = () => 1 }) => {}").kind, "definition");
  assert.equal(classifyConstant("(() => { return () => 1; })()").kind, "definition");
  assert.equal(classifyConstant("Object.freeze({ run: () => 1 })").members, 1);
  assert.equal(classifyConstant("new Set([1])").kind, "value");
  const found = topLevelConstants(analyze('const A = 1;\nexport const b = Object.freeze({ x: 1 });').code);
  assert.deepEqual(found.map((item) => item.name), ["A", "b"]);
});

test("the data folder is not part of the project and is ignored by git", () => {
  assert.equal(fs.existsSync(path.join(projectRoot(), "data")), false);
  assert.equal(fs.existsSync(path.join(projectRoot(), "backups")), false);
  const ignored = fs.readFileSync(path.join(projectRoot(), ".gitignore"), "utf8").split("\n");
  assert.ok(ignored.includes("data/"));
  assert.ok(ignored.includes("backups/"));
});

test("the project has no runtime dependencies", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies, {});
  assert.equal(manifest.type, "module");
});
