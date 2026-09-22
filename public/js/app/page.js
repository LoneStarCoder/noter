// The page view: loads a note, shows it rendered or in the editor, autosaves,
// merges with other people's edits and keeps everyone's screen up to date.
import { api, get, put, post, pageUrl, ApiError } from '../lib/api.js';
import { el, icon, toast, modal, timeAgo, formatDateTime } from '../lib/ui.js';
import { identity, colorFor, initials } from '../lib/identity.js';
import { renderMarkdown, toggleTaskLine } from '../lib/markdown.js';
import { merge as diff3Merge } from '/vendor/diff3.mjs';

const SAVE_DELAY_MS = 600;
const RETRY_DELAY_MS = 5000;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;

function storage() {
  try {
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

// Line-based 3-way merge in the browser (for edits made while a save was in flight)
function mergeLocal(mine, base, theirs) {
  const result = diff3Merge(mine.split('\n'), base.split('\n'), theirs.split('\n'));
  return result.conflict ? null : result.result.join('\n');
}

// Keeps the caret in place when the text changes underneath it
function mapOffset(oldText, newText, offset) {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
  if (offset <= prefix) return offset;
  return Math.max(prefix, Math.min(newText.length, offset + newText.length - oldText.length));
}

export class PageView {
  constructor({ body, title, lockIcon, status, modeToggle, menuButton, presence, onChange, onNavigate }) {
    this.body = body;
    this.titleEl = title;
    this.lockIcon = lockIcon;
    this.statusEl = status;
    this.modeToggle = modeToggle;
    this.menuButton = menuButton;
    this.presenceEl = presence;
    this.onChange = onChange; // called after saves/renames so the sidebar can refresh
    this.onNavigate = onNavigate;
    this.reset();

    modeToggle.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-mode]');
      if (button) this.setMode(button.dataset.mode, { focus: true });
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty || this.saving) e.preventDefault();
    });
    window.addEventListener('online', () => {
      if (this.dirty) this.save();
    });
  }

  reset() {
    this.name = null;
    this.local = '';        // text on screen
    this.base = '';         // last text confirmed by the server
    this.version = null;
    this.exists = false;
    this.protected = false;
    this.locked = false;
    this.deleted = false;
    this.mode = 'view';
    this.dirty = false;
    this.saving = false;
    this.saveQueued = false;
    this.forceNext = false;
    this.updatedAt = null;
    this.updatedBy = '';
    this.editor = null;
    this.clearTimers();
  }

  clearTimers() {
    clearTimeout(this.saveTimer);
    clearTimeout(this.retryTimer);
  }

  // ---------- Loading ----------

  async open(name) {
    if (this.dirty || this.saving) await this.flush();
    this.disconnect();
    this.reset();
    this.name = name;
    this.titleEl.textContent = name;
    document.title = `${name} · Noter`;
    this.body.replaceChildren(el('div', { class: 'page-info', text: 'Loading…' }));
    this.setStatus('');
    this.presenceEl.replaceChildren();

    let page;
    try {
      page = await get(pageUrl(name));
    } catch (err) {
      if (this.name !== name) return;
      if (err instanceof ApiError && err.status === 401) return this.showLocked();
      if (err instanceof ApiError && err.status === 400) return this.showError(err.message);
      return this.showError(navigator.onLine ? 'Could not load this page.' : 'You are offline and this page is not saved on this device.');
    }
    if (this.name !== name) return;
    this.applyPage(page);
    const preferred = storage()?.getItem(`noter-mode:${name}`);
    this.mode = page.text.trim() === '' ? 'edit' : (preferred === 'edit' ? 'edit' : 'view');
    this.render();
    this.connect();
  }

  applyPage(page) {
    this.local = page.text;
    this.base = page.text;
    this.version = page.version;
    this.exists = page.exists;
    this.protected = page.protected;
    this.updatedAt = page.updatedAt;
    this.updatedBy = page.updatedBy;
    this.lockIcon.hidden = !page.protected;
    if (page.viewers) this.renderPresence(page.viewers);
  }

  // Re-reads the page from the server when we have no unsaved edits
  async refresh(reason) {
    if (this.dirty || this.saving || this.locked || !this.name) return;
    const name = this.name;
    try {
      const page = await get(pageUrl(name));
      if (this.name !== name || this.dirty || this.saving) return;
      if (page.version === this.version) return;
      const oldLocal = this.local;
      this.applyPage(page);
      this.updateContent(oldLocal);
      if (reason) this.setStatus(reason);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.showLocked();
    }
  }

  // ---------- Rendering ----------

  render() {
    this.locked = false;
    this.modeToggle.hidden = false;
    this.menuButton.hidden = false;
    for (const button of this.modeToggle.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode));
    }
    const info = el('div', { class: 'page-info', id: 'page-info' });
    this.infoEl = info;
    this.renderInfo();

    if (this.mode === 'edit') {
      this.editor = el('textarea', {
        class: 'editor',
        id: 'editor',
        spellcheck: true,
        'aria-label': `Edit ${this.name}`,
        placeholder: 'Start writing…\n\n# Headings, **bold**, - lists\n- [ ] checklists\n[[other-page]] links, #tags, paste images'
      });
      this.editor.value = this.local;
      this.editor.addEventListener('input', () => this.onInput());
      this.editor.addEventListener('keydown', (e) => this.onEditorKey(e));
      this.editor.addEventListener('paste', (e) => this.onPaste(e));
      this.body.replaceChildren(info, this.editor, el('div', { class: 'editor-hint hide-mobile', text:
        'Markdown · "- [ ]" for checklists · [[page]] links · #tags · paste or drop files to attach · Ctrl+E to view' }));
      this.autosize();
    } else {
      this.editor = null;
      this.preview = el('div', { class: 'markdown', id: 'preview' });
      this.body.replaceChildren(info, this.preview);
      this.renderPreview();
      this.preview.addEventListener('dblclick', (e) => {
        if (!e.target.closest('a, input, button, pre')) this.setMode('edit', { focus: true });
      });
    }
  }

  renderInfo() {
    if (!this.infoEl) return;
    const parts = [];
    if (!this.exists) parts.push('New page — it will be created when you start writing.');
    else if (this.updatedAt) {
      const edited = el('span', { title: formatDateTime(this.updatedAt), text: `Edited ${timeAgo(this.updatedAt)}` });
      parts.push(edited);
      if (this.updatedBy) parts.push(` by ${this.updatedBy}`);
    }
    this.infoEl.replaceChildren(...parts);
  }

  renderPreview() {
    if (!this.preview) return;
    if (!this.local.trim()) {
      this.preview.replaceChildren(el('p', { class: 'empty-page', text: 'This page is empty. Double-click or press Edit to start writing.' }));
      return;
    }
    const name = this.name;
    renderMarkdown(this.preview, this.local, {
      attachmentUrl: file => `${pageUrl(name)}/attachments/${encodeURIComponent(file)}`,
      pageUrl: page => `/person/${page}`,
      tagUrl: tag => `/?tag=${encodeURIComponent(tag)}`,
      onToggleTask: (line, checked) => {
        this.local = toggleTaskLine(this.local, line, checked);
        this.markDirty();
        this.save();
      }
    });
  }

  // Shows new text (e.g. from someone else) without losing the caret
  updateContent(oldLocal) {
    this.renderInfo();
    if (this.editor) {
      if (this.editor.value !== this.local) {
        const { selectionStart, selectionEnd } = this.editor;
        const hadFocus = document.activeElement === this.editor;
        this.editor.value = this.local;
        if (hadFocus) {
          this.editor.setSelectionRange(mapOffset(oldLocal, this.local, selectionStart), mapOffset(oldLocal, this.local, selectionEnd));
        }
        this.autosize();
      }
    } else {
      this.renderPreview();
    }
  }

  setMode(mode, { focus = false } = {}) {
    if (!this.name || this.locked) return;
    if (mode === this.mode) {
      if (focus && this.editor) this.editor.focus();
      return;
    }
    if (this.editor) this.local = this.editor.value;
    this.mode = mode;
    storage()?.setItem(`noter-mode:${this.name}`, mode);
    const scroll = this.body.parentElement.scrollTop;
    this.render();
    this.body.parentElement.scrollTop = scroll;
    if (focus && this.editor) this.editor.focus();
  }

  toggleMode() {
    this.setMode(this.mode === 'edit' ? 'view' : 'edit', { focus: true });
  }

  autosize() {
    if (!this.editor) return;
    this.editor.style.height = 'auto';
    this.editor.style.height = `${this.editor.scrollHeight + 4}px`;
  }

  showLocked(message) {
    this.disconnect();
    this.locked = true;
    this.modeToggle.hidden = true;
    this.menuButton.hidden = true;
    this.lockIcon.hidden = false;
    this.presenceEl.replaceChildren();
    const input = el('input', { class: 'input', type: 'password', placeholder: 'Password', 'aria-label': 'Password', autocomplete: 'current-password' });
    const error = el('div', { class: 'form-error', role: 'alert', text: message || '' });
    const form = el('form', {}, [input, el('button', { class: 'btn primary', type: 'submit', text: 'Unlock' })]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await post('/api/unlock', { scope: 'page', page: this.name, password: input.value });
        const draft = this.pendingDraft;
        await this.open(this.name);
        if (draft !== undefined && draft !== this.local) {
          this.local = draft;
          this.pendingDraft = undefined;
          this.setMode('edit');
          this.updateContent(this.base);
          this.markDirty();
          this.save();
        }
        this.onChange();
      } catch (err) {
        error.textContent = err.status === 429 ? 'Too many attempts. Try again in a few minutes.' : 'Incorrect password';
        input.select();
      }
    });
    this.body.replaceChildren(el('div', { class: 'lock-card' }, [
      icon('lock'),
      el('h2', { text: 'This page is private' }),
      el('p', { text: `Enter the password for “${this.name}”.` }),
      form,
      error
    ]));
    input.focus();
  }

  showError(message) {
    this.modeToggle.hidden = true;
    this.menuButton.hidden = true;
    this.body.replaceChildren(el('div', { class: 'lock-card' }, [el('h2', { text: 'Something went wrong' }), el('p', { text: message })]));
  }

  // ---------- Editing ----------

  onInput() {
    this.local = this.editor.value;
    this.autosize();
    this.markDirty();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  markDirty() {
    this.dirty = true;
    if (!this.saving) this.setStatus('Editing…', 'busy');
  }

  insertText(text) {
    // execCommand keeps the browser's undo history intact
    this.editor.focus();
    if (!document.execCommand('insertText', false, text)) {
      this.editor.setRangeText(text, this.editor.selectionStart, this.editor.selectionEnd, 'end');
      this.onInput();
    }
  }

  // Enter continues lists; Tab / Shift+Tab indent list items
  onEditorKey(e) {
    const ed = this.editor;
    if (e.isComposing) return;
    const lineStart = ed.value.lastIndexOf('\n', ed.selectionStart - 1) + 1;
    const line = ed.value.slice(lineStart, ed.value.indexOf('\n', ed.selectionStart) === -1 ? ed.value.length : ed.value.indexOf('\n', ed.selectionStart));
    const match = LIST_ITEM.exec(line);

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && match && ed.selectionStart === ed.selectionEnd) {
      e.preventDefault();
      if (line.slice(match[0].length).trim() === '' && ed.selectionStart === lineStart + line.length) {
        // Empty item: end the list
        ed.setSelectionRange(lineStart, lineStart + line.length);
        this.insertText('');
        return;
      }
      let bullet = match[2];
      const number = /^(\d+)([.)])$/.exec(bullet);
      if (number) bullet = `${Number(number[1]) + 1}${number[2]}`;
      this.insertText(`\n${match[1]}${bullet}${match[3]}${match[4] ? '[ ] ' : ''}`);
      return;
    }
    if (e.key === 'Tab' && match && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const caret = ed.selectionStart;
      if (e.shiftKey) {
        const remove = Math.min(2, match[1].length);
        if (!remove) return;
        ed.setSelectionRange(lineStart, lineStart + remove);
        this.insertText('');
        ed.setSelectionRange(Math.max(lineStart, caret - remove), Math.max(lineStart, caret - remove));
      } else {
        ed.setSelectionRange(lineStart, lineStart);
        this.insertText('  ');
        ed.setSelectionRange(caret + 2, caret + 2);
      }
    }
  }

  onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    this.attachFiles(files);
  }

  // Uploads files to this page and inserts Markdown references to them
  async attachFiles(files) {
    if (!files.length || this.locked || !this.name) return;
    if (this.mode !== 'edit') this.setMode('edit');
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name || 'pasted-image.png');
    this.setStatus(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`, 'busy');
    try {
      const result = await api('POST', `${pageUrl(this.name)}/attachments`, form);
      const refs = result.files.map(f => {
        const target = `attachments/${encodeURIComponent(f.name)}`;
        return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(f.name) ? `![${f.name}](${target})` : `[${f.name}](${target})`;
      });
      const before = this.editor.value.slice(0, this.editor.selectionStart);
      const lead = before && !before.endsWith('\n') ? '\n' : '';
      this.insertText(`${lead}${refs.join('\n')}\n`);
      this.setStatus('Attached');
    } catch (err) {
      this.setStatus(`Upload failed: ${err.message}`, 'error');
    }
  }

  // ---------- Saving ----------

  setStatus(text, kind = '') {
    this.statusEl.textContent = text;
    this.statusEl.className = `save-status${kind ? ' ' + kind : ''}`;
  }

  // Saves now and waits for it (used before navigating away)
  async flush() {
    clearTimeout(this.saveTimer);
    if (this.dirty) await this.save();
    while (this.saving) await new Promise(r => setTimeout(r, 50));
  }

  async save() {
    if (!this.name || this.locked || this.deleted) return;
    if (this.saving) {
      this.saveQueued = true;
      return;
    }
    clearTimeout(this.saveTimer);
    clearTimeout(this.retryTimer);
    if (this.editor) this.local = this.editor.value;
    const sent = this.local;
    const force = this.forceNext;
    const snapshot = this.snapshotNext;
    this.forceNext = false;
    this.snapshotNext = false;
    if (sent === this.base && this.exists && !force) {
      this.dirty = false;
      this.setStatus('Saved');
      return;
    }
    this.saving = true;
    this.dirty = false;
    this.setStatus('Saving…', 'busy');
    const name = this.name;
    let again = false;

    try {
      const result = await put(pageUrl(name), { text: sent, baseVersion: this.version || undefined, force: force || undefined, snapshot: snapshot || undefined });
      if (this.name !== name) return;
      const serverText = result.merged ? result.text : sent;
      this.version = result.version;
      this.base = serverText;
      this.exists = true;
      this.updatedAt = Date.now();
      this.updatedBy = identity.name;
      if (result.merged) {
        const current = this.editor ? this.editor.value : this.local;
        const oldLocal = this.local;
        if (current === sent) {
          this.local = serverText;
        } else {
          // Typed more while saving: fold the other person's changes in locally
          const merged = mergeLocal(current, sent, serverText);
          this.local = merged === null ? current : merged;
          this.dirty = true;
          again = true;
        }
        this.updateContent(oldLocal);
        this.setStatus('Merged with changes from others');
      } else {
        this.renderInfo();
        this.setStatus(this.dirty ? 'Editing…' : 'Saved', this.dirty ? 'busy' : '');
      }
      this.onChange();
    } catch (err) {
      if (this.name !== name) return;
      this.dirty = true;
      if (err instanceof ApiError && err.status === 409) {
        again = await this.resolveConflict(sent, err.data);
      } else if (err instanceof ApiError && err.status === 401) {
        this.pendingDraft = this.local;
        this.showLocked('This page was locked. Enter the password to save your changes.');
      } else if (err instanceof ApiError) {
        this.setStatus(`Not saved: ${err.message}`, 'error');
      } else {
        this.setStatus(navigator.onLine ? 'Not saved: connection problem, retrying…' : 'Offline — will save when reconnected', 'error');
        this.retryTimer = setTimeout(() => this.save(), RETRY_DELAY_MS);
      }
    } finally {
      this.saving = false;
    }

    // Save again if asked to, or if edits arrived while this save was running
    const queued = this.saveQueued;
    this.saveQueued = false;
    if (again || (queued && this.dirty)) return this.save();
  }

  // Someone else changed the same lines. Returns true to save again.
  async resolveConflict(mine, data) {
    this.setStatus('Conflicting edit', 'error');
    const who = data.updatedBy || 'Someone';
    const choice = await modal({
      title: 'Edited at the same time',
      body: el('div', {}, [
        el('p', { text: `${who} changed the same lines you were editing. Which version should the page keep?` }),
        el('p', { text: '“Keep both” puts your lines and theirs one after the other so nothing is lost.' })
      ]),
      actions: [
        { label: 'Use theirs', value: 'theirs' },
        { label: 'Keep mine', value: 'mine' },
        { label: 'Keep both', value: 'both', primary: true }
      ]
    });
    const oldLocal = this.local;
    this.version = data.version;
    this.base = data.text;
    if (choice === 'theirs') {
      this.local = data.text;
      this.dirty = false;
      this.updateContent(oldLocal);
      this.setStatus('Using their version');
      toast('Loaded their version.', {
        action: { label: 'Undo', onClick: () => this.replaceText(mine) }
      });
      return false;
    }
    this.local = choice === 'mine' ? mine : (data.bothText || `${mine}\n\n${data.text}`);
    this.forceNext = true;
    this.updateContent(oldLocal);
    return true;
  }

  // Replaces the whole page (import, restore from undo)
  replaceText(text) {
    const oldLocal = this.local;
    this.local = text;
    this.forceNext = true;
    this.snapshotNext = true;
    this.markDirty();
    this.updateContent(oldLocal);
    return this.save();
  }

  // ---------- Live updates ----------

  connect() {
    if (!window.EventSource || !this.name) return;
    const url = `${pageUrl(this.name)}/events?client=${encodeURIComponent(identity.clientId)}&user=${encodeURIComponent(identity.name)}`;
    const source = new EventSource(url);
    this.source = source;
    let opened = false;
    source.addEventListener('open', () => {
      // After a reconnect we may have missed updates
      if (opened) this.refresh();
      opened = true;
    });
    source.addEventListener('presence', (e) => this.renderPresence(JSON.parse(e.data).users));
    source.addEventListener('update', (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId === identity.clientId || data.version === this.version) return;
      if (this.dirty || this.saving) return; // our next save merges their change
      this.refresh(data.by ? `Updated by ${data.by}` : 'Updated');
    });
    source.addEventListener('deleted', (e) => {
      const data = JSON.parse(e.data);
      this.deleted = true;
      this.disconnect();
      this.onChange();
      this.showError(`${data.by || 'Someone'} deleted this page. You can restore it from Trash.`);
    });
    source.addEventListener('renamed', (e) => {
      const data = JSON.parse(e.data);
      toast(`${data.by || 'Someone'} renamed this page to “${data.to}”.`);
      this.onChange();
      this.onNavigate(data.to, { replace: true });
    });
    source.addEventListener('protection', () => {
      this.onChange();
      this.refresh();
    });
  }

  disconnect() {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  renderPresence(users) {
    const others = users.filter(u => u.clientId !== identity.clientId);
    const seen = new Set();
    const unique = others.filter(u => (seen.has(u.user) ? false : seen.add(u.user)));
    const shown = unique.slice(0, 4).map(u => el('span', {
      class: 'avatar',
      title: `${u.user} is here`,
      style: `background:${colorFor(u.user)}`,
      text: initials(u.user)
    }));
    if (unique.length > 4) shown.push(el('span', { class: 'avatar', style: 'background:var(--faint)', text: `+${unique.length - 4}`, title: unique.slice(4).map(u => u.user).join(', ') }));
    this.presenceEl.replaceChildren(...shown);
    this.presenceEl.setAttribute('aria-label', unique.length ? `Also here: ${unique.map(u => u.user).join(', ')}` : 'Nobody else is here');
  }
}
