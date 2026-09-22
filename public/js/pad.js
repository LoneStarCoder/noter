// Note pad logic shared by the home page and the per-page editor.
// The page name comes from <body data-page="..."> or the last URL segment.
(function () {
  const pad = document.getElementById('pad');
  const name = document.body.dataset.page ||
    decodeURIComponent(window.location.pathname.split('/').pop()) || 'home';
  let password = Noter.getPassword(name);
  let saveTimer;

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

    Noter.renderLinkified(pad, await res.text());
    setEditable(true);
  }

  function savePad(text) {
    return request(`/save/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  }

  pad.addEventListener('input', () => {
    if (pad.contentEditable !== 'true') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePad(Noter.extractPlainText(pad)), 500);
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
      const blob = new Blob([Noter.extractPlainText(pad)], { type: 'text/plain' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `person_${name}.txt`;
      link.click();
      URL.revokeObjectURL(link.href);
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
        const text = e.target.result;
        const res = await savePad(text);
        if (res.ok) {
          Noter.renderLinkified(pad, text);
          setEditable(true);
          alert('File uploaded and saved.');
        } else {
          alert('Failed to save the uploaded file.');
        }
      };
      reader.readAsText(file);
    });
  }
})();
