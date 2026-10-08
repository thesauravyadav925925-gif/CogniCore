/**
 * Minimal ZIP reader (central-directory based) used for PPTX and file-content validation.
 * Only supports stored/deflated entries - exactly what Office files use. No dependencies.
 */
const zlib = require('zlib');

function readZipEntries(buf, { maxEntries = 5000, maxUncompressed = 200 * 1024 * 1024 } = {}) {
  if (buf.length < 22) throw new Error('Not a valid ZIP file.');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid ZIP file (no central directory).');
  const total = buf.readUInt16LE(eocd + 10);
  if (total > maxEntries) throw new Error('ZIP has too many entries.');
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let uncompressedTotal = 0;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    uncompressedTotal += usize;
    if (uncompressedTotal > maxUncompressed) throw new Error('ZIP expands beyond the allowed size (possible zip bomb).');
    entries.set(name, { method, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  return {
    names: [...entries.keys()],
    has: (n) => entries.has(n),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const nlen = buf.readUInt16LE(e.lho + 26), elen = buf.readUInt16LE(e.lho + 28);
      const start = e.lho + 30 + nlen + elen;
      const data = buf.subarray(start, start + e.csize);
      return e.method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.usize, 1) + 1024 });
    },
  };
}

module.exports = { readZipEntries };
