// Small DOM helpers: element builder, icons, toasts and dialogs

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const ICONS = {
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  share: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  rename: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  attach: '<path d="m21 12-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8L15 7"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  print: '<path d="M6 9V3h12v6M6 18H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-2M6 14h12v7H6z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// ---------- Toasts ----------

export function toast(message, { error = false, action, duration = 4000 } = {}) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const node = el('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, [el('span', { text: message })]);
  if (action) {
    node.append(el('button', {
      text: action.label,
      onclick: () => {
        node.remove();
        action.onClick();
      }
    }));
  }
  container.append(node);
  setTimeout(() => node.remove(), action ? Math.max(duration, 7000) : duration);
}

// ---------- Dialogs ----------

// Opens a modal. `actions`: [{ label, value, primary, danger, onClick }]
// onClick may return false to keep the dialog open. Resolves with the value.
export function modal({ title, body, actions = [], wide = false, onOpen, initialFocus }) {
  return new Promise(resolve => {
    const dialog = el('dialog', { class: `modal${wide ? ' wide' : ''}` });
    let result;
    const footer = el('div', { class: 'modal-footer' });
    for (const action of actions) {
      footer.append(el('button', {
        type: 'button',
        class: `btn${action.primary ? ' primary' : ''}${action.danger ? ' danger' : ''}${action.solid ? ' solid' : ''}`,
        text: action.label,
        onclick: async () => {
          if (action.onClick) {
            const keep = await action.onClick();
            if (keep === false) return;
          }
          result = action.value;
          dialog.close();
        }
      }));
    }
    const closeButton = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, [icon('close')]);
    dialog.append(el('div', { class: 'modal-inner' }, [
      el('div', { class: 'modal-header' }, [el('h2', { text: title }), closeButton]),
      el('div', { class: 'modal-body' }, [body]),
      actions.length ? footer : null
    ]));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    // Enter in a single-line input triggers the primary action
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
        const primary = footer.querySelector('.btn.primary');
        if (primary) {
          e.preventDefault();
          primary.click();
        }
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    if (onOpen) onOpen(dialog);
    const focusTarget = initialFocus ? dialog.querySelector(initialFocus) : dialog.querySelector('input, textarea, select');
    if (focusTarget) focusTarget.focus();
  });
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'OK', danger = false } = {}) {
  return modal({
    title,
    body: el('p', { text: message }),
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, primary: !danger, danger, solid: danger }
    ],
    initialFocus: '.btn:last-child'
  }).then(Boolean);
}

// Text input dialog. `validate(value)` returns an error message or ''.
// `submit(value)` may throw to show an error and keep the dialog open.
export function promptDialog({ title, label, value = '', type = 'text', placeholder = '', confirmLabel = 'OK', note, validate, submit }) {
  const input = el('input', { class: 'input', type, value, placeholder, autocomplete: type === 'password' ? 'new-password' : 'off' });
  const error = el('div', { class: 'form-error' });
  const body = el('div', {}, [
    note ? el('p', { text: note }) : null,
    el('label', { class: 'field' }, [label, input]),
    error
  ]);
  let submitted;
  return modal({
    title,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: confirmLabel,
        primary: true,
        onClick: async () => {
          const problem = validate ? validate(input.value) : '';
          if (problem) {
            error.textContent = problem;
            return false;
          }
          if (submit) {
            try {
              await submit(input.value);
            } catch (err) {
              error.textContent = err.message;
              return false;
            }
          }
          submitted = input.value;
          return true;
        }
      }
    ]
  }).then(() => submitted);
}

// ---------- Formatting ----------

export function timeAgo(ms) {
  if (!ms) return '';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

export function formatDateTime(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Math.round((bytes / 1024 ** i) * 10) / 10} ${units[i]}`;
}

// Turns "My Page!" into "my-page"
export function slugify(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

export function downloadText(text, filename, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    return false;
  }
}
