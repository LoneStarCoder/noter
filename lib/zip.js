const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// zlib.crc32 needs Node 20.15+; fall back to a table-based CRC-32
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(data) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data) >>> 0;
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal streaming ZIP writer (deflate, no zip64: fine for archives < 4GB).
// Each file is read and compressed one at a time to keep memory bounded.
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// entries: [{ name: 'path/in/zip.txt', file: '/abs/path' }]; writes to a stream
async function writeZip(output, entries) {
  const central = [];
  let offset = 0;

  function write(buffer) {
    offset += buffer.length;
    if (!output.write(buffer)) return new Promise(resolve => output.once('drain', resolve));
    return null;
  }

  for (const entry of entries) {
    let data;
    let stat;
    try {
      stat = fs.statSync(entry.file);
      data = fs.readFileSync(entry.file);
    } catch (err) {
      continue; // file vanished while backing up
    }
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const nameBuffer = Buffer.from(entry.name, 'utf-8');
    const { time, day } = dosDateTime(stat.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBuffer]));

    await write(Buffer.concat([local, nameBuffer]));
    await write(compressed);
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(centralBuffer);
  await write(end);
}

// Lists files under dir (recursively) as zip entries, skipping excluded names
function collectFiles(dir, prefix = '', exclude = () => false) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (exclude(rel) || item.name.endsWith('.tmp')) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) entries.push(...collectFiles(full, rel, exclude));
    else if (item.isFile()) entries.push({ name: rel, file: full });
  }
  return entries;
}

module.exports = { writeZip, collectFiles, crc32 };
