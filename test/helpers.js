const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../server');

const ROOT = { username: 'root', name: 'Root', password: 'root-password', admin: true };
const MEMBER_PASSWORD = 'member-password';

// Starts an app on a random port with a throwaway data dir and one admin
// account ("root"). Pass users: [] to start with no accounts (setup mode).
async function startServer(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'noter-test-'));
  const app = createApp({ dataDir, secret: 'test-secret', users: [ROOT], ...options });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let root;
  let counter = 0;
  async function rootClient() {
    if (!root) {
      root = new Client(base, '');
      const res = await root.post('/api/auth/login', { username: ROOT.username, password: ROOT.password });
      if (res.status !== 200) throw new Error(`root login failed: ${res.status}`);
    }
    return root;
  }
  return {
    base,
    dataDir,
    server,
    // A signed-in member. The account (display name = `name`) is created on
    // first use through the admin API.
    client(name) {
      const client = new Client(base, '');
      const username = `u${++counter}-${String(name || 'member').toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 32);
      client.username = username;
      client.setup = async (c) => {
        const admin = await rootClient();
        const created = await admin.post('/api/users', { username, name: name || username, password: MEMBER_PASSWORD });
        if (created.status !== 200) throw new Error(`could not create ${username}: ${JSON.stringify(created.data)}`);
        const login = await c.post('/api/auth/login', { username, password: MEMBER_PASSWORD });
        if (login.status !== 200) throw new Error(`login failed for ${username}`);
      };
      return client;
    },
    // Not signed in at all
    anon: () => new Client(base, ''),
    admin: rootClient,
    close() {
      server.closeAllConnections();
      server.close();
      if (!options.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

// A browser-like client: keeps its session cookie and sends the CSRF header
class Client {
  constructor(base, user = '') {
    this.base = base;
    this.user = user;
    this.cookie = '';
  }

  async request(method, url, { json, body, headers = {}, raw = false } = {}) {
    if (this.setup) {
      const setup = this.setup;
      this.setup = null;
      await setup(this);
    }
    const h = { 'X-Noter': '1', ...headers };
    if (this.user) h['X-Noter-User'] = encodeURIComponent(this.user);
    if (this.cookie) h.Cookie = this.cookie;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(this.base + url, { method, headers: h, body });
    for (const cookie of res.headers.getSetCookie()) {
      const value = cookie.split(';')[0];
      this.cookie = value.endsWith('=') ? '' : value;
    }
    if (raw) return res;
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch (err) {
      // not JSON
    }
    return { status: res.status, data, headers: res.headers };
  }

  get(url, opts) { return this.request('GET', url, opts); }
  put(url, json) { return this.request('PUT', url, { json }); }
  post(url, json) { return this.request('POST', url, { json }); }
  del(url, json) { return this.request('DELETE', url, { json }); }

  unlock(scope, password, page) {
    return this.post('/api/unlock', { scope, password, page });
  }

  save(name, text, extra = {}) {
    return this.put(`/api/pages/${name}`, { text, ...extra });
  }

  upload(url, files) {
    const form = new FormData();
    for (const [name, content] of files) form.append('files', new Blob([content]), name);
    return this.request('POST', url, { body: form });
  }
}

// GET with an exact, un-normalized path (fetch() collapses "..")
function rawGet(base, urlPath, headers = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    http.get({ host: hostname, port, path: urlPath, headers }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

// Reads a ZIP buffer and returns { name: Buffer } (verifies CRCs)
function readZip(buffer) {
  const zlib = require('zlib');
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf-8', offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtra;
    const data = zlib.inflateRawSync(buffer.subarray(start, start + compressedSize));
    if (require('../lib/zip').crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    files[name] = data;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

module.exports = { startServer, Client, rawGet, readZip, ROOT, MEMBER_PASSWORD };
