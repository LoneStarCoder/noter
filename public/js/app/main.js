import { get, post } from '../lib/api.js';
import { el, icon, toast, confirmDialog, downloadText } from '../lib/ui.js';
import { identity } from '../lib/identity.js';
import { PageView } from './page.js';
import { Sidebar } from './sidebar.js';
import {
  showHistory, showShare, showPrivacy, renamePage, deletePage,
  showTrash, newPage, showSettings, showSwitcher
} from './dialogs.js';

const $ = id => document.getElementById(id);
const app = $('app');
let session = { user: null, admin: false, adminConfigured: false, files: false, filesConfigured: false, unlocked: [] };

// Old versions kept page passwords in browser storage in plain text; remove them
try {
  for (const store of [localStorage, sessionStorage]) {
    Object.keys(store).filter(k => k.startsWith('pw_')).forEach(k => store.removeItem(k));
  }
} catch (err) {
  // storage unavailable
}

const sidebar = new Sidebar({ list: $('page-list'), filter: $('filter-input'), tagRow: $('tag-row') });

let refreshTimer;
function refreshSidebarSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => sidebar.refresh(), 400);
}

const page = new PageView({
  body: $('page-body'),
  title: $('page-title'),
  lockIcon: $('page-lock-icon'),
  status: $('save-status'),
  modeToggle: $('mode-toggle'),
  menuButton: $('page-menu-btn'),
  presence: $('presence'),
  onChange: refreshSidebarSoon,
  onNavigate: (name, opts) => navigate(name, opts)
});

// Returns 'ok', 'offline' or 'signed-out'
async function loadSession() {
  try {
    session = await get('/api/session');
    if (session.user) identity.name = session.user.name;
    return session.user ? 'ok' : 'signed-out';
  } catch (err) {
    return err instanceof TypeError ? 'offline' : 'signed-out';
  }
}

async function signOut() {
  await page.flush();
  page.disconnect();
  try {
    await post('/api/auth/logout');
  } finally {
    // Nothing from this account should stay readable on the device
    if (window.caches) await caches.delete('noter-api').catch(() => {});
    window.location.replace('/login');
  }
}

// ---------- Routing ----------

function nameFromPath(pathname) {
  const match = /^\/(?:person|p)\/([^/]+)\/?$/.exec(pathname);
  if (match) return decodeURIComponent(match[1]);
  return 'home';
}

function pathFor(name) {
  return name === 'home' ? '/' : `/person/${encodeURIComponent(name)}`;
}

async function navigate(name, { replace = false, edit = false } = {}) {
  const url = new URL(pathFor(name), window.location.origin);
  const tag = new URLSearchParams(window.location.search).get('tag');
  if (tag) url.searchParams.set('tag', tag);
  if (replace) history.replaceState({ name }, '', url);
  else if (url.pathname !== window.location.pathname) history.pushState({ name }, '', url);
  app.classList.remove('nav-open');
  sidebar.setCurrent(name);
  await page.open(name);
  if (edit && !page.locked) page.setMode('edit', { focus: true });
}

window.addEventListener('popstate', () => {
  const name = nameFromPath(window.location.pathname);
  sidebar.setCurrent(name);
  page.open(name);
});

// In-app links (sidebar, [[wikilinks]], #tags) navigate without a reload
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || link.target) return;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin) return;
  if (url.pathname === '/' && url.searchParams.has('tag')) {
    e.preventDefault();
    sidebar.setTag(url.searchParams.get('tag'));
    app.classList.add('nav-open');
    return;
  }
  if (url.pathname === '/' || /^\/(person|p)\/[^/]+$/.test(url.pathname)) {
    e.preventDefault();
    navigate(nameFromPath(url.pathname));
  }
});

// ---------- Page menu ----------

function menuItem(iconName, label, onClick, danger = false) {
  return el('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', onclick: () => { closeMenu(); onClick(); } }, [icon(iconName), label]);
}

let openMenu = null;
function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
    $('page-menu-btn').setAttribute('aria-expanded', 'false');
  }
}

function showPageMenu() {
  if (openMenu) return closeMenu();
  const isHome = page.name === 'home';
  const menu = el('div', { class: 'menu', role: 'menu' }, [
    menuItem('history', 'History', () => showHistory(page)),
    menuItem('share', 'Share read-only link', () => showShare(page)),
    menuItem(page.protected ? 'lock' : 'unlock', page.protected ? 'Password & privacy' : 'Make private', () => showPrivacy(page, session)),
    menuItem('attach', 'Attach files', () => $('attach-input').click()),
    el('hr'),
    isHome ? null : menuItem('rename', 'Rename', () => renamePage(page, navigate)),
    menuItem('upload', 'Replace with a file…', () => $('import-input').click()),
    menuItem('download', 'Download as Markdown', () => downloadText(page.local, `${page.name}.md`)),
    menuItem('print', 'Print', () => {
      if (page.mode === 'edit') page.setMode('view');
      setTimeout(() => window.print(), 50);
    }),
    isHome ? null : el('hr'),
    isHome ? null : menuItem('trash', 'Delete page', () => deletePage(page, navigate), true)
  ]);
  const rect = $('page-menu-btn').getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6 + window.scrollY}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  document.body.append(menu);
  openMenu = menu;
  $('page-menu-btn').setAttribute('aria-expanded', 'true');
  menu.querySelector('button').focus();
}

$('page-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  showPageMenu();
});
document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});

// ---------- Buttons ----------

$('new-page-btn').addEventListener('click', () => newPage(navigate, refreshSidebarSoon));
$('search-btn').addEventListener('click', () => showSwitcher(sidebar, navigate));
$('trash-btn').addEventListener('click', () => showTrash(session, navigate, refreshSidebarSoon));
$('settings-btn').addEventListener('click', () => showSettings(session, {
  onChange: refreshSidebarSoon,
  onSessionChange: async () => {
    await loadSession();
    if (page.name) page.open(page.name);
    return session;
  },
  onSignOut: signOut
}));
$('nav-btn').addEventListener('click', () => app.classList.toggle('nav-open'));
$('scrim').addEventListener('click', () => app.classList.remove('nav-open'));

$('attach-input').addEventListener('change', (e) => {
  page.attachFiles([...e.target.files]);
  e.target.value = '';
});

$('import-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    if (!(await confirmDialog(`Replace “${page.name}” with the contents of ${file.name}? The current text is kept in history.`, { confirmLabel: 'Replace' }))) return;
    await page.replaceText(String(reader.result));
    toast('Page replaced');
  };
  reader.readAsText(file);
});

// Drag files anywhere on the page to attach them
let dragDepth = 0;
let overlay = null;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files') || page.locked || !page.name) return;
  dragDepth++;
  if (!overlay) {
    overlay = el('div', { class: 'drop-overlay', text: `Drop to attach to “${page.name}”` });
    document.body.append(overlay);
  }
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth && overlay) {
    overlay.remove();
    overlay = null;
  }
});
document.addEventListener('dragover', (e) => {
  if (overlay) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (!overlay) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.remove();
  overlay = null;
  page.attachFiles([...e.dataTransfer.files]);
});

// ---------- Keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const inDialog = Boolean(document.querySelector('dialog[open]'));
  if (e.key === 'Escape') {
    closeMenu();
    app.classList.remove('nav-open');
  }
  if (inDialog) return;
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    showSwitcher(sidebar, navigate);
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    page.flush().then(() => {
      if (!page.dirty && !page.locked) page.setStatus('Saved');
    });
  } else if (mod && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    page.toggleMode();
  } else if (e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newPage(navigate, refreshSidebarSoon);
  }
});

// ---------- Online status ----------

function updateOnline() {
  $('offline-banner').hidden = navigator.onLine;
}
window.addEventListener('online', () => {
  updateOnline();
  sidebar.refresh();
});
window.addEventListener('offline', updateOnline);
updateOnline();

// Keep the list fresh when coming back to the tab
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    sidebar.refresh();
    page.refresh();
  }
});
setInterval(() => {
  if (document.visibilityState === 'visible') sidebar.refresh();
}, 60 * 1000);

// ---------- Start ----------

(async function start() {
  const name = nameFromPath(window.location.pathname);
  sidebar.setCurrent(name);
  history.replaceState({ name }, '', window.location.href);
  // Offline, carry on with what this device has cached (the server still
  // checks the sign-in on every request once we're back online)
  const state = await loadSession();
  if (state === 'signed-out') return; // the API call above sent us to the sign-in page
  sidebar.refresh();
  await page.open(name);
  if (new URLSearchParams(window.location.search).has('search')) showSwitcher(sidebar, navigate);
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
