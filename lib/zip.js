/**
 * Minimal, dependency-free ZIP support for dsh-plugin-packer.
 *
 * The Harness profile ships no archive library (no jszip / yauzl / tar), so the
 * packer carries its own writer and reader on top of node:zlib. Only the two
 * methods the format needs are produced: STORE (0) and DEFLATE (8). ZIP64 is
 * deliberately unsupported; an over-limit archive fails loudly instead of
 * producing a file other tools cannot read.
 */
import { readFileSync, statSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** Bit 11: entry names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xfffffffe;

const CRC_TABLE = new Int32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value;
}

/**
 * CRC-32 (IEEE 802.3) as ZIP stores it.
 * @param {Uint8Array} buffer - bytes to checksum.
 * @returns {number} unsigned 32-bit checksum.
 */
export function crc32(buffer) {
  let value = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ -1) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff,
    date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

/**
 * One archive member.
 * @typedef {object} ZipSource
 * @property {string} name - forward-slash archive path.
 * @property {string} [file] - absolute path to read.
 * @property {Buffer} [data] - in-memory bytes (takes precedence).
 * @property {number} [size] - uncompressed size when known.
 * @property {Date} [mtime] - modification time recorded in the entry.
 */

/**
 * Encode members into a streaming ZIP.
 *
 * Yields chunks in archive order so the caller can pipe them straight to a
 * response without materializing the whole archive: one member is compressed
 * at a time, and only the central-directory records stay resident.
 *
 * @param {ZipSource[]} sources - members in archive order.
 * @returns {AsyncGenerator<Buffer>} archive chunks.
 */
export async function* createZipStream(sources) {
  if (sources.length > MAX_ENTRIES) {
    throw new Error('zip: too many entries (' + sources.length + ' > ' + MAX_ENTRIES + ')');
  }
  /** @type {object[]} */
  const records = [];
  let offset = 0;
  for (const source of sources) {
    const raw = source.data ?? readFileSync(source.file);
    const nameBuffer = Buffer.from(source.name, 'utf8');
    const mtime = source.mtime ?? new Date();
    const stamp = dosDateTime(mtime);
    const deflated = raw.length > 64 ? deflateRawSync(raw, { level: 6 }) : raw;
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);
    const local = Buffer.concat([
      u32(SIG_LOCAL), u16(20), u16(FLAG_UTF8), u16(method), u16(stamp.time), u16(stamp.date),
      u32(checksum), u32(body.length), u32(raw.length), u16(nameBuffer.length), u16(0), nameBuffer,
    ]);
    records.push({
      nameBuffer, method, time: stamp.time, date: stamp.date,
      checksum, compressed: body.length, uncompressed: raw.length, offset,
    });
    offset += local.length + body.length;
    if (offset > MAX_BYTES) throw new Error('zip: archive exceeds the 4 GiB format limit');
    yield local;
    yield body;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const record of records) {
    const header = Buffer.concat([
      u32(SIG_CENTRAL), u16(20), u16(20), u16(FLAG_UTF8), u16(record.method),
      u16(record.time), u16(record.date), u32(record.checksum), u32(record.compressed),
      u32(record.uncompressed), u16(record.nameBuffer.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(record.offset), record.nameBuffer,
    ]);
    centralSize += header.length;
    yield header;
  }
  if (centralStart + centralSize > MAX_BYTES) throw new Error('zip: central directory exceeds the 4 GiB format limit');
  yield Buffer.concat([
    u32(SIG_EOCD), u16(0), u16(0), u16(records.length), u16(records.length),
    u32(centralSize), u32(centralStart), u16(0),
  ]);
}

/**
 * Locate the end-of-central-directory record.
 * @param {Buffer} buffer - complete archive.
 * @returns {number} offset of the EOCD signature.
 */
function findEocd(buffer) {
  const first = Math.max(0, buffer.length - 0xffff - 22);
  for (let at = buffer.length - 22; at >= first; at -= 1) {
    if (buffer.readUInt32LE(at) === SIG_EOCD) return at;
  }
  throw new Error('zip: not a zip archive (no end-of-central-directory record)');
}

/**
 * Read every member of an archive into memory.
 *
 * Entry names are returned verbatim; the caller is responsible for path
 * safety. Sizes are validated against the declared lengths so a corrupted or
 * hostile archive fails instead of silently truncating.
 *
 * @param {Buffer} buffer - complete archive bytes.
 * @returns {{ name: string, directory: boolean, data: Buffer }[]} members.
 */
export function readZip(buffer) {
  if (buffer.length < 22) throw new Error('zip: archive is too small');
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buffer.length) throw new Error('zip: central directory out of range');
  if (count > MAX_ENTRIES) throw new Error('zip: too many entries');
  const members = [];
  let at = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== SIG_CENTRAL) {
      throw new Error('zip: corrupt central directory at entry ' + index);
    }
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (uncompressedSize > MAX_BYTES) throw new Error('zip: member "' + name + '" exceeds the size limit');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error('zip: corrupt local header for "' + name + '"');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw new Error('zip: member "' + name + '" runs past the end of the archive');
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = payload;
    else if (method === 8) data = inflateRawSync(payload);
    else throw new Error('zip: unsupported compression method ' + method + ' for "' + name + '"');
    if (data.length !== uncompressedSize) {
      throw new Error('zip: member "' + name + '" size mismatch (' + data.length + ' != ' + uncompressedSize + ')');
    }
    members.push({ name, directory: name.endsWith('/'), data });
  }
  return members;
}

/**
 * Sum a tree's size, used for the catalogue rows.
 * @param {string} file - absolute path.
 * @returns {{ size: number, mtime: Date }} size and modification time.
 */
export function fileStat(file) {
  const stat = statSync(file);
  return { size: stat.size, mtime: stat.mtime };
}
