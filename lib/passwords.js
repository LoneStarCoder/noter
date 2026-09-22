const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./util');

// Keys in protected_pages.json that are not page names
const RESERVED_KEYS = ['files', 'admin'];
const RELOAD_CHECK_MS = 2000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

// Supports scrypt hashes written by Noter and legacy plaintext entries
function verifyPassword(supplied, stored) {
  if (typeof supplied !== 'string' || typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, saltB64, hashB64] = stored.split('$');
    const expected = Buffer.from(hashB64 || '', 'base64');
    if (expected.length !== 32) return false;
    const actual = crypto.scryptSync(supplied, Buffer.from(saltB64, 'base64'), 32);
    return crypto.timingSafeEqual(actual, expected);
  }
  return crypto.timingSafeEqual(sha256(supplied), sha256(stored));
}

// Copies only non-empty string values into a prototype-less object, so names
// like "__proto__" or "constructor" can never resolve to something truthy.
function normalize(raw) {
  const result = Object.create(null);
  for (const [key, value] of Object.entries(raw || {})) {
    if (typeof value === 'string' && value !== '') result[key] = value;
  }
  return result;
}

// Password store backed by protected_pages.json. Picks up manual edits to the
// file without a restart and writes changes made through the app back to it.
class PasswordStore {
  constructor({ dataDir, initial }) {
    const candidates = [
      process.env.NOTER_PASSWORDS_FILE,
      path.join(dataDir, 'protected_pages.json'),
      path.join(__dirname, '..', 'protected_pages.json')
    ].filter(Boolean);

    if (initial) {
      // Tests pass passwords directly; writes go to the data dir
      this.file = path.join(dataDir, 'protected_pages.json');
      this.entries = normalize(initial);
      this.mtimeMs = null;
      this.watchFile = false;
    } else {
      this.file = candidates.find(f => fs.existsSync(f)) || path.join(dataDir, 'protected_pages.json');
      this.watchFile = true;
      this.entries = Object.create(null);
      this.mtimeMs = null;
      if (fs.existsSync(this.file)) {
        // Invalid JSON at startup throws on purpose: better not to start than to run unprotected
        this.entries = normalize(JSON.parse(fs.readFileSync(this.file, 'utf-8')));
        this.mtimeMs = fs.statSync(this.file).mtimeMs;
      } else {
        console.warn('No protected_pages.json found: all pages are public and the file manager is disabled.');
      }
    }
    this.lastCheck = Date.now();
  }

  // Reloads the file if it was edited by hand since we last read it
  refresh() {
    if (!this.watchFile || Date.now() - this.lastCheck < RELOAD_CHECK_MS) return;
    this.lastCheck = Date.now();
    try {
      if (!fs.existsSync(this.file)) return;
      const mtimeMs = fs.statSync(this.file).mtimeMs;
      if (mtimeMs === this.mtimeMs) return;
      this.entries = normalize(JSON.parse(fs.readFileSync(this.file, 'utf-8')));
      this.mtimeMs = mtimeMs;
      console.log('Reloaded protected_pages.json');
    } catch (err) {
      console.error('Could not reload protected_pages.json, keeping previous passwords:', err.message);
    }
  }

  get(key) {
    this.refresh();
    return this.entries[key] || null;
  }

  has(key) {
    return Boolean(this.get(key));
  }

  verify(key, password) {
    const stored = this.get(key);
    return Boolean(stored) && verifyPassword(password, stored);
  }

  // Short fingerprint of the stored entry: sessions carry it so that changing
  // a password invalidates everyone's existing access.
  fingerprint(key, secret) {
    const stored = this.get(key);
    if (!stored) return null;
    return crypto.createHmac('sha256', secret).update(key + '\0' + stored).digest('hex').slice(0, 16);
  }

  // Protected page names (excludes the "files" and "admin" keys)
  protectedPages() {
    this.refresh();
    return Object.keys(this.entries).filter(k => !RESERVED_KEYS.includes(k));
  }

  // Sets (hashing it) or removes (null) a password, then persists
  set(key, password) {
    this.refresh();
    if (password === null) delete this.entries[key];
    else this.entries[key] = hashPassword(password);
    this.save();
  }

  // Raw entry access, used when moving pages to and from the trash
  getRaw(key) {
    return this.get(key);
  }

  setRaw(key, stored) {
    this.refresh();
    if (stored) this.entries[key] = stored;
    else delete this.entries[key];
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(this.entries, null, 2) + '\n', { mode: 0o600 });
    if (this.watchFile) this.mtimeMs = fs.statSync(this.file).mtimeMs;
  }
}

module.exports = { PasswordStore, RESERVED_KEYS, hashPassword, verifyPassword };
