const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, readZip } = require('./helpers');

let srv;

before(async () => {
  srv = await startServer({ passwords: { admin: 'adminpw', files: 'filespw' } });
});

after(() => srv.close());

test('save and load round-trip with metadata', async () => {
  const alice = srv.client('Alice');
  const saved = await alice.save('roundtrip', '# Groceries\nmilk and eggs #shopping');
  assert.strictEqual(saved.status, 200);
  const page = (await alice.get('/api/pages/roundtrip')).data;
  assert.strictEqual(page.text, '# Groceries\nmilk and eggs #shopping');
  assert.strictEqual(page.version, saved.data.version);
  assert.strictEqual(page.updatedBy, 'Alice');
  assert.strictEqual(page.exists, true);

  const listed = (await alice.get('/api/pages')).data.find(p => p.name === 'roundtrip');
  assert.strictEqual(listed.title, 'Groceries');
  assert.strictEqual(listed.preview, 'milk and eggs #shopping');
  assert.deepStrictEqual(listed.tags, ['shopping']);
  assert.strictEqual(listed.updatedBy, 'Alice');
});

test('a missing page loads as empty and is created on first save', async () => {
  const c = srv.client();
  const page = (await c.get('/api/pages/fresh')).data;
  assert.strictEqual(page.exists, false);
  assert.strictEqual(page.text, '');
  assert.strictEqual((await c.save('fresh', 'first', { baseVersion: page.version })).status, 200);
});

test('large notes save; oversized notes get a clear 413', async () => {
  const c = srv.client();
  assert.strictEqual((await c.save('big', 'a'.repeat(1024 * 1024))).status, 200);
  const res = await c.save('huge', 'a'.repeat(6 * 1024 * 1024));
  assert.strictEqual(res.status, 413);
  assert.match(res.data.message, /too large/i);
});

test('concurrent edits to different lines are merged automatically', async () => {
  const alice = srv.client('Alice');
  const bob = srv.client('Bob');
  await alice.save('shared', 'line 1\nline 2\nline 3\nline 4');
  const { version } = (await alice.get('/api/pages/shared')).data;

  // Both start from the same version
  const a = await alice.save('shared', 'line 1 (alice)\nline 2\nline 3\nline 4', { baseVersion: version });
  assert.strictEqual(a.status, 200);
  const b = await bob.save('shared', 'line 1\nline 2\nline 3\nline 4 (bob)', { baseVersion: version });
  assert.strictEqual(b.status, 200);
  assert.strictEqual(b.data.merged, true);
  assert.strictEqual(b.data.text, 'line 1 (alice)\nline 2\nline 3\nline 4 (bob)');
  assert.strictEqual((await alice.get('/api/pages/shared')).data.text, 'line 1 (alice)\nline 2\nline 3\nline 4 (bob)');
});

test('edits to the same line conflict, offering a keep-both text', async () => {
  const alice = srv.client('Alice');
  const bob = srv.client('Bob');
  await alice.save('clash', 'title\nbody');
  const { version } = (await alice.get('/api/pages/clash')).data;
  await alice.save('clash', 'alice title\nbody', { baseVersion: version });
  const res = await bob.save('clash', 'bob title\nbody', { baseVersion: version });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.text, 'alice title\nbody');
  assert.strictEqual(res.data.bothText, 'bob title\nalice title\nbody');
  assert.strictEqual(res.data.updatedBy, 'Alice');
  // Force saves anyway
  assert.strictEqual((await bob.save('clash', 'bob title\nbody', { force: true })).status, 200);
});

test('history keeps earlier versions and can restore them', async () => {
  const alice = srv.client('Alice');
  const bob = srv.client('Bob');
  await alice.save('hist', 'v1 by alice');
  await bob.save('hist', 'v2 by bob'); // different editor: v1 goes to history
  await alice.save('hist', 'v3 by alice'); // v2 goes to history
  const history = (await alice.get('/api/pages/hist/history')).data;
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].by, 'Bob');
  assert.strictEqual(history[1].by, 'Alice');

  const v1 = (await alice.get(`/api/pages/hist/history/${history[1].id}`)).data;
  assert.strictEqual(v1.text, 'v1 by alice');
  assert.strictEqual((await alice.get('/api/pages/hist/history/..%2F..%2Fx')).status, 404);

  const restored = await bob.post('/api/pages/hist/restore', { id: history[1].id });
  assert.strictEqual(restored.status, 200);
  assert.strictEqual((await bob.get('/api/pages/hist')).data.text, 'v1 by alice');
  // The version that was replaced by the restore is itself kept
  const after = (await bob.get('/api/pages/hist/history')).data;
  const texts = await Promise.all(after.map(async h => (await bob.get(`/api/pages/hist/history/${h.id}`)).data.text));
  assert.ok(texts.includes('v3 by alice'), JSON.stringify(texts));
});

test('rapid saves by the same person do not flood history', async () => {
  const c = srv.client('Carol');
  for (let i = 0; i < 10; i++) await c.save('typing', `draft ${i}`);
  const history = (await c.get('/api/pages/typing/history')).data;
  assert.ok(history.length <= 1, `got ${history.length} snapshots`);
});

test('delete moves a page (with history and attachments) to trash; restore brings it back', async () => {
  const c = srv.client('Dana');
  await c.save('todelete', 'keep me');
  await srv.client('Eve').save('todelete', 'keep me please');
  await c.upload('/api/pages/todelete/attachments', [['photo.png', 'png-bytes']]);
  const del = await c.del('/api/pages/todelete');
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await c.get('/api/pages/todelete')).data.exists, false);

  const trash = (await c.get('/api/trash')).data;
  const entry = trash.find(e => e.id === del.data.trashId);
  assert.strictEqual(entry.name, 'todelete');
  assert.strictEqual(entry.deletedBy, 'Dana');

  // Someone recreated the page meanwhile: restore picks a free name
  await c.save('todelete', 'new page');
  const restored = await c.post(`/api/trash/${del.data.trashId}/restore`);
  assert.strictEqual(restored.data.name, 'todelete-restored');
  const page = (await c.get('/api/pages/todelete-restored')).data;
  assert.strictEqual(page.text, 'keep me please');
  assert.strictEqual((await c.get('/api/pages/todelete-restored/attachments')).data[0].name, 'photo.png');
  assert.ok((await c.get('/api/pages/todelete-restored/history')).data.length >= 1);
  assert.strictEqual((await c.post('/api/trash/../../x/restore')).status, 404);
});

test('home cannot be deleted or renamed', async () => {
  const c = srv.client();
  await c.save('home', 'welcome');
  assert.strictEqual((await c.del('/api/pages/home')).status, 403);
  assert.strictEqual((await c.post('/api/pages/home/rename', { to: 'x' })).status, 403);
});

test('rename moves history, attachments, share links and password', async () => {
  const c = srv.client('Finn');
  await c.post('/api/pages/oldname/password', { password: 'renamepw' });
  await c.save('oldname', 'v1');
  await srv.client('Gus').unlock('page', 'renamepw', 'oldname');
  await c.save('oldname', 'v2 by finn again');
  await c.upload('/api/pages/oldname/attachments', [['doc.txt', 'hello']]);
  const { token } = (await c.post('/api/pages/oldname/shares')).data;

  assert.strictEqual((await c.post('/api/pages/oldname/rename', { to: 'newname' })).status, 200);
  assert.strictEqual((await c.get('/api/pages/oldname')).data.exists, false);
  assert.strictEqual((await c.get('/api/pages/newname')).data.text, 'v2 by finn again');
  assert.strictEqual((await c.get('/api/pages/newname/attachments')).data.length, 1);
  assert.strictEqual((await c.get(`/api/share/${token}`)).data.name, 'newname');
  assert.strictEqual((await srv.client().get('/api/pages/newname')).status, 401, 'still protected');

  await c.save('taken', 'x');
  assert.strictEqual((await c.post('/api/pages/newname/rename', { to: 'taken' })).status, 409);
});

test('search finds text across pages with snippets', async () => {
  const c = srv.client();
  await c.save('recipe', 'Tortillas\n2 cups flour, 1 tsp salt, water');
  await c.save('other', 'nothing here');
  const results = (await c.get('/api/search?q=FLOUR salt')).data;
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'recipe');
  assert.strictEqual(results[0].title, 'Tortillas');
  assert.match(results[0].snippet, /flour/);
  assert.strictEqual((await c.get('/api/search?q=recipe')).data[0].name, 'recipe', 'matches page names');
  assert.deepStrictEqual((await c.get('/api/search?q=')).data, []);
});

test('live events: presence and update notifications', async () => {
  const c = srv.client('Hal');
  await c.save('live', 'start');
  const controller = new AbortController();
  const res = await fetch(`${srv.base}/api/pages/live/events?client=tab1&user=Ivy`, { signal: controller.signal });
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextEvent(type) {
    for (;;) {
      const match = buffer.match(new RegExp(`event: ${type}\\ndata: (.*)\\n\\n`));
      if (match) {
        buffer = buffer.slice(buffer.indexOf(match[0]) + match[0].length);
        return JSON.parse(match[1]);
      }
      const { value } = await reader.read();
      buffer += decoder.decode(value);
    }
  }
  const presence = await nextEvent('presence');
  assert.deepStrictEqual(presence.users, [{ clientId: 'tab1', user: 'Ivy' }]);
  assert.deepStrictEqual((await c.get('/api/pages/live')).data.viewers, [{ clientId: 'tab1', user: 'Ivy' }]);

  const saved = await c.request('PUT', '/api/pages/live', { json: { text: 'changed' }, headers: { 'X-Noter-Client': 'tab2' } });
  const update = await nextEvent('update');
  assert.strictEqual(update.version, saved.data.version);
  assert.strictEqual(update.by, 'Hal');
  assert.strictEqual(update.clientId, 'tab2');
  controller.abort();
});

test('attachments upload, list, serve and delete', async () => {
  const c = srv.client();
  const up = await c.upload('/api/pages/pics/attachments', [['cat.png', 'img'], ['cat.png', 'img2']]);
  assert.deepStrictEqual(up.data.files.map(f => f.name), ['cat.png', 'cat (1).png']);
  assert.strictEqual(up.data.files[0].url, '/api/pages/pics/attachments/cat.png');
  assert.strictEqual((await c.get('/api/pages/pics/attachments/cat.png')).data, 'img');
  assert.strictEqual((await c.del('/api/pages/pics/attachments/cat.png')).status, 200);
  assert.strictEqual((await c.get('/api/pages/pics/attachments')).data.length, 1);
});

test('admin: full backup is a valid zip without the session secret', async () => {
  const admin = srv.client();
  await admin.unlock('admin', 'adminpw');
  await admin.save('backedup', 'in the backup');
  const res = await admin.request('GET', '/api/admin/backup', { raw: true });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /noter-backup-.*\.zip/);
  const files = readZip(Buffer.from(await res.arrayBuffer()));
  assert.strictEqual(files['person_backedup.txt'].toString(), 'in the backup');
  assert.ok(!Object.keys(files).some(f => f.includes('secret')));
});

test('admin can change the files password', async () => {
  const admin = srv.client();
  await admin.unlock('admin', 'adminpw');
  assert.strictEqual((await admin.post('/api/admin/password', { key: 'files', password: 'newfiles' })).status, 200);
  const c = srv.client();
  assert.strictEqual((await c.unlock('files', 'filespw')).status, 401);
  assert.strictEqual((await c.unlock('files', 'newfiles')).status, 200);
});

test('password file edits are picked up without a restart; plaintext entries still work', async () => {
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'noter-pw-'));
  const file = path.join(dataDir, 'protected_pages.json');
  fs.writeFileSync(file, JSON.stringify({ notes: 'plain' }));
  const s = await startServer({ dataDir, passwords: undefined });
  try {
    const c = s.client();
    assert.strictEqual((await c.unlock('page', 'plain', 'notes')).status, 200);
    fs.writeFileSync(file, JSON.stringify({ notes: 'plain', later: 'added' }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    await new Promise(r => setTimeout(r, 2100));
    assert.strictEqual((await s.client().get('/api/pages/later')).status, 401);
  } finally {
    s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('app routes serve the shell and share page', async () => {
  for (const url of ['/', '/person/anything', '/s/whatever', '/files.html', '/vendor/marked.esm.js', '/vendor/purify.es.mjs', '/vendor/diff3.mjs']) {
    const res = await fetch(srv.base + url);
    assert.strictEqual(res.status, 200, url);
  }
  assert.strictEqual((await fetch(srv.base + '/api/nope')).status, 404);
});
