const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, Client, rawGet } = require('./helpers');

let srv;

before(async () => {
  srv = await startServer({
    passwords: { secret: 'pagepw', files: 'filespw', admin: 'adminpw' },
    maxUploadBytes: 1024,
    maxPasswordFailures: 5
  });
  fs.writeFileSync(path.join(srv.dataDir, 'person_secret.txt'), 'original');
});

after(() => srv.close());

test('protected page: read, save, delete, history and attachments all need the password', async () => {
  const anon = srv.client();
  assert.strictEqual((await anon.get('/api/pages/secret')).status, 401);
  assert.strictEqual((await anon.save('secret', 'pwned')).status, 401);
  assert.strictEqual((await anon.del('/api/pages/secret')).status, 401);
  assert.strictEqual((await anon.get('/api/pages/secret/history')).status, 401);
  assert.strictEqual((await anon.get('/api/pages/secret/attachments')).status, 401);
  assert.strictEqual((await anon.get('/api/pages/secret/events')).status, 401);
  assert.strictEqual((await anon.post('/api/pages/secret/rename', { to: 'mine' })).status, 401);
  assert.strictEqual(fs.readFileSync(path.join(srv.dataDir, 'person_secret.txt'), 'utf-8'), 'original');

  const owner = srv.client();
  assert.strictEqual((await owner.unlock('page', 'wrong', 'secret')).status, 401);
  assert.strictEqual((await owner.unlock('page', 'pagepw', 'secret')).status, 200);
  const page = await owner.get('/api/pages/secret');
  assert.strictEqual(page.status, 200);
  assert.strictEqual(page.data.text, 'original');
  assert.strictEqual(page.headers.get('x-noter-protected'), '1');
});

test('session cookie is HttpOnly, SameSite=Strict and tamper-proof', async () => {
  const c = srv.client();
  const res = await c.request('POST', '/api/unlock', { json: { scope: 'page', page: 'secret', password: 'pagepw' }, raw: true });
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  // Forge a cookie claiming admin: signature no longer matches
  const [payload] = cookie.split(';')[0].split('=')[1].split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  data.a = 'x';
  const forged = new Client(srv.base);
  forged.cookie = `noter_session=${Buffer.from(JSON.stringify(data)).toString('base64url')}.${cookie.split('.')[1].split(';')[0]}`;
  assert.strictEqual((await forged.get('/api/pages/secret')).status, 401);
  assert.strictEqual((await forged.get('/api/session')).data.admin, false);
});

test('changing a page password revokes other sessions', async () => {
  const a = srv.client();
  const b = srv.client();
  await a.unlock('page', 'pagepw', 'secret');
  await b.unlock('page', 'pagepw', 'secret');
  assert.strictEqual((await a.post('/api/pages/secret/password', { password: 'newpass1' })).status, 200);
  assert.strictEqual((await a.get('/api/pages/secret')).status, 200, 'changer keeps access');
  assert.strictEqual((await b.get('/api/pages/secret')).status, 401, 'others are locked out');
  assert.strictEqual((await b.unlock('page', 'newpass1', 'secret')).status, 200);
  // Stored as a hash, not plaintext
  const stored = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'protected_pages.json'), 'utf-8'));
  assert.match(stored.secret, /^scrypt\$/);
  await a.post('/api/pages/secret/password', { password: 'pagepw' });
});

test('state-changing requests need the X-Noter header and a same-origin Origin', async () => {
  const noHeader = await fetch(`${srv.base}/api/pages/victim`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x' })
  });
  assert.strictEqual(noHeader.status, 403);
  const crossOrigin = await fetch(`${srv.base}/api/pages/victim`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Noter': '1', Origin: 'https://evil.example' },
    body: JSON.stringify({ text: 'x' })
  });
  assert.strictEqual(crossOrigin.status, 403);
  const formPost = await fetch(`${srv.base}/upload`, { method: 'POST', body: new FormData() });
  assert.strictEqual(formPost.status, 403);
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'person_victim.txt')));
});

test('save rejects bodies without a text string', async () => {
  const c = srv.client();
  assert.strictEqual((await c.put('/api/pages/victim', { text: { not: 'a string' } })).status, 400);
  assert.strictEqual((await c.request('PUT', '/api/pages/victim', { body: 'text=gone', headers: { 'Content-Type': 'text/plain' } })).status, 400);
});

test('protected pages are hidden from lists and search unless unlocked', async () => {
  const anon = srv.client();
  await anon.save('public', 'hello secretword');
  const pages = (await anon.get('/api/pages')).data.map(p => p.name);
  assert.ok(pages.includes('public'));
  assert.ok(!pages.includes('secret'));
  const results = (await anon.get('/api/search?q=original')).data;
  assert.deepStrictEqual(results, []);

  const owner = srv.client();
  await owner.unlock('page', 'pagepw', 'secret');
  const unlockedPages = (await owner.get('/api/pages')).data;
  const secret = unlockedPages.find(p => p.name === 'secret');
  assert.ok(secret && secret.protected);
  assert.strictEqual((await owner.get('/api/search?q=original')).data[0].name, 'secret');
});

test('anyone can make a new page private, but only admin can lock an existing page', async () => {
  const c = srv.client();
  assert.strictEqual((await c.post('/api/pages/brandnew/password', { password: 'mypass' })).status, 200);
  assert.strictEqual((await c.save('brandnew', 'private stuff')).status, 200);
  assert.strictEqual((await srv.client().get('/api/pages/brandnew')).status, 401);

  await c.save('shared', 'everyone uses this');
  const res = await c.post('/api/pages/shared/password', { password: 'grief' });
  assert.strictEqual(res.status, 403);

  const admin = srv.client();
  await admin.unlock('admin', 'adminpw');
  assert.strictEqual((await admin.post('/api/pages/shared/password', { password: 'lockit' })).status, 200);
  assert.strictEqual((await c.get('/api/pages/shared')).status, 401);
  assert.strictEqual((await admin.post('/api/pages/shared/password', { password: null })).status, 200);
  assert.strictEqual((await c.get('/api/pages/shared')).status, 200);
});

test('admin can read every page; reserved names cannot be pages', async () => {
  const admin = srv.client();
  await admin.unlock('admin', 'adminpw');
  assert.strictEqual((await admin.get('/api/pages/secret')).status, 200);
  assert.strictEqual((await admin.save('files', 'x')).status, 400);
  assert.strictEqual((await admin.save('admin', 'x')).status, 400);
});

test('prototype property names cannot bypass password checks', async () => {
  const c = srv.client();
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.strictEqual((await c.save(name, 'x')).status, 200, name);
    assert.strictEqual((await c.unlock('page', 'anything', name)).status, 200, 'unprotected page: nothing to unlock');
  }
});

test('page names are sanitized and empty names rejected', async () => {
  const c = srv.client();
  assert.strictEqual((await c.save('..%2F..%2Fetc', 'x')).status, 200);
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'person_etc.txt')));
  assert.strictEqual((await c.save('%21%21', 'x')).status, 400);
});

test('file manager needs the files password (cookie), and is off without one', async () => {
  const anon = srv.client();
  assert.strictEqual((await anon.get('/list-files')).status, 401);
  assert.strictEqual((await anon.upload('/upload', [['a.txt', 'a']])).status, 401);
  const c = srv.client();
  assert.strictEqual((await c.unlock('files', 'filespw')).status, 200);
  assert.strictEqual((await c.get('/list-files')).status, 200);

  const bare = await startServer({ passwords: {} });
  try {
    assert.strictEqual((await bare.client().get('/list-files')).status, 403);
  } finally {
    bare.close();
  }
});

test('file manager: bad folder params are rejected and do not crash the server', async () => {
  const c = srv.client();
  await c.unlock('files', 'filespw');
  assert.strictEqual((await c.upload('/upload?folder=a&folder=b', [['a.txt', 'a']])).status, 400);
  assert.strictEqual((await c.get('/list-files?folder[x]=y')).status, 400);
  assert.strictEqual((await c.post('/create-folder', { name: ['x'], parent: { a: 1 } })).status, 400);
  assert.strictEqual((await c.get('/list-files?folder=../')).status, 400);
  assert.strictEqual((await c.get('/download/person_secret.txt?folder=..')).status, 400);
  assert.strictEqual((await c.upload('/upload?folder=../..', [['a.txt', 'a']])).status, 400);
  assert.strictEqual((await c.del('/delete-folder/x?parent=..')).status, 400);
  assert.notStrictEqual(await rawGet(srv.base, '/download/..', { Cookie: c.cookie }), 200);
  assert.strictEqual((await srv.client().get('/api/pages')).status, 200, 'server still alive');
});

test('uploads: names sanitized, no overwrite, UTF-8 kept, size limited', async () => {
  const c = srv.client();
  await c.unlock('files', 'filespw');
  const evil = `x');alert(1);//"<img>.txt`;
  const first = (await c.upload('/upload', [[evil, 'one']])).data.files[0];
  const second = (await c.upload('/upload', [[evil, 'two']])).data.files[0];
  assert.ok(!/["<>/\\]/.test(first), first);
  assert.notStrictEqual(first, second);
  assert.deepStrictEqual((await c.upload('/upload', [['résumé 📄.txt', 'x']])).data.files, ['résumé 📄.txt']);
  assert.strictEqual((await c.upload('/upload', [['big.bin', 'x'.repeat(2048)]])).status, 413);
});

test('attachments: path traversal blocked, non-images downloaded, all sandboxed', async () => {
  const c = srv.client();
  await c.save('att', 'page with files');
  const up = await c.upload('/api/pages/att/attachments', [['page.html', '<script>alert(1)</script>'], ['pic.svg', '<svg/>']]);
  assert.strictEqual(up.status, 200);
  const html = await c.get('/api/pages/att/attachments/page.html');
  assert.match(html.headers.get('content-disposition'), /^attachment/);
  assert.match(html.headers.get('content-security-policy'), /sandbox/);
  const svg = await c.get('/api/pages/att/attachments/pic.svg');
  assert.strictEqual(svg.headers.get('content-disposition'), null, 'images display inline');
  assert.match(svg.headers.get('content-security-policy'), /sandbox/);
  assert.strictEqual((await c.get('/api/pages/att/attachments/..%2F..%2Fprotected_pages.json')).status, 404);
  assert.notStrictEqual(await rawGet(srv.base, '/api/pages/att/attachments/..'), 200);
});

test('share links give read-only access to one page only', async () => {
  const owner = srv.client();
  await owner.unlock('page', 'pagepw', 'secret');
  const { token, url } = (await owner.post('/api/pages/secret/shares')).data;
  assert.ok(url.startsWith('/s/'));

  const anon = srv.client();
  const shared = await anon.get(`/api/share/${token}`);
  assert.strictEqual(shared.status, 200);
  assert.strictEqual(shared.data.name, 'secret');
  assert.strictEqual((await anon.get('/api/pages/secret')).status, 401, 'share does not unlock the page');
  assert.strictEqual((await anon.del(`/api/shares/${token}`)).status, 401, 'only people with access can revoke');
  assert.strictEqual((await anon.get('/api/share/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.strictEqual((await anon.get('/api/share/constructor')).status, 404);

  assert.strictEqual((await owner.del(`/api/shares/${token}`)).status, 200);
  assert.strictEqual((await anon.get(`/api/share/${token}`)).status, 404);
});

test('trash hides protected pages from non-admins and needs the old password to restore', async () => {
  const owner = srv.client();
  await owner.post('/api/pages/diary/password', { password: 'diarypw' });
  await owner.save('diary', 'dear diary');
  const { trashId } = (await owner.del('/api/pages/diary')).data;

  const anon = srv.client();
  assert.ok(!(await anon.get('/api/trash')).data.some(e => e.id === trashId));
  assert.strictEqual((await anon.post(`/api/trash/${trashId}/restore`, {})).status, 401);
  assert.strictEqual((await anon.post(`/api/trash/${trashId}/restore`, { password: 'diarypw' })).status, 200);
  assert.strictEqual((await srv.client().get('/api/pages/diary')).status, 401, 'restored page is still protected');
  assert.strictEqual((await anon.get('/api/pages/diary')).data.text, 'dear diary');
  assert.strictEqual((await anon.del(`/api/trash/${trashId}`)).status, 401, 'purge needs admin');
});

test('admin backup requires admin', async () => {
  assert.strictEqual((await srv.client().get('/api/admin/backup')).status, 401);
});

test('security headers are set, X-Powered-By removed, no stack traces', async () => {
  const res = await fetch(`${srv.base}/`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
  const bad = await srv.client().request('PUT', '/api/pages/x', { body: '{bad json', headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(bad.status, 400);
  assert.ok(!/\n\s+at /.test(JSON.stringify(bad.data)));
});

// Runs last because it locks out the test client's IP
test('repeated wrong passwords are rate limited', async () => {
  const c = srv.client();
  let status;
  for (let i = 0; i < 6; i++) status = (await c.unlock('page', 'wrong', 'secret')).status;
  assert.strictEqual(status, 429);
  assert.strictEqual((await c.unlock('page', 'pagepw', 'secret')).status, 429);
});
