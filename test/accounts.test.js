const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, Client, rawGet, ROOT, MEMBER_PASSWORD } = require('./helpers');

let srv;

before(async () => {
  srv = await startServer({ maxPasswordFailures: 5 });
  fs.writeFileSync(path.join(srv.dataDir, 'person_family.txt'), 'family notes');
});

after(() => srv.close());

test('without signing in, every page, API and file is off limits', async () => {
  const anon = srv.anon();
  for (const url of ['/api/pages', '/api/pages/family', '/api/search?q=family', '/api/trash', '/api/session', '/list-files', '/api/pages/family/events', '/api/users']) {
    assert.strictEqual((await anon.get(url)).status, 401, url);
  }
  assert.strictEqual((await anon.save('family', 'defaced')).status, 401);
  assert.strictEqual(fs.readFileSync(path.join(srv.dataDir, 'person_family.txt'), 'utf-8'), 'family notes');

  // Browsers are sent to the sign-in page, keeping where they wanted to go
  for (const url of ['/', '/person/family', '/files.html', '/index.html', '/blog.html']) {
    const res = await fetch(srv.base + url, { redirect: 'manual', headers: { Accept: 'text/html' } });
    assert.strictEqual(res.status, 302, url);
    assert.strictEqual(res.headers.get('location'), `/login?next=${encodeURIComponent(url)}`);
  }
  // …but the sign-in page and the code/styles it needs load
  for (const url of ['/login', '/app.css', '/js/login.js', '/js/lib/api.js', '/icons/icon.svg', '/manifest.webmanifest', '/sw.js']) {
    assert.strictEqual((await fetch(srv.base + url)).status, 200, url);
  }
  // The static data files are not reachable by path either
  assert.notStrictEqual(await rawGet(srv.base, '/person_family.txt'), 200);
});

test('open redirects are not possible through ?next', async () => {
  const res = await fetch(`${srv.base}//evil.example/x`, { redirect: 'manual', headers: { Accept: 'text/html' } });
  assert.ok(!/^\/\//.test(decodeURIComponent(res.headers.get('location') || '').replace('/login?next=', '')));
});

test('sign in, see who you are, sign out', async () => {
  const c = new Client(srv.base);
  assert.strictEqual((await c.post('/api/auth/login', { username: 'root', password: 'wrong' })).status, 401);
  assert.strictEqual((await c.post('/api/auth/login', { username: 'nobody', password: 'wrong' })).status, 401);
  const ok = await c.post('/api/auth/login', { username: 'ROOT', password: ROOT.password });
  assert.strictEqual(ok.status, 200, 'usernames are case-insensitive');
  assert.deepStrictEqual((await c.get('/api/auth/status')).data.user, { username: 'root', name: 'Root', admin: true });
  assert.strictEqual((await c.get('/api/pages')).status, 200);
  await c.post('/api/auth/logout');
  assert.strictEqual((await c.get('/api/pages')).status, 401);
  assert.strictEqual((await c.get('/api/auth/status')).data.user, null);
});

test('edits and presence use the account name, not a header', async () => {
  const c = srv.client('Elizabeth');
  await c.request('PUT', '/api/pages/named', { json: { text: 'hi' }, headers: { 'X-Noter-User': 'Someone Else' } });
  assert.strictEqual((await c.get('/api/pages/named')).data.updatedBy, 'Elizabeth');
});

test('admin manages people; members cannot', async () => {
  const admin = await srv.admin();
  const member = srv.client('Member');
  assert.strictEqual((await member.get('/api/users')).status, 401);
  assert.strictEqual((await member.post('/api/users', { username: 'sneaky', password: 'password123' })).status, 401);

  const created = await admin.post('/api/users', { username: 'Grandma', name: 'Grandma Jo', password: 'cookies-and-milk' });
  assert.strictEqual(created.status, 200);
  assert.deepStrictEqual(created.data.user.username, 'grandma');
  assert.strictEqual((await admin.post('/api/users', { username: 'grandma', password: 'another-pass' })).status, 409);
  assert.strictEqual((await admin.post('/api/users', { username: 'x', password: 'password123' })).status, 400, 'username too short');
  assert.strictEqual((await admin.post('/api/users', { username: 'shortpw', password: 'abc' })).status, 400, 'password too short');
  const list = (await admin.get('/api/users')).data;
  assert.ok(list.some(u => u.username === 'grandma' && u.name === 'Grandma Jo' && !u.admin));
  assert.ok(list.every(u => !('hash' in u)), 'password hashes are never sent');

  // Stored hashed
  const stored = JSON.parse(fs.readFileSync(path.join(srv.dataDir, '.noter', 'users.json'), 'utf-8'));
  assert.match(stored.users.grandma.hash, /^scrypt\$/);
});

test('removing a person or resetting their password signs them out everywhere', async () => {
  const admin = await srv.admin();
  await admin.post('/api/users', { username: 'cousin', name: 'Cousin', password: 'first-password' });
  const phone = new Client(srv.base);
  const laptop = new Client(srv.base);
  await phone.post('/api/auth/login', { username: 'cousin', password: 'first-password' });
  await laptop.post('/api/auth/login', { username: 'cousin', password: 'first-password' });
  assert.strictEqual((await phone.get('/api/pages')).status, 200);

  await admin.post('/api/users/cousin/password', { password: 'second-password' });
  assert.strictEqual((await phone.get('/api/pages')).status, 401);
  assert.strictEqual((await laptop.get('/api/pages')).status, 401);
  assert.strictEqual((await phone.post('/api/auth/login', { username: 'cousin', password: 'second-password' })).status, 200);

  await admin.del('/api/users/cousin');
  assert.strictEqual((await phone.get('/api/pages')).status, 401);
  assert.strictEqual((await phone.post('/api/auth/login', { username: 'cousin', password: 'second-password' })).status, 401);
});

test('you can change your own name and password', async () => {
  const c = srv.client('Old Name');
  assert.strictEqual((await c.put('/api/me', { name: 'New Name' })).data.user.name, 'New Name');
  assert.strictEqual((await c.post('/api/me/password', { current: 'wrong', password: 'brand-new-pass' })).status, 401);
  const other = new Client(srv.base);
  await other.post('/api/auth/login', { username: c.username, password: MEMBER_PASSWORD });
  assert.strictEqual((await c.post('/api/me/password', { current: MEMBER_PASSWORD, password: 'brand-new-pass' })).status, 200);
  assert.strictEqual((await c.get('/api/pages')).status, 200, 'still signed in where you changed it');
  assert.strictEqual((await other.get('/api/pages')).status, 401, 'signed out on other devices');
});

test('the last admin cannot be removed or demoted, and you cannot remove yourself', async () => {
  const admin = await srv.admin();
  assert.strictEqual((await admin.del('/api/users/root')).status, 400);
  assert.strictEqual((await admin.request('PATCH', '/api/users/root', { json: { admin: false } })).status, 400);
  await admin.post('/api/users', { username: 'second', name: 'Second', password: 'second-admin-pw' });
  assert.strictEqual((await admin.request('PATCH', '/api/users/second', { json: { admin: true } })).data.user.admin, true);
  const second = new Client(srv.base);
  await second.post('/api/auth/login', { username: 'second', password: 'second-admin-pw' });
  assert.strictEqual((await second.get('/api/users')).status, 200, 'promoted person is an admin');
});

test('private page unlocks are remembered on the account, across sign-outs and devices', async () => {
  const admin = await srv.admin();
  await admin.post('/api/users', { username: 'keeper', name: 'Keeper', password: 'keeper-password' });
  const laptop = new Client(srv.base);
  await laptop.post('/api/auth/login', { username: 'keeper', password: 'keeper-password' });
  // A new private page, created by this person
  assert.strictEqual((await laptop.post('/api/pages/keepsake/password', { password: 'keep1234' })).status, 200);
  assert.strictEqual((await laptop.save('keepsake', 'mine')).status, 200);
  const listed = (await laptop.get('/api/pages')).data.find(p => p.name === 'keepsake');
  assert.ok(listed && !listed.locked && listed.title === 'mine', 'creator sees it unlocked in the list');

  // Sign out and back in, and on another device: still unlocked
  await laptop.post('/api/auth/logout');
  await laptop.post('/api/auth/login', { username: 'keeper', password: 'keeper-password' });
  assert.strictEqual((await laptop.get('/api/pages/keepsake')).data.text, 'mine');
  const phone = new Client(srv.base);
  await phone.post('/api/auth/login', { username: 'keeper', password: 'keeper-password' });
  assert.strictEqual((await phone.get('/api/pages/keepsake')).status, 200);
  assert.ok((await phone.get('/api/session')).data.unlocked.includes('keepsake'));

  // Someone else sees it listed but locked
  const other = srv.client('Other');
  const seen = (await other.get('/api/pages')).data.find(p => p.name === 'keepsake');
  assert.ok(seen && seen.locked);
  assert.strictEqual((await other.get('/api/pages/keepsake')).status, 401);
  await other.unlock('page', 'keep1234', 'keepsake');
  assert.strictEqual((await other.get('/api/pages/keepsake')).status, 200);

  // Renaming keeps it unlocked for everyone who had it
  assert.strictEqual((await laptop.post('/api/pages/keepsake/rename', { to: 'keepsake2' })).status, 200);
  assert.strictEqual((await other.get('/api/pages/keepsake2')).status, 200);
  assert.strictEqual((await phone.get('/api/pages/keepsake2')).status, 200);

  // Changing the password re-locks it for others (the changer keeps access)
  await laptop.post('/api/pages/keepsake2/password', { password: 'newkeep1' });
  assert.strictEqual((await other.get('/api/pages/keepsake2')).status, 401);
  assert.strictEqual((await phone.get('/api/pages/keepsake2')).status, 200, 'same account keeps access');

  // "Lock it again for me" works across devices too
  await phone.post('/api/lock', { scope: 'page', page: 'keepsake2' });
  assert.strictEqual((await phone.get('/api/pages/keepsake2')).status, 401);
  assert.strictEqual((await laptop.get('/api/pages/keepsake2')).status, 200, 'this browser keeps its own unlock');
  await laptop.post('/api/lock', { all: true });
  assert.strictEqual((await laptop.get('/api/pages/keepsake2')).status, 401);
});

test('an empty page can be created right away', async () => {
  const c = srv.client();
  assert.strictEqual((await c.save('blank-start', '')).status, 200);
  assert.ok((await c.get('/api/pages')).data.some(p => p.name === 'blank-start'));
});

test('share links still work without signing in', async () => {
  const c = srv.client();
  await c.save('shareme', 'public recipe');
  const { token } = (await c.post('/api/pages/shareme/shares')).data;
  const anon = srv.anon();
  assert.strictEqual((await anon.get(`/s/${token}`)).status, 200);
  assert.strictEqual((await anon.get(`/api/share/${token}`)).data.text, 'public recipe');
  assert.strictEqual((await anon.get('/api/pages/shareme')).status, 401);
});

test('first run: the setup code creates the first admin, once', async () => {
  const fresh = await startServer({ users: [] });
  try {
    const anon = fresh.anon();
    assert.strictEqual((await anon.get('/api/auth/status')).data.setupRequired, true);
    const code = fs.readFileSync(path.join(fresh.dataDir, '.noter', 'setup-code'), 'utf-8').trim();
    assert.match(code, /^[0-9A-F]{5}-[0-9A-F]{5}$/);

    const bad = await anon.post('/api/auth/setup', { code: 'WRONG-CODE', username: 'brody', password: 'long-enough-pw' });
    assert.strictEqual(bad.status, 401);
    const ok = await anon.post('/api/auth/setup', { code: code.toLowerCase(), username: 'brody', name: 'Brody', password: 'long-enough-pw' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.data.user, { username: 'brody', name: 'Brody', admin: true });
    assert.strictEqual((await anon.get('/api/pages')).status, 200, 'signed in right away');
    assert.ok(!fs.existsSync(path.join(fresh.dataDir, '.noter', 'setup-code')), 'code is used up');

    const again = await fresh.anon().post('/api/auth/setup', { code, username: 'intruder', password: 'long-enough-pw' });
    assert.strictEqual(again.status, 409);
  } finally {
    fresh.close();
  }
});

test('first run: the legacy admin password also works as a setup code', async () => {
  const fresh = await startServer({ users: [], passwords: { admin: 'old-admin-pw' } });
  try {
    const res = await fresh.anon().post('/api/auth/setup', { code: 'old-admin-pw', username: 'boss', password: 'long-enough-pw' });
    assert.strictEqual(res.status, 200);
  } finally {
    fresh.close();
  }
});

// Runs last: locks out this IP
test('sign-in attempts are rate limited', async () => {
  const c = new Client(srv.base);
  let status;
  for (let i = 0; i < 6; i++) status = (await c.post('/api/auth/login', { username: 'root', password: `guess${i}` })).status;
  assert.strictEqual(status, 429);
  assert.strictEqual((await c.post('/api/auth/login', { username: 'root', password: ROOT.password })).status, 429);
});
