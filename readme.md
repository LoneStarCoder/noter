# Noter

A private, shared notebook for a family or small group: lists, recipes, code
snippets and anything else, edited together in real time, with version history so
nothing is ever lost.

Everyone signs in with their own account. Pages are written in Markdown, update
live on everyone's screen, and can be searched, tagged, linked, shared read-only
or kept private.

- **Live site:** https://noter-u007.onrender.com (Render web service `noter`)
- **Docs:** [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) ·
  [API reference](docs/API.md) · [Operations runbook](docs/OPERATIONS.md)

---

## Contents

- [Features](#features)
- [Quick start (local)](#quick-start-local)
- [First-time setup](#first-time-setup)
- [Using Noter](#using-noter)
- [Configuration](#configuration)
- [Deploying on Render](#deploying-on-render)
- [Where data lives](#where-data-lives)
- [Project structure](#project-structure)
- [Development and tests](#development-and-tests)
- [Release notes](#release-notes)

---

## Features

**Accounts**
- The whole site is behind sign-in. Everyone has their own username and password.
- Admins add people, reset passwords, promote admins and remove people from
  Settings → People. Removing someone or resetting their password signs them out
  on every device at once.
- Names on edits, history and presence come from the account.

**Writing**
- Markdown with a View / Edit toggle (Ctrl+E). Plain-text notes still read naturally.
- Checklists (`- [ ] item`) you can tick straight from the rendered page.
- `[[page-name]]` links between pages, `#tags`, and automatic links for web addresses.
- Paste or drop images and files into a page to attach them.
- Enter continues a list; Tab / Shift+Tab indents list items.
- Copy buttons on code blocks, and clean printing.

**Working together**
- Live updates: when someone saves, everyone viewing the page sees it within about a second.
- Presence: avatars show who else has the page open.
- Automatic merging: two people editing *different lines* of a page at the same
  time both keep their changes. Editing the *same line* asks what to keep: yours,
  theirs, or both.

**Never lose anything**
- Version history for every page, with a diff view and one-click restore.
- Deleted pages go to Trash for 30 days (with history and attachments), and
  there's an Undo right after deleting.
- Admins can download a full backup; a smaller automatic backup is made daily.

**Finding things**
- Sidebar of every page, newest first, with a preview and who edited it last.
- Filter by name or `#tag`; Ctrl+K searches the text of every page you can open.

**Privacy and sharing**
- Private pages: an extra password on top of sign-in.
- Read-only share links for one page, revocable, that work without an account.
- A shared file manager for everyone who is signed in.

**Everywhere**
- Works on phones and can be installed as an app (Add to Home Screen).
- Pages you've opened can be read offline (private pages are never stored offline).
- Light and dark themes, following your device by default.

---

## Quick start (local)

Requires Node.js 18 or newer.

```sh
npm install
npm start            # http://localhost:3000
```

The first start prints a setup code; see [First-time setup](#first-time-setup).
Data goes in `./persistent/` (created automatically).

---

## First-time setup

When Noter starts with no accounts, the whole site shows a setup screen and the
server prints a one-time code in its log:

```
Noter setup: no accounts yet. Open /login and create the first (admin) account with setup code 1A2B3-C4D5E
```

1. Find the code: in the terminal locally, or on Render in the service's **Logs** tab.
   It is also stored in `persistent/.noter/setup-code` until used.
2. Open the site, enter the code, and choose your name, username and password.
3. That account is the admin. Add everyone else from **Settings → People**.

The code stops working as soon as the first account exists. The code is required
so that nobody who finds the site before you can make themselves admin. (If
`protected_pages.json` has an `"admin"` password, that also works as the code.)

---

## Using Noter

### Signing in and your account
- Sign in at `/login`. You stay signed in on that device for 30 days.
- **Settings → Your account:** change your display name or password, sign out, or
  "Sign out everywhere else" (useful after using a shared computer).

### People (admins)
- **Settings → People → Add person:** type their name; the username fills in and
  a temporary password is suggested. Adding copies the sign-in details so you can
  send them.
- **Reset password** gives someone a new password and signs them out everywhere.
- **Make admin / Remove admin** and **Remove** are in the same list. There is always
  at least one admin, and you can't remove yourself.

### Pages
- **New page:** the **+** in the sidebar (or Alt+N). Tick *Private* to give it a password.
- **View / Edit:** the toggle at the top right, Ctrl+E, or double-click the page.
- Changes save automatically; the status next to the toggle shows *Saved*.
- **Page menu (⋯):** History, Share read-only link, Make private / Password,
  Attach files, Rename, Replace with a file, Download as Markdown, Print, Delete.

### Private pages
- Private pages are hidden from the sidebar until you unlock them. Open one with
  Ctrl+K and type its name, or go to `/person/<name>`.
- Anyone can make a **new or empty** page private. Only admins can lock an existing
  shared page, so nobody gets locked out of a page they already use.
- Admins can open every page without its password.

### Writing cheat sheet

| Type | Result |
| --- | --- |
| `# Heading`, `## Smaller` | Headings |
| `**bold**`, `*italic*` | **bold**, *italic* |
| `- item` or `1. item` | Lists (Enter continues them) |
| `- [ ] task` / `- [x] done` | Checklist you can tick |
| `[[grocery-list]]` | Link to another page |
| `#recipe` | Tag (click to filter the sidebar) |
| `example.com` or a full URL | Link |
| `` `code` `` and fenced ``` blocks | Code, with a copy button |
| Paste or drop an image | Attached and shown in the page |

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl/⌘ + K | Search and jump to any page (or create one) |
| Ctrl/⌘ + E | Switch between View and Edit |
| Ctrl/⌘ + S | Save now |
| Alt + N | New page |
| Tab / Shift + Tab | Indent / outdent list items while editing |

---

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `NOTER_DATA_DIR` | `./persistent` | Where all data is stored |
| `NOTER_PASSWORDS_FILE` | *(see below)* | Path to `protected_pages.json` |
| `NOTER_SECRET` | *(generated)* | Secret for signing session cookies. By default one is generated and kept in `<data dir>/.noter/secret`. Changing it signs everyone out. |
| `NOTER_MAX_UPLOAD_MB` | `50` | Max size per uploaded file |
| `NOTER_MAX_NOTE_SIZE` | `5mb` | Max size of a single note |
| `TRUST_PROXY` | *(unset)* | Number of reverse proxies in front of the app (`1` on Render), so rate limiting sees real client IPs and cookies get the `Secure` flag. Leave unset when not behind a proxy. |

`protected_pages.json` holds **private page passwords** (plain text you type by
hand, or scrypt hashes written by the app):

```json
{
  "brody": "a-page-password"
}
```

It is looked up in `$NOTER_PASSWORDS_FILE`, then `<data dir>/protected_pages.json`,
then the project root. Edits take effect within a few seconds, with no restart.
Accounts are separate: they live in `<data dir>/.noter/users.json` and are managed
in the app.

---

## Deploying on Render

The production service is a Node web service with a persistent disk:

| Setting | Value |
| --- | --- |
| Build command | `npm install` |
| Start command | `npm start` |
| Disk | mounted at `/opt/render/project/src/persistent` (the data directory) |
| Environment | `TRUST_PROXY=1` |
| Auto-deploy | off: deploy manually after merging to `main` |

Everything that must survive a deploy (notes, accounts, passwords, uploads,
history, backups) is on the disk. See the [Operations runbook](docs/OPERATIONS.md)
for deploying, backups and restore, account recovery and troubleshooting.

---

## Where data lives

All data is in the data directory (`persistent/` by default):

```
person_<name>.txt          notes (plain text / Markdown)
attachments/<name>/        files attached to a page
uploads/                   the shared file manager
protected_pages.json       private page passwords
.noter/users.json          accounts (scrypt-hashed passwords)
.noter/meta/<name>.json    who edited each page and when
.noter/history/<name>/     earlier versions of pages
.noter/trash/              deleted pages (kept 30 days)
.noter/shares.json         read-only share links
.noter/backups/            automatic daily backups (last 7)
.noter/secret              cookie-signing secret (never included in backups)
.noter/setup-code          first-run setup code (removed once used)
```

Notes stay plain text files, so they are readable and portable outside the app.

---

## Project structure

```
server.js                Express app: sign-in gate, API routes, security headers
lib/
    users.js             Accounts, first-run setup code
    session.js           Signed session cookie
    passwords.js         Private page passwords (protected_pages.json, hot reload)
    limiter.js           Rate limiting for wrong passwords
    notes.js             Note storage: history, trash, rename, search, 3-way merge
    live.js              Server-sent events: presence and live updates
    shares.js            Read-only share links
    backups.js, zip.js   Full and daily backup zips
    util.js              Small shared helpers
public/
    index.html           The app (sidebar + page view) for / and /person/<name>
    login.html           Sign-in and first-run setup
    share.html           Read-only view for share links (/s/<token>)
    files.html           Shared file manager
    app.css              Styles (light/dark tokens)
    sw.js, manifest.webmanifest, icons/   Installable app and offline reading
    js/app/              App modules: main (routing), page, sidebar, dialogs
    js/lib/              Shared helpers: api, markdown, ui, identity
    js/login.js, js/files.js, js/share.js
scripts/
    reset-password.js    Account recovery from the command line
test/
    *.test.js            API tests (node:test)
    e2e/app.e2e.js       Browser test with several people at once (Playwright)
docs/                    Architecture, security, API, operations
```

There is no build step: the browser loads ES modules directly, and third-party
libraries (marked, DOMPurify, node-diff3) are served from `node_modules` under
`/vendor/`. All JavaScript lives in files under `public/js/`: the
Content-Security-Policy blocks inline scripts, so don't add `<script>` blocks or
`onclick=` attributes to HTML.

---

## Development and tests

```sh
npm test             # 48 API tests (node:test), about 10 seconds
npm run test:e2e     # browser test, 44 checks (needs Playwright + Chromium)
npm audit            # dependency check
```

The browser test starts a real server on a throwaway data directory and drives
several signed-in people at once. It covers live editing and merging, the conflict
dialog, history, private pages, sharing, attachments, search, trash, people
management, sign-out, the phone layout, offline reading and XSS payloads. It needs
Playwright, which is not a project dependency:

```sh
npm install --no-save playwright && npx playwright install chromium
npm run test:e2e
```

Contributions: keep changes covered by tests, and run both suites before deploying.
The design and the reasons behind it are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Release notes

### v2.1.0: Accounts
- The whole site requires signing in with individual accounts. First run shows a
  setup screen that needs the one-time code from the server log.
- Settings → People for admins: add, remove, reset passwords, make admins.
- Names on edits, history and presence come from accounts.
- The file manager no longer has its own password; everyone signed in can use it.
- Session cookie is `SameSite=Lax` so links from email and chat arrive signed in.
- `scripts/reset-password.js` for account recovery.

### v2.0.0: Collaborative notebook
- New interface: sidebar, Markdown with checklists, wiki links, tags, attachments,
  search, dark mode, phone layout, installable app with offline reading.
- Live collaboration with presence and automatic three-way merging.
- Version history, trash with undo, read-only share links, admin backups.
- Private pages can be created from the app; passwords set in the app are hashed.

### v1.2.0: Security and reliability
- Page passwords required for saving and deleting (not only reading); passwords
  moved out of URLs, compared in constant time and rate-limited.
- Fixed stored XSS in link rendering and script injection through file names; added
  CSP and security headers; input validation (a malformed request could crash the
  server); upload limits.
- Notes up to 5MB (was 100KB), save status, conflict detection, atomic writes.
- `node_modules/` no longer committed; `npm test` added.

### v1.1.0 (2025-05-20)
- Notes stored in `persistent/` so a persistent disk can keep them across deploys.

---

## License

ISC © Brody Kilpatrick
