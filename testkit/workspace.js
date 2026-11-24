import fs from "fs";
import os from "os";
import path from "path";

export const workspace = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcjs-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
};

export const writeFiles = (directory, files) => {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return directory;
};

export const listTree = (directory) => {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(path.relative(directory, full).split(path.sep).join("/"));
      }
    }
  };
  walk(directory);
  return found.sort();
};

export const waitFor = async (predicate, { timeoutMs = 5000, stepMs = 10, label = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${label}`);
};
