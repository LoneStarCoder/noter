// Who "you" are to other people on a page: a display name kept in this
// browser, plus a random id per tab so we can ignore our own live events.
const NAME_KEY = 'noter-name';

function storage() {
  try {
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

function randomName() {
  return `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
}

export const identity = {
  clientId: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 12),
  get name() {
    const store = storage();
    let name = store && store.getItem(NAME_KEY);
    if (!name) {
      name = randomName();
      if (store) store.setItem(NAME_KEY, name);
    }
    return name;
  },
  set name(value) {
    const store = storage();
    if (store) store.setItem(NAME_KEY, String(value || '').trim().slice(0, 40) || randomName());
  },
  get isGuestName() {
    return /^Guest \d{4}$/.test(this.name);
  }
};

// Stable color per name for avatars
export function colorFor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 45%)`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
