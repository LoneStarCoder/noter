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

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
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
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    const fileList = files.map(filename => {
      const filepath = path.join(UPLOADS_DIR, filename);
      const stats = fs.statSync(filepath);
      return {
        name: filename,
        size: stats.size
      };
    });
    res.json(fileList);
  } catch (err) {
    res.json([]);
  }
});

app.get('/download/:filename', checkFilePassword, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOADS_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('File not found');
  }
  
  res.download(filepath);
});

app.get('/view/:filename', checkFilePassword, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOADS_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
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
  const filepath = path.join(UPLOADS_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    return res.json({ success: false, message: 'File not found' });
  }
  
  try {
    fs.unlinkSync(filepath);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: 'Failed to delete file' });
  }
});
  

  
app.listen(3000, () => console.log('Listening on http://localhost:3000'));
