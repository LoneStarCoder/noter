const path = require('path');
const { readJson, writeJson } = require('./util');
const { randomId } = require('./notes');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// Read-only share links: token -> { page, createdAt, createdBy }
class ShareStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, '.noter', 'shares.json');
    this.shares = readJson(this.file, {});
  }

  save() {
    writeJson(this.file, this.shares);
  }

  get(token) {
    if (!TOKEN_PATTERN.test(token || '')) return null;
    return Object.prototype.hasOwnProperty.call(this.shares, token) ? this.shares[token] : null;
  }

  create(page, by) {
    const token = randomId(16);
    this.shares[token] = { page, createdAt: Date.now(), createdBy: by || '' };
    this.save();
    return token;
  }

  forPage(page) {
    return Object.entries(this.shares)
      .filter(([, share]) => share.page === page)
      .map(([token, share]) => ({ token, ...share }));
  }

  revoke(token) {
    if (!this.get(token)) return false;
    delete this.shares[token];
    this.save();
    return true;
  }

  renamePage(from, to) {
    for (const share of Object.values(this.shares)) if (share.page === from) share.page = to;
    this.save();
  }

  removePage(page) {
    for (const [token, share] of Object.entries(this.shares)) if (share.page === page) delete this.shares[token];
    this.save();
  }
}

module.exports = { ShareStore };
