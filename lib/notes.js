const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const diff3 = require('node-diff3');
const { contentVersion, writeFileAtomic, readJson, writeJson, moveIfExists } = require('./util');

const HISTORY_INTERVAL_MS = 10 * 60 * 1000; // at most one snapshot per 10 minutes per editor
const MAX_HISTORY_PER_PAGE = 200;
const VERSIONS_PER_PAGE = 20;
const VERSION_CACHE_BYTES = 32 * 1024 * 1024; // memory budget for merge bases across all pages
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TRASH_ID_PATTERN = /^\d{13}-[a-z0-9_-]{1,100}$/i;
const HISTORY_ID_PATTERN = /^\d{13}(\.[0-9a-f]*)?$/;
const TAG_PATTERN = /(?:^|\s)#([a-z][\w-]{1,30})/gi;

function hexEncode(text) {
  return Buffer.from(text || '', 'utf-8').toString('hex');
}

function hexDecode(hex) {
  try {
    return Buffer.from(hex || '', 'hex').toString('utf-8');
  } catch (err) {
    return '';
  }
}

// Title = first non-empty line without markdown heading/list markers
function summarize(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const clean = line => line.replace(/^(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*)/, '').trim();
  const title = lines.length ? clean(lines[0]).slice(0, 80) : '';
  const preview = lines.slice(1).map(clean).join(' ').slice(0, 140);
  const tags = new Set();
  let inCode = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
    if (inCode || /^\s{0,3}#{1,6}\s/.test(line)) continue;
    for (const match of line.matchAll(TAG_PATTERN)) tags.add(match[1].toLowerCase());
  }
  return { title, preview, tags: [...tags].slice(0, 20) };
}

// Line-based three-way merge. Returns { clean: true, text } or
// { clean: false, bothText } where bothText keeps both sides of each conflict.
function mergeTexts(mine, base, theirs) {
  const regions = diff3.diff3Merge(mine.split('\n'), base.split('\n'), theirs.split('\n'), { excludeFalseConflicts: true });
  const out = [];
  let conflicts = 0;
  for (const region of regions) {
    if (region.ok) {
      out.push(...region.ok);
    } else {
      conflicts++;
      const a = region.conflict.a;
      const b = region.conflict.b;
      out.push(...a);
      if (b.join('\n') !== a.join('\n')) out.push(...b);
    }
  }
  const text = out.join('\n');
  return conflicts === 0 ? { clean: true, text } : { clean: false, bothText: text, conflicts };
}

// All note storage lives here: note text, per-page metadata, history
// snapshots, trash and attachments.
//
//   <dataDir>/person_<name>.txt           note text (unchanged format)
//   <dataDir>/attachments/<name>/...      files attached to a page
//   <dataDir>/.noter/meta/<name>.json     { updatedAt, updatedBy }
//   <dataDir>/.noter/history/<name>/<ms>.<hex(by)>.txt
//   <dataDir>/.noter/trash/<ms>-<name>/   note.txt, meta.json, history/, attachments/
class NoteStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.internalDir = path.join(dataDir, '.noter');
    this.attachmentsRoot = path.join(dataDir, 'attachments');
    for (const dir of ['meta', 'history', 'trash']) {
      fs.mkdirSync(path.join(this.internalDir, dir), { recursive: true });
    }
    fs.mkdirSync(this.attachmentsRoot, { recursive: true });
    this.versions = new Map(); // name -> Map(version -> text): recent texts used as merge bases
    this.versionBytes = 0;
    this.summaries = new Map(); // name -> { mtimeMs, summary }
  }

  noteFile(name) {
    return path.join(this.dataDir, `person_${name}.txt`);
  }

  metaFile(name) {
    return path.join(this.internalDir, 'meta', `${name}.json`);
  }

  historyDir(name) {
    return path.join(this.internalDir, 'history', name);
  }

  attachmentsDir(name) {
    return path.join(this.attachmentsRoot, name);
  }

  exists(name) {
    return fs.existsSync(this.noteFile(name));
  }

  // Remembers recent texts so concurrent saves can be merged. Bounded per page
  // and overall; the least recently used pages are dropped first.
  rememberVersion(name, text) {
    const version = contentVersion(text);
    let map = this.versions.get(name);
    if (map) this.versions.delete(name); // re-insert: most recently used last
    else map = new Map();
    this.versions.set(name, map);
    if (map.has(version)) {
      map.delete(version);
    } else {
      this.versionBytes += text.length;
    }
    map.set(version, text);
    while (map.size > VERSIONS_PER_PAGE) this.dropOldest(map);
    for (const [page, pageMap] of this.versions) {
      if (this.versionBytes <= VERSION_CACHE_BYTES || page === name) break;
      while (pageMap.size) this.dropOldest(pageMap);
      this.versions.delete(page);
    }
    return version;
  }

  dropOldest(map) {
    const [key, value] = map.entries().next().value;
    map.delete(key);
    this.versionBytes -= value.length;
  }

  forgetVersions(name) {
    const map = this.versions.get(name);
    if (!map) return;
    while (map.size) this.dropOldest(map);
    this.versions.delete(name);
  }

  // Returns { text, version, updatedAt, updatedBy, exists }
  read(name) {
    const file = this.noteFile(name);
    const exists = fs.existsSync(file);
    const text = exists ? fs.readFileSync(file, 'utf-8') : '';
    const meta = readJson(this.metaFile(name), {});
    const updatedAt = meta.updatedAt || (exists ? fs.statSync(file).mtimeMs : null);
    return { text, version: this.rememberVersion(name, text), updatedAt, updatedBy: meta.updatedBy || '', exists };
  }

  // Saves text. With baseVersion, concurrent edits are merged:
  //   { status: 'saved', version, text, merged }  or
  //   { status: 'conflict', current, bothText? }
  save(name, text, { baseVersion, by = '', force = false, snapshot = false } = {}) {
    const current = this.read(name);
    let finalText = text;
    let merged = false;

    if (!force && typeof baseVersion === 'string' && baseVersion !== current.version) {
      const base = this.versions.get(name)?.get(baseVersion);
      if (base === undefined) return { status: 'conflict', current };
      const result = mergeTexts(text, base, current.text);
      if (!result.clean) return { status: 'conflict', current, bothText: result.bothText };
      finalText = result.text;
      merged = true;
    }

    if (finalText === current.text && current.exists) {
      return { status: 'saved', version: current.version, text: finalText, merged, unchanged: true };
    }

    this.maybeSnapshot(name, current, by, snapshot);
    writeFileAtomic(this.noteFile(name), finalText);
    writeJson(this.metaFile(name), { updatedAt: Date.now(), updatedBy: by });
    return { status: 'saved', version: this.rememberVersion(name, finalText), text: finalText, merged };
  }

  // Keeps the previous content in history when enough time has passed, the
  // editor changed, or a snapshot is forced (restore, replace, delete).
  maybeSnapshot(name, current, by, force = false) {
    if (!current.exists || current.text === '') return;
    const latest = this.listHistory(name)[0];
    const due = force || !latest ||
      current.updatedAt - latest.savedAt >= HISTORY_INTERVAL_MS ||
      (current.updatedBy || '') !== (by || '');
    if (!due) return;
    if (latest && fs.readFileSync(path.join(this.historyDir(name), latest.file), 'utf-8') === current.text) return;
    const dir = this.historyDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const savedAt = Math.round(current.updatedAt || Date.now());
    let file = path.join(dir, `${savedAt}.${hexEncode(current.updatedBy)}.txt`);
    if (fs.existsSync(file)) file = path.join(dir, `${savedAt + 1}.${hexEncode(current.updatedBy)}.txt`);
    writeFileAtomic(file, current.text);
    this.pruneHistory(name);
  }

  pruneHistory(name) {
    const entries = this.listHistory(name);
    for (const entry of entries.slice(MAX_HISTORY_PER_PAGE)) {
      fs.rmSync(path.join(this.historyDir(name), entry.file), { force: true });
    }
  }

  // Newest first: [{ id, savedAt, by, size, file }] (reads metadata only)
  listHistory(name) {
    const dir = this.historyDir(name);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => /^\d{13}\.[0-9a-f]*\.txt$/.test(f))
      .map(file => {
        const [ms, hex] = file.split('.');
        return {
          id: `${ms}.${hex}`,
          savedAt: Number(ms),
          by: hexDecode(hex),
          size: fs.statSync(path.join(dir, file)).size,
          file
        };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  readHistory(name, id) {
    if (!HISTORY_ID_PATTERN.test(id)) return null;
    const entry = this.listHistory(name).find(e => e.id === id);
    if (!entry) return null;
    return { ...entry, text: fs.readFileSync(path.join(this.historyDir(name), entry.file), 'utf-8') };
  }

  restore(name, id, by) {
    const entry = this.readHistory(name, id);
    if (!entry) return null;
    this.maybeSnapshot(name, this.read(name), by, true);
    return this.save(name, entry.text, { by, force: true });
  }

  // Lists existing pages with summary info (cached by mtime)
  list() {
    return fs.readdirSync(this.dataDir)
      .filter(f => /^person_[a-z0-9_-]+\.txt$/i.test(f))
      .map(f => f.slice('person_'.length, -'.txt'.length))
      .map(name => this.info(name))
      .filter(Boolean);
  }

  info(name) {
    const file = this.noteFile(name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      return null;
    }
    let cached = this.summaries.get(name);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      cached = { mtimeMs: stat.mtimeMs, summary: summarize(fs.readFileSync(file, 'utf-8')) };
      this.summaries.set(name, cached);
    }
    const meta = readJson(this.metaFile(name), {});
    return {
      name,
      ...cached.summary,
      size: stat.size,
      updatedAt: meta.updatedAt || stat.mtimeMs,
      updatedBy: meta.updatedBy || ''
    };
  }

  // Case-insensitive search; every word must appear in the name or text
  search(names, query, limit = 50) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
    if (!words.length) return [];
    const results = [];
    for (const name of names) {
      const file = this.noteFile(name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf-8');
      const haystack = (name + '\n' + text).toLowerCase();
      if (!words.every(w => haystack.includes(w))) continue;
      const nameHit = words.some(w => name.toLowerCase().includes(w));
      const lower = text.toLowerCase();
      const index = Math.max(0, lower.indexOf(words[0]));
      const start = Math.max(0, index - 50);
      const snippet = (start > 0 ? '…' : '') + text.slice(start, start + 160).replace(/\s+/g, ' ').trim() +
        (start + 160 < text.length ? '…' : '');
      results.push({ name, title: summarize(text).title, snippet, score: nameHit ? 2 : 1 });
    }
    return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  // Moves note, metadata, history and attachments to a new name
  rename(from, to) {
    fs.renameSync(this.noteFile(from), this.noteFile(to));
    moveIfExists(this.metaFile(from), this.metaFile(to));
    moveIfExists(this.historyDir(from), this.historyDir(to));
    moveIfExists(this.attachmentsDir(from), this.attachmentsDir(to));
    this.forgetVersions(from);
    this.summaries.delete(from);
  }

  // Moves the page and everything that belongs to it into the trash
  trash(name, { by = '', passwordEntry = null } = {}) {
    const current = this.read(name);
    const id = `${Date.now()}-${name}`;
    const dir = path.join(this.internalDir, 'trash', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(this.noteFile(name), path.join(dir, 'note.txt'));
    moveIfExists(this.historyDir(name), path.join(dir, 'history'));
    moveIfExists(this.attachmentsDir(name), path.join(dir, 'attachments'));
    fs.rmSync(this.metaFile(name), { force: true });
    writeJson(path.join(dir, 'meta.json'), {
      name,
      deletedAt: Date.now(),
      deletedBy: by,
      updatedAt: current.updatedAt,
      updatedBy: current.updatedBy,
      passwordEntry
    });
    this.forgetVersions(name);
    this.summaries.delete(name);
    return id;
  }

  trashDir(id) {
    return TRASH_ID_PATTERN.test(id) ? path.join(this.internalDir, 'trash', id) : null;
  }

  // Newest first: [{ id, name, deletedAt, deletedBy, preview, protected }]
  listTrash() {
    const root = path.join(this.internalDir, 'trash');
    return fs.readdirSync(root)
      .filter(id => TRASH_ID_PATTERN.test(id))
      .map(id => {
        const meta = readJson(path.join(root, id, 'meta.json'), null);
        if (!meta) return null;
        let summary = { title: '', preview: '' };
        try {
          summary = summarize(fs.readFileSync(path.join(root, id, 'note.txt'), 'utf-8'));
        } catch (err) {
          // missing note file: still listable
        }
        return {
          id,
          name: meta.name,
          deletedAt: meta.deletedAt,
          deletedBy: meta.deletedBy || '',
          title: summary.title,
          preview: summary.preview,
          protected: Boolean(meta.passwordEntry)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  readTrashMeta(id) {
    const dir = this.trashDir(id);
    return dir ? readJson(path.join(dir, 'meta.json'), null) : null;
  }

  // Restores into `name` (the original or a free alternative). Returns the meta.
  restoreFromTrash(id, name) {
    const dir = this.trashDir(id);
    const meta = this.readTrashMeta(id);
    if (!dir || !meta) return null;
    fs.renameSync(path.join(dir, 'note.txt'), this.noteFile(name));
    moveIfExists(path.join(dir, 'history'), this.historyDir(name));
    moveIfExists(path.join(dir, 'attachments'), this.attachmentsDir(name));
    writeJson(this.metaFile(name), { updatedAt: meta.updatedAt || Date.now(), updatedBy: meta.updatedBy || '' });
    fs.rmSync(dir, { recursive: true, force: true });
    return meta;
  }

  purgeTrash(id) {
    const dir = this.trashDir(id);
    if (!dir || !fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  purgeExpiredTrash() {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    for (const entry of this.listTrash()) {
      if (entry.deletedAt < cutoff) this.purgeTrash(entry.id);
    }
  }

  // Picks a name that is free, e.g. "notes-restored", "notes-restored-2"
  freeName(name) {
    if (!this.exists(name)) return name;
    for (let i = 1; ; i++) {
      const candidate = `${name}-restored${i > 1 ? '-' + i : ''}`.slice(0, 100);
      if (!this.exists(candidate)) return candidate;
    }
  }
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { NoteStore, mergeTexts, summarize, randomId, TRASH_ID_PATTERN };
