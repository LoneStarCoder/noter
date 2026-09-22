// File manager page. All user-controlled values (file and folder names) are
// rendered with textContent / DOM properties, never through innerHTML.
(function () {
  let currentPassword = Noter.getPassword('files');
  let currentFolder = '';

  const passwordSection = document.getElementById('password-section');
  const mainContent = document.getElementById('main-content');
  const passwordInput = document.getElementById('password-input');
  const passwordStatus = document.getElementById('password-status');
  const uploadArea = document.getElementById('upload-area');
  const fileInput = document.getElementById('file-input');
  const uploadStatus = document.getElementById('upload-status');
  const uploadLoading = document.getElementById('upload-loading');
  const fileList = document.getElementById('file-list');
  const downloadLoading = document.getElementById('download-loading');
  const breadcrumb = document.getElementById('breadcrumb');
  const modal = document.getElementById('view-modal');
  const modalFilename = document.getElementById('modal-filename');
  const modalBodyContent = document.getElementById('modal-body-content');
  let modalObjectUrl = null;

  // Builds a URL with query params (empty values are dropped)
  function buildApiUrl(endpoint, params) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== '') query.append(key, value);
    });
    const qs = query.toString();
    return qs ? endpoint + '?' + qs : endpoint;
  }

  function api(url, options = {}) {
    options.headers = Noter.authHeaders(currentPassword, options.headers);
    return fetch(url, options);
  }

  function el(tag, props, children) {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach(child => node.append(child));
    return node;
  }

  function setStatus(target, message, isError) {
    target.textContent = message;
    target.classList.remove('success', 'error');
    target.classList.add(isError ? 'error' : 'success');
  }

  function showMain() {
    passwordSection.style.display = 'none';
    mainContent.style.display = 'block';
    updateBreadcrumb();
    loadFiles();
  }

  function showPasswordForm(message) {
    mainContent.style.display = 'none';
    passwordSection.style.display = 'block';
    if (message) setStatus(passwordStatus, message, true);
    passwordInput.focus();
  }

  // Handles auth-related statuses shared by every call; returns true if handled
  async function handleAuthError(res) {
    if (res.status === 401) {
      currentPassword = '';
      Noter.setPassword('files', '');
      showPasswordForm('Password required');
      return true;
    }
    if (res.status === 403 || res.status === 429) {
      const data = await res.json().catch(() => ({}));
      showPasswordForm(data.message || 'Access denied');
      return true;
    }
    return false;
  }

  function checkAccess() {
    api(buildApiUrl('/list-files'))
      .then(async res => {
        if (res.status === 401) {
          showPasswordForm(currentPassword ? 'Incorrect password' : '');
          if (!currentPassword) passwordStatus.className = 'status-message';
          return;
        }
        if (await handleAuthError(res)) return;
        showMain();
      })
      .catch(() => showPasswordForm('Error contacting server'));
  }

  function submitPassword() {
    const password = passwordInput.value;
    if (!password) {
      setStatus(passwordStatus, 'Please enter a password', true);
      return;
    }
    currentPassword = password;
    api(buildApiUrl('/list-files'))
      .then(async res => {
        if (res.ok) {
          Noter.setPassword('files', password);
          passwordInput.value = '';
          passwordStatus.className = 'status-message';
          showMain();
          return;
        }
        currentPassword = '';
        const data = await res.json().catch(() => ({}));
        setStatus(passwordStatus, res.status === 401 ? 'Incorrect password' : (data.message || 'Access denied'), true);
      })
      .catch(() => setStatus(passwordStatus, 'Error checking password', true));
  }

  document.getElementById('password-submit').addEventListener('click', submitPassword);
  passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitPassword();
  });

  // Drag and drop
  uploadArea.addEventListener('click', () => fileInput.click());
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  function handleFiles(files) {
    if (files.length === 0) return;

    uploadLoading.classList.add('active');
    uploadStatus.classList.remove('success', 'error');

    const formData = new FormData();
    for (const file of files) formData.append('files', file);

    api(buildApiUrl('/upload', { folder: currentFolder }), { method: 'POST', body: formData })
      .then(async res => {
        uploadLoading.classList.remove('active');
        if (await handleAuthError(res)) return;
        const data = await res.json();
        if (data.success) {
          setStatus(uploadStatus, `Successfully uploaded ${data.count} file(s)`, false);
          fileInput.value = '';
          loadFiles();
        } else {
          setStatus(uploadStatus, data.message || 'Upload failed', true);
        }
      })
      .catch(err => {
        uploadLoading.classList.remove('active');
        setStatus(uploadStatus, 'Upload failed: ' + err.message, true);
      });
  }

  function navigateToFolder(folder) {
    currentFolder = folder;
    updateBreadcrumb();
    loadFiles();
  }

  function folderLink(label, folder) {
    const link = el('a', { href: '#', textContent: label });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToFolder(folder);
    });
    return link;
  }

  function updateBreadcrumb() {
    breadcrumb.replaceChildren(folderLink('Root', ''));
    let builtPath = '';
    (currentFolder ? currentFolder.split('/') : []).forEach(part => {
      builtPath = builtPath ? builtPath + '/' + part : part;
      breadcrumb.append(' / ', folderLink(part, builtPath));
    });
  }

  function button(label, className, onClick) {
    const btn = el('button', { textContent: label, className: className || '' });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function renderFolder(folder) {
    const subPath = currentFolder ? currentFolder + '/' + folder.name : folder.name;
    const info = el('div', { className: 'file-info' }, [
      el('p', { className: 'file-name', textContent: '📁 ' + folder.name })
    ]);
    info.style.cursor = 'pointer';
    info.addEventListener('click', () => navigateToFolder(subPath));

    return el('div', { className: 'file-item folder-item' }, [
      info,
      el('div', { className: 'file-actions' }, [
        button('Open', '', () => navigateToFolder(subPath)),
        button('Delete', 'delete-btn', () => deleteFolder(folder.name))
      ])
    ]);
  }

  function renderFile(file) {
    return el('div', { className: 'file-item' }, [
      el('div', { className: 'file-info' }, [
        el('p', { className: 'file-name', textContent: file.name }),
        el('p', { className: 'file-size', textContent: formatSize(file.size) })
      ]),
      el('div', { className: 'file-actions' }, [
        button('View', 'view-btn', () => viewFile(file.name)),
        button('Download', '', () => downloadFile(file.name)),
        button('Delete', 'delete-btn', () => deleteFile(file.name))
      ])
    ]);
  }

  function loadFiles() {
    downloadLoading.classList.add('active');
    fileList.replaceChildren();

    api(buildApiUrl('/list-files', { folder: currentFolder }))
      .then(async res => {
        downloadLoading.classList.remove('active');
        if (await handleAuthError(res)) return;
        const items = await res.json();
        const folders = items.filter(i => i.isDirectory);
        const files = items.filter(i => !i.isDirectory);

        if (folders.length === 0 && files.length === 0) {
          const empty = el('p', { textContent: 'No files or folders here' });
          empty.style.cssText = 'color: #666; text-align: center;';
          fileList.append(empty);
          return;
        }
        folders.forEach(folder => fileList.append(renderFolder(folder)));
        files.forEach(file => fileList.append(renderFile(file)));
      })
      .catch(() => {
        downloadLoading.classList.remove('active');
        const error = el('p', { textContent: 'Failed to load files' });
        error.style.color = 'red';
        fileList.append(error);
      });
  }

  function createFolder() {
    const input = document.getElementById('folder-name-input');
    const name = input.value.trim();
    if (!name) {
      alert('Please enter a folder name');
      return;
    }

    api('/create-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent: currentFolder })
    })
      .then(async res => {
        if (await handleAuthError(res)) return;
        const data = await res.json();
        if (data.success) {
          input.value = '';
          loadFiles();
        } else {
          alert('Failed to create folder: ' + (data.message || 'Unknown error'));
        }
      })
      .catch(err => alert('Failed to create folder: ' + err.message));
  }

  document.getElementById('create-folder-btn').addEventListener('click', createFolder);

  // Downloads go through fetch so the password travels in a header, not the URL
  async function fetchFileBlob(filename) {
    const res = await api(buildApiUrl(`/download/${encodeURIComponent(filename)}`, { folder: currentFolder }));
    if (await handleAuthError(res)) return null;
    if (!res.ok) throw new Error('File not found');
    return res.blob();
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadFile(filename) {
    fetchFileBlob(filename)
      .then(blob => blob && saveBlob(blob, filename))
      .catch(err => alert('Download failed: ' + err.message));
  }

  function deleteFile(filename) {
    if (!confirm(`Delete "${filename}"?`)) return;

    api(buildApiUrl(`/delete-file/${encodeURIComponent(filename)}`, { folder: currentFolder }), { method: 'DELETE' })
      .then(async res => {
        if (await handleAuthError(res)) return;
        const data = await res.json();
        if (data.success) loadFiles();
        else alert('Delete failed: ' + (data.message || 'Unknown error'));
      })
      .catch(err => alert('Delete failed: ' + err.message));
  }

  function deleteFolder(foldername) {
    if (!confirm(`Delete folder "${foldername}" and all its contents?`)) return;

    api(buildApiUrl(`/delete-folder/${encodeURIComponent(foldername)}`, { parent: currentFolder }), { method: 'DELETE' })
      .then(async res => {
        if (await handleAuthError(res)) return;
        const data = await res.json();
        if (data.success) loadFiles();
        else alert('Delete failed: ' + (data.message || 'Unknown error'));
      })
      .catch(err => alert('Delete failed: ' + err.message));
  }

  async function viewFile(filename) {
    try {
      const res = await api(buildApiUrl(`/view/${encodeURIComponent(filename)}`, { folder: currentFolder }));
      if (await handleAuthError(res)) return;
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'File not found');

      modalFilename.textContent = filename;
      modalBodyContent.replaceChildren();

      if (data.isText && typeof data.content === 'string') {
        modalBodyContent.append(el('div', { className: 'file-content', textContent: data.content }));
      } else {
        const extension = filename.split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension)) {
          const blob = await fetchFileBlob(filename);
          if (!blob) return;
          modalObjectUrl = URL.createObjectURL(blob);
          const img = el('img', { src: modalObjectUrl, alt: filename });
          img.style.cssText = 'max-width: 100%; max-height: 500px;';
          modalBodyContent.append(img);
        } else {
          const link = el('a', { href: '#', textContent: 'Download it instead' });
          link.addEventListener('click', (e) => {
            e.preventDefault();
            downloadFile(filename);
          });
          modalBodyContent.append(el('p', {}, ['This file cannot be previewed. ', link]));
        }
      }
      modal.classList.add('active');
    } catch (err) {
      alert('Failed to view file: ' + err.message);
    }
  }

  function closeModal() {
    modal.classList.remove('active');
    if (modalObjectUrl) {
      URL.revokeObjectURL(modalObjectUrl);
      modalObjectUrl = null;
    }
  }

  document.getElementById('modal-close').addEventListener('click', closeModal);
  window.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });

  function formatSize(bytes) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  Noter.initThemeToggle(document.getElementById('theme-toggle'));
  checkAccess();
})();
