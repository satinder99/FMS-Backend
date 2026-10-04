// [BACKEND · Express] src/Utils/zipWriter.js
// Builds a ZIP file on the fly and streams it to a response, without any extra package. Photos and PDFs are
// already compressed, so entries are simply "stored" (no compression). One entry is held in memory at a time
// (a document is at most 15 MB). Names are written as UTF-8.
//
//   const zip = new ZipWriter(res);
//   await zip.addFile('TRP-000012/POD/TRP-000012-POD-1.jpg', buffer);
//   await zip.finish();            // also ends the stream

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Entry names use forward slashes and can never climb out of the archive. */
function safeEntryName(name) {
  const parts = String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) throw new Error('Invalid zip entry name.');
  return parts.join('/');
}

const UTF8_FLAG = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff; // no ZIP64: far above anything a trip's documents will reach

class ZipWriter {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }

  _write(buffer) {
    this.offset += buffer.length;
    if (this.offset > MAX_BYTES) throw new Error('The zip file is too large.');
    return new Promise((resolve, reject) => {
      const ok = this.out.write(buffer, (err) => err && reject(err));
      if (ok) resolve();
      else this.out.once('drain', resolve);
    });
  }

  async addFile(name, data, modified = new Date()) {
    if (this.entries.length >= MAX_ENTRIES) throw new Error('Too many files for one zip.');
    const fileName = Buffer.from(safeEntryName(name), 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(modified);
    const localOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(0, 8); // method 0 = stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); // compressed size
    header.writeUInt32LE(data.length, 22); // uncompressed size
    header.writeUInt16LE(fileName.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    await this._write(header);
    await this._write(fileName);
    if (data.length) await this._write(data);
    this.entries.push({ fileName, crc, size: data.length, time, date, localOffset });
  }

  /** Writes the table of contents and closes the output. */
  async finish() {
    const centralStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); // central directory header signature
      h.writeUInt16LE(20, 4); // version made by
      h.writeUInt16LE(20, 6); // version needed
      h.writeUInt16LE(UTF8_FLAG, 8);
      h.writeUInt16LE(0, 10); // stored
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.fileName.length, 28);
      // extra length, comment length, disk number, internal attrs, external attrs: all 0
      h.writeUInt32LE(e.localOffset, 42);
      await this._write(h);
      await this._write(e.fileName);
    }
    const centralSize = this.offset - centralStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    await this._write(end);
    await new Promise((resolve) => this.out.end(resolve));
  }
}

module.exports = { ZipWriter, crc32, safeEntryName };
