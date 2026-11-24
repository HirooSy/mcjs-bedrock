import fs from "fs";
import path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import zlib from "zlib";
import { checksum } from "./crc.js";

const signatures = Object.freeze({
  end: 0x06054b50,
  central: 0x02014b50,
  local: 0x04034b50
});

const sizes = Object.freeze({
  endRecord: 22,
  centralHeader: 46,
  localHeader: 30,
  maxComment: 65535
});

const limits = Object.freeze({
  short: 0xffff,
  long: 0xffffffff
});

const methods = Object.freeze({
  stored: 0,
  deflated: 8
});

const kinds = Object.freeze({
  mask: 0o170000,
  symlink: 0o120000,
  unixHost: 3
});

const readRange = (fd, position, length) => {
  const buffer = Buffer.alloc(length);
  const bytes = fs.readSync(fd, buffer, 0, length, position);
  if (bytes !== length) {
    throw new Error("zip archive is truncated");
  }
  return buffer;
};

const findEnd = (tail) => {
  for (let at = tail.length - sizes.endRecord; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) === signatures.end) {
      return at;
    }
  }
  return -1;
};

export const readEntries = (file) => {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < sizes.endRecord) {
      throw new Error("not a zip archive");
    }
    const tailLength = Math.min(size, sizes.endRecord + sizes.maxComment);
    const tail = readRange(fd, size - tailLength, tailLength);
    const at = findEnd(tail);
    if (at < 0) {
      throw new Error("not a zip archive: end of central directory not found");
    }
    const total = tail.readUInt16LE(at + 10);
    const directorySize = tail.readUInt32LE(at + 12);
    const directoryOffset = tail.readUInt32LE(at + 16);
    if (total === limits.short || directorySize === limits.long || directoryOffset === limits.long) {
      throw new Error("zip64 archives are not supported");
    }
    const directory = readRange(fd, directoryOffset, directorySize);
    const entries = [];
    let cursor = 0;
    for (let index = 0; index < total; index += 1) {
      if (cursor + sizes.centralHeader > directory.length || directory.readUInt32LE(cursor) !== signatures.central) {
        throw new Error("zip central directory is corrupt");
      }
      const madeBy = directory.readUInt16LE(cursor + 4);
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const crc = directory.readUInt32LE(cursor + 16);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const attributes = directory.readUInt32LE(cursor + 38);
      const offset = directory.readUInt32LE(cursor + 42);
      const name = directory.toString("utf8", cursor + sizes.centralHeader, cursor + sizes.centralHeader + nameLength);
      const unix = madeBy >> 8 === kinds.unixHost;
      const mode = unix ? attributes >>> 16 : 0;
      entries.push({
        name,
        method,
        encrypted: (flags & 1) === 1,
        crc,
        compressedSize,
        size: uncompressedSize,
        offset,
        mode: mode & 0o7777,
        directory: name.endsWith("/"),
        symlink: unix && (mode & kinds.mask) === kinds.symlink
      });
      cursor += sizes.centralHeader + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
};

export const resolveEntryPath = (root, name) => {
  const normalized = name.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  const absolute = normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized);
  if (absolute || segments.includes("..") || segments.some((segment) => segment.includes("\0"))) {
    throw new Error(`unsafe path in archive: ${name}`);
  }
  const target = path.join(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`unsafe path in archive: ${name}`);
  }
  return target;
};

const locateData = (fd, entry) => {
  const header = readRange(fd, entry.offset, sizes.localHeader);
  if (header.readUInt32LE(0) !== signatures.local) {
    throw new Error(`zip local header is corrupt for ${entry.name}`);
  }
  return entry.offset + sizes.localHeader + header.readUInt16LE(26) + header.readUInt16LE(28);
};

const verifier = (entry) => {
  let crc = 0;
  let bytes = 0;
  return new Transform({
    transform(chunk, encoding, done) {
      crc = checksum(crc, chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
    flush(done) {
      if (bytes !== entry.size || crc !== entry.crc) {
        done(new Error(`corrupt archive entry: ${entry.name}`));
        return;
      }
      done();
    }
  });
};

const extractEntry = async (file, entry, target) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (entry.size === 0 && entry.compressedSize === 0) {
    if (entry.crc !== 0) {
      throw new Error(`corrupt archive entry: ${entry.name}`);
    }
    fs.writeFileSync(target, "");
    return;
  }
  const fd = fs.openSync(file, "r");
  let start;
  try {
    start = locateData(fd, entry);
  } finally {
    fs.closeSync(fd);
  }
  const stages = [fs.createReadStream(file, { start, end: start + entry.compressedSize - 1 })];
  if (entry.method === methods.deflated) {
    stages.push(zlib.createInflateRaw());
  }
  stages.push(verifier(entry), fs.createWriteStream(target));
  await pipeline(...stages);
};

export const extractArchive = async (file, destination) => {
  const entries = readEntries(file);
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  const result = { files: 0, bytes: 0, skipped: 0 };
  for (const entry of entries) {
    const target = resolveEntryPath(root, entry.name);
    if (entry.encrypted) {
      throw new Error(`encrypted archive entries are not supported: ${entry.name}`);
    }
    if (entry.directory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (entry.symlink) {
      result.skipped += 1;
      continue;
    }
    if (entry.method !== methods.stored && entry.method !== methods.deflated) {
      throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
    }
    await extractEntry(file, entry, target);
    if (process.platform !== "win32" && entry.mode > 0) {
      fs.chmodSync(target, (entry.mode & 0o777) | 0o600);
    }
    result.files += 1;
    result.bytes += entry.size;
  }
  return result;
};
