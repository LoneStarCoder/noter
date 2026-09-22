// Dialogs for page actions: history, sharing, passwords, rename, trash,
// settings, new page and the quick switcher.
import { api, get, post, del, pageUrl, ApiError } from '../lib/api.js';
import { el, icon, modal, promptDialog, confirmDialog, toast, timeAgo, formatDateTime, formatSize, slugify, copyText } from '../lib/ui.js';
import { identity } from '../lib/identity.js';
import { diffComm } from '/vendor/diff3.mjs';

const CONTEXT_LINES = 3;

// ---------- History ----------

function renderDiff(oldText, newText) {
  const pre = el('div', { class: 'diff', role: 'region', 'aria-label': 'Changes' });
  const chunks = diffComm(oldText.split('\n'), newText.split('\n'));
  if (chunks.every(c => c.common)) {
    pre.append(el('div', { class: 'gap', text: 'Same as the current version.' }));
    return pre;
  }
  chunks.forEach((chunk, i) => {
    if (chunk.common) {
      let lines = chunk.common;
      const first = i === 0;
      const last = i === chunks.length - 1;
      const keepStart = first ? 0 : CONTEXT_LINES;
      const keepEnd = last ? 0 : CONTEXT_LINES;
      if (lines.length > keepStart + keepEnd + 1) {
        const hidden = lines.length - keepStart - keepEnd;
        for (const line of lines.slice(0, keepStart)) pre.append(el('div', { text: line || ' ' }));
        pre.append(el('div', { class: 'gap', text: `… ${hidden} unchanged line${hidden === 1 ? '' : 's'} …` }));
        lines = keepEnd ? lines.slice(-keepEnd) : [];
      }
      for (const line of lines) pre.append(el('div', { text: line || ' ' }));
    } else {
      // buffer1 = that version, buffer2 = current
      for (const line of chunk.buffer1) pre.append(el('div', { class: 'add', text: `+ ${line}` }));
      for (const line of chunk.buffer2) pre.append(el('div', { class: 'del', text: `− ${line}` }));
    }
  });
  return pre;
}

export async function showHistory(page) {
  const name = page.name;
  let entries;
  try {
    entries = await get(`${pageUrl(name)}/history`);
  } catch (err) {
    return toast(`Could not load history: ${err.message}`, { error: true });
  }
  const current = page.local;
  const list = el('ul', { class: 'list', 'aria-label': 'Versions' });
  const detail = el('div', {});
  let selected = null;
  let restoreButton;

  async function select(entry, item) {
    for (const li of list.children) li.classList.remove('selected');
    item.classList.add('selected');
    detail.replaceChildren(el('p', { text: 'Loading…' }));
    try {
      selected = await get(`${pageUrl(name)}/history/${encodeURIComponent(entry.id)}`);
    } catch (err) {
      detail.replaceChildren(el('p', { text: err.message }));
      return;
    }
    detail.replaceChildren(
      el('p', { text: `${formatDateTime(selected.savedAt)}${selected.by ? ' · ' + selected.by : ''} — green lines are in this version, red lines are in the current one.` }),
      renderDiff(selected.text, current)
    );
    if (restoreButton) restoreButton.disabled = false;
  }

  if (!entries.length) {
    list.append(el('li', { class: 'list-empty', text: 'No earlier versions yet. Versions are kept as people edit.' }));
  }
  for (const entry of entries) {
    const item = el('li', { class: 'selectable', tabindex: 0 }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'primary-line', text: timeAgo(entry.savedAt), title: formatDateTime(entry.savedAt) }),
        el('div', { class: 'secondary-line', text: [entry.by || 'Earlier version', formatSize(entry.size)].join(' · ') })
      ])
    ]);
    item.addEventListener('click', () => select(entry, item));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') select(entry, item);
    });
    list.append(item);
  }

  const body = el('div', { class: 'history-layout' }, [list, detail]);
  detail.append(el('p', { text: entries.length ? 'Pick a version to see what changed.' : '' }));

  await modal({
    title: `History of ${name}`,
    wide: true,
    body,
    onOpen: (dialog) => {
      restoreButton = dialog.querySelector('.modal-footer .btn.primary');
      restoreButton.disabled = true;
      const first = list.querySelector('li.selectable');
      if (first) first.click();
    },
    actions: [
      {
        label: 'Copy text',
        onClick: async () => {
          if (selected) toast((await copyText(selected.text)) ? 'Copied to clipboard' : 'Could not copy');
          return false;
        }
      },
      {
        label: 'Restore this version',
        primary: true,
        onClick: async () => {
          if (!selected) return false;
          try {
            await post(`${pageUrl(name)}/restore`, { id: selected.id });
            toast('Version restored. The replaced text was kept in history.');
            await page.open(name);
            page.onChange();
          } catch (err) {
            toast(`Restore failed: ${err.message}`, { error: true });
            return false;
          }
        }
      }
    ]
  });
}

// ---------- Share links ----------

export async function showShare(page) {
  const name = page.name;
  const listEl = el('ul', { class: 'list' });
  const fullUrl = url => `${window.location.origin}${url}`;

  async function load() {
    let shares = [];
    try {
      shares = await get(`${pageUrl(name)}/shares`);
    } catch (err) {
      listEl.replaceChildren(el('li', { text: err.message }));
      return;
    }
    if (!shares.length) {
      listEl.replaceChildren(el('li', { class: 'list-empty', text: 'No links yet.' }));
      return;
    }
    listEl.replaceChildren(...shares.map(share => {
      const input = el('input', { class: 'input', readonly: true, value: fullUrl(share.url), 'aria-label': 'Share link' });
      input.addEventListener('focus', () => input.select());
      return el('li', {}, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'share-url' }, [
            input,
            el('button', {
              class: 'btn small',
              type: 'button',
              text: 'Copy',
              onclick: async () => toast((await copyText(fullUrl(share.url))) ? 'Link copied' : 'Select the link and copy it')
            })
          ]),
          el('div', { class: 'secondary-line', text: `Created ${timeAgo(share.createdAt)}${share.createdBy ? ' by ' + share.createdBy : ''}` })
        ]),
        el('button', {
          class: 'btn small danger',
          type: 'button',
          text: 'Revoke',
          onclick: async () => {
            await del(`/api/shares/${encodeURIComponent(share.token)}`);
            toast('Link revoked');
            load();
          }
        })
      ]);
    }));
  }

  await load();
  await modal({
    title: `Share ${name}`,
    body: el('div', {}, [
      el('p', { text: 'Anyone with a link can read this page (and its attachments) but not edit it — even if the page is private. Revoke a link to turn it off.' }),
      listEl
    ]),
    actions: [
      { label: 'Done' },
      {
        label: 'Create link',
        primary: true,
        onClick: async () => {
          try {
            if (page.dirty) await page.flush();
            const share = await post(`${pageUrl(name)}/shares`);
            await copyText(fullUrl(share.url));
            toast('Link created and copied');
            load();
          } catch (err) {
            toast(err.message, { error: true });
          }
          return false;
        }
      }
    ]
  });
}

// ---------- Password / privacy ----------

export async function showPrivacy(page, session) {
  const name = page.name;
  if (!page.protected) {
    const note = page.exists && page.local.trim()
      ? (session.admin
        ? 'Only people with the password will be able to see or edit this page.'
        : 'Only the admin can make an existing shared page private, so nobody gets locked out of a page they use. New pages can be made private when you create them.')
      : 'Only people with the password will be able to see or edit this page.';
    const canLock = !page.exists || !page.local.trim() || session.admin;
    if (!canLock) {
      await modal({ title: 'Make private', body: el('p', { text: note }), actions: [{ label: 'OK', primary: true }] });
      return;
    }
    const password = await promptDialog({
      title: `Make ${name} private`,
      note,
      label: 'Password (at least 4 characters)',
      type: 'password',
      confirmLabel: 'Make private',
      validate: v => (v.length < 4 ? 'Use at least 4 characters' : ''),
      submit: async v => post(`${pageUrl(name)}/password`, { password: v })
    });
    if (password !== undefined) {
      toast('Page is now private');
      await page.open(name);
      page.onChange();
    }
    return;
  }

  const choice = await modal({
    title: `${name} is private`,
    body: el('p', { text: 'People need the password to open this page. You can change or remove the password, or lock it again on this device.' }),
    actions: [
      { label: 'Remove password', value: 'remove', danger: true },
      { label: 'Lock on this device', value: 'lock' },
      { label: 'Change password', value: 'change', primary: true }
    ]
  });
  if (choice === 'change') {
    const password = await promptDialog({
      title: 'Change password',
      note: 'Everyone else will need the new password.',
      label: 'New password',
      type: 'password',
      confirmLabel: 'Change',
      validate: v => (v.length < 4 ? 'Use at least 4 characters' : ''),
      submit: async v => post(`${pageUrl(name)}/password`, { password: v })
    });
    if (password !== undefined) toast('Password changed');
  } else if (choice === 'remove') {
    if (await confirmDialog('Anyone will be able to see and edit this page.', { title: 'Remove the password?', confirmLabel: 'Remove', danger: true })) {
      await post(`${pageUrl(name)}/password`, { password: null });
      toast('Page is no longer private');
      await page.open(name);
      page.onChange();
    }
  } else if (choice === 'lock') {
    await page.flush();
    await post('/api/lock', { scope: 'page', page: name });
    await forgetCachedPage(name);
    await page.open(name);
    page.onChange();
  }
}

// Removes a page from the offline cache (used when locking it again)
export async function forgetCachedPage(name) {
  if (!window.caches) return;
  try {
    const cache = await caches.open('noter-api');
    await cache.delete(pageUrl(name));
  } catch (err) {
    // no cache
  }
}

// ---------- Rename / delete ----------

export async function renamePage(page, navigate) {
  const from = page.name;
  let result;
  await promptDialog({
    title: `Rename ${from}`,
    label: 'New name (letters, numbers, - and _)',
    value: from,
    confirmLabel: 'Rename',
    validate: v => (!slugify(v) ? 'Enter a name' : ''),
    submit: async v => {
      await page.flush();
      result = await post(`${pageUrl(from)}/rename`, { to: slugify(v) });
    }
  });
  if (result) {
    toast(`Renamed to ${result.name}`);
    navigate(result.name, { replace: true });
    page.onChange();
  }
}

export async function deletePage(page, navigate) {
  const name = page.name;
  if (!(await confirmDialog(`“${name}” will move to Trash. You can restore it for 30 days.`, { title: 'Delete this page?', confirmLabel: 'Delete', danger: true }))) return;
  await page.flush();
  try {
    const { trashId } = await del(pageUrl(name));
    page.dirty = false;
    navigate('home');
    page.onChange();
    toast(`Deleted ${name}`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          const restored = await post(`/api/trash/${encodeURIComponent(trashId)}/restore`);
          navigate(restored.name);
          page.onChange();
        }
      }
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- Trash ----------

export async function showTrash(session, navigate, onChange) {
  const listEl = el('ul', { class: 'list' });

  async function load() {
    let entries = [];
    try {
      entries = await get('/api/trash');
    } catch (err) {
      listEl.replaceChildren(el('li', { text: err.message }));
      return;
    }
    if (!entries.length) {
      listEl.replaceChildren(el('li', { class: 'list-empty', text: 'Trash is empty.' }));
      return;
    }
    listEl.replaceChildren(...entries.map(entry => el('li', {}, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'primary-line' }, [entry.protected ? icon('lock') : null, ` ${entry.name}${entry.title && entry.title !== entry.name ? ' — ' + entry.title : ''}`]),
        el('div', { class: 'secondary-line', text: `Deleted ${timeAgo(entry.deletedAt)}${entry.deletedBy ? ' by ' + entry.deletedBy : ''}` })
      ]),
      session.admin ? el('button', {
        class: 'btn small danger',
        type: 'button',
        text: 'Delete forever',
        onclick: async () => {
          if (await confirmDialog(`Permanently delete “${entry.name}”?`, { confirmLabel: 'Delete forever', danger: true })) {
            await del(`/api/trash/${encodeURIComponent(entry.id)}`);
            load();
          }
        }
      }) : null,
      el('button', {
        class: 'btn small',
        type: 'button',
        text: 'Restore',
        onclick: async () => {
          try {
            const result = await post(`/api/trash/${encodeURIComponent(entry.id)}/restore`);
            toast(result.name === entry.name ? `Restored ${result.name}` : `Restored as ${result.name} (the name was taken)`);
            onChange();
            navigate(result.name);
            document.querySelector('dialog[open]')?.close();
          } catch (err) {
            toast(err.message, { error: true });
          }
        }
      })
    ])));
  }

  await load();
  await modal({
    title: 'Trash',
    body: el('div', {}, [el('p', { text: 'Deleted pages are kept for 30 days, with their history and attachments.' }), listEl]),
    actions: [{ label: 'Close', primary: true }]
  });
}

// ---------- New page ----------

export async function newPage(navigate, onChange) {
  const nameInput = el('input', { class: 'input', placeholder: 'e.g. grocery-list', autocomplete: 'off' });
  const hint = el('div', { class: 'secondary-line' });
  const privateBox = el('input', { type: 'checkbox' });
  const passwordInput = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'At least 4 characters' });
  const passwordField = el('label', { class: 'field', hidden: true }, ['Password', passwordInput]);
  const error = el('div', { class: 'form-error', role: 'alert' });
  nameInput.addEventListener('input', () => {
    const slug = slugify(nameInput.value);
    hint.textContent = slug && slug !== nameInput.value ? `Address: /person/${slug}` : '';
  });
  privateBox.addEventListener('change', () => {
    passwordField.hidden = !privateBox.checked;
    if (privateBox.checked) passwordInput.focus();
  });

  let created;
  await modal({
    title: 'New page',
    body: el('div', {}, [
      el('label', { class: 'field' }, ['Page name', nameInput]),
      hint,
      el('label', { class: 'check' }, [privateBox, 'Private — only people with the password can open it']),
      passwordField,
      error
    ]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create',
        primary: true,
        onClick: async () => {
          const name = slugify(nameInput.value);
          if (!name) {
            error.textContent = 'Enter a name';
            return false;
          }
          try {
            const existing = await get(pageUrl(name)).catch(err => (err.status === 401 ? { exists: true, locked: true } : Promise.reject(err)));
            if (existing.exists) {
              created = name;
              toast(`“${name}” already exists — opening it`);
              return true;
            }
            if (privateBox.checked) {
              if (passwordInput.value.length < 4) {
                error.textContent = 'Use a password of at least 4 characters';
                return false;
              }
              await post(`${pageUrl(name)}/password`, { password: passwordInput.value });
            }
            created = name;
            return true;
          } catch (err) {
            error.textContent = err.message;
            return false;
          }
        }
      }
    ]
  });
  if (created) {
    navigate(created, { edit: true });
    onChange();
  }
}

// ---------- Settings ----------

export async function showSettings(session, { onChange, onSessionChange, onSignOut }) {
  const user = session.user || { name: identity.name, username: '', admin: false };
  const nameInput = el('input', { class: 'input', value: user.name, maxlength: 40, autocomplete: 'name' });
  const nameError = el('div', { class: 'form-error' });
  const themeSelect = el('select', { class: 'input' }, [
    el('option', { value: 'system', text: 'Match my device' }),
    el('option', { value: 'light', text: 'Light' }),
    el('option', { value: 'dark', text: 'Dark' })
  ]);
  themeSelect.value = document.documentElement.dataset.theme || 'system';
  themeSelect.addEventListener('change', () => {
    const value = themeSelect.value;
    if (value === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
    try {
      if (value === 'system') localStorage.removeItem('noter-theme');
      else localStorage.setItem('noter-theme', value);
    } catch (err) {
      // storage unavailable
    }
  });

  const adminSection = el('div', {});
  async function renderAdmin() {
    adminSection.replaceChildren();
    if (!session.admin) return;
    let backups = [];
    try {
      backups = await get('/api/admin/backups');
    } catch (err) {
      // ignore
    }
    adminSection.append(
      el('h3', { text: 'Admin' }),
      el('p', { text: 'You can add and remove people, open every page, lock existing pages, empty the trash and download backups.' }),
      el('div', { class: 'share-url' }, [
        el('button', { class: 'btn primary', type: 'button', text: 'People…', onclick: () => showPeople(session) }),
        el('a', { class: 'btn', href: '/api/admin/backup', download: '', text: 'Download full backup' })
      ]),
      el('p', { text: backups.length ? 'Automatic daily backups (notes and attachments, last 7 days):' : 'Automatic daily backups will appear here.' }),
      el('ul', { class: 'list' }, backups.map(b => el('li', {}, [
        el('div', { class: 'grow', text: b.name }),
        el('span', { class: 'secondary-line', text: formatSize(b.size) }),
        el('a', { class: 'btn small', href: `/api/admin/backups/${encodeURIComponent(b.name)}`, download: '', text: 'Download' })
      ])))
    );
  }
  await renderAdmin();

  await modal({
    title: 'Settings',
    body: el('div', {}, [
      el('h3', { text: 'Your account' }),
      el('p', { text: `Signed in as ${user.username}${user.admin ? ' (admin)' : ''}.` }),
      el('label', { class: 'field' }, ['Your name (shown to others on edits and when you are on a page)', nameInput]),
      nameError,
      el('div', { class: 'share-url' }, [
        el('button', { class: 'btn', type: 'button', text: 'Change password…', onclick: () => changeOwnPassword() }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Sign out',
          onclick: async () => {
            document.querySelector('dialog[open]')?.close();
            await onSignOut();
          }
        })
      ]),
      el('label', { class: 'field' }, ['Theme', themeSelect]),
      el('h3', { text: 'This device' }),
      el('p', { text: 'Private pages you unlock stay unlocked on this device for 30 days.' }),
      el('div', { class: 'share-url' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Lock private pages here',
          onclick: async () => {
            await post('/api/lock', { all: true });
            if (window.caches) await caches.delete('noter-api');
            toast('Private pages are locked on this device');
            session = await onSessionChange();
            onChange();
          }
        }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Sign out everywhere else',
          onclick: async () => {
            await post('/api/me/signout-everywhere');
            toast('Signed out on all your other devices');
          }
        })
      ]),
      adminSection,
      el('h3', { text: 'Keyboard shortcuts' }),
      el('ul', { class: 'list' }, [
        ['Ctrl/⌘ + K', 'Search and jump to any page'],
        ['Ctrl/⌘ + E', 'Switch between view and edit'],
        ['Ctrl/⌘ + S', 'Save now'],
        ['Alt + N', 'New page'],
        ['Tab / Shift+Tab', 'Indent list items while editing']
      ].map(([keys, what]) => el('li', {}, [el('span', { class: 'kbd', text: keys }), el('span', { class: 'grow', text: what })])))
    ]),
    actions: [
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          const name = nameInput.value.trim();
          if (!name || name === user.name) return true;
          try {
            const result = await api('PUT', '/api/me', { name });
            identity.name = result.user.name;
            session = await onSessionChange();
            toast('Name saved');
          } catch (err) {
            nameError.textContent = err.message;
            return false;
          }
        }
      }
    ]
  });
}

async function changeOwnPassword() {
  const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8 });
  const error = el('div', { class: 'form-error', role: 'alert' });
  let changed = false;
  await modal({
    title: 'Change your password',
    body: el('div', {}, [
      el('p', { text: 'You stay signed in here; your other devices will be signed out.' }),
      el('label', { class: 'field' }, ['Current password', current]),
      el('label', { class: 'field' }, ['New password (at least 8 characters)', next]),
      error
    ]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Change password',
        primary: true,
        onClick: async () => {
          try {
            await post('/api/me/password', { current: current.value, password: next.value });
            changed = true;
          } catch (err) {
            error.textContent = err.message;
            return false;
          }
        }
      }
    ]
  });
  if (changed) toast('Password changed');
}

// ---------- People (admin) ----------

function temporaryPassword() {
  const words = ['maple', 'river', 'cedar', 'sunny', 'pepper', 'meadow', 'harbor', 'lemon', 'orbit', 'willow', 'canyon', 'breeze'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick()}-${pick()}-${crypto.getRandomValues(new Uint32Array(1))[0] % 900 + 100}`;
}

export async function showPeople(session) {
  const me = session.user ? session.user.username : '';
  const listEl = el('ul', { class: 'list' });

  async function load() {
    let people;
    try {
      people = await get('/api/users');
    } catch (err) {
      listEl.replaceChildren(el('li', { text: err.message }));
      return;
    }
    listEl.replaceChildren(...people.map(person => el('li', {}, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'primary-line', text: `${person.name}${person.username === me ? ' (you)' : ''}` }),
        el('div', { class: 'secondary-line', text: `${person.username}${person.admin ? ' · admin' : ''}` })
      ]),
      el('button', { class: 'btn small', type: 'button', text: 'Reset password', onclick: () => resetPassword(person) }),
      person.username === me ? null : el('button', {
        class: 'btn small',
        type: 'button',
        text: person.admin ? 'Remove admin' : 'Make admin',
        onclick: async () => {
          try {
            await api('PATCH', `/api/users/${encodeURIComponent(person.username)}`, { admin: !person.admin });
            load();
          } catch (err) {
            toast(err.message, { error: true });
          }
        }
      }),
      person.username === me ? null : el('button', {
        class: 'btn small danger',
        type: 'button',
        text: 'Remove',
        onclick: async () => {
          if (!(await confirmDialog(`${person.name} will be signed out and won’t be able to sign in again. Their pages stay.`, { title: `Remove ${person.name}?`, confirmLabel: 'Remove', danger: true }))) return;
          try {
            await del(`/api/users/${encodeURIComponent(person.username)}`);
            load();
          } catch (err) {
            toast(err.message, { error: true });
          }
        }
      })
    ])));
  }

  async function resetPassword(person) {
    const password = await promptDialog({
      title: `New password for ${person.name}`,
      note: person.username === me ? 'Your other devices will be signed out.' : `${person.name} will be signed out everywhere. Give them the new password.`,
      label: 'New password (at least 8 characters)',
      value: person.username === me ? '' : temporaryPassword(),
      confirmLabel: 'Set password',
      validate: v => (v.length < 8 ? 'Use at least 8 characters' : ''),
      submit: v => post(`/api/users/${encodeURIComponent(person.username)}/password`, { password: v })
    });
    if (password !== undefined) {
      if (person.username !== me) await copyText(password);
      toast(person.username === me ? 'Password changed' : `Password set (copied) — send it to ${person.name}`);
    }
  }

  async function addPerson() {
    const name = el('input', { class: 'input', placeholder: 'e.g. Elizabeth', autocomplete: 'off' });
    const username = el('input', { class: 'input', placeholder: 'e.g. elizabeth', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
    const password = el('input', { class: 'input', value: temporaryPassword(), autocomplete: 'off' });
    const admin = el('input', { type: 'checkbox' });
    const error = el('div', { class: 'form-error', role: 'alert' });
    let touched = false;
    username.addEventListener('input', () => (touched = true));
    name.addEventListener('input', () => {
      if (!touched) username.value = name.value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '').slice(0, 32);
    });
    let created;
    await modal({
      title: 'Add a person',
      body: el('div', {}, [
        el('label', { class: 'field' }, ['Name (what others see)', name]),
        el('label', { class: 'field' }, ['Username (for signing in)', username]),
        el('label', { class: 'field' }, ['Temporary password — send this to them', password]),
        el('label', { class: 'check' }, [admin, 'Admin (can manage people and backups)']),
        error
      ]),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Add person',
          primary: true,
          onClick: async () => {
            try {
              created = (await post('/api/users', { name: name.value, username: username.value, password: password.value, admin: admin.checked })).user;
            } catch (err) {
              error.textContent = err.message;
              return false;
            }
          }
        }
      ]
    });
    if (created) {
      const copied = await copyText(`${window.location.origin}/login\nUsername: ${created.username}\nPassword: ${password.value}`);
      toast(copied ? `Added ${created.name}. Sign-in details copied — send them over.` : `Added ${created.name}.`);
      load();
    }
  }

  await load();
  await modal({
    title: 'People',
    body: el('div', {}, [
      el('p', { text: 'Everyone here can sign in and use Noter. Private pages still need their own password.' }),
      listEl
    ]),
    actions: [
      { label: 'Close' },
      { label: 'Add person', primary: true, onClick: () => { addPerson(); return false; } }
    ]
  });
}

// ---------- Quick switcher / search ----------

export async function showSwitcher(sidebar, navigate) {
  const input = el('input', { class: 'input switcher-input', placeholder: 'Search pages and text, or type a name to create…', 'aria-label': 'Search', autocomplete: 'off' });
  const results = el('ul', { class: 'list switcher-results', role: 'listbox' });
  let items = [];
  let active = 0;
  let searchTimer;
  let dialogRef;

  function highlight(text, words) {
    const span = el('span', {});
    if (!words.length) {
      span.textContent = text;
      return span;
    }
    const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
    for (const part of text.split(pattern)) {
      if (!part) continue;
      span.append(pattern.test(part) ? el('mark', { text: part }) : part);
      pattern.lastIndex = 0;
    }
    return span;
  }

  function draw(serverResults = null) {
    const query = input.value.trim();
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const local = sidebar.pages
      .filter(p => !q || words.every(w => p.name.toLowerCase().includes(w) || (p.title || '').toLowerCase().includes(w)))
      .slice(0, 8)
      .map(p => ({ name: p.name, title: p.title, snippet: p.preview }));
    const seen = new Set(local.map(p => p.name));
    const remote = (serverResults || []).filter(r => !seen.has(r.name)).slice(0, 10);
    items = [...local, ...remote];
    const slug = slugify(query);
    if (slug && !sidebar.pages.some(p => p.name === slug)) items.push({ name: slug, create: true });
    active = Math.min(active, Math.max(0, items.length - 1));

    results.replaceChildren(...items.map((item, i) => {
      const li = el('li', { class: `selectable${i === active ? ' selected' : ''}`, role: 'option', 'aria-selected': String(i === active) }, [
        el('div', { class: 'grow' }, item.create
          ? [el('div', { class: 'primary-line', text: `Open or create “${item.name}”` }), el('div', { class: 'snippet', text: 'Also opens private pages by name' })]
          : [
            el('div', { class: 'primary-line' }, [highlight(item.title && item.title !== item.name ? `${item.title} · ${item.name}` : item.name, words)]),
            item.snippet ? el('div', { class: 'snippet' }, [highlight(item.snippet, words)]) : null
          ])
      ]);
      li.addEventListener('click', () => choose(i));
      return li;
    }));
    if (!items.length) results.append(el('li', { class: 'list-empty', text: 'Nothing found' }));
  }

  function choose(i) {
    const item = items[i];
    if (!item) return;
    dialogRef.close();
    navigate(item.name, { edit: Boolean(item.create) });
  }

  input.addEventListener('input', () => {
    active = 0;
    draw();
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) return;
    searchTimer = setTimeout(async () => {
      try {
        const found = await get(`/api/search?q=${encodeURIComponent(q)}`);
        if (input.value.trim() === q) draw(found);
      } catch (err) {
        // keep local results
      }
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(items.length - 1, active + 1);
      draw();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, active - 1);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      choose(active);
    }
  });

  await modal({
    title: 'Go to page',
    body: el('div', {}, [input, results]),
    onOpen: (dialog) => {
      dialogRef = dialog;
      draw();
    }
  });
}

export { ApiError };
