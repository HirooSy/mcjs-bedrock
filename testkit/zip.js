import zlib from "zlib";
import { checksum } from "../lib/installer/crc.js";

const toBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data)));

export const createZip = (entries, { comment = "" } = {}) => {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const directory = entry.name.endsWith("/");
    const raw = directory ? Buffer.alloc(0) : toBuffer(entry.data ?? "");
    const deflate = !directory && entry.deflate !== false && raw.length > 0;
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = entry.crc ?? checksum(0, raw);
    const method = deflate ? 8 : 0;
    const flags = entry.encrypted ? 1 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.windows ? 20 : (3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    const kind = entry.symlink ? 0o120000 : directory ? 0o040000 : 0o100000;
    const mode = entry.mode ?? (directory ? 0o755 : 0o644);
    header.writeUInt32LE(entry.windows ? 0 : ((kind | mode) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }

  const directoryBuffer = Buffer.concat(central);
  const note = Buffer.from(comment);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...chunks, directoryBuffer, end, note]);
};
