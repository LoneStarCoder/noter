const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp, sanitizeFileName } = require('../server');

let server;
let base;
let dataDir;

const PASSWORDS = { secret: 'pagepw', files: 'filespw', home: 'homepw' };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noter-test-'));
  const app = createApp({
    dataDir,
    passwords: PASSWORDS,
    maxUploadBytes: 1024,
    maxPasswordFailures: 5
  });
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function pw(password) {
  return { 'X-Noter-Password': encodeURIComponent(password) };
}

function save(name, text, headers = {}) {
  return fetch(`${base}/save/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ text })
  });
}

function rawStatus(urlPath, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: urlPath, headers }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

function upload(query, files, headers = pw('filespw')) {
  const form = new FormData();
  for (const [name, content] of files) form.append('files', new Blob([content]), name);
  return fetch(`${base}/upload${query}`, { method: 'POST', body: form, headers });
}

test('protected page: load, save and delete all require the password', async () => {
  fs.writeFileSync(path.join(dataDir, 'person_secret.txt'), 'original');

  assert.strictEqual((await fetch(`${base}/load/secret`)).status, 401);
  assert.strictEqual((await save('secret', 'pwned')).status, 401);
  assert.strictEqual((await fetch(`${base}/delete/secret`, { method: 'DELETE' })).status, 401);
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'person_secret.txt'), 'utf-8'), 'original');

  assert.strictEqual((await save('secret', 'updated', pw('pagepw'))).status, 200);
  const res = await fetch(`${base}/load/secret`, { headers: pw('pagepw') });
  assert.strictEqual(await res.text(), 'updated');
});

test('passwords in the query string are ignored', async () => {
  assert.strictEqual((await fetch(`${base}/load/secret?password=pagepw`)).status, 401);
});

test('protected pages are not listed', async () => {
  fs.writeFileSync(path.join(dataDir, 'person_public.txt'), 'hi');
  const pages = await (await fetch(`${base}/pages`)).json();
  assert.ok(pages.includes('public'));
  assert.ok(!pages.includes('secret'));
});

test('save rejects bodies without a text string (no cross-site blanking)', async () => {
  fs.writeFileSync(path.join(dataDir, 'person_victim.txt'), 'keep me');
  const formPost = await fetch(`${base}/save/victim`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'text=gone'
  });
  assert.strictEqual(formPost.status, 400);
  assert.strictEqual((await save('victim', { not: 'a string' })).status, 400);
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'person_victim.txt'), 'utf-8'), 'keep me');
});

test('page names are sanitized and empty names rejected', async () => {
  assert.strictEqual((await save('..%2F..%2Fetc', 'x')).status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'person_etc.txt')));
  assert.strictEqual((await save('%21%21', 'x')).status, 400);
});

test('prototype property names cannot bypass or break password checks', async () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.strictEqual((await save(name, 'x')).status, 200, name);
  }
});

test('file manager is disabled when no "files" password is configured', async () => {
  const app = createApp({ dataDir, passwords: {} });
  const open = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${open.address().port}/list-files`);
    assert.strictEqual(res.status, 403);
  } finally {
    open.close();
  }
});

test('file routes require the files password', async () => {
  assert.strictEqual((await fetch(`${base}/list-files`)).status, 401);
  assert.strictEqual((await upload('', [['a.txt', 'a']], {})).status, 401);
  assert.strictEqual((await fetch(`${base}/list-files`, { headers: pw('filespw') })).status, 200);
});

test('non-string folder params are rejected and do not crash the server', async () => {
  const res = await upload('?folder=a&folder=b', [['a.txt', 'a']]);
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await fetch(`${base}/list-files?folder[x]=y`, { headers: pw('filespw') })).status, 400);
  const created = await fetch(`${base}/create-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...pw('filespw') },
    body: JSON.stringify({ name: ['x'], parent: { a: 1 } })
  });
  assert.strictEqual(created.status, 400);
  // Server is still alive
  assert.strictEqual((await fetch(`${base}/pages`)).status, 200);
});

test('path traversal is blocked on every file route', async () => {
  const h = pw('filespw');
  assert.strictEqual((await fetch(`${base}/list-files?folder=../`, { headers: h })).status, 400);
  assert.strictEqual((await fetch(`${base}/download/person_secret.txt?folder=..`, { headers: h })).status, 400);
  // fetch() normalizes "..", so send these paths raw
  assert.notStrictEqual(await rawStatus('/download/..', h), 200);
  assert.notStrictEqual(await rawStatus('/download/%2E%2E', h), 200);
  assert.strictEqual((await fetch(`${base}/download/..%2Fperson_secret.txt`, { headers: h })).status, 404);
  assert.strictEqual((await upload('?folder=../..', [['a.txt', 'a']])).status, 400);
  const del = await fetch(`${base}/delete-folder/x?parent=..`, { method: 'DELETE', headers: h });
  assert.strictEqual(del.status, 400);
  assert.ok(fs.existsSync(path.join(dataDir, 'person_secret.txt')));
});

test('uploaded file names are sanitized and never overwrite', async () => {
  const evil = `x');alert(1);//"<img>.txt`;
  let res = await upload('', [[evil, 'one']]);
  const first = (await res.json()).files[0];
  assert.ok(!/["<>/\\]/.test(first), first);

  res = await upload('', [[evil, 'two']]);
  const second = (await res.json()).files[0];
  assert.notStrictEqual(first, second);
  const dir = path.join(dataDir, 'uploads');
  assert.strictEqual(fs.readFileSync(path.join(dir, first), 'utf-8'), 'one');
  assert.strictEqual(fs.readFileSync(path.join(dir, second), 'utf-8'), 'two');

  assert.strictEqual(sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.strictEqual(sanitizeFileName('.htaccess'), 'htaccess');
  assert.strictEqual(sanitizeFileName(''), 'file');
});

test('UTF-8 file names survive upload', async () => {
  const res = await upload('', [['résumé 📄.txt', 'x']]);
  assert.deepStrictEqual((await res.json()).files, ['résumé 📄.txt']);
});

test('upload size limit is enforced', async () => {
  const res = await upload('', [['big.bin', 'x'.repeat(2048)]]);
  assert.strictEqual(res.status, 413);
  assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', 'big.bin')));
});

test('downloads are sandboxed and served as attachments', async () => {
  await upload('', [['page.html', '<script>alert(1)</script>']]);
  const res = await fetch(`${base}/download/page.html`, { headers: pw('filespw') });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('security headers are set and X-Powered-By is removed', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('errors do not leak stack traces', async () => {
  const res = await fetch(`${base}/save/x`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json'
  });
  assert.strictEqual(res.status, 400);
  const body = await res.text();
  assert.ok(!/\n\s+at /.test(body) && !body.includes(__dirname), body);
});

// Runs last because it locks out the test client's IP
test('repeated wrong passwords are rate limited', async () => {
  let status;
  for (let i = 0; i < 6; i++) {
    status = (await fetch(`${base}/load/secret`, { headers: pw('wrong') })).status;
  }
  assert.strictEqual(status, 429);
  // Even the right password is refused while locked out
  assert.strictEqual((await fetch(`${base}/load/secret`, { headers: pw('pagepw') })).status, 429);
});
