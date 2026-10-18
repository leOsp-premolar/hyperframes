import { closeSync, openSync, readFileSync, writeSync } from "node:fs";

// PNG frames are already compressed, so the archive stores them as they are: no deflate, no
// dependency. Classic ZIP only (no ZIP64), so an archive tops out at 65,535 entries and 4 GiB.
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** The name inside the archive, forward slashes. */
  name: string;
  /** The file on disk whose bytes it holds. */
  source: string;
}

function header(size: number, fill: (view: DataView) => void): Buffer {
  const buffer = Buffer.alloc(size);
  fill(new DataView(buffer.buffer, buffer.byteOffset, size));
  return buffer;
}

/** Write `entries` as an uncompressed zip at `zipPath`, reading one file at a time. */
export function writeStoredZip(zipPath: string, entries: readonly ZipEntry[]): void {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`A zip holds at most ${MAX_ENTRIES} files; this export has ${entries.length}`);
  }
  const fd = openSync(zipPath, "wx");
  const central: Buffer[] = [];
  let offset = 0;
  const write = (buffer: Buffer | Uint8Array) => {
    writeSync(fd, buffer);
    offset += buffer.length;
  };
  try {
    for (const entry of entries) {
      const data = readFileSync(entry.source);
      const name = Buffer.from(entry.name, "utf8");
      const crc = crc32(data);
      if (offset + 30 + name.length + data.length > MAX_OFFSET) {
        throw new Error("The frames are larger than a zip without ZIP64 can hold (4 GiB)");
      }
      const at = offset;
      write(
        header(30, (v) => {
          v.setUint32(0, 0x04034b50, true);
          v.setUint16(4, 20, true);
          v.setUint16(6, 0x0800, true);
          v.setUint32(14, crc, true);
          v.setUint32(18, data.length, true);
          v.setUint32(22, data.length, true);
          v.setUint16(26, name.length, true);
        }),
      );
      write(name);
      write(data);
      central.push(
        header(46, (v) => {
          v.setUint32(0, 0x02014b50, true);
          v.setUint16(4, 20, true);
          v.setUint16(6, 20, true);
          v.setUint16(8, 0x0800, true);
          v.setUint32(16, crc, true);
          v.setUint32(20, data.length, true);
          v.setUint32(24, data.length, true);
          v.setUint16(28, name.length, true);
          v.setUint32(42, at, true);
        }),
        name,
      );
    }
    const centralStart = offset;
    for (const part of central) write(part);
    const centralSize = offset - centralStart;
    write(
      header(22, (v) => {
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(8, entries.length, true);
        v.setUint16(10, entries.length, true);
        v.setUint32(12, centralSize, true);
        v.setUint32(16, centralStart, true);
      }),
    );
  } finally {
    closeSync(fd);
  }
}
