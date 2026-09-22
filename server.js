const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const PASSWORD_HEADER = 'x-noter-password';
const MAX_PAGE_NAME_LENGTH = 100;
const MAX_FILE_NAME_LENGTH = 200;
const TEXT_PREVIEW_PATTERN = /\.(txt|md|csv|json|xml|html|css|js|py|sh|yml|yaml|log)$/i;

// Pages that can never be deleted through the API
const UNDELETABLE_PAGES = ['home'];

// Looks for protected_pages.json in (1) $NOTER_PASSWORDS_FILE, (2) the data dir
// (so it can live on a persistent disk), (3) the project root.
function loadProtectedPages(dataDir) {
  const candidates = [
    process.env.NOTER_PASSWORDS_FILE,
    path.join(dataDir, 'protected_pages.json'),
    path.join(__dirname, 'protected_pages.json')
  ].filter(Boolean);

  const file = candidates.find(f => fs.existsSync(f));
  if (!file) {
    console.warn('No protected_pages.json found: all pages are public and the file manager is disabled.');
    return {};
  }
  // Invalid JSON throws on purpose: better to refuse to start than to run unprotected.
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Copies only string values into a prototype-less object, so names like
// "__proto__" or "constructor" can never resolve to something truthy.
function normalizePasswords(raw) {
  const result = Object.create(null);
  for (const [key, value] of Object.entries(raw || {})) {
    if (typeof value === 'string' && value !== '') result[key] = value;
  }
  return result;
}

// Constant-time comparison (hashing first makes the lengths equal)
function passwordMatches(supplied, required) {
  if (typeof supplied !== 'string') return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(required).digest();
  return crypto.timingSafeEqual(a, b);
}

// Passwords are sent URI-encoded because header values must be Latin-1
function readPasswordHeader(req) {
  const raw = req.get(PASSWORD_HEADER);
  if (typeof raw !== 'string') return null;
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return null;
  }
}

// Counts failed password attempts per client IP within a sliding window
function createFailureLimiter({ maxFailures, windowMs }) {
  const failures = new Map();

  function prune(now) {
    for (const [ip, entry] of failures) {
      if (entry.resetAt <= now) failures.delete(ip);
    }
  }
  setInterval(() => prune(Date.now()), windowMs).unref();

  return {
    isBlocked(ip) {
      const entry = failures.get(ip);
      return Boolean(entry && entry.resetAt > Date.now() && entry.count >= maxFailures);
    },
    recordFailure(ip) {
      const now = Date.now();
      const entry = failures.get(ip);
      if (!entry || entry.resetAt <= now) {
        failures.set(ip, { count: 1, resetAt: now + windowMs });
      } else {
        entry.count++;
      }
    }
  };
}

// Returns the sanitized page name, or '' when nothing usable is left
function getSafeName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[^a-z0-9_\-]/gi, '').slice(0, MAX_PAGE_NAME_LENGTH);
}

function sanitizeFolderName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[^a-z0-9_\-]/gi, '').slice(0, MAX_PAGE_NAME_LENGTH);
}

// Strips path separators, control and shell/HTML-special characters from an
// uploaded file name and keeps it at a sane length.
function sanitizeFileName(name) {
  let clean = String(name || '')
    .normalize('NFC')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+/, '')
    .trim();
  if (clean.length > MAX_FILE_NAME_LENGTH) {
    const ext = path.extname(clean).slice(0, 20);
    clean = clean.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext;
  }
  return clean || 'file';
}

// Returns "name (1).ext", "name (2).ext", ... until the name is free
function uniqueFileName(dir, fileName) {
  if (!fs.existsSync(path.join(dir, fileName))) return fileName;
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.NOTER_DATA_DIR || path.join(__dirname, 'persistent');
  const uploadsDir = path.join(dataDir, 'uploads');
  const protectedPages = normalizePasswords(options.passwords || loadProtectedPages(dataDir));
  const maxUploadBytes = options.maxUploadBytes || Number(process.env.NOTER_MAX_UPLOAD_MB || 50) * 1024 * 1024;
  const maxUploadFiles = options.maxUploadFiles || 20;
  const limiter = createFailureLimiter({
    maxFailures: options.maxPasswordFailures || 10,
    windowMs: options.failureWindowMs || 15 * 60 * 1000
  });

  fs.mkdirSync(uploadsDir, { recursive: true });

  function getTextFile(name) {
    return path.join(dataDir, `person_${name}.txt`);
  }

  // Returns a safe absolute path within uploadsDir, or null when the input is
  // not a string or tries to escape it.
  function getSafeUploadPath(folder, filename) {
    if (typeof folder !== 'string' || typeof filename !== 'string') return null;
    if (folder.includes('\0') || filename.includes('\0')) return null;
    const normalized = path.normalize(path.join(folder, filename));
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
    const full = path.join(uploadsDir, normalized);
    if (full !== uploadsDir && !full.startsWith(uploadsDir + path.sep)) return null;
    return full;
  }

  // Middleware: checks the password for `key` if one is configured.
  // With `required`, a missing password config denies access instead of allowing it.
  function checkPassword(getKey, { required = false } = {}) {
    return (req, res, next) => {
      const key = getKey(req);
      const requiredPassword = protectedPages[key];
      if (!requiredPassword) {
        if (!required) return next();
        return res.status(403).json({
          success: false,
          message: `Disabled: set a "${key}" password in protected_pages.json to enable this.`
        });
      }
      if (limiter.isBlocked(req.ip)) {
        return res.status(429).json({ success: false, message: 'Too many failed attempts. Try again later.' });
      }
      const supplied = readPasswordHeader(req);
      if (!passwordMatches(supplied, requiredPassword)) {
        // Only wrong guesses count; simply opening a protected page does not
        if (supplied) limiter.recordFailure(req.ip);
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }
      next();
    };
  }

  // Middleware: rejects requests whose :name param has no usable characters
  function requirePageName(req, res, next) {
    req.pageName = getSafeName(req.params.name);
    if (!req.pageName) return res.status(400).json({ success: false, message: 'Invalid page name' });
    next();
  }

  // Middleware: resolves a query/body folder param to a directory inside uploadsDir
  function resolveFolder(source, param) {
    return (req, res, next) => {
      const value = req[source] && req[source][param] !== undefined ? req[source][param] : '';
      const dir = getSafeUploadPath(value, '');
      if (!dir) return res.status(400).json({ success: false, message: 'Invalid folder path' });
      req.folderPath = dir;
      next();
    };
  }

  // Middleware: resolves :filename + ?folder= to an existing regular file
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

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(req.folderPath)) return cb(Object.assign(new Error('Folder does not exist'), { status: 400 }));
      cb(null, req.folderPath);
    },
    filename: (req, file, cb) => {
      cb(null, uniqueFileName(req.folderPath, sanitizeFileName(file.originalname)));
    }
  });
  const upload = multer({
    storage,
    defParamCharset: 'utf8',
    limits: { fileSize: maxUploadBytes, files: maxUploadFiles, fields: 10, parts: maxUploadFiles + 10 }
  });

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    next();
  });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const pagePassword = checkPassword(req => req.pageName);
  const filesPassword = checkPassword(() => 'files', { required: true });

  // Serve dynamic person editor (e.g. /person/brody)
  app.get('/person/:name', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'editor.html'));
  });

  app.get('/load/:name', requirePageName, pagePassword, (req, res) => {
    const file = getTextFile(req.pageName);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    res.set('Cache-Control', 'no-store').type('text/plain').send(text);
  });

  app.post('/save/:name', requirePageName, pagePassword, (req, res) => {
    // Rejecting non-JSON bodies also stops cross-site form posts from blanking a page
    if (!req.body || typeof req.body.text !== 'string') {
      return res.status(400).json({ success: false, message: 'Expected JSON body with a "text" string' });
    }
    fs.writeFileSync(getTextFile(req.pageName), req.body.text);
    res.sendStatus(200);
  });

  // Protected pages are left out so their names are not advertised
  app.get('/pages', (req, res) => {
    const pages = fs.readdirSync(dataDir)
      .filter(f => f.startsWith('person_') && f.endsWith('.txt'))
      .map(f => f.replace(/^person_/, '').replace(/\.txt$/, ''))
      .filter(name => !protectedPages[name]);
    res.json(pages);
  });

  app.delete('/delete/:name', requirePageName, pagePassword, (req, res) => {
    if (UNDELETABLE_PAGES.includes(req.pageName)) {
      return res.status(403).send('Protected page');
    }
    const file = getTextFile(req.pageName);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return res.sendStatus(200);
    }
    res.sendStatus(404);
  });

  // File routes: always require the "files" password
  app.post('/upload', filesPassword, resolveFolder('query', 'folder'), upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.json({ success: false, message: 'No files provided' });
    }
    res.json({ success: true, count: req.files.length, files: req.files.map(f => f.filename) });
  });

  app.get('/list-files', filesPassword, resolveFolder('query', 'folder'), (req, res) => {
    try {
      const result = fs.readdirSync(req.folderPath).map(name => {
        const stats = fs.statSync(path.join(req.folderPath, name));
        const isDirectory = stats.isDirectory();
        return { name, size: isDirectory ? null : stats.size, isDirectory };
      });
      res.json(result);
    } catch (err) {
      res.status(404).json([]);
    }
  });

  app.post('/create-folder', filesPassword, resolveFolder('body', 'parent'), (req, res) => {
    const folderName = sanitizeFolderName(req.body.name);
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

  app.get('/download/:filename', filesPassword, resolveFolder('query', 'folder'), resolveExistingFile, (req, res) => {
    // Sandbox the response in case a browser ever renders it inline
    res.set('Content-Security-Policy', 'sandbox; default-src \'none\'');
    res.download(req.filePath, req.filename);
  });

  app.get('/view/:filename', filesPassword, resolveFolder('query', 'folder'), resolveExistingFile, (req, res) => {
    const stats = fs.statSync(req.filePath);
    const isText = TEXT_PREVIEW_PATTERN.test(req.filename);

    if (isText && stats.size < 5 * 1024 * 1024) { // 5MB limit for text preview
      try {
        const content = fs.readFileSync(req.filePath, 'utf-8');
        return res.json({ success: true, content, isText: true });
      } catch (err) {
        // fall through to "not previewable"
      }
    }
    res.json({ success: true, isText: false });
  });

  app.delete('/delete-file/:filename', filesPassword, resolveFolder('query', 'folder'), resolveExistingFile, (req, res) => {
    try {
      fs.unlinkSync(req.filePath);
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, message: 'Failed to delete file' });
    }
  });

  app.delete('/delete-folder/:foldername', filesPassword, resolveFolder('query', 'parent'), (req, res) => {
    const foldername = sanitizeFolderName(req.params.foldername);
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

  // Generic error handler: never leak stack traces to clients
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = status < 500 && err.expose !== false ? err.message : 'Internal server error';
    if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = err.code === 'LIMIT_FILE_SIZE'
        ? `File too large (max ${Math.round(maxUploadBytes / 1024 / 1024)}MB)`
        : err.message;
    }
    if (status >= 500) console.error(err);
    if (res.headersSent) return next(err);
    res.status(status).json({ success: false, message });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

module.exports = { createApp, getSafeName, sanitizeFileName, passwordMatches };
