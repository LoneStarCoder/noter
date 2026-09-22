// Note pad logic shared by the home page and the per-page editor.
// The page name comes from <body data-page="..."> or the last URL segment.
(function () {
  const pad = document.getElementById('pad');
  const name = document.body.dataset.page ||
    decodeURIComponent(window.location.pathname.split('/').pop()) || 'home';
  const statusEl = document.getElementById('save-status');
  let password = Noter.getPassword(name);
  let saveTimer;
  let version = null;       // version of the text last loaded from / saved to the server
  let dirty = false;        // edits not yet saved
  let saving = false;
  let saveQueued = false;

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function setEditable(editable) {
    pad.contentEditable = editable ? 'true' : 'false';
  }

  function request(url, options = {}) {
    options.headers = Noter.authHeaders(password, options.headers);
    return fetch(url, options);
  }

  // Asks for the page password; returns false if the user cancels
  function askPassword(message) {
    const pw = prompt(message);
    password = pw || '';
    Noter.setPassword(name, password);
    return Boolean(pw);
  }

  async function loadPad() {
    setEditable(false);
    const res = await request(`/load/${encodeURIComponent(name)}`);

    if (res.status === 401) {
      pad.textContent = '[🔒 This page is protected]';
      const message = password
        ? 'Incorrect password. Try again:'
        : 'This page is password protected. Enter password:';
      if (askPassword(message)) return loadPad();
      return;
    }
    if (res.status === 429) {
      pad.textContent = '[Too many failed password attempts. Try again later.]';
      return;
    }
    if (!res.ok) {
      pad.textContent = '[Failed to load this page]';
      return;
    }

    version = res.headers.get('X-Note-Version');
    Noter.renderLinkified(pad, await res.text());
    dirty = false;
    setStatus('');
    setEditable(true);
  }

  function downloadText(text, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // The page changed elsewhere since we loaded it. Returns true to overwrite.
  async function resolveConflict(myText) {
    const overwrite = confirm(
      'This page was changed somewhere else since you opened it.\n\n' +
      'OK: keep YOUR version (replaces the other changes)\n' +
      'Cancel: load the LATEST version (your text is downloaded as a backup file)'
    );
    if (overwrite) return true;
    downloadText(myText, `person_${name}_backup.txt`);
    await loadPad();
    return false;
  }

  // Saves the pad. Only one save runs at a time; edits made meanwhile are
  // saved right after. `force` skips the conflict check.
  async function savePad(force = false) {
    if (saving) {
      saveQueued = true;
      return;
    }
    saving = true;
    dirty = false;
    setStatus('Saving…');
    const text = Noter.extractPlainText(pad);
    let retry = false;
    let retryForce = false;

    try {
      const body = { text };
      if (version && !force) body.baseVersion = version;
      const res = await request(`/save/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        version = (await res.json()).version;
        setStatus(dirty ? 'Unsaved changes' : 'Saved');
      } else if (res.status === 409) {
        dirty = true;
        setStatus('Conflict: page changed elsewhere', true);
        retry = retryForce = await resolveConflict(text);
      } else if (res.status === 401) {
        dirty = true;
        setStatus('Not saved: password required', true);
        retry = askPassword('Enter the password to save this page:');
      } else {
        dirty = true;
        const data = await res.json().catch(() => ({}));
        setStatus('Not saved: ' + (data.message || `error ${res.status}`), true);
      }
    } catch (err) {
      dirty = true;
      setStatus('Not saved: connection problem, retrying…', true);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => savePad(force), 5000);
    } finally {
      saving = false;
    }

    if (retry || saveQueued) {
      saveQueued = false;
      return savePad(retryForce);
    }
  }

  pad.addEventListener('input', () => {
    if (pad.contentEditable !== 'true') return;
    dirty = true;
    setStatus('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePad(), 500);
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty || saving) e.preventDefault();
  });

  loadPad().catch(err => {
    console.warn(err);
    pad.textContent = '[Failed to load this page]';
  });

  Noter.initThemeToggle(document.getElementById('theme-toggle'));

  // Editor-only controls
  const deleteBtn = document.getElementById('delete-btn');
  if (deleteBtn) {
    if (name === 'home') deleteBtn.style.display = 'none';

    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to delete this page? This cannot be undone.')) return;
      const res = await request(`/delete/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) {
        dirty = false;
        alert('Page deleted.');
        window.location.href = '/';
      } else {
        alert('Failed to delete page.');
      }
    });
  }

  const downloadBtn = document.getElementById('download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      downloadText(Noter.extractPlainText(pad), `person_${name}.txt`);
    });
  }

  const uploadInput = document.getElementById('upload-input');
  if (uploadInput) {
    uploadInput.addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (!file || !file.name.endsWith('.txt')) {
        alert('Please select a .txt file');
        return;
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        if (!confirm('Replace this page with the contents of the file?')) return;
        Noter.renderLinkified(pad, e.target.result);
        setEditable(true);
        clearTimeout(saveTimer);
        await savePad(true);
        uploadInput.value = '';
      };
      reader.readAsText(file);
    });
  }
})();
