const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const app = express();

const protectedPages = JSON.parse(
  fs.existsSync('protected_pages.json') ? fs.readFileSync('protected_pages.json') : '{}'
);

const NOTES_DIR = path.join(__dirname, 'persistent');
const UPLOADS_DIR = path.join(__dirname, 'persistent', 'uploads');
if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Returns a safe absolute path within UPLOADS_DIR, or null on path traversal attempt
function getSafeUploadPath(folder, filename) {
  const rel = path.join(folder || '', filename || '');
  const normalized = path.normalize(rel);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  const full = path.join(UPLOADS_DIR, normalized);
  if (full !== UPLOADS_DIR && !full.startsWith(UPLOADS_DIR + path.sep)) return null;
  return full;
}

function sanitizeFolderName(name) {
  return (name || '').replace(/[^a-z0-9_\-]/gi, '');
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = getSafeUploadPath(req.query.folder || '', '');
    if (!dest) return cb(new Error('Invalid folder path'));
    if (!fs.existsSync(dest)) return cb(new Error('Folder does not exist'));
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public')); // Serves index.html and other assets

function getSafeName(name) {
  return name.replace(/[^a-z0-9_\-]/gi, '');
}
function getTextFile(name) {
  return path.join(NOTES_DIR, `person_${getSafeName(name)}.txt`);
}

// Serve dynamic person editor (e.g. /person/brody)
app.get('/person/:name', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// Save/load routes
app.get('/load/:name', (req, res) => {
  const name = getSafeName(req.params.name);
  const file = getTextFile(req.params.name);
  
  const requiredPassword = protectedPages[name];
  const userPassword = req.query.password;

  if (requiredPassword && userPassword !== requiredPassword) {
    return res.status(401).send('Unauthorized');
  }

  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  res.send(text);
});

app.post('/save/:name', (req, res) => {
  const file = getTextFile(req.params.name);
  fs.writeFileSync(file, req.body.text || '');
  res.sendStatus(200);
});

app.get('/pages', (req, res) => {
    const files = fs.readdirSync(NOTES_DIR);
    const pages = files
      .filter(f => f.startsWith('person_') && f.endsWith('.txt'))
      .map(f => f.replace(/^person_/, '').replace(/\.txt$/, ''));
    res.json(pages);
  });
  
  app.delete('/delete/:name', (req, res) => {
    const safeName = getSafeName(req.params.name);
    if (['home'].includes(safeName)) {
      return res.status(403).send('Protected page');
    }
  
    const file = getTextFile(safeName);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return res.sendStatus(200);
    }
    res.sendStatus(404);
  });

// Password check middleware for file routes
function checkFilePassword(req, res, next) {
  const requiredPassword = protectedPages['files'];
  const userPassword = req.query.password || req.body.password;

  if (requiredPassword && userPassword !== requiredPassword) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// File upload/download routes
app.post('/upload', checkFilePassword, upload.array('files'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.json({ success: false, message: 'No files provided' });
  }
  res.json({ success: true, count: req.files.length });
});

app.get('/list-files', checkFilePassword, (req, res) => {
  const dirPath = getSafeUploadPath(req.query.folder || '', '');
  if (!dirPath) return res.status(400).json([]);
  try {
    const items = fs.readdirSync(dirPath);
    const result = items.map(name => {
      const fp = path.join(dirPath, name);
      const stats = fs.statSync(fp);
      const isDirectory = stats.isDirectory();
      return { name, size: isDirectory ? null : stats.size, isDirectory };
    });
    res.json(result);
  } catch (err) {
    res.json([]);
  }
});

app.post('/create-folder', checkFilePassword, (req, res) => {
  const folderName = sanitizeFolderName(req.body.name);
  if (!folderName) return res.json({ success: false, message: 'Invalid folder name' });
  const folderPath = getSafeUploadPath(req.body.parent || '', folderName);
  if (!folderPath) return res.json({ success: false, message: 'Invalid path' });
  if (fs.existsSync(folderPath)) return res.json({ success: false, message: 'Folder already exists' });
  try {
    fs.mkdirSync(folderPath);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: 'Failed to create folder' });
  }
});

app.get('/download/:filename', checkFilePassword, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = getSafeUploadPath(req.query.folder || '', filename);
  
  if (!filepath || !fs.existsSync(filepath) || fs.statSync(filepath).isDirectory()) {
    return res.status(404).send('File not found');
  }
  
  res.download(filepath);
});

app.get('/view/:filename', checkFilePassword, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = getSafeUploadPath(req.query.folder || '', filename);
  
  if (!filepath || !fs.existsSync(filepath) || fs.statSync(filepath).isDirectory()) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }
  
  const stats = fs.statSync(filepath);
  const isText = filename.match(/\.(txt|md|csv|json|xml|html|css|js|py|sh|yml|yaml|log)$/i);
  
  if (isText && stats.size < 5 * 1024 * 1024) { // 5MB limit for text preview
    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      res.json({ success: true, content, isText: true });
    } catch (err) {
      res.json({ success: true, isText: false });
    }
  } else {
    res.json({ success: true, isText: false });
  }
});

app.delete('/delete-file/:filename', checkFilePassword, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = getSafeUploadPath(req.query.folder || '', filename);
  
  if (!filepath || !fs.existsSync(filepath) || fs.statSync(filepath).isDirectory()) {
    return res.json({ success: false, message: 'File not found' });
  }
  
  try {
    fs.unlinkSync(filepath);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: 'Failed to delete file' });
  }
});

app.delete('/delete-folder/:foldername', checkFilePassword, (req, res) => {
  const foldername = sanitizeFolderName(req.params.foldername);
  const folderPath = getSafeUploadPath(req.query.parent || '', foldername);
  if (!folderPath || folderPath === UPLOADS_DIR || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return res.json({ success: false, message: 'Folder not found' });
  }
  try {
    fs.rmSync(folderPath, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: 'Failed to delete folder' });
  }
});
  

  
app.listen(3000, () => console.log('Listening on http://localhost:4000'));
