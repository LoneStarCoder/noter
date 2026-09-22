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

**Privacy**
- Private pages (password). Make a new page private when you create it; the admin
  can lock or unlock any page. Unlocked pages stay unlocked on that device for 30 days.
- Read-only share links for a single page (revocable), even for private pages
- Password-protected shared file manager

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

## Passwords and privacy

`protected_pages.json` holds page passwords plus two special keys:

```json
{
  "admin": "admin-password",
  "files": "file-manager-password",
  "brody": "yourpassword"
}
```

- **`admin`**: unlocks every page, lets you lock/unlock existing pages, empty the
  trash, change the files password and download backups (Settings → Admin).
- **`files`**: the shared file manager is disabled until this is set.
- **page names**: private pages. People can also make pages private from the app.

The file is looked up in this order: `$NOTER_PASSWORDS_FILE`, the data directory
(`persistent/protected_pages.json`, use this on a host with a persistent disk),
then the project root. It is gitignored. Edits to it take effect within a few
seconds, no restart needed. If it contains invalid JSON at startup the server
refuses to start.

Passwords set through the app are stored as scrypt hashes; passwords you type into
the file by hand can be plain text. Changing a password signs everyone else out of
that page.

Rules that keep a shared notebook safe from lock-outs:
- Anyone can make a **new or empty** page private.
- Only the **admin** can make an existing shared page with content private.
- Anyone with a private page's password can change or remove it.
- Pages without a password are public: anyone who can reach the site can read and edit them.

Sign-in is a signed, HttpOnly, SameSite=Strict cookie; after 10 wrong passwords
from one IP in 15 minutes further attempts are refused for a while.

---

## Storage

Everything lives in the data directory (`persistent/` by default):

```
person_<name>.txt          the notes (plain text / Markdown, unchanged format)
attachments/<name>/        files attached to a page
uploads/                   the shared file manager
protected_pages.json       passwords
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
