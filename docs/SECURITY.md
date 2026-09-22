# Security

This covers what Noter protects, how, and what it deliberately doesn't. Every
control listed here has automated tests in `test/security.test.js`,
`test/accounts.test.js` and the browser test (`test/e2e/app.e2e.js`).

## Who can do what

| | Signed out | Signed-in member | Knows a private page's password | Admin |
| --- | --- | --- | --- | --- |
| Sign-in page, share links (`/s/…`) | ✅ | ✅ | ✅ | ✅ |
| Read and edit public pages | ❌ | ✅ | ✅ | ✅ |
| Read and edit a private page | ❌ | ❌ | ✅ | ✅ |
| Create pages, make a new page private | ❌ | ✅ | ✅ | ✅ |
| Lock an existing shared page | ❌ | ❌ | ❌ | ✅ |
| History, trash, search, attachments, file manager | ❌ | ✅ (private pages excluded) | ✅ | ✅ |
| Restore a deleted private page | ❌ | with its old password | with its old password | ✅ |
| People, backups, empty trash | ❌ | ❌ | ❌ | ✅ |

## Threats and controls

### Someone on the internet finds the site
- **Sign-in gate on everything.** Every page, API endpoint and file needs a valid
  session. Browsers are redirected to `/login`; API calls get a 401. Only the
  sign-in page, its static assets and share links are public.
- **First run can't be hijacked.** Creating the first (admin) account needs a
  one-time setup code that is only visible in the server log.
- **Password guessing is slowed.** After 10 wrong passwords from one IP within 15
  minutes, further attempts from that IP are refused. This one budget covers
  sign-in, setup codes, page unlocks, trash restores and "change my password".
  With `TRUST_PROXY=1` the real client IP is used behind Render's proxy.
- **Usernames can't be probed.** A failed sign-in takes the same time whether or
  not the username exists (a dummy hash is checked) and returns the same message.

### Stolen or leaked credentials
- Account passwords are stored as **scrypt** hashes (random salt, 32-byte key) and
  must be at least 8 characters. Page passwords set in the app are hashed the same
  way; ones typed into `protected_pages.json` by hand stay plain text until they
  are changed in the app.
- **Revocation is immediate.** Resetting a password, removing a person, changing
  admin status and "sign out everywhere else" all bump the account's token
  version, which invalidates every existing session for that account. Changing a
  page password locks everyone else out of that page.
- Passwords never appear in URLs, logs or browser storage.

### Forged requests from other websites (CSRF)
- Every non-GET request must carry the custom header `X-Noter: 1`. A plain HTML
  form can't set it, and cross-site scripts can't send it without a CORS preflight,
  which Noter never approves.
- If the browser sends an `Origin` header, it must match the host.
- The session cookie is `SameSite=Lax`: it goes with top-level navigations (so
  links from email work) but not with cross-site sub-requests.
- Saves require a JSON body with a string `text`, so a form post can't blank a page.

### Stealing the session
- The cookie is `HttpOnly`, so scripts can't read it. It is `Secure` over HTTPS
  (requires `TRUST_PROXY=1` on Render) and HMAC-signed with a 256-bit secret; a
  tampered cookie is rejected. It expires after 30 days.
- `/login?next=` only accepts same-site paths, so it can't be used as an open
  redirect.

### Malicious content in notes or file names (XSS)
- Markdown is sanitized with **DOMPurify**. Wiki links, tags and bare-domain links
  are created as DOM nodes, never by building HTML strings.
- A **Content-Security-Policy** allows scripts only from Noter's own files
  (`script-src 'self'`, no inline script), so even a sanitizer bypass could not run
  injected script. Also set: `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'` and `form-action 'self'`.
- File names and user names are only ever shown as text.
- Uploaded files are served with `Content-Security-Policy: sandbox` and `nosniff`.
  Only images are shown inline; everything else downloads. An uploaded HTML or SVG
  file therefore can't run script on the Noter origin.
- External images in notes are loaded with `referrerpolicy=no-referrer`.

### Reaching files outside the data directory
- Page and folder names are limited to `[A-Za-z0-9_-]`.
- File names are sanitized: path separators, control characters and
  `<>:"|?*` are replaced, and leading dots are removed.
- Every file path is resolved and checked to stay inside its directory.
- Query parameters must be strings; arrays and objects are rejected. An array
  parameter used to crash v1.
- Uploads never overwrite: a clash gets a new name, `name (1).ext`.
- History and trash IDs are validated against strict patterns.

### Abuse and denial of service
- Limits:
  - notes 5 MB
  - uploads 50 MB per file, 20 files per request
  - live connections 500 in total, 20 per IP
  - the merge cache 32 MB
  - search: the first 10 words
- No stack traces are sent to clients.
- Dependencies are kept current: `npm audit` reports 0 known vulnerabilities as of
  v2.1.0.

## What is public on purpose

- **Share links** (`/s/<token>`) show one page, read-only, to anyone who has the
  link, including private pages. A link is a random 128-bit token, can be revoked
  per page, and does not unlock anything else.
- The **app's code** (HTML, CSS, JavaScript) is public so the sign-in page can
  load. It contains no data or secrets.

## Known limitations and residual risks

- **Members trust each other.** Any signed-in person can read, edit and delete any
  page that isn't private. Deletes go to Trash, and history keeps earlier versions,
  but there are no per-page permissions beyond private-page passwords.
- **Admins can see everything,** including private pages and full backups, which
  contain the password hashes.
- **Page names can be claimed.** Anyone can make a *new* page name private before
  someone else uses it. An admin can remove the password.
- **No two-factor sign-in and no password-reset email.** Admins reset passwords by
  hand; if every admin is locked out, use `scripts/reset-password.js` (see
  [OPERATIONS.md](OPERATIONS.md)).
- **Rate limits and presence live in memory,** so a restart resets the counters.
- **Offline copies.** Public pages someone opened stay in their browser's cache
  until they sign out. Private pages are never cached.
- **Hand-written page passwords** in `protected_pages.json` are plain text until
  changed in the app.
- **The data directory is trusted.** Anyone with shell access to the server (for
  example the Render account) can read everything. Protect the Render account with
  a strong password and two-factor authentication.

## Secrets

| Secret | Where | If it leaks |
| --- | --- | --- |
| Cookie-signing secret | `$NOTER_SECRET` or `.noter/secret` | Sessions could be forged: rotate it (delete the file or change the variable and restart). Everyone is signed out. |
| Setup code | `.noter/setup-code`, until used | Only useful while no account exists. |
| Account hashes | `.noter/users.json` | Offline guessing is slow (scrypt), but reset the affected passwords. |
| Page passwords | `protected_pages.json` | Change them in the app. |

The secret and setup code are never included in backups.

## Security history

The v1 review found, and v1.2.0 fixed:

- save and delete on protected pages didn't check the password
- stored XSS through the link renderer
- script injection through uploaded file names
- a one-request crash (array query parameter)
- the file manager was open when no password was set
- passwords were sent in URLs

v2.0.0 moved to signed cookies, CSRF protection, DOMPurify and a strict CSP.
v2.1.0 put the whole site behind individual accounts.

## Reporting a problem

Open an issue in this repository without sensitive details, or contact the
maintainer directly for anything exploitable.
