# Architecture

How Noter is put together, how data flows through it, and why it is built this
way. For endpoint details see [API.md](API.md); for the threat model see
[SECURITY.md](SECURITY.md); for running it see [OPERATIONS.md](OPERATIONS.md).

## Goals and constraints

- **A small group sharing pages.** Tens of people and hundreds of pages, not
  thousands. One server process on a small Render instance with a 1 GB disk.
- **Nothing gets lost.** Concurrent edits merge, every page has history, deletes
  are reversible, and backups exist.
- **Simple to run.** No database and no build step. Notes are plain text files
  that stay readable outside the app.
- **Secure by default.** Everything needs sign-in, user content can never run as
  code, and state-changing requests can't be forged from other sites.

## Overview

```
 Browser (per person, per tab)                    Server (one Node process)
 ┌──────────────────────────────┐   HTTPS   ┌──────────────────────────────────────┐
 │ index.html + ES modules      │──────────▶│ server.js (Express)                  │
 │  main.js    routing, menus   │  JSON API │  security headers → CSRF check →     │
 │  page.js    view/edit/save   │           │  JSON body → sign-in gate → routes   │
 │  sidebar.js list/filter/tags │◀──────────│                                      │
 │  dialogs.js history, people… │    SSE    │ lib/users.js     accounts            │
 │  markdown.js render+sanitize │  (live)   │ lib/session.js   signed cookie       │
 │ sw.js  offline cache         │           │ lib/passwords.js private pages       │
 └──────────────────────────────┘           │ lib/notes.js     pages, history,     │
                                            │                  trash, merge, search│
                                            │ lib/live.js      presence + updates  │
                                            │ lib/shares.js    share links         │
                                            │ lib/backups.js   zip backups         │
                                            └──────────────────┬───────────────────┘
                                                               │ files
                                                  persistent disk (data dir)
```

- **Server:** Express 4. `createApp(options)` in `server.js` builds the app; tests
  create isolated instances with their own data directory.
- **Client:** vanilla JavaScript ES modules, no framework and no bundler. Third-party
  browser libraries are served from `node_modules` via `/vendor/`:
  - [marked](https://marked.js.org) turns Markdown into HTML
  - [DOMPurify](https://github.com/cure53/DOMPurify) sanitizes that HTML
  - [node-diff3](https://github.com/bhousel/node-diff3) does three-way merges and
    diffs (used on both server and client)
- **Server dependencies:** `express`, `multer` (uploads), `marked`, `dompurify`,
  `node-diff3`.

## Request pipeline

Every request goes through the same middleware, in this order:

1. **Security headers:** Content-Security-Policy, `X-Content-Type-Options`,
   `X-Frame-Options`, `Referrer-Policy`.
2. **CSRF guard:** any non-GET request must carry `X-Noter: 1`, and if the browser
   sends an `Origin`, it must match the host.
3. **JSON body parsing:** limited to `NOTER_MAX_NOTE_SIZE` (5 MB).
4. **Public routes:** `/login`, `/api/auth/*`.
5. **Sign-in gate:** a request without a valid session gets a 401 JSON response
   (API calls) or a redirect to `/login?next=…` (browser page loads). The exceptions
   are the static assets the sign-in page needs (`/app.css`, `/js/`, `/vendor/`,
   `/icons/`, the manifest and service worker) and share links (`/s/`,
   `/api/share/`).
6. **Routes**, some of which add their own checks:
   - `requirePageAccess` for private pages
   - `requireAdmin` for people management and backups
   - `pageParam`, which validates page names

## Identity and access

There are three independent layers:

| Layer | Who decides | Stored in | Carried by |
| --- | --- | --- | --- |
| **Account** (sign-in) | admins, in Settings → People | `.noter/users.json` | session cookie `u` + `v` |
| **Private page** (extra password) | anyone for new pages; admins for existing ones | `protected_pages.json` | session cookie `p[page]` |
| **Admin** | admins | the `admin` flag on an account | the account |

### Session cookie

`noter_session` is stateless and HMAC-signed with the server secret. It is
HttpOnly, SameSite=Lax, and marked Secure when served over HTTPS; it lasts 30
days. The payload:

```js
{ u: 'brody',                 // signed-in username
  v: 3,                       // the account's token version
  p: { brody: 'a1b2…' },      // unlocked private pages → password fingerprint
  e: 1790000000000 }          // expiry
```

- **Revocation without a session store.** Each account has a `version` number.
  Resetting a password, removing someone, changing admin status and "sign out
  everywhere" all increase it. A cookie only counts while its `v` matches, so all
  of that person's sessions stop working immediately.
- **Private page unlocks** store a fingerprint: an HMAC of the stored password
  entry. Changing a page's password changes the fingerprint, which locks everyone
  else out of that page.

### First-run setup

With no accounts, `UserStore` creates a random code (`XXXXX-XXXXX`, 40 bits),
stores it in `.noter/setup-code` and prints it to the log. `POST /api/auth/setup`
requires the code (rate-limited) and creates the first admin; the code is then
deleted. The alternative, "first visitor becomes admin", would let anyone who
finds the URL first take over.

## Data model

Everything is files in the data directory (see the README for the layout). There
is no database: there is little data, the files are human-readable, and backup
and restore are plain file copies.

| Data | File | Notes |
| --- | --- | --- |
| Page text | `person_<name>.txt` | Same format as v1: existing notes just work |
| Page metadata | `.noter/meta/<name>.json` | `{ updatedAt, updatedBy }` |
| History | `.noter/history/<name>/<ms>.<hex(author)>.txt` | Earlier versions of the text; newest 200 kept |
| Trash | `.noter/trash/<ms>-<name>/` | `note.txt`, `meta.json`, `history/`, `attachments/`; purged after 30 days |
| Attachments | `attachments/<name>/<file>` | Move with the page on rename, delete and restore |
| Share links | `.noter/shares.json` | `token → { page, createdAt, createdBy }` |
| Accounts | `.noter/users.json` | `username → { name, hash, admin, version, createdAt }` |
| Page passwords | `protected_pages.json` | Plain text (hand-written) or `scrypt$salt$hash` |

Page names are limited to `[A-Za-z0-9_-]`, 100 characters. `files` and `admin`
are reserved because they are special keys in `protected_pages.json`.

All writes go to a temporary file and are then renamed into place, so a crash
never leaves a half-written note.

## The life of a save

```
 Alice's editor                 Server                              Bob's screen
 ─────────────                  ──────                              ────────────
 types… (600 ms debounce)
 PUT /api/pages/list
   { text, baseVersion: v1 } ─▶ current version == v1? ── yes ─▶ write file
                                  │                               snapshot previous text
                                  │                                 into history (if due)
                                  │                               broadcast "update" ─────▶ refetch and re-render
                                  no (Bob saved v2 meanwhile)                              (keeps the caret in place)
                                  │
                                  ▼
                           three-way merge(Alice, base = v1, Bob = v2)
                             clean ─▶ save the merged text, reply { merged, text }
                             conflict ─▶ 409 { text: Bob's, bothText }
 conflict dialog ◀────────────┘
 [Use theirs] [Keep mine] [Keep both]
```

- **Versions** are the first 16 hex characters of the SHA-256 of the text. Every
  load and save returns the version, and the client sends the version it started
  from (`baseVersion`) with each save.
- **Merge bases.** To merge, the server needs the text as it was at `baseVersion`.
  It keeps recent versions in memory: up to 20 per page and 32 MB in total, least
  recently used first. If the base has been forgotten (for example after a
  restart), the save gets a 409 and the person chooses; nothing is overwritten
  silently.
- **The merge** (`mergeTexts` in `lib/notes.js`) works line by line. Changes to
  different lines combine; changes to the same lines conflict. "Keep both" puts
  both versions of each conflicting block one after the other.
- **Typing during a save.** If the person kept typing while a save was in flight
  and the server merged in someone else's change, the browser runs the same
  three-way merge locally (their newer text, the text it sent, the server's merged
  text), so neither the keystrokes nor the other person's edit are lost.
- **History snapshots** store the *previous* text when:
  - 10 minutes have passed since the last snapshot, or
  - a different person is editing, or
  - the change is a restore, a replace-from-file or a delete.

  Snapshots are therefore not taken on every keystroke, but every author change is
  kept. At most 200 are kept per page.

## Live updates

`GET /api/pages/:name/events` is a server-sent events stream. The browser's
`EventSource` sends the session cookie and reconnects on its own.

| Event | Data | Client reaction |
| --- | --- | --- |
| `presence` | `{ users: [{ clientId, user }] }` | Show avatars (excluding yourself) |
| `update` | `{ version, by, clientId }` | Refetch if you have no unsaved edits; otherwise your next save merges |
| `deleted` | `{ by }` | Show "deleted by …, restore from Trash" |
| `renamed` | `{ to, by }` | Navigate to the new name |
| `protection` | `{ protected, by }` | Reload (you may now need the page password) |

Presence names come from the signed-in account. A heartbeat is sent every 25
seconds. Connections are capped at 500 in total and 20 per IP. SSE was chosen over
WebSockets because updates only flow one way (saves are ordinary requests), it
works through Render's proxy without extra setup, and browsers reconnect
automatically.

## Rendering notes safely

`public/js/lib/markdown.js`:

1. `marked` turns Markdown into HTML (GFM, with line breaks preserved so plain-text
   notes look as they did in v1).
2. **DOMPurify** sanitizes that HTML into a DOM fragment and forbids `style`,
   `form`, buttons and inline `style` attributes.
3. Text-only transforms walk the sanitized DOM. They create elements, never parse
   HTML:
   - `[[wiki]]` links
   - bare-domain links (`example.com`)
   - `#tags`
   - `attachments/…` URL rewriting
4. Links to other sites get `target=_blank rel="noopener noreferrer"`.
5. Checklist boxes are enabled only when their count matches the task lines found
   in the source; ticking one rewrites exactly that line.

The Content-Security-Policy (`script-src 'self'`) is the second safety net: even
if sanitizing missed something, injected inline script would not run.

## Offline and installable app

- `manifest.webmanifest` plus icons make Noter installable.
- `sw.js` caches:
  - static assets: network first, cache as fallback, so a deploy never mixes old
    and new code
  - the app page, stored as `/app-shell` the first time it loads successfully while
    signed in
  - page data for pages that are **not** private (the response header
    `X-Noter-Protected: 1` tells it to skip private pages)
- Offline, the app starts from the cache and says it is offline. Saves retry when
  the connection returns.
- Signing out deletes the cached page data.

## Backups

- **Full backup** (`GET /api/admin/backup`, admins only): a streaming ZIP of the
  whole data directory except the cookie secret, the setup code and old backup
  archives.
- **Daily backup:** created 10 seconds after start, then checked hourly, as
  `.noter/backups/noter-YYYY-MM-DD.zip`. It holds notes, metadata, attachments,
  accounts, passwords and share links (not uploads, history or trash, to keep it
  small). The newest 7 are kept.
- The ZIP writer (`lib/zip.js`) is a small built-in implementation using deflate,
  handling one file at a time so memory use stays bounded. It has no extra
  dependencies.

## Design decisions (and alternatives considered)

| Decision | Why | Alternative not taken |
| --- | --- | --- |
| Files, not a database | Tiny data set; readable, portable, trivially backed up; v1 data works unchanged | SQLite or Postgres: more moving parts for no real gain at this size |
| Line-based three-way merge | Predictable, easy to explain ("same line = conflict"); works with plain textareas | CRDT such as Yjs: true character-level co-editing, but a much bigger client, a binary state format and a new editor |
| Stateless signed cookie + per-account version | No session table; revocation still immediate | Server-side sessions: need storage and cleanup |
| Setup code from the log | Nobody can claim admin by finding the site first | First visitor becomes admin |
| SSE for live updates | One-way, proxy-friendly, auto-reconnect | WebSockets: two-way channel not needed |
| No build step | Anyone can read and change the code; no toolchain to maintain | Bundler plus framework |
| Private pages as an extra password | Keeps the v1 model people already use | Per-page permissions per account: more to manage for a family |

## Limits

| Thing | Limit |
| --- | --- |
| Note size | 5 MB (`NOTER_MAX_NOTE_SIZE`) |
| Upload size / files per upload | 50 MB (`NOTER_MAX_UPLOAD_MB`) / 20 |
| History per page | 200 versions |
| Trash retention | 30 days |
| Daily backups kept | 7 |
| Wrong passwords per IP | 10 per 15 minutes (sign-in, setup, page unlock and trash restore share one budget) |
| Live connections | 500 total, 20 per IP |
| Search | first 10 words; 50 results |

The server is a single process: accounts, merge bases, presence and rate limits
are held in memory. Running more than one instance would need shared storage for
those; that isn't a goal at this scale.
