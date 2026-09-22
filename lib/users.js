const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./passwords');
const { readJson, writeJson } = require('./util');

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const MIN_PASSWORD_LENGTH = 8;
// Verified against when a username doesn't exist, so failed logins take the
// same time whether or not the account exists
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function cleanName(value, fallback) {
  const name = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40) : '';
  return name || fallback;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 200) return 'Password is too long';
  return '';
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

// Site accounts, stored in <dataDir>/.noter/users.json:
//   { users: { username: { name, hash, admin, version, createdAt } } }
// `version` goes up whenever a password changes or access is revoked; sessions
// carry it, so old sessions stop working.
class UserStore {
  constructor(dataDir, initialUsers) {
    this.file = path.join(dataDir, '.noter', 'users.json');
    this.setupFile = path.join(dataDir, '.noter', 'setup-code');
    const data = readJson(this.file, { users: {} });
    this.users = Object.assign(Object.create(null), data.users || {});
    for (const user of initialUsers || []) {
      if (!this.users[user.username]) this.addUser(user, { save: false });
    }
    if (initialUsers) this.save();
    if (this.count() === 0) this.setupCode(); // create it now so it can be logged and read
  }

  save() {
    writeJson(this.file, { users: this.users });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch (err) {
      // best effort
    }
  }

  count() {
    return Object.keys(this.users).length;
  }

  get(username) {
    const key = normalizeUsername(username);
    return Object.prototype.hasOwnProperty.call(this.users, key) ? this.users[key] : null;
  }

  // Public view of an account (never includes the hash)
  describe(username) {
    const user = this.get(username);
    if (!user) return null;
    return { username: normalizeUsername(username), name: user.name, admin: Boolean(user.admin), createdAt: user.createdAt };
  }

  list() {
    return Object.keys(this.users).sort().map(u => this.describe(u));
  }

  adminCount() {
    return Object.values(this.users).filter(u => u.admin).length;
  }

  // Returns the username on success, null otherwise (constant-ish time)
  authenticate(username, password) {
    const user = this.get(username);
    const ok = verifyPassword(typeof password === 'string' ? password : '', user ? user.hash : DUMMY_HASH);
    return ok && user ? normalizeUsername(username) : null;
  }

  addUser({ username, name, password, admin = false }, { save = true } = {}) {
    const key = normalizeUsername(username);
    if (!USERNAME_PATTERN.test(key)) {
      throw httpError(400, 'Usernames are 2–32 characters: letters, numbers, dots, dashes or underscores');
    }
    if (this.get(key)) throw httpError(409, `The username "${key}" is taken`);
    const problem = validatePassword(password);
    if (problem) throw httpError(400, problem);
    this.users[key] = {
      name: cleanName(name, key),
      hash: hashPassword(password),
      admin: Boolean(admin),
      version: 1,
      createdAt: Date.now()
    };
    if (save) this.save();
    return this.describe(key);
  }

  setPassword(username, password) {
    const user = this.get(username);
    if (!user) throw httpError(404, 'No such person');
    const problem = validatePassword(password);
    if (problem) throw httpError(400, problem);
    user.hash = hashPassword(password);
    user.version = (user.version || 1) + 1;
    this.save();
  }

  update(username, { name, admin }) {
    const user = this.get(username);
    if (!user) throw httpError(404, 'No such person');
    if (name !== undefined) user.name = cleanName(name, normalizeUsername(username));
    if (admin !== undefined) {
      if (!admin && user.admin && this.adminCount() <= 1) throw httpError(400, 'There must be at least one admin');
      if (Boolean(admin) !== Boolean(user.admin)) user.version = (user.version || 1) + 1;
      user.admin = Boolean(admin);
    }
    this.save();
    return this.describe(username);
  }

  remove(username) {
    const user = this.get(username);
    if (!user) throw httpError(404, 'No such person');
    if (user.admin && this.adminCount() <= 1) throw httpError(400, 'You can’t remove the last admin');
    delete this.users[normalizeUsername(username)];
    this.save();
  }

  // ---------- Private pages unlocked by this account ----------
  // Stored as page -> password fingerprint, so a password change re-locks them.

  pageGrant(username, page) {
    const user = this.get(username);
    return user && user.unlocked && Object.prototype.hasOwnProperty.call(user.unlocked, page) ? user.unlocked[page] : null;
  }

  unlockedPages(username) {
    const user = this.get(username);
    return user && user.unlocked ? { ...user.unlocked } : {};
  }

  grantPage(username, page, fingerprint) {
    const user = this.get(username);
    if (!user || !fingerprint) return;
    user.unlocked = Object.assign(Object.create(null), user.unlocked, { [page]: fingerprint });
    this.save();
  }

  revokePage(username, page) {
    const user = this.get(username);
    if (!user || !user.unlocked || !(page in user.unlocked)) return;
    delete user.unlocked[page];
    this.save();
  }

  revokeAllPages(username) {
    const user = this.get(username);
    if (!user || !user.unlocked) return;
    delete user.unlocked;
    this.save();
  }

  // After a rename: everyone who had the page unlocked keeps it unlocked
  movePageGrants(from, to, oldFingerprint, newFingerprint) {
    let changed = false;
    for (const user of Object.values(this.users)) {
      if (!user.unlocked || !(from in user.unlocked)) continue;
      if (user.unlocked[from] === oldFingerprint) user.unlocked[to] = newFingerprint;
      delete user.unlocked[from];
      changed = true;
    }
    if (changed) this.save();
  }

  // Signs someone out everywhere
  revokeSessions(username) {
    const user = this.get(username);
    if (!user) return;
    user.version = (user.version || 1) + 1;
    this.save();
  }

  // ---------- First-run setup ----------

  // One-time code needed to create the first account (printed in the server
  // log), so nobody who finds the site first can make themselves admin.
  setupCode() {
    if (this.count() > 0) return null;
    if (!this.code) {
      try {
        this.code = fs.readFileSync(this.setupFile, 'utf-8').trim();
      } catch (err) {
        const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
        this.code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
        fs.mkdirSync(path.dirname(this.setupFile), { recursive: true });
        fs.writeFileSync(this.setupFile, this.code, { mode: 0o600 });
      }
    }
    return this.code;
  }

  checkSetupCode(code) {
    const expected = this.setupCode();
    if (!expected || typeof code !== 'string') return false;
    const a = crypto.createHash('sha256').update(code.trim().toUpperCase()).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  }

  finishSetup() {
    this.code = null;
    fs.rmSync(this.setupFile, { force: true });
  }
}

module.exports = { UserStore, normalizeUsername, validatePassword, MIN_PASSWORD_LENGTH };
