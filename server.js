const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

const protectedPages = JSON.parse(
  fs.existsSync('protected_pages.json') ? fs.readFileSync('protected_pages.json') : '{}'
);


app.use(express.json());
app.use(express.static('public')); // Serves index.html and other assets

function getSafeName(name) {
  return name.replace(/[^a-z0-9_\-]/gi, '');
}
function getTextFile(name) {
  return path.join(__dirname, `person_${getSafeName(name)}.txt`);
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
    const files = fs.readdirSync(__dirname);
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
  

  
app.listen(3000, () => console.log('Listening on http://localhost:3000'));
