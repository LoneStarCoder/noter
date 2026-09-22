// Shared file manager for everyone who is signed in.
// File and folder names are only ever rendered as text.
import { api, get, post } from './lib/api.js';
import { el, icon, modal, confirmDialog, toast, formatSize, timeAgo } from './lib/ui.js';

const $ = id => document.getElementById(id);
let currentFolder = '';

function url(endpoint, params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) query.append(k, v);
  const qs = query.toString();
  return qs ? `${endpoint}?${qs}` : endpoint;
}

function showMain() {
  $('main-content').hidden = false;
  renderBreadcrumb();
  loadFiles();
}

// Signed-out requests are sent to the sign-in page by api(); anything else is shown
function handleAccess(err) {
  return err.status === 401;
}

// ---------- Upload ----------

const uploadArea = $('upload-area');
$('file-input').addEventListener('change', (e) => {
  upload([...e.target.files]);
  e.target.value = '';
});
uploadArea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    $('file-input').click();
  }
});
uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('dragover');
});
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  upload([...e.dataTransfer.files]);
});

async function upload(files) {
  if (!files.length) return;
  const status = $('upload-status');
  status.textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`;
  const form = new FormData();
  for (const file of files) form.append('files', file);
  try {
    const data = await api('POST', url('/upload', { folder: currentFolder }), form);
    if (!data.success) throw new Error(data.message || 'Upload failed');
    status.textContent = `Uploaded ${data.count} file${data.count > 1 ? 's' : ''}.`;
    loadFiles();
  } catch (err) {
    if (!handleAccess(err)) status.textContent = `Upload failed: ${err.message}`;
  }
}

// ---------- Listing ----------

function navigateTo(folder) {
  currentFolder = folder;
  renderBreadcrumb();
  loadFiles();
}

function renderBreadcrumb() {
  const crumbs = $('breadcrumb');
  const link = (label, folder) => el('a', {
    href: '#',
    text: label,
    onclick: (e) => {
      e.preventDefault();
      navigateTo(folder);
    }
  });
  crumbs.replaceChildren(link('All files', ''));
  let built = '';
  for (const part of currentFolder ? currentFolder.split('/') : []) {
    built = built ? `${built}/${part}` : part;
    crumbs.append(' / ', link(part, built));
  }
}

async function loadFiles() {
  const list = $('file-list');
  let items;
  try {
    items = await get(url('/list-files', { folder: currentFolder }));
  } catch (err) {
    if (!handleAccess(err)) list.replaceChildren(el('li', { class: 'list-empty', text: 'Could not load files' }));
    return;
  }
  items.sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
  if (!items.length) {
    list.replaceChildren(el('li', { class: 'list-empty', text: 'Nothing here yet.' }));
    return;
  }
  list.replaceChildren(...items.map(item => (item.isDirectory ? folderRow(item) : fileRow(item))));
}

function folderRow(folder) {
  const path = currentFolder ? `${currentFolder}/${folder.name}` : folder.name;
  const name = el('div', { class: 'primary-line', text: folder.name, onclick: () => navigateTo(path) });
  return el('li', { class: 'file-row folder' }, [
    el('span', { class: 'icon' }, [folderIcon()]),
    el('div', { class: 'grow' }, [name]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', text: 'Open', onclick: () => navigateTo(path) }),
      el('button', { class: 'btn small danger', type: 'button', text: 'Delete', onclick: () => deleteFolder(folder.name) })
    ])
  ]);
}

function folderIcon() {
  const svg = icon('file');
  svg.innerHTML = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
  return svg;
}

function fileRow(file) {
  const downloadUrl = url(`/download/${encodeURIComponent(file.name)}`, { folder: currentFolder });
  return el('li', { class: 'file-row' }, [
    el('span', { class: 'icon' }, [icon('file')]),
    el('div', { class: 'grow' }, [
      el('div', { class: 'primary-line', text: file.name }),
      el('div', { class: 'secondary-line', text: [formatSize(file.size), file.modifiedAt ? timeAgo(file.modifiedAt) : ''].filter(Boolean).join(' · ') })
    ]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', text: 'View', onclick: () => viewFile(file.name) }),
      el('a', { class: 'btn small', href: downloadUrl, download: file.name, text: 'Download' }),
      el('button', { class: 'btn small danger', type: 'button', text: 'Delete', onclick: () => deleteFile(file.name) })
    ])
  ]);
}

async function viewFile(name) {
  let body;
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name)) {
    body = el('img', { class: 'preview-img', alt: name, src: url(`/download/${encodeURIComponent(name)}`, { folder: currentFolder, inline: '1' }) });
  } else {
    try {
      const data = await get(url(`/view/${encodeURIComponent(name)}`, { folder: currentFolder }));
      body = data.isText
        ? el('pre', { class: 'preview-text', text: data.content })
        : el('p', { text: 'This file type cannot be previewed. Use Download instead.' });
    } catch (err) {
      if (handleAccess(err)) return;
      return toast(err.message, { error: true });
    }
  }
  await modal({ title: name, wide: true, body, actions: [{ label: 'Close', primary: true }] });
}

async function deleteFile(name) {
  if (!(await confirmDialog(`Delete “${name}”? This cannot be undone.`, { confirmLabel: 'Delete', danger: true }))) return;
  try {
    const data = await api('DELETE', url(`/delete-file/${encodeURIComponent(name)}`, { folder: currentFolder }));
    if (!data.success) throw new Error(data.message);
    loadFiles();
  } catch (err) {
    if (!handleAccess(err)) toast(`Delete failed: ${err.message}`, { error: true });
  }
}

async function deleteFolder(name) {
  if (!(await confirmDialog(`Delete the folder “${name}” and everything in it? This cannot be undone.`, { confirmLabel: 'Delete folder', danger: true }))) return;
  try {
    const data = await api('DELETE', url(`/delete-folder/${encodeURIComponent(name)}`, { parent: currentFolder }));
    if (!data.success) throw new Error(data.message);
    loadFiles();
  } catch (err) {
    if (!handleAccess(err)) toast(`Delete failed: ${err.message}`, { error: true });
  }
}

async function createFolder() {
  const input = $('folder-name-input');
  const name = input.value.trim();
  if (!name) return input.focus();
  try {
    const data = await post('/create-folder', { name, parent: currentFolder });
    if (!data.success) throw new Error(data.message);
    input.value = '';
    loadFiles();
  } catch (err) {
    if (!handleAccess(err)) toast(`Could not create folder: ${err.message}`, { error: true });
  }
}

$('create-folder-btn').addEventListener('click', createFolder);
$('folder-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createFolder();
});

showMain();
