// [BACKEND · Express] src/Utils/fileType.js
// Decides what an uploaded file REALLY is by reading its first bytes, never by trusting the name or the
// type the browser claims. Only photos and PDFs are accepted.

const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'heif', 'mif1', 'msf1'];

const TYPES = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
  heic: { mime: 'image/heic', ext: 'heic' },
  pdf: { mime: 'application/pdf', ext: 'pdf' },
};

/** @returns {{mime: string, ext: string} | null} */
function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return TYPES.jpeg;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return TYPES.png;
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return TYPES.pdf;
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return TYPES.webp;
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp' && HEIF_BRANDS.includes(buffer.subarray(8, 12).toString('latin1'))) {
    return TYPES.heic;
  }
  return null;
}

/** A safe name to show and store: no folders, no odd characters, and an extension that matches the real type. */
function cleanFilename(original, ext) {
  const base = String(original || '')
    .split(/[\\/]/)
    .pop()
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"<>:*?|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const stem = base.replace(/\.[^.]*$/, '').replace(/^\.+/, '').slice(0, 100).trim();
  return `${stem || 'document'}.${ext}`;
}

/** The file extension for a stored content type (used to name downloads). */
function extensionFor(mime) {
  return Object.values(TYPES).find((t) => t.mime === mime)?.ext ?? 'bin';
}

module.exports = { detectFileType, cleanFilename, extensionFor };
