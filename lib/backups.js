const fs = require('fs');
const path = require('path');
const { writeZip, collectFiles } = require('./zip');

const KEEP_DAILY = 7;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const BACKUP_NAME_PATTERN = /^noter-\d{4}-\d{2}-\d{2}\.zip$/;

const SECRET_FILES = ['.noter/secret', '.noter/setup-code'];

// Full backup: everything except secrets and old backup archives
function fullBackupEntries(dataDir) {
  return collectFiles(dataDir, '', rel => SECRET_FILES.includes(rel) || rel.startsWith('.noter/backups'));
}

// Daily backup: notes, metadata, attachments, passwords and share links.
// Skips the file manager uploads and page history to keep it small.
function dailyBackupEntries(dataDir) {
  return collectFiles(dataDir, '', rel =>
    SECRET_FILES.includes(rel) || rel.startsWith('.noter/backups') ||
    rel.startsWith('.noter/history') || rel.startsWith('.noter/trash') || rel.startsWith('uploads'));
}

function createBackups(dataDir) {
  const dir = path.join(dataDir, '.noter', 'backups');
  fs.mkdirSync(dir, { recursive: true });

  function list() {
    return fs.readdirSync(dir)
      .filter(f => BACKUP_NAME_PATTERN.test(f))
      .map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  function file(name) {
    return BACKUP_NAME_PATTERN.test(name || '') && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null;
  }

  async function runDaily() {
    const today = new Date().toISOString().slice(0, 10);
    const target = path.join(dir, `noter-${today}.zip`);
    if (fs.existsSync(target)) return;
    const tmp = `${target}.tmp`;
    const out = fs.createWriteStream(tmp);
    await writeZip(out, dailyBackupEntries(dataDir));
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    fs.renameSync(tmp, target);
    for (const old of list().slice(KEEP_DAILY)) fs.rmSync(path.join(dir, old.name), { force: true });
  }

  function schedule() {
    const tick = () => runDaily().catch(err => console.error('Daily backup failed:', err.message));
    setTimeout(tick, 10 * 1000).unref();
    setInterval(tick, CHECK_INTERVAL_MS).unref();
  }

  return { list, file, runDaily, schedule };
}

module.exports = { createBackups, fullBackupEntries };
