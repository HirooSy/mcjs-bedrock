import fs from "fs";
import path from "path";
import { fileNames } from "./paths.js";

export const readState = (directory) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, fileNames.state), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const writeState = (directory, patch) => {
  const next = { ...readState(directory), ...patch };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, fileNames.state), `${JSON.stringify(next, null, 2)}\n`);
  return next;
};
