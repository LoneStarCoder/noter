const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { safeName, sanitizeFileName, uniqueFileName, cleanDisplayName } = require('./lib/util');
const { PasswordStore, RESERVED_KEYS, verifyPassword } = require('./lib/passwords');
const { createSessions } = require('./lib/session');
const { createFailureLimiter } = require('./lib/limiter');
const { NoteStore } = require('./lib/notes');
const { ShareStore } = require('./lib/shares');
const { createLiveHub } = require('./lib/live');
const { createBackups, fullBackupEntries } = require('./lib/backups');
const { writeZip } = require('./lib/zip');
const { UserStore, normalizeUsername } = require('./lib/users');

const TEXT_PREVIEW_PATTERN = /\.(txt|md|csv|json|xml|html|css|js|py|sh|yml|yaml|log)$/i;
const INLINE_IMAGE_PATTERN = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const HOME_PAGE = 'home';
const MIN_PASSWORD_LENGTH = 4;
const PUBLIC_DIR = path.join(__dirname, 'public');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// Secret for signing session cookies: $NOTER_SECRET or generated once and
// kept in the data dir so sessions survive restarts.
function loadSecret(dataDir) {
  if (process.env.NOTER_SECRET) return process.env.NOTER_SECRET;
  const file = path.join(dataDir, '.noter', 'secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true, extra });
}

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.NOTER_DATA_DIR || path.join(__dirname, 'persistent');
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const secret = options.secret || loadSecret(dataDir);
  const passwords = new PasswordStore({ dataDir, initial: options.passwords });
  const users = new UserStore(dataDir, options.users);
  const sessions = createSessions(secret);
  const notes = new NoteStore(dataDir);
  const shares = new ShareStore(dataDir);
  const live = createLiveHub();
  const backups = createBackups(dataDir);
  const limiter = createFailureLimiter({
    maxFailures: options.maxPasswordFailures || 10,
    windowMs: options.failureWindowMs || 15 * 60 * 1000
  });
  const maxUploadBytes = options.maxUploadBytes || Number(process.env.NOTER_MAX_UPLOAD_MB || 50) * 1024 * 1024;
  const maxUploadFiles = options.maxUploadFiles || 20;
  const maxNoteSize = options.maxNoteSize || process.env.NOTER_MAX_NOTE_SIZE || '5mb';

  if (options.backgroundJobs) {
    if (users.count() === 0) {
      console.log(`Noter setup: no accounts yet. Open /login and create the first (admin) account with setup code ${users.setupCode()}`);
    }
    backups.schedule();
    notes.purgeExpiredTrash();
    setInterval(() => notes.purgeExpiredTrash(), 6 * 60 * 60 * 1000).unref();
  }

  // ---------- Access control ----------

  const fingerprint = key => passwords.fingerprint(key, secret);

  function session(req) {
    if (!req.noterSession) req.noterSession = sessions.read(req);
    return req.noterSession;
  }

  // The signed-in account, or null. A session only counts while its token
  // version matches the account (password changes and removals revoke it).
  function currentUser(req) {
    if (req.noterUser !== undefined) return req.noterUser;
    const s = session(req);
    const user = s.u ? users.get(s.u) : null;
    req.noterUser = user && user.version === s.v ? { username: normalizeUsername(s.u), name: user.name, admin: Boolean(user.admin) } : null;
    return req.noterUser;
  }

  // Account admins, plus the legacy "admin" password from protected_pages.json
  function isAdmin(req) {
    const user = currentUser(req);
    if (user && user.admin) return true;
    return passwords.has('admin') && session(req).a === fingerprint('admin');
  }

  // Everyone who is signed in can use the shared file manager
  function canUseFiles(req) {
    return Boolean(currentUser(req));
  }

  function isProtected(name) {
    return passwords.has(name);
  }

  function canAccessPage(req, name) {
    if (!isProtected(name) || isAdmin(req)) return true;
    return session(req).p[name] === fingerprint(name);
  }

  // Updates the session cookie; stale grants (changed passwords) are dropped
  function updateSession(req, res, change) {
    const current = session(req);
    change(current);
    for (const [page, fp] of Object.entries(current.p)) {
      if (fp !== fingerprint(page)) delete current.p[page];
    }
    if (current.f && current.f !== fingerprint('files')) current.f = null;
    if (current.a && current.a !== fingerprint('admin')) current.a = null;
    if (current.u) {
      const user = users.get(current.u);
      if (!user || user.version !== current.v) {
        current.u = null;
        current.v = null;
      }
    }
    sessions.write(req, res, current);
    req.noterUser = undefined;
  }

  // Name shown for edits, history and presence: the signed-in account's name
  function by(req) {
    const user = currentUser(req);
    return user ? user.name : cleanDisplayName(req.get('X-Noter-User'));
  }

  // ---------- Middleware ----------

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    next();
  });

  // CSRF defence for cookie auth: state-changing requests must carry a custom
  // header (forces a CORS preflight) and, if the browser sends an Origin, it
  // must be ours.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Noter') !== '1') {
      return res.status(403).json({ success: false, message: 'Missing X-Noter header' });
    }
    const origin = req.get('Origin');
    if (origin && origin !== 'null') {
      let host;
      try {
        host = new URL(origin).host;
      } catch (err) {
        host = null;
      }
      if (host !== req.get('Host')) return res.status(403).json({ success: false, message: 'Cross-origin request' });
    }
    next();
  });

  app.use(express.json({ limit: maxNoteSize }));

  function pageParam(req, res, next) {
    const name = safeName(req.params.name);
    if (!name) return next(httpError(400, 'Invalid page name'));
    if (RESERVED_KEYS.includes(name.toLowerCase())) return next(httpError(400, `"${name}" is a reserved name`));
    req.pageName = name;
    next();
  }

  function requirePageAccess(req, res, next) {
    if (!canAccessPage(req, req.pageName)) {
      return res.status(401).json({ success: false, locked: true, message: 'This page is password protected' });
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Admin access required' });
    next();
  }

  function requireFiles(req, res, next) {
    if (!canUseFiles(req)) return res.status(401).json({ success: false, signIn: true, message: 'Please sign in' });
    next();
  }

  // ---------- Sign-in (public) ----------

  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

  app.get('/api/auth/status', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ user: currentUser(req), setupRequired: users.count() === 0 });
  });

  function signIn(req, res, username) {
    const user = users.get(username);
    // A new sign-in starts clean: no page unlocks carried over from someone else
    const s = session(req);
    s.u = normalizeUsername(username);
    s.v = user.version;
    s.p = {};
    s.f = null;
    s.a = null;
    sessions.write(req, res, s);
    req.noterUser = undefined;
  }

  function rateLimited(req, res) {
    if (!limiter.isBlocked(req.ip)) return false;
    res.status(429).json({ success: false, message: 'Too many failed attempts. Try again in a few minutes.' });
    return true;
  }

  app.post('/api/auth/login', (req, res) => {
    if (rateLimited(req, res)) return;
    const { username, password } = req.body || {};
    const account = users.authenticate(username, password);
    if (!account) {
      limiter.recordFailure(req.ip);
      return res.status(401).json({ success: false, message: 'Wrong username or password' });
    }
    signIn(req, res, account);
    res.json({ success: true, user: currentUser(req) });
  });

  app.post('/api/auth/logout', (req, res) => {
    sessions.write(req, res, { u: null, v: null, p: {}, f: null, a: null });
    res.json({ success: true });
  });

  // First account: needs the one-time setup code from the server log (or the
  // legacy admin password from protected_pages.json)
  app.post('/api/auth/setup', (req, res, next) => {
    if (users.count() > 0) return next(httpError(409, 'Noter is already set up. Please sign in.'));
    if (rateLimited(req, res)) return;
    const { code, username, name, password } = req.body || {};
    const legacyAdmin = passwords.has('admin') && passwords.verify('admin', typeof code === 'string' ? code : '');
    if (!users.checkSetupCode(code) && !legacyAdmin) {
      limiter.recordFailure(req.ip);
      return res.status(401).json({ success: false, message: 'That setup code is not right' });
    }
    try {
      users.addUser({ username, name, password, admin: true });
    } catch (err) {
      return next(err);
    }
    users.finishSetup();
    signIn(req, res, username);
    res.json({ success: true, user: currentUser(req) });
  });

  // ---------- Everything below requires a signed-in account ----------

  const PUBLIC_FILES = new Set(['/app.css', '/sw.js', '/manifest.webmanifest', '/login.html', '/share.html']);
  const PUBLIC_PREFIXES = ['/js/', '/vendor/', '/icons/', '/s/', '/api/share/'];

  app.use((req, res, next) => {
    if (currentUser(req)) return next();
    if (PUBLIC_FILES.has(req.path) || PUBLIC_PREFIXES.some(prefix => req.path.startsWith(prefix))) return next();
    // Page loads (browsers ask for text/html) go to the sign-in page; API calls get a 401
    const wantsPage = /text\/html/.test(req.get('Accept') || '');
    if ((req.method === 'GET' || req.method === 'HEAD') && wantsPage && !req.path.startsWith('/api/')) {
      const target = req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//') ? req.originalUrl : '/';
      return res.redirect(`/login?next=${encodeURIComponent(target)}`);
    }
    res.status(401).json({ success: false, signIn: true, message: 'Please sign in' });
  });

  // ---------- Static pages ----------

  const vendor = {
    'marked.esm.js': path.join(path.dirname(require.resolve('marked')), 'marked.esm.js'),
    'purify.es.mjs': path.join(path.dirname(require.resolve('dompurify')), 'purify.es.mjs'),
    'diff3.mjs': path.join(path.dirname(require.resolve('node-diff3')), 'diff3.mjs')
  };
  app.get('/vendor/:file', (req, res, next) => {
    const file = vendor[req.params.file];
    if (!file) return next();
    res.type('application/javascript').sendFile(file, { maxAge: '1d' });
  });

  app.get(['/person/:name', '/p/:name'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.get('/s/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'share.html')));
  app.use(express.static(PUBLIC_DIR));

  // ---------- Session / unlock ----------

  app.get('/api/session', (req, res) => {
    const s = session(req);
    res.set('Cache-Control', 'no-store').json({
      user: currentUser(req),
      admin: isAdmin(req),
      adminConfigured: passwords.has('admin'),
      files: canUseFiles(req),
      filesConfigured: passwords.has('files'),
      unlocked: Object.keys(s.p).filter(page => s.p[page] === fingerprint(page))
    });
  });

  app.post('/api/unlock', (req, res, next) => {
    const { scope, password } = req.body || {};
    if (typeof password !== 'string' || !password) return next(httpError(400, 'Password required'));
    let key;
    if (scope === 'page') {
      key = safeName(req.body.page);
      if (!key || RESERVED_KEYS.includes(key)) return next(httpError(400, 'Invalid page name'));
      if (!isProtected(key)) return res.json({ success: true });
    } else if (scope === 'files' || scope === 'admin') {
      key = scope;
      if (!passwords.has(key)) return next(httpError(403, `No ${scope} password is configured`));
    } else {
      return next(httpError(400, 'Invalid scope'));
    }

    if (limiter.isBlocked(req.ip)) {
      return res.status(429).json({ success: false, message: 'Too many failed attempts. Try again later.' });
    }
    if (!passwords.verify(key, password)) {
      limiter.recordFailure(req.ip);
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }
    updateSession(req, res, s => {
      if (scope === 'page') s.p[key] = fingerprint(key);
      if (scope === 'files') s.f = fingerprint('files');
      if (scope === 'admin') s.a = fingerprint('admin');
    });
    res.json({ success: true });
  });

  app.post('/api/lock', (req, res) => {
    const { scope, page, all } = req.body || {};
    updateSession(req, res, s => {
      if (all) {
        s.p = {};
        s.f = null;
        s.a = null;
      } else if (scope === 'page') {
        delete s.p[safeName(page)];
      } else if (scope === 'files') {
        s.f = null;
      } else if (scope === 'admin') {
        s.a = null;
      }
    });
    res.json({ success: true });
  });

  // ---------- Pages ----------

  app.get('/api/pages', (req, res) => {
    const pages = notes.list()
      .filter(p => canAccessPage(req, p.name))
      .map(p => ({ ...p, protected: isProtected(p.name) }))
      .sort((a, b) => (b.name === HOME_PAGE) - (a.name === HOME_PAGE) || b.updatedAt - a.updatedAt);
    res.set('Cache-Control', 'no-store').json(pages);
  });

  app.get('/api/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const names = notes.list().map(p => p.name).filter(name => canAccessPage(req, name));
    res.set('Cache-Control', 'no-store').json(notes.search(names, q));
  });

  app.get('/api/pages/:name', pageParam, requirePageAccess, (req, res) => {
    const page = notes.read(req.pageName);
    const isProt = isProtected(req.pageName);
    res.set({ 'Cache-Control': 'no-store', 'X-Noter-Protected': isProt ? '1' : '0' });
    res.json({
      name: req.pageName,
      text: page.text,
      version: page.version,
      updatedAt: page.updatedAt,
      updatedBy: page.updatedBy,
      exists: page.exists,
      protected: isProt,
      // How you get in: 'public', 'password' (unlocked on this device) or
      // 'admin' (admins can open private pages without the password)
      access: !isProt ? 'public' : (session(req).p[req.pageName] === fingerprint(req.pageName) ? 'password' : 'admin'),
      viewers: live.presence(req.pageName)
    });
  });

  app.put('/api/pages/:name', pageParam, requirePageAccess, (req, res, next) => {
    const { text, baseVersion, force, snapshot } = req.body || {};
    // Rejecting non-JSON bodies also stops cross-site form posts from blanking a page
    if (typeof text !== 'string') return next(httpError(400, 'Expected JSON body with a "text" string'));
    const result = notes.save(req.pageName, text, {
      baseVersion: typeof baseVersion === 'string' ? baseVersion : undefined,
      force: force === true,
      snapshot: snapshot === true,
      by: by(req)
    });
    if (result.status === 'conflict') {
      return res.status(409).json({
        success: false,
        conflict: true,
        message: 'Page was changed by someone else',
        text: result.current.text,
        version: result.current.version,
        updatedBy: result.current.updatedBy,
        bothText: result.bothText
      });
    }
    if (!result.unchanged) {
      live.broadcast(req.pageName, 'update', {
        version: result.version,
        by: by(req),
        clientId: req.get('X-Noter-Client') || ''
      });
    }
    res.json({ success: true, version: result.version, merged: result.merged, text: result.merged ? result.text : undefined });
  });

  app.delete('/api/pages/:name', pageParam, requirePageAccess, (req, res, next) => {
    const name = req.pageName;
    if (name === HOME_PAGE) return next(httpError(403, 'The home page cannot be deleted'));
    if (!notes.exists(name)) return next(httpError(404, 'Page not found'));
    const passwordEntry = passwords.getRaw(name);
    const trashId = notes.trash(name, { by: by(req), passwordEntry });
    if (passwordEntry) passwords.setRaw(name, null);
    shares.removePage(name);
    live.broadcast(name, 'deleted', { by: by(req) });
    res.json({ success: true, trashId });
  });

  app.post('/api/pages/:name/rename', pageParam, requirePageAccess, (req, res, next) => {
    const from = req.pageName;
    const to = safeName(req.body && req.body.to);
    if (from === HOME_PAGE) return next(httpError(403, 'The home page cannot be renamed'));
    if (!to || RESERVED_KEYS.includes(to.toLowerCase())) return next(httpError(400, 'Invalid new name'));
    if (!notes.exists(from)) return next(httpError(404, 'Page not found'));
    if (to === from) return res.json({ success: true, name: to });
    if (notes.exists(to) || isProtected(to)) return next(httpError(409, `A page named "${to}" already exists`));

    notes.rename(from, to);
    const entry = passwords.getRaw(from);
    if (entry) {
      passwords.setRaw(to, entry);
      passwords.setRaw(from, null);
      updateSession(req, res, s => {
        delete s.p[from];
        s.p[to] = fingerprint(to);
      });
    }
    shares.renamePage(from, to);
    live.broadcast(from, 'renamed', { to, by: by(req) });
    res.json({ success: true, name: to });
  });

  // Set, change or remove (password: null) a page password.
  // Anyone may make a new or empty page private; locking an existing public
  // page with content needs the admin, so nobody can lock others out.
  app.post('/api/pages/:name/password', pageParam, requirePageAccess, (req, res, next) => {
    const name = req.pageName;
    const { password } = req.body || {};
    if (password !== null && (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200)) {
      return next(httpError(400, `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters`));
    }
    if (name === HOME_PAGE && password !== null && !isAdmin(req)) {
      return next(httpError(403, 'Only the admin can lock the home page'));
    }
    if (!isProtected(name)) {
      if (password === null) return res.json({ success: true, protected: false });
      const current = notes.read(name);
      if (current.exists && current.text.trim() !== '' && !isAdmin(req)) {
        return next(httpError(403, 'Only the admin can lock an existing page. New pages can be made private when created.'));
      }
    }
    passwords.set(name, password);
    updateSession(req, res, s => {
      if (password === null) delete s.p[name];
      else s.p[name] = fingerprint(name);
    });
    live.broadcast(name, 'protection', { protected: password !== null, by: by(req) });
    res.json({ success: true, protected: password !== null });
  });

  // ---------- History ----------

  app.get('/api/pages/:name/history', pageParam, requirePageAccess, (req, res) => {
    const entries = notes.listHistory(req.pageName).map(({ file, ...entry }) => entry);
    res.set('Cache-Control', 'no-store').json(entries);
  });

  app.get('/api/pages/:name/history/:id', pageParam, requirePageAccess, (req, res, next) => {
    const entry = notes.readHistory(req.pageName, req.params.id);
    if (!entry) return next(httpError(404, 'Version not found'));
    const { file, ...rest } = entry;
    res.set('Cache-Control', 'no-store').json(rest);
  });

  app.post('/api/pages/:name/restore', pageParam, requirePageAccess, (req, res, next) => {
    const result = notes.restore(req.pageName, String((req.body && req.body.id) || ''), by(req));
    if (!result) return next(httpError(404, 'Version not found'));
    live.broadcast(req.pageName, 'update', { version: result.version, by: by(req), clientId: req.get('X-Noter-Client') || '' });
    res.json({ success: true, version: result.version, text: result.text });
  });

  // ---------- Attachments ----------

  function attachmentUpload(dirFor) {
    return multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => {
          try {
            const dir = dirFor(req);
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
          } catch (err) {
            cb(err);
          }
        },
        // Names are reserved per request: files in one upload are written
        // concurrently, so the disk alone can't tell us a name is taken.
        filename: (req, file, cb) => {
          req.reservedNames = req.reservedNames || new Set();
          const name = uniqueFileName(dirFor(req), sanitizeFileName(file.originalname), req.reservedNames);
          req.reservedNames.add(name);
          cb(null, name);
        }
      }),
      defParamCharset: 'utf8',
      limits: { fileSize: maxUploadBytes, files: maxUploadFiles, fields: 10, parts: maxUploadFiles + 10 }
    });
  }

  const pageAttachmentUpload = attachmentUpload(req => notes.attachmentsDir(req.pageName));

  function attachmentUrl(page, file) {
    return `/api/pages/${encodeURIComponent(page)}/attachments/${encodeURIComponent(file)}`;
  }

  function resolveAttachment(dir, rawName) {
    const file = path.basename(String(rawName || ''));
    if (!file || file === '.' || file === '..') return null;
    const full = path.join(dir, file);
    return fs.existsSync(full) && fs.statSync(full).isFile() ? { file, full } : null;
  }

  // Serves an uploaded file safely: sandboxed, and only images inline
  function sendUserFile(res, full, file) {
    res.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    if (INLINE_IMAGE_PATTERN.test(file)) {
      res.set('Cache-Control', 'private, max-age=3600');
      return res.sendFile(full);
    }
    res.download(full, file);
  }

  app.get('/api/pages/:name/attachments', pageParam, requirePageAccess, (req, res) => {
    const dir = notes.attachmentsDir(req.pageName);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => !f.endsWith('.tmp')) : [];
    res.json(files.map(name => ({
      name,
      size: fs.statSync(path.join(dir, name)).size,
      url: attachmentUrl(req.pageName, name)
    })));
  });

  app.post('/api/pages/:name/attachments', pageParam, requirePageAccess, pageAttachmentUpload.array('files'), (req, res, next) => {
    if (!req.files || req.files.length === 0) return next(httpError(400, 'No files provided'));
    res.json({
      success: true,
      files: req.files.map(f => ({ name: f.filename, size: f.size, url: attachmentUrl(req.pageName, f.filename) }))
    });
  });

  app.get('/api/pages/:name/attachments/:file', pageParam, requirePageAccess, (req, res, next) => {
    const found = resolveAttachment(notes.attachmentsDir(req.pageName), req.params.file);
    if (!found) return next(httpError(404, 'Attachment not found'));
    sendUserFile(res, found.full, found.file);
  });

  app.delete('/api/pages/:name/attachments/:file', pageParam, requirePageAccess, (req, res, next) => {
    const found = resolveAttachment(notes.attachmentsDir(req.pageName), req.params.file);
    if (!found) return next(httpError(404, 'Attachment not found'));
    fs.unlinkSync(found.full);
    res.json({ success: true });
  });

  // ---------- Share links ----------

  app.get('/api/pages/:name/shares', pageParam, requirePageAccess, (req, res) => {
    res.json(shares.forPage(req.pageName).map(s => ({ ...s, url: `/s/${s.token}` })));
  });

  app.post('/api/pages/:name/shares', pageParam, requirePageAccess, (req, res, next) => {
    if (!notes.exists(req.pageName)) return next(httpError(404, 'Save the page before sharing it'));
    const token = shares.create(req.pageName, by(req));
    res.json({ success: true, token, url: `/s/${token}` });
  });

  app.delete('/api/shares/:token', (req, res, next) => {
    const share = shares.get(req.params.token);
    if (!share) return next(httpError(404, 'Share link not found'));
    if (!canAccessPage(req, share.page)) return res.status(401).json({ success: false, locked: true });
    shares.revoke(req.params.token);
    res.json({ success: true });
  });

  function requireShare(req, res, next) {
    const share = shares.get(req.params.token);
    if (!share || !notes.exists(share.page)) return next(httpError(404, 'This link is no longer valid'));
    req.share = share;
    next();
  }

  app.get('/api/share/:token', requireShare, (req, res) => {
    const page = notes.read(req.share.page);
    res.set('Cache-Control', 'no-store').json({
      name: req.share.page,
      text: page.text,
      updatedAt: page.updatedAt,
      updatedBy: page.updatedBy
    });
  });

  app.get('/api/share/:token/attachments/:file', requireShare, (req, res, next) => {
    const found = resolveAttachment(notes.attachmentsDir(req.share.page), req.params.file);
    if (!found) return next(httpError(404, 'Attachment not found'));
    sendUserFile(res, found.full, found.file);
  });

  // ---------- Live updates ----------

  app.get('/api/pages/:name/events', pageParam, requirePageAccess, (req, res) => {
    const clientId = typeof req.query.client === 'string' ? req.query.client.slice(0, 40) : '';
    const user = by(req) || 'Someone';
    if (!live.join(req, res, req.pageName, { clientId, user })) {
      res.status(503).json({ success: false, message: 'Too many live connections' });
    }
  });

  // ---------- Trash ----------

  app.get('/api/trash', (req, res) => {
    const admin = isAdmin(req);
    res.set('Cache-Control', 'no-store').json(notes.listTrash().filter(entry => admin || !entry.protected));
  });

  app.post('/api/trash/:id/restore', (req, res, next) => {
    const meta = notes.readTrashMeta(req.params.id);
    if (!meta) return next(httpError(404, 'Not found in trash'));
    if (meta.passwordEntry && !isAdmin(req)) {
      const password = req.body && req.body.password;
      if (limiter.isBlocked(req.ip)) {
        return res.status(429).json({ success: false, message: 'Too many failed attempts. Try again later.' });
      }
      if (!verifyPassword(password, meta.passwordEntry)) {
        if (password) limiter.recordFailure(req.ip);
        return res.status(401).json({ success: false, locked: true, message: 'Password required to restore this page' });
      }
    }
    let name = notes.freeName(meta.name);
    while (isProtected(name)) name = notes.freeName(`${name}-x`);
    notes.restoreFromTrash(req.params.id, name);
    if (meta.passwordEntry) {
      passwords.setRaw(name, meta.passwordEntry);
      updateSession(req, res, s => {
        s.p[name] = fingerprint(name);
      });
    }
    res.json({ success: true, name });
  });

  app.delete('/api/trash/:id', requireAdmin, (req, res, next) => {
    if (!notes.purgeTrash(req.params.id)) return next(httpError(404, 'Not found in trash'));
    res.json({ success: true });
  });

  // ---------- Admin ----------

  app.post('/api/admin/password', requireAdmin, (req, res, next) => {
    const { key, password } = req.body || {};
    if (!['files', 'admin'].includes(key)) return next(httpError(400, 'Invalid key'));
    if (key === 'admin' && password === null) return next(httpError(400, 'The admin password cannot be removed here'));
    if (password !== null && (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)) {
      return next(httpError(400, `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters`));
    }
    passwords.set(key, password);
    updateSession(req, res, s => {
      if (key === 'admin') s.a = fingerprint('admin');
    });
    res.json({ success: true });
  });

  app.get('/api/admin/backup', requireAdmin, async (req, res, next) => {
    const date = new Date().toISOString().slice(0, 10);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="noter-backup-${date}.zip"` });
    try {
      await writeZip(res, fullBackupEntries(dataDir));
      res.end();
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/backups', requireAdmin, (req, res) => res.json(backups.list()));

  app.get('/api/admin/backups/:file', requireAdmin, (req, res, next) => {
    const file = backups.file(req.params.file);
    if (!file) return next(httpError(404, 'Backup not found'));
    res.download(file);
  });

  // ---------- Your account ----------

  app.put('/api/me', (req, res) => {
    const user = currentUser(req);
    const updated = users.update(user.username, { name: req.body && req.body.name });
    res.json({ success: true, user: updated });
  });

  app.post('/api/me/password', (req, res, next) => {
    const user = currentUser(req);
    const { current, password } = req.body || {};
    if (rateLimited(req, res)) return;
    if (!users.authenticate(user.username, current)) {
      limiter.recordFailure(req.ip);
      return next(httpError(401, 'Your current password is not right'));
    }
    users.setPassword(user.username, password);
    signIn(req, res, user.username); // stay signed in here; other devices are signed out
    res.json({ success: true });
  });

  app.post('/api/me/signout-everywhere', (req, res) => {
    const user = currentUser(req);
    users.revokeSessions(user.username);
    signIn(req, res, user.username);
    res.json({ success: true });
  });

  // ---------- People (admin) ----------

  app.get('/api/users', requireAdmin, (req, res) => {
    res.set('Cache-Control', 'no-store').json(users.list());
  });

  app.post('/api/users', requireAdmin, (req, res) => {
    const { username, name, password, admin } = req.body || {};
    res.json({ success: true, user: users.addUser({ username, name, password, admin: admin === true }) });
  });

  app.patch('/api/users/:username', requireAdmin, (req, res) => {
    const { name, admin } = req.body || {};
    const updated = users.update(req.params.username, {
      name: typeof name === 'string' ? name : undefined,
      admin: typeof admin === 'boolean' ? admin : undefined
    });
    res.json({ success: true, user: updated });
  });

  app.post('/api/users/:username/password', requireAdmin, (req, res) => {
    users.setPassword(req.params.username, req.body && req.body.password);
    if (normalizeUsername(req.params.username) === currentUser(req).username) signIn(req, res, req.params.username);
    res.json({ success: true });
  });

  app.delete('/api/users/:username', requireAdmin, (req, res, next) => {
    if (normalizeUsername(req.params.username) === currentUser(req).username) {
      return next(httpError(400, 'You can’t remove your own account'));
    }
    users.remove(req.params.username);
    res.json({ success: true });
  });

  // ---------- File manager (any signed-in account) ----------

  function getSafeUploadPath(folder, filename) {
    if (typeof folder !== 'string' || typeof filename !== 'string') return null;
    if (folder.includes('\0') || filename.includes('\0')) return null;
    const normalized = path.normalize(path.join(folder, filename));
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
    const full = path.join(uploadsDir, normalized);
    if (full !== uploadsDir && !full.startsWith(uploadsDir + path.sep)) return null;
    return full;
  }

  function resolveFolder(source, param) {
    return (req, res, next) => {
      const value = req[source] && req[source][param] !== undefined ? req[source][param] : '';
      const dir = getSafeUploadPath(value, '');
      if (!dir) return res.status(400).json({ success: false, message: 'Invalid folder path' });
      req.folderPath = dir;
      next();
    };
  }

  function resolveExistingFile(req, res, next) {
    const filename = path.basename(req.params.filename);
    const filepath = ['', '.', '..'].includes(filename) ? null : path.join(req.folderPath, filename);
    if (!filepath || !fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }
    req.filename = filename;
    req.filePath = filepath;
    next();
  }

  const fileManagerUpload = attachmentUpload(req => {
    if (!fs.existsSync(req.folderPath)) throw httpError(400, 'Folder does not exist');
    return req.folderPath;
  });

  app.post('/upload', requireFiles, resolveFolder('query', 'folder'), fileManagerUpload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.json({ success: false, message: 'No files provided' });
    }
    res.json({ success: true, count: req.files.length, files: req.files.map(f => f.filename) });
  });

  app.get('/list-files', requireFiles, resolveFolder('query', 'folder'), (req, res) => {
    try {
      const result = fs.readdirSync(req.folderPath).filter(n => !n.endsWith('.tmp')).map(name => {
        const stats = fs.statSync(path.join(req.folderPath, name));
        const isDirectory = stats.isDirectory();
        return { name, size: isDirectory ? null : stats.size, isDirectory, modifiedAt: stats.mtimeMs };
      });
      res.json(result);
    } catch (err) {
      res.status(404).json([]);
    }
  });

  app.post('/create-folder', requireFiles, resolveFolder('body', 'parent'), (req, res) => {
    const folderName = safeName(req.body.name);
    if (!folderName) return res.json({ success: false, message: 'Invalid folder name' });
    const folderPath = path.join(req.folderPath, folderName);
    if (fs.existsSync(folderPath)) return res.json({ success: false, message: 'Folder already exists' });
    try {
      fs.mkdirSync(folderPath);
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, message: 'Failed to create folder' });
    }
  });

  app.get('/download/:filename', requireFiles, resolveFolder('query', 'folder'), resolveExistingFile, (req, res) => {
    if (req.query.inline === '1') return sendUserFile(res, req.filePath, req.filename);
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.download(req.filePath, req.filename);
  });

  app.get('/view/:filename', requireFiles, resolveFolder('query', 'folder'), resolveExistingFile, (req, res) => {
    const stats = fs.statSync(req.filePath);
    if (TEXT_PREVIEW_PATTERN.test(req.filename) && stats.size < 5 * 1024 * 1024) {
      try {
        return res.json({ success: true, content: fs.readFileSync(req.filePath, 'utf-8'), isText: true });
      } catch (err) {
        // fall through to "not previewable"
      }
    }
    res.json({ success: true, isText: false });
  });

  app.delete('/delete-file/:filename', requireFiles, resolveFolder('query', 'folder'), resolveExistingFile, (req, res) => {
    try {
      fs.unlinkSync(req.filePath);
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, message: 'Failed to delete file' });
    }
  });

  app.delete('/delete-folder/:foldername', requireFiles, resolveFolder('query', 'parent'), (req, res) => {
    const foldername = safeName(req.params.foldername);
    const folderPath = foldername ? path.join(req.folderPath, foldername) : null;
    if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      return res.json({ success: false, message: 'Folder not found' });
    }
    try {
      fs.rmSync(folderPath, { recursive: true });
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, message: 'Failed to delete folder' });
    }
  });

  // ---------- Errors ----------

  app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Not found' }));

  // Never leak stack traces to clients
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = status < 500 && err.expose !== false ? err.message : 'Internal server error';
    if (err.type === 'entity.too.large') message = `Note too large (max ${maxNoteSize})`;
    if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = err.code === 'LIMIT_FILE_SIZE'
        ? `File too large (max ${Math.round(maxUploadBytes / 1024 / 1024)}MB)`
        : err.message;
    }
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ success: false, message, ...(err.extra || {}) });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp({ backgroundJobs: true }).listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

module.exports = { createApp, sanitizeFileName };
