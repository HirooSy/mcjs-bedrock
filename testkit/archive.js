import path from "path";
import { pathToFileURL } from "url";
import { fileURLToPath } from "url";
import { createZip } from "./zip.js";

export const fakeServerPath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-bedrock.js");

export const launcherSource = (args = []) =>
  `#!${process.execPath}\nprocess.argv.push(...${JSON.stringify(args)});\nimport(${JSON.stringify(pathToFileURL(fakeServerPath()).href)});\n`;

export const nativeBinary = () => (process.platform === "win32" ? "bedrock_server.exe" : "bedrock_server");

export const serverArchive = ({ binary = nativeBinary(), binaryData = null, marker = "release", args = [], extra = [] } = {}) =>
  createZip([
    { name: binary, data: binaryData ?? launcherSource(args), mode: 0o755 },
    { name: "server.properties", data: "server-name=Dedicated Server\n" },
    { name: "allowlist.json", data: "[]\n" },
    { name: "permissions.json", data: "[]\n" },
    { name: "release-notes.txt", data: `notes ${marker}\n` },
    { name: "config/", data: "" },
    { name: "config/default/permissions.json", data: '{"allowed_modules":["@minecraft/server"]}\n' },
    { name: "behavior_packs/vanilla/manifest.json", data: `{"vanilla":"${marker}"}\n` },
    { name: "resource_packs/vanilla/manifest.json", data: `{"vanilla":"${marker}"}\n` },
    ...extra
  ]);
