const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_NAME_LENGTH = 100;
const MAX_FILE_NAME_LENGTH = 200;

// Page and folder names: letters, digits, "-" and "_" only
function safeName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[^a-z0-9_\-]/gi, '').slice(0, MAX_NAME_LENGTH);
}

// Strips path separators, control and shell/HTML-special characters from an
// uploaded file name and keeps it at a sane length.
function sanitizeFileName(name) {
  let clean = String(name || '')
    .normalize('NFC')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+/, '')
    .trim();
  if (clean.length > MAX_FILE_NAME_LENGTH) {
    const ext = path.extname(clean).slice(0, 20);
    clean = clean.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext;
  }
  return clean || 'file';
}

// Returns "name (1).ext", "name (2).ext", ... until the name is free on disk
// and not in `reserved`
function uniqueFileName(dir, fileName, reserved = new Set()) {
  const taken = name => reserved.has(name) || fs.existsSync(path.join(dir, name));
  if (!taken(fileName)) return fileName;
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

// Version tag for a note's content, used to detect and merge concurrent edits
function contentVersion(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Writes via a temp file + rename so a crash never leaves a half-written file
function writeFileAtomic(file, data, options) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, options);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

// Moves a file or directory if it exists; creates the target's parent
function moveIfExists(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

// Display names come from an unauthenticated header: keep them short and plain
function cleanDisplayName(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch (err) {
    // use as-is
  }
  return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40);
}

module.exports = {
  MAX_NAME_LENGTH,
  safeName,
  sanitizeFileName,
  uniqueFileName,
  contentVersion,
  writeFileAtomic,
  readJson,
  writeJson,
  moveIfExists,
  cleanDisplayName
};
