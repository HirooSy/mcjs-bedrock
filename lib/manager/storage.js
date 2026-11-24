import fs from "fs";
import path from "path";

const names = Object.freeze({
  folder: "mcjs-plugins",
  pattern: /^[a-z][a-z0-9_]*$/
});

export const createStorage = (directory, name) => {
  if (typeof name !== "string" || !names.pattern.test(name)) {
    throw new Error("storage name must use lowercase letters, digits and underscores");
  }
  const file = path.join(directory, names.folder, `${name}.json`);
  return Object.freeze({
    read: () => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    },
    write: (data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
      fs.renameSync(temporary, file);
    }
  });
};
