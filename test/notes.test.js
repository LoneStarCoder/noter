const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noter-notes-'));
  await new Promise(resolve => {
    server = createApp({ dataDir, passwords: {} }).listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function load(name) {
  const res = await fetch(`${base}/load/${name}`);
  return { text: await res.text(), version: res.headers.get('x-note-version') };
}

function save(name, body) {
  return fetch(`${base}/save/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('save and load round-trip, with the version returned by save matching load', async () => {
  const res = await save('roundtrip', { text: 'hello\nworld' });
  assert.strictEqual(res.status, 200);
  const { version } = await res.json();
  const loaded = await load('roundtrip');
  assert.strictEqual(loaded.text, 'hello\nworld');
  assert.strictEqual(loaded.version, version);
});

test('notes larger than the old 100KB limit can be saved', async () => {
  const big = 'a'.repeat(1024 * 1024);
  assert.strictEqual((await save('big', { text: big })).status, 200);
  assert.strictEqual((await load('big')).text.length, big.length);
});

test('oversized notes get a clear 413 error', async () => {
  const res = await save('huge', { text: 'a'.repeat(6 * 1024 * 1024) });
  assert.strictEqual(res.status, 413);
  assert.match((await res.json()).message, /too large/i);
});

test('saving from a stale version is rejected with 409', async () => {
  await save('shared', { text: 'v1' });
  const { version: v1 } = await load('shared');

  // Someone else saves first
  assert.strictEqual((await save('shared', { text: 'theirs', baseVersion: v1 })).status, 200);

  // Our save, based on v1, must not silently overwrite theirs
  const stale = await save('shared', { text: 'mine', baseVersion: v1 });
  assert.strictEqual(stale.status, 409);
  const { version: current } = await stale.json();
  assert.strictEqual((await load('shared')).text, 'theirs');

  // Saving against the current version (or with no version) works
  assert.strictEqual((await save('shared', { text: 'mine', baseVersion: current })).status, 200);
  assert.strictEqual((await save('shared', { text: 'forced' })).status, 200);
  assert.strictEqual((await load('shared')).text, 'forced');
});

test('a brand new page can be saved against the version of its empty load', async () => {
  const { text, version } = await load('fresh');
  assert.strictEqual(text, '');
  assert.strictEqual((await save('fresh', { text: 'first', baseVersion: version })).status, 200);
});

test('writes leave no temp files behind and temp files are never listed', async () => {
  await save('tidy', { text: 'x' });
  const leftovers = fs.readdirSync(dataDir).filter(f => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);
  const pages = await (await fetch(`${base}/pages`)).json();
  assert.ok(pages.includes('tidy'));
  assert.ok(pages.every(p => !p.includes('.')));
});

test('home cannot be deleted; other pages can', async () => {
  await save('home', { text: 'home' });
  assert.strictEqual((await fetch(`${base}/delete/home`, { method: 'DELETE' })).status, 403);
  await save('gone', { text: 'x' });
  assert.strictEqual((await fetch(`${base}/delete/gone`, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await fetch(`${base}/delete/gone`, { method: 'DELETE' })).status, 404);
});

test('editor route serves the editor page', async () => {
  const res = await fetch(`${base}/person/anything`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /id="pad"/);
});
