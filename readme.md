# Noter

A simple web-based note-taking app with per-page password protection, persistent storage, and a clean, themeable interface.

---

## Features

- Create, edit, and delete named note pages (e.g., `/person/brody`)
- Autosave with a status indicator, and a warning if you leave with unsaved changes
- Conflict detection: if a page changed elsewhere since you opened it, you choose whether to overwrite it or load the latest version (your text is downloaded as a backup)
- Per-page password protection (optional, via `protected_pages.json`)
- Password-protected file manager with folders, previews, uploads and downloads
- Download/upload notes as `.txt` files
- Light and dark themes (toggleable, persists in browser)
- All notes stored as plain text files on the server

---

## Project Structure

```
server.js              Express server (notes API, file manager API, security headers)
package.json
test/                  API tests (node:test), run with `npm test`
persistent/            Data directory: notes (person_<name>.txt) and uploads/
public/
    index.html         Home page (the "home" note, page picker, create page)
    editor.html        Editor for /person/<name>
    files.html         File manager
    blog.html          Static blog page
    js/common.js       Shared helpers (safe link rendering, passwords, theme)
    js/pad.js          Note loading/autosave logic used by home and editor
    js/home.js         Home page picker / create page
    js/files.js        File manager logic
    style.css, dark.css, style_blog.css
```

All JavaScript lives in `public/js/`. The server sends a Content-Security-Policy
that blocks inline scripts, so don't add `<script>` blocks or `onclick=` attributes
to the HTML; add code to a file in `public/js/` instead.

---

## Usage

```sh
npm install
npm start      # http://localhost:3000
npm test       # run the API tests
```

- Home: [http://localhost:3000/](http://localhost:3000/)
- Editor for a page: [http://localhost:3000/person/brody](http://localhost:3000/person/brody)
- Files: [http://localhost:3000/files.html](http://localhost:3000/files.html)

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `NOTER_DATA_DIR` | `./persistent` | Where notes and uploads are stored |
| `NOTER_PASSWORDS_FILE` | *(see below)* | Path to `protected_pages.json` |
| `NOTER_MAX_UPLOAD_MB` | `50` | Max size per uploaded file |
| `NOTER_MAX_NOTE_SIZE` | `5mb` | Max size of a single note |
| `TRUST_PROXY` | *(unset)* | Number of reverse proxies in front of the app (e.g. `1` on Render), so rate limiting sees real client IPs. Leave unset when not behind a proxy. |

---

## Password Protection

Create a `protected_pages.json` file:

```json
{
  "brody": "yourpassword",
  "elizabeth": "anotherpassword",
  "files": "file-manager-password"
}
```

The file is looked up in this order: `$NOTER_PASSWORDS_FILE`, then the data
directory (`persistent/protected_pages.json`, which is what you want on a host with
a persistent disk), then the project root. It is gitignored, so it must be created on
the server. If the file contains invalid JSON the server refuses to start.

- A protected page needs its password to be **read, saved, or deleted**. Protected
  pages are not shown in the page list.
- The **file manager is disabled** until a `"files"` password is set.
- Passwords are sent in an `X-Noter-Password` header (never in the URL), and the
  browser only remembers them for the current session.
- After 10 wrong passwords from one IP within 15 minutes, further attempts are
  refused until the window passes.
- Pages without a password are public: anyone who can reach the site can read
  and edit them.

---

## Notes Storage

- Each note page is stored as `person_<name>.txt` in the data directory; the home page is `person_home.txt`.
- Page names may only contain letters, numbers, `-` and `_`, and are case-sensitive.
- Uploaded files are stored in `uploads/` inside the data directory. Uploading a file
  with an existing name keeps both (`name (1).ext`).

---

## Customization

- Edit CSS in `public/style.css` and `public/dark.css` for appearance.
- Add/remove links in `public/index.html` and `public/editor.html` for navigation.

---

## License

ISC

---

## Author

Brody Kilpatrick

---

# Release Notes

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
