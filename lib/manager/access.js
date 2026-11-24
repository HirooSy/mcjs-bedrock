import fs from "fs";
import path from "path";
import { fileNames } from "../engine/paths.js";

const levels = Object.freeze({
  operators: "operator",
  members: "member",
  visitors: "visitor"
});

const readList = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeList = (file, list) => {
  const body = `${JSON.stringify(list, null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) {
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return true;
};

const toEntry = (value) => (typeof value === "string" ? { name: value } : value);

const mergeAllowlist = (list, entries) => {
  for (const entry of entries) {
    const existing = list.find((item) => String(item.name).toLowerCase() === entry.name.toLowerCase());
    if (existing) {
      if (entry.xuid) {
        existing.xuid = String(entry.xuid);
      }
      if (entry.ignoresPlayerLimit !== undefined) {
        existing.ignoresPlayerLimit = entry.ignoresPlayerLimit;
      }
    } else {
      const created = { ignoresPlayerLimit: entry.ignoresPlayerLimit ?? false, name: entry.name };
      if (entry.xuid) {
        created.xuid = String(entry.xuid);
      }
      list.push(created);
    }
  }
  return list;
};

const mergePermissions = (list, grants) => {
  for (const grant of grants) {
    const existing = list.find((item) => String(item.xuid) === grant.xuid);
    if (existing) {
      existing.permission = grant.permission;
    } else {
      list.push({ permission: grant.permission, xuid: grant.xuid });
    }
  }
  return list;
};

export const writeAccess = (directory, config) => {
  const result = { allowlist: 0, permissions: 0 };

  const entries = config.access.allowlist.map(toEntry);
  if (entries.length > 0) {
    const file = path.join(directory, fileNames.allowlist);
    writeList(file, mergeAllowlist(readList(file), entries));
    result.allowlist = entries.length;
  }

  const grants = Object.entries(levels).flatMap(([key, permission]) =>
    config.access[key].map((xuid) => ({ permission, xuid: String(xuid) }))
  );
  if (grants.length > 0) {
    const file = path.join(directory, fileNames.permissions);
    writeList(file, mergePermissions(readList(file), grants));
    result.permissions = grants.length;
  }

  return result;
};
