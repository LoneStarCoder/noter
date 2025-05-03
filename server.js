const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static('.'));

app.get('/load',(req, res) => {
    const text = fs.existsSync('data.txt') ? fs.readFileSync('data.txt', 'utf-8') : '';
    res.send(text);
});

app.post('/save', (req, res) => {
    fs.writeFileSync('data.txt', req.body.text || '');
    res.sendStatus(200);
  });

app.listen(3000, () => console.log('Listening on http://localhost:3000'));