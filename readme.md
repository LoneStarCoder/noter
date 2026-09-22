# Noter

A shared notebook for a small group of people: lists, recipes, code snippets and
anything else, edited together in real time, with history so nothing is ever lost.

---

## Features

**Writing**
- Markdown with a View / Edit toggle (Ctrl+E). Plain-text notes still look right.
- Checklists (`- [ ] item`) you can tick straight from the rendered page
- `[[page-name]]` links between pages, `#tags`, and automatic links for URLs
- Paste or drop images and files into a page to attach them
- Enter continues lists, Tab / Shift+Tab indents list items
- Copy buttons on code blocks; print a page cleanly

**Working together**
- Live updates: when someone saves, everyone viewing the page sees it within a second
- Presence: avatars show who else has the page open
- Automatic merging: two people editing different lines of the same page at once
  both keep their changes. Editing the *same* line asks what to keep (yours,
  theirs, or both).
- Everyone picks a display name (Settings) so edits and history show who did what

**Never lose anything**
- Version history for every page with a diff view and one-click restore
- Deleted pages go to Trash for 30 days (with their history and attachments); Undo right after deleting
- Admin: download a full backup zip any time; automatic daily backups (last 7) are kept on the disk

**Finding things**
- Sidebar of every page, newest first, with title, preview, who edited it and when
- Filter by name or `#tag`; Ctrl+K searches the text of every page you can open

**Accounts and privacy**
- The whole site is behind sign-in: everyone has their own username and password
- Admins add, remove and reset people from Settings → People; removing someone or
  resetting their password signs them out everywhere at once
- Private pages (extra password) on top of sign-in. Make a new page private when
  you create it; admins can lock or unlock any page.
- Read-only share links for a single page (revocable) work without an account
- Shared file manager for everyone who is signed in

**Everywhere**
- Works on phones; installable as an app (Add to Home Screen)
- Public pages you've opened can be read offline
- Light and dark themes (follows your device by default)

---

## Project Structure

```
server.js              Express app: API routes, auth, security headers
lib/
    notes.js           Note storage: history, trash, rename, search, merging
    passwords.js       protected_pages.json (hashed passwords, hot reload)
    session.js         Signed session cookie (what this browser has unlocked)
    live.js            Server-sent events: presence and live updates
    shares.js          Read-only share links
    backups.js, zip.js Backup zips
public/
    index.html         The app (sidebar + page view) for / and /person/<name>
    share.html         Read-only view for share links (/s/<token>)
    files.html         Shared file manager
    app.css            Styles (light/dark tokens)
    sw.js, manifest.webmanifest, icons/   Installable app / offline reading
    js/app/            App modules (page view, sidebar, dialogs)
    js/lib/            Shared helpers (API, markdown, UI)
test/                  API tests (npm test) and a browser test (test/e2e)
```

All JavaScript lives in files under `public/js/`. The server sends a
Content-Security-Policy that blocks inline scripts, so don't add `<script>` blocks
or `onclick=` attributes to the HTML.

---

## Usage

```sh
npm install
npm start          # http://localhost:3000
npm test           # API tests
npm run test:e2e   # browser test (needs Playwright, see test/e2e/app.e2e.js)
```

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl/⌘ + K | Search and jump to any page (or create one) |
| Ctrl/⌘ + E | Switch between View and Edit |
| Ctrl/⌘ + S | Save now |
| Alt + N | New page |

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `NOTER_DATA_DIR` | `./persistent` | Where notes, history, attachments and uploads are stored |
| `NOTER_PASSWORDS_FILE` | *(see below)* | Path to `protected_pages.json` |
| `NOTER_SECRET` | *(generated)* | Secret for signing session cookies. By default one is generated and kept in `<data dir>/.noter/secret` |
| `NOTER_MAX_UPLOAD_MB` | `50` | Max size per uploaded file |
| `NOTER_MAX_NOTE_SIZE` | `5mb` | Max size of a single note |
| `TRUST_PROXY` | *(unset)* | Number of reverse proxies in front of the app (`1` on Render), so rate limiting sees real client IPs and cookies are marked Secure. Leave unset when not behind a proxy. |

---

## Accounts

Everything except the sign-in page and share links requires signing in.

**First run.** When Noter starts with no accounts it prints a one-time setup code
in the server log:

```
Noter setup: no accounts yet. Open /login and create the first (admin) account with setup code 1A2B3-C4D5E
```

(On Render: the service's **Logs** tab.) Open the site, enter the code and create
your account; it becomes the admin. If `protected_pages.json` has an `"admin"`
password, that also works as the setup code.

**Adding people.** Settings → People → Add person. Noter suggests a temporary
password and copies the sign-in details so you can send them. People can change
their own name and password in Settings.

**Taking access away.** Remove the person, or reset their password; either signs
them out on every device immediately. Anyone can also use Settings → "Sign out
everywhere else" for their own account.

Details:
- Passwords are stored as scrypt hashes in `.noter/users.json` (at least 8 characters).
- Sign-in lasts 30 days per device, in a signed HttpOnly cookie. After 10 wrong
  passwords from one IP in 15 minutes, further attempts are refused for a while.
- There is always at least one admin; you can't remove yourself.

## Private pages

`protected_pages.json` can still give individual pages an extra password (people
must be signed in *and* know the page password):

```json
{
  "brody": "yourpassword"
}
```

- Anyone can make a **new or empty** page private; only admins can lock an existing
  shared page (so nobody gets locked out of a page they use).
- Anyone with a private page's password can change or remove it.
- The file is looked up in `$NOTER_PASSWORDS_FILE`, then the data directory
  (`persistent/protected_pages.json`), then the project root. Edits take effect
  within a few seconds.
- The `"files"` key is no longer needed: the file manager is open to everyone who
  is signed in.

---

## Storage

Everything lives in the data directory (`persistent/` by default):

```
person_<name>.txt          the notes (plain text / Markdown, unchanged format)
attachments/<name>/        files attached to a page
uploads/                   the shared file manager
protected_pages.json       private page passwords
.noter/users.json          accounts (hashed passwords)
.noter/meta/               who edited each page and when
.noter/history/            earlier versions of pages
.noter/trash/              deleted pages (kept 30 days)
.noter/shares.json         share links
.noter/backups/            automatic daily backups (last 7)
.noter/secret              cookie-signing secret (never included in backups)
```

---

## License

ISC

---

## Author

Brody Kilpatrick

---

# Release Notes

## v2.1.0

- Individual accounts: the whole site now requires signing in. First run shows a
  setup screen that needs the one-time code from the server log.
- Settings → People for admins: add, remove, reset passwords, make admins.
- Names on edits, history and presence come from accounts.
- The file manager no longer has its own password; everyone signed in can use it.

## v2.0.0

A rebuild of the interface and a lot of new features for groups sharing pages:
Markdown with checklists, live collaboration with presence and automatic merging,
version history, trash, search, tags, attachments, share links, private pages from
the app, admin tools and backups, installable app with offline reading, dark mode
and a phone-friendly layout.

### Upgrading from 1.x
- Existing notes, passwords and uploads are used as they are. New data is added
  under `.noter/` and `attachments/` in the data directory.
- Add an `"admin"` password to `protected_pages.json` to use the admin tools.
- Sign-in now uses a cookie instead of a password header, so everyone enters page
  passwords once more (then stays signed in on that device for 30 days).
- Existing notes are now shown as Markdown. Plain text looks the same, except that
  lines starting with `#`, `-`, `*` or a number become headings and lists.

## v1.2.0

### Security
- Page passwords are now required to save and delete protected pages, not only to read them.
- Passwords moved from URLs to a request header, compared in constant time, and rate-limited.
- Fixed stored XSS in note link rendering and script injection through uploaded file names.
- The file manager is disabled unless a `files` password is configured.
- Upload size limits, no overwriting on upload, input validation (a malformed request could crash the server), security headers and CSP.
- Upgraded multer to 2.x and express to 4.22.

### Changed
- Notes up to 5MB (was 100KB, which failed silently), autosave status, conflict detection, safe writes.
- `node_modules/` is no longer committed; run `npm install`.
- Added `npm test`.

## v1.1.0 (2025-05-20)

### Changed
- **Persistent Note Storage:** All note files are now stored in the `persistent/` directory instead of the project root. This enables compatibility with persistent volumes on cloud hosts (e.g., Render, Heroku, etc.), ensuring that user-created notes and data are not lost on redeploy or restart.
- The application will automatically create the `persistent/` directory if it does not exist.
- All note operations (create, read, update, delete, list) now use the `persistent/` directory for storage.

### Migration
- If you have existing note files in the project root (e.g., `person_brody.txt`), move them to the `persistent/` directory to retain access.

### Configuration
- No configuration is required for local use. For deployment, mount a persistent volume to the `persistent/` directory.

---

## Deploying with Persistent Disk on Render

To ensure your notes and data are not lost on redeploy or restart, configure a persistent disk on Render:

1. **Create a Persistent Disk**
   - In your Render dashboard, go to your web service settings.
   - Under the "Disks" section, click "Add Disk".
   - Name the disk (e.g., `noter-data`), set the mount path to `/opt/render/project/src/persistent`, and choose a size (e.g., 1GB or more).
   - Put `protected_pages.json` on the disk (`persistent/protected_pages.json`) via the Render Shell, and set the environment variable `TRUST_PROXY=1`.

2. **Update Your Service**
   - Make sure your Render service uses the latest code (with all note files stored in `/persistent`).
   - The app will automatically use the persistent disk for all note storage.

3. **Migration (if needed)**
   - If you have existing note files, move them into the `/persistent` directory after the disk is mounted.
   - You can do this via the Render Shell or by uploading files.

4. **Done**
   - The app will create the `/persistent` directory if it does not exist.
   - All note operations (create, read, update, delete, list) will use the persistent disk.

**Tip:**
- For local development, the app uses the `persistent/` directory in your project root.
- For deployment, Render will mount the persistent disk at `/persistent` and your app will use it automatically.
