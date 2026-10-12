import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Minimal zip writer/reader for tests: builds real jars (stored or deflated entries, optional
 * duplicates / corrupt CRCs) and reads them the way `jar.readEntries` must — the central directory
 * is authoritative (agent-protocol.md "Extension scans").
 */

export interface ZipEntryInput {
  name: string;
  data: string | Buffer;
  method?: "store" | "deflate";
  /** Store a wrong CRC-32 in the headers (a CRC mismatch must be detected when the entry is read). */
  corruptCrc?: boolean;
  /** Compression method id written to the headers (e.g. 12 = bzip2, unsupported). */
  rawMethod?: number;
  /** General-purpose flag bits (bit 0 = encrypted). */
  flags?: number;
}

export function makeZip(entries: readonly ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.rawMethod ?? (e.method === "store" ? 0 : 8);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = (crc32(raw) ^ (e.corruptCrc ? 0xffffffff : 0)) >>> 0;
    const name = Buffer.from(e.name, "utf8");
    const flags = (e.flags ?? 0) | 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A jar with the given metadata files (path in the jar → text) plus a class file. */
export function makeJar(files: Record<string, string>, extra: readonly ZipEntryInput[] = []): Buffer {
  return makeZip([
    { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\n\r\n" },
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
    { name: "com/example/Main.class", data: Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]) },
    ...extra,
  ]);
}

export class ZipFormatError extends Error {}
export class ZipLimitError extends Error {}

export interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Reads the central directory (bounded like `JAR_READ_LIMITS`). */
export function readCentralDirectory(buf: Buffer, limits: { maxRecords: number; maxBytes: number }): CentralEntry[] {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > limits.maxRecords || cdSize > limits.maxBytes) throw new ZipLimitError("central directory too large");
  if (cdOffset + cdSize > eocd) throw new ZipFormatError("central directory out of bounds");
  const out: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipFormatError("bad central directory record");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Decompresses up to `maxBytes` of an entry; a CRC mismatch on a fully read entry is a format error. */
export function readEntry(buf: Buffer, e: CentralEntry, maxBytes: number): { data: Buffer; truncated: boolean } {
  if (e.flags & 1) throw new ZipFormatError("encrypted entry");
  if (e.method !== 0 && e.method !== 8) throw new ZipFormatError("unsupported compression method");
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new ZipFormatError("bad local header");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const body = buf.subarray(start, start + e.compressedSize);
  if (body.length !== e.compressedSize) throw new ZipFormatError("truncated entry data");
  let data: Buffer;
  try {
    data = e.method === 8 ? inflateRawSync(body) : Buffer.from(body);
  } catch {
    throw new ZipFormatError("malformed deflate data");
  }
  const truncated = data.length > maxBytes;
  if (!truncated && (data.length !== e.size || (crc32(data) >>> 0) !== e.crc)) throw new ZipFormatError("size or CRC mismatch");
  return { data: truncated ? data.subarray(0, maxBytes) : data, truncated };
}
