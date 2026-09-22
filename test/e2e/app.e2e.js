// Browser end-to-end test: starts a real server on a throwaway data dir and
// drives it with several independent browsers (people) at once.
//
// Needs Playwright with Chromium, which is not a project dependency:
//   npm install --no-save playwright && npx playwright install chromium
//   node test/e2e/app.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (err) {
  console.error('Playwright is not installed. See the header of this file.');
  process.exit(2);
}

const PORT = Number(process.env.E2E_PORT || 3471);
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noter-e2e-'));
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readNote = name => fs.readFileSync(path.join(dataDir, `person_${name}.txt`), 'utf-8');
const noteExists = name => fs.existsSync(path.join(dataDir, `person_${name}.txt`));

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    try {
      if (await fn()) return true;
    } catch (err) {
      // retry
    }
    if (Date.now() - start > timeout) return false;
    await sleep(100);
  }
}

function seed() {
  fs.writeFileSync(path.join(dataDir, 'protected_pages.json'), JSON.stringify({ brody: 'brodypw', files: 'filespw', admin: 'adminpw' }));
  const notes = {
    home: 'Welcome to the family notebook!\nSee the [[beachlist]] and github.com/LoneStarCoder.',
    beachlist: '# Beach trip\n- [ ] sunscreen\n- [x] towels\n- [ ] snacks #trip',
    tortillarecipe: 'Tortillas\n2 cups flour\n1 tsp salt\n#recipe',
    shared: 'line one\nline two\nline three\nline four',
    brody: 'Brody private notes',
    xss: 'Hi <img src=x onerror="window.__xss=1"> [click](javascript:window.__xss=2) x.com/"onmouseover="window.__xss=3\n<script>window.__xss=4</script>'
  };
  for (const [name, text] of Object.entries(notes)) fs.writeFileSync(path.join(dataDir, `person_${name}.txt`), text);
}

async function main() {
  seed();
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NOTER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', d => (serverLog += d));
  server.stderr.on('data', d => (serverLog += d));
  await waitFor(async () => (await fetch(BASE + '/api/pages')).ok, 10000);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const consoleProblems = [];

  async function person(name, viewport = { width: 1200, height: 800 }) {
    const context = await browser.newContext({ viewport, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    await context.addInitScript(n => {
      if (!localStorage.getItem('noter-name')) localStorage.setItem('noter-name', n);
    }, name);
    const page = await context.newPage();
    page.on('console', m => {
      if (m.type() === 'error' && !/status of (401|409|404)|ERR_INTERNET_DISCONNECTED/.test(m.text())) consoleProblems.push(`${name}: ${m.text()}`);
    });
    page.on('pageerror', e => consoleProblems.push(`${name} pageerror: ${e.message}`));
    page.on('dialog', d => d.accept());
    return { context, page };
  }

  const editor = page => page.locator('#editor');
  const status = page => page.locator('#save-status');
  async function openEdit(page, name) {
    await page.goto(`${BASE}/person/${name}`);
    await page.waitForSelector('#mode-toggle:not([hidden])');
    await page.click('#mode-toggle button[data-mode=edit]');
    await page.waitForSelector('#editor');
  }
  const saved = page => waitFor(async () => (await status(page).textContent()) === 'Saved' || /Merged/.test(await status(page).textContent()));

  try {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const anon = await person('Visitor');
    const A = alice.page;
    const B = bob.page;

    // ---- Rendering and navigation
    await A.goto(BASE + '/');
    await A.waitForSelector('#preview a.wikilink');
    check('home renders markdown with [[wiki]] and bare-domain links',
      (await A.locator('#preview a.wikilink').textContent()) === 'beachlist' &&
      (await A.locator('#preview a[href="https://github.com/LoneStarCoder"]').count()) === 1);
    await A.click('#preview a.wikilink');
    await A.waitForURL('**/person/beachlist');
    await A.waitForSelector('#preview li.task');
    check('wiki link navigates without a reload', (await A.locator('#page-title').textContent()) === 'beachlist');

    // ---- Checklists tick from the rendered view
    await A.locator('#preview li.task input').first().check();
    await waitFor(() => readNote('beachlist').includes('- [x] sunscreen'));
    check('ticking a checklist item saves it', readNote('beachlist').includes('- [x] sunscreen'), readNote('beachlist').split('\n')[1]);

    // ---- Editor: autosave and list continuation
    await openEdit(A, 'beachlist');
    await editor(A).click();
    await A.keyboard.press('Control+End');
    await A.keyboard.press('Enter');
    await A.keyboard.type('hats');
    await A.keyboard.press('Enter');
    await A.keyboard.type('water');
    await saved(A);
    check('Enter continues a checklist and autosave writes it',
      readNote('beachlist').endsWith('#trip\n- [ ] hats\n- [ ] water'), JSON.stringify(readNote('beachlist').slice(-40)));

    // ---- XSS payloads are inert
    await A.goto(BASE + '/person/xss');
    await A.waitForSelector('#preview');
    await A.hover('#preview').catch(() => {});
    const xss = await A.evaluate(() => ({
      flag: window.__xss,
      imgs: document.querySelectorAll('#preview img[onerror]').length,
      scripts: document.querySelectorAll('#preview script').length,
      jsLinks: [...document.querySelectorAll('#preview a')].filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length,
      handlers: [...document.querySelectorAll('#preview *')].filter(e => [...e.attributes].some(a => a.name.startsWith('on'))).length
    }));
    check('stored XSS payloads do not execute', !xss.flag && !xss.imgs && !xss.scripts && !xss.jsLinks && !xss.handlers, JSON.stringify(xss));

    // ---- Live collaboration: presence and live updates
    await A.goto(BASE + '/person/shared');
    await B.goto(BASE + '/person/shared');
    await A.waitForSelector('#preview');
    await B.waitForSelector('#preview');
    const presenceOk = await waitFor(async () => (await A.locator('#presence .avatar').getAttribute('title')) === 'Bob is here');
    check('presence shows who else is on the page', presenceOk);

    await A.click('#mode-toggle button[data-mode=edit]');
    await editor(A).click();
    await A.keyboard.press('Control+End');
    await A.keyboard.type('\nline five from Alice');
    await saved(A);
    const liveOk = await waitFor(async () => (await B.locator('#preview').textContent()).includes('line five from Alice'));
    check("Bob sees Alice's edit live without reloading", liveOk);
    check('…and is told who changed it', /Updated by Alice/.test(await status(B).textContent()), await status(B).textContent());

    // ---- Simultaneous edits to different lines merge
    await B.click('#mode-toggle button[data-mode=edit]');
    await B.waitForSelector('#editor');
    await bob.context.setOffline(true);
    await editor(B).click();
    await B.keyboard.press('Control+Home');
    await B.keyboard.type('Bob was here: ');
    await sleep(900); // Bob's save fails while offline
    await editor(A).click();
    await A.keyboard.press('Control+End');
    await A.keyboard.type('\nline six from Alice');
    await saved(A);
    await bob.context.setOffline(false);
    await B.evaluate(() => window.dispatchEvent(new Event('online')));
    const mergedOk = await waitFor(() => {
      const text = readNote('shared');
      return text.startsWith('Bob was here: line one') && text.includes('line six from Alice');
    }, 10000);
    check('edits to different lines by two people are merged', mergedOk, JSON.stringify(readNote('shared')));
    const convergeOk = await waitFor(async () => (await editor(A).inputValue()) === readNote('shared') && (await editor(B).inputValue()) === readNote('shared'), 8000);
    check('both screens converge on the merged text', convergeOk);

    // ---- Same line: conflict dialog, keep both
    await bob.context.setOffline(true);
    await editor(B).click();
    await B.keyboard.press('Control+End');
    await B.keyboard.type(' (Bob)');
    await sleep(900);
    await editor(A).click();
    await A.keyboard.press('Control+End');
    await A.keyboard.type(' (Alice)');
    await saved(A);
    B.removeAllListeners('dialog');
    await bob.context.setOffline(false);
    await B.evaluate(() => window.dispatchEvent(new Event('online')));
    const dialogShown = await waitFor(async () => (await B.locator('dialog[open] h2').textContent()) === 'Edited at the same time', 8000);
    check('editing the same line shows a conflict dialog', dialogShown);
    if (dialogShown) await B.click('dialog[open] .btn.primary');
    const bothKept = await waitFor(() => readNote('shared').includes('line six from Alice (Bob)') && readNote('shared').includes('line six from Alice (Alice)'), 6000);
    check('"Keep both" keeps both versions of the line', bothKept, JSON.stringify(readNote('shared').split('\n').slice(-2)));

    // ---- History and restore
    await A.goto(BASE + '/person/shared');
    await A.waitForSelector('#page-menu-btn:not([hidden])');
    await A.click('#page-menu-btn');
    await A.click('.menu >> text=History');
    await A.waitForSelector('dialog[open] .history-layout li.selectable');
    const versions = await A.locator('dialog[open] li.selectable').count();
    check('history lists earlier versions', versions >= 2, `${versions} versions`);
    await A.locator('dialog[open] li.selectable').last().click();
    await A.waitForSelector('dialog[open] .diff');
    await A.click('dialog[open] >> text=Restore this version');
    const restored = await waitFor(() => readNote('shared') === 'line one\nline two\nline three\nline four');
    check('restoring an old version works', restored, JSON.stringify(readNote('shared')));

    // ---- Private pages, unlock, share links
    await A.goto(BASE + '/person/brody');
    await A.waitForSelector('.lock-card input');
    await A.fill('.lock-card input', 'wrong');
    await A.click('.lock-card button');
    await A.waitForSelector('.lock-card .form-error:text("Incorrect password")');
    await A.fill('.lock-card input', 'brodypw');
    await A.click('.lock-card button');
    await A.waitForSelector('#preview');
    check('private page unlocks with the right password', (await A.locator('#preview').textContent()).includes('Brody private notes'));
    const listed = await waitFor(async () => (await A.locator('#page-list a[data-name="brody"]').count()) === 1);
    check('an unlocked private page appears in your sidebar', listed);
    check('…but not in other people\'s', await (async () => {
      await B.goto(BASE + '/');
      await B.waitForSelector('#page-list a');
      return (await B.locator('#page-list a[data-name="brody"]').count()) === 0;
    })());

    await A.click('#page-menu-btn');
    await A.click('.menu >> text=Share read-only link');
    await A.click('dialog[open] >> text=Create link');
    await A.waitForSelector('dialog[open] .share-url input');
    const shareUrl = await A.locator('dialog[open] .share-url input').first().inputValue();
    await A.keyboard.press('Escape');
    await anon.page.goto(shareUrl);
    await anon.page.waitForSelector('#share-content:has-text("Brody private notes")');
    check('share link shows a private page read-only', true);
    await anon.page.goto(BASE + '/person/brody');
    await anon.page.waitForSelector('.lock-card');
    check('…without unlocking the page itself', true);

    // ---- New private page from the dialog
    await A.goto(BASE + '/');
    await A.click('#new-page-btn');
    await A.fill('dialog[open] input.input', 'Gift Ideas');
    await A.check('dialog[open] input[type=checkbox]');
    await A.fill('dialog[open] input[type=password]', 'gifts123');
    await A.click('dialog[open] .btn.primary');
    await A.waitForURL('**/person/gift-ideas');
    await A.waitForSelector('#editor');
    await A.keyboard.type('- [ ] a book for Bob');
    await saved(A);
    await B.goto(BASE + '/person/gift-ideas');
    await B.waitForSelector('.lock-card');
    check('a page made private at creation is hidden from others', noteExists('gift-ideas'));

    // ---- Attachments
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await openEdit(A, 'beachlist');
    await editor(A).click();
    await A.keyboard.press('Control+End');
    await A.setInputFiles('#attach-input', { name: 'beach.png', mimeType: 'image/png', buffer: png });
    await waitFor(async () => (await editor(A).inputValue()).includes('![beach.png](attachments/beach.png)'));
    await saved(A);
    await A.click('#mode-toggle button[data-mode=view]');
    await A.waitForSelector('#preview img');
    const imgOk = await waitFor(() => A.locator('#preview img').evaluate(img => img.complete && img.naturalWidth === 1));
    check('attached image is inserted and displays', imgOk);

    // ---- Search and tags
    await A.keyboard.press('Control+k');
    await A.fill('dialog[open] .switcher-input', 'flour');
    await A.waitForSelector('dialog[open] li.selectable:has-text("tortillarecipe")');
    await A.keyboard.press('Enter');
    await A.waitForURL('**/person/tortillarecipe');
    check('Ctrl+K full-text search finds and opens a page', true);
    await A.click('#tag-row button:has-text("#recipe")');
    const tagged = await A.locator('#page-list a.page-link').evaluateAll(links => links.map(l => l.dataset.name));
    check('tag filter shows only tagged pages', tagged.length === 1 && tagged[0] === 'tortillarecipe', JSON.stringify(tagged));
    await A.click('#tag-row button:has-text("#recipe")');

    // ---- Rename, delete, undo, trash
    await A.goto(BASE + '/person/tortillarecipe');
    await A.waitForSelector('#page-menu-btn:not([hidden])');
    await A.click('#page-menu-btn');
    await A.click('.menu >> text=Rename');
    await A.fill('dialog[open] input', 'tortillas');
    await A.click('dialog[open] .btn.primary');
    await A.waitForURL('**/person/tortillas');
    check('rename moves the page', noteExists('tortillas') && !noteExists('tortillarecipe'));

    await A.click('#page-menu-btn');
    await A.click('.menu >> text=Delete page');
    await A.click('dialog[open] .btn.danger');
    await A.waitForURL(BASE + '/');
    check('delete removes the page', !noteExists('tortillas'));
    await A.click('.toast button:has-text("Undo")');
    await A.waitForURL('**/person/tortillas');
    check('Undo restores the deleted page', noteExists('tortillas'));

    await A.click('#page-menu-btn');
    await A.click('.menu >> text=Delete page');
    await A.click('dialog[open] .btn.danger');
    await A.waitForURL(BASE + '/');
    await A.click('#trash-btn');
    await A.click('dialog[open] li:has-text("tortillas") button:has-text("Restore")');
    await A.waitForURL('**/person/tortillas');
    check('Trash restores a deleted page', noteExists('tortillas'));

    // ---- Settings: display name and dark mode
    await A.click('#settings-btn');
    await A.fill('dialog[open] input.input >> nth=0', 'Alice Smith');
    await A.selectOption('dialog[open] select', 'dark');
    await A.click('dialog[open] .modal-footer .btn.primary');
    check('dark theme applies', (await A.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    await A.goto(BASE + '/person/beachlist');
    await B.goto(BASE + '/person/beachlist');
    const renamedPresence = await waitFor(async () => (await B.locator('#presence .avatar').getAttribute('title')) === 'Alice Smith is here');
    check('your display name is what others see', renamedPresence);

    // ---- Files page
    await A.goto(BASE + '/files.html');
    await A.fill('#password-input', 'filespw');
    await A.click('#unlock-form button');
    await A.waitForSelector('#main-content:not([hidden])');
    await A.setInputFiles('#file-input', [{ name: `it's "fine".txt`, mimeType: 'text/plain', buffer: Buffer.from('hello files') }]);
    await A.waitForSelector('#file-list li:has-text("fine")');
    await A.click('#file-list li:has-text("fine") >> text=View');
    await A.waitForSelector('dialog[open] pre:has-text("hello files")');
    check('file manager uploads and previews files', true);
    await A.keyboard.press('Escape');

    // ---- Admin
    await A.goto(BASE + '/');
    await A.click('#settings-btn');
    await A.fill('dialog[open] input[type=password]', 'adminpw');
    await A.click('dialog[open] >> text=Unlock admin');
    await A.waitForSelector('dialog[open] >> text=Download full backup');
    const [download] = await Promise.all([A.waitForEvent('download'), A.click('dialog[open] >> text=Download full backup')]);
    const zip = fs.readFileSync(await download.path());
    check('admin can download a full backup zip', zip.subarray(0, 2).toString() === 'PK' && zip.length > 500, `${zip.length} bytes`);
    await A.keyboard.press('Escape');

    // ---- Mobile layout
    const phone = await person('Phone', { width: 390, height: 800 });
    await phone.page.goto(BASE + '/person/beachlist');
    await phone.page.waitForSelector('#preview');
    const noOverflow = await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await phone.page.click('#nav-btn');
    await phone.page.waitForTimeout(300);
    await phone.page.click('#page-list a[data-name="home"]');
    await phone.page.waitForURL(BASE + '/');
    check('mobile: no sideways scrolling, drawer navigation works', noOverflow);

    // ---- Offline reading (service worker)
    const reader = await person('Reader');
    await reader.page.goto(BASE + '/person/beachlist');
    await reader.page.waitForSelector('#preview');
    await reader.page.evaluate(() => navigator.serviceWorker.ready);
    await reader.page.reload();
    await reader.page.waitForSelector('#preview');
    await reader.context.setOffline(true);
    await reader.page.reload();
    const offlineOk = await waitFor(async () => (await reader.page.locator('#preview').textContent()).includes('Beach trip'), 5000);
    check('a public page you opened before is readable offline', offlineOk);
    check('offline banner shows', await reader.page.locator('#offline-banner').isVisible());

    check('no unexpected console errors', consoleProblems.length === 0, consoleProblems.slice(0, 5).join(' | '));
  } catch (err) {
    check(`test run crashed: ${err.message.split('\n')[0]}`, false);
    console.error(err);
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
  if (failed && serverLog.trim()) console.log('--- server log ---\n' + serverLog);
  process.exit(failed ? 1 : 0);
}

main();
