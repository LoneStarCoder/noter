# Noter

A simple web-based note-taking app with per-page password protection, persistent storage, and a clean, themeable interface.

---

## Features

- Create, edit, and delete named note pages (e.g., `/person/brody`)
- Per-page password protection (optional, via `protected_pages.json`)
- Download/upload notes as `.txt` files
- Light and dark themes (toggleable, persists in browser)
- All notes stored as plain text files on the server
- Responsive, minimal UI

---

## Project Structure

```
.gitignore
data.txt
package.json
person_testers.txt
readme.md
server.js
persistent/
    brody.txt
public/
    dark.css
    editor.html
    index.html
    style.css
```

### File Descriptions

#### [server.js](server.js)
- Main Express server.
- Serves static files from `public/`.
- Handles dynamic routes for loading, saving, listing, and deleting note pages.
- Supports per-page password protection via `protected_pages.json` (not included in repo).
- Notes are stored as `person_<name>.txt` in the project root.

#### [public/index.html](public/index.html)
- Home page UI.
- Lets users select or create note pages.
- Loads and saves the "home" page by default.
- Theme toggle and page navigation.

#### [public/editor.html](public/editor.html)
- Editor UI for individual note pages.
- Loads/saves note content, with password prompt if protected.
- Allows downloading/uploading `.txt` files.
- Delete button for removing the current page (except protected ones).
- Theme toggle.

#### [public/style.css](public/style.css)
- Main stylesheet for light theme and layout.

#### [public/dark.css](public/dark.css)
- Overrides for dark theme.

#### [package.json](package.json)
- Project metadata and dependencies (uses Express).

#### [data.txt](data.txt), [person_testers.txt](person_testers.txt)
- Example/test data files (not used by the app).

#### [persistent/brody.txt](persistent/brody.txt)
- Example persistent data file (not used by the app).

#### [.gitignore](.gitignore)
- Ignores all generated note files and `protected_pages.json`.

---

## Usage

### Install dependencies

```sh
npm install
```

### Start the server

```sh
npm start
```

Server runs at [http://localhost:3000](http://localhost:3000).

### Access the app

- Home: [http://localhost:3000/](http://localhost:3000/)
- Editor for a page: [http://localhost:3000/person/brody](http://localhost:3000/person/brody) (replace `brody` with any page name)

---

## Password Protection

To protect a page with a password, create a `protected_pages.json` file in the project root:

```json
{
  "brody": "yourpassword",
  "elizabeth": "anotherpassword"
}
```

- When accessing a protected page, users will be prompted for the password.

---

## Notes Storage

- Each note page is stored as `person_<name>.txt` in the `persistent/` directory.
- The home page is stored as `person_home.txt` in the `persistent/` directory.

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

2. **Update Your Service**
   - Make sure your Render service uses the latest code (with all note files stored in `/persistent`).
   - The app will automatically use the persistent disk for all note storage.

3. **Migration (if needed)**
   - If you have existing note files, move them into the `/persistent` directory after the disk is mounted.
   - You can do this via the Render Shell or by uploading files.

4. **No Further Configuration Needed**
   - The app will create the `/persistent` directory if it does not exist.
   - All note operations (create, read, update, delete, list) will use the persistent disk.

**Tip:**
- For local development, the app uses the `persistent/` directory in your project root.
- For deployment, Render will mount the persistent disk at `/persistent` and your app will use it automatically.
