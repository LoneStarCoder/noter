# API reference

The browser app uses this JSON API; you can call it too (for scripts or
integrations) with a signed-in session cookie.

## Conventions

- **Sign-in:** every endpoint needs a signed-in session unless marked *public*. The
  session is the `noter_session` cookie, which `POST /api/auth/login` sets.
- **CSRF:** every request other than GET/HEAD must send `X-Noter: 1`. If an
  `Origin` header is present, it must match the host.
- **Bodies** are JSON (`Content-Type: application/json`), except uploads, which are
  `multipart/form-data` with the field `files`.
- **Errors** are `{ "success": false, "message": "…" }` with an HTTP status:

  | Status | Meaning |
  | --- | --- |
  | `400` | invalid input |
  | `401` | not signed in (`signIn: true`), locked private page (`locked: true`), wrong password, or not an admin |
  | `403` | not allowed (e.g. deleting home) |
  | `404` | not found |
  | `409` | conflict (name taken, concurrent edit) |
  | `413` | too large |
  | `429` | too many wrong passwords |
- **Page names** in URLs are `[A-Za-z0-9_-]` (other characters are stripped),
  up to 100 characters. `files` and `admin` are reserved.
- **Author names:** the name recorded for edits and presence is the signed-in
  account's name.

Example with `curl`:

```sh
B=https://noter.example.com
curl -c jar -H 'X-Noter: 1' -H 'Content-Type: application/json' \
     -d '{"username":"brody","password":"…"}' $B/api/auth/login
curl -b jar $B/api/pages
curl -b jar -X PUT -H 'X-Noter: 1' -H 'Content-Type: application/json' \
     -d '{"text":"- [ ] milk"}' $B/api/pages/groceries
```

---

## Authentication

| Method & path | Access | Body | Response |
| --- | --- | --- | --- |
| `GET /api/auth/status` | public | | `{ user: {username,name,admin} \| null, setupRequired }` |
| `POST /api/auth/login` | public, rate-limited | `{ username, password }` | `{ success, user }`, sets the cookie; `401` on a wrong username or password |
| `POST /api/auth/logout` | public | | `{ success }`, clears the cookie |
| `POST /api/auth/setup` | public, only while no accounts exist, rate-limited | `{ code, username, name, password }` | `{ success, user }`, creates the first admin and signs in; `409` once set up |
| `GET /login` | public | | Sign-in / setup page. Signed-out browsers are redirected here as `/login?next=<path>` |

Usernames are 2–32 characters (`a-z 0-9 . _ -`, case-insensitive). Passwords are
at least 8 characters.

## Your account

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/session` | | `{ user, admin, unlocked: [private pages you have unlocked], … }` |
| `PUT /api/me` | `{ name }` | `{ success, user }` |
| `POST /api/me/password` | `{ current, password }` | `{ success }`. Stays signed in here; other sessions are signed out. `401` if `current` is wrong (rate-limited) |
| `POST /api/me/signout-everywhere` | | `{ success }`. Revokes every other session |

## People (admin)

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/users` | | `[{ username, name, admin, createdAt }]` (never hashes) |
| `POST /api/users` | `{ username, name?, password, admin? }` | `{ success, user }`; `409` if the username is taken |
| `PATCH /api/users/:username` | `{ name?, admin? }` | `{ success, user }`; `400` if it would leave no admin |
| `POST /api/users/:username/password` | `{ password }` | `{ success }`. Signs that person out everywhere |
| `DELETE /api/users/:username` | | `{ success }`. Signs them out; `400` for yourself or the last admin |

## Pages

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/pages` | | Every page, home first then newest: `[{ name, title, preview, tags, size, updatedAt, updatedBy, protected, locked }]`. Private pages you haven't unlocked have `locked: true` and only `name`/`updatedAt` (empty title, preview and tags) |
| `GET /api/search?q=` | | `[{ name, title, snippet }]`: every word must appear in the name or text; up to 50 results |
| `GET /api/pages/:name` | | `{ name, text, version, updatedAt, updatedBy, exists, protected, access, viewers }` (`access`: `public`, `password` or `admin`); `401 {locked}` for a private page you haven't unlocked. A missing page returns `exists: false`, `text: ""` |
| `PUT /api/pages/:name` | `{ text, baseVersion?, force?, snapshot? }` | See *Saving* below |
| `DELETE /api/pages/:name` | | `{ success, trashId }`. Moves the page (with history and attachments) to Trash. `403` for `home` |
| `POST /api/pages/:name/rename` | `{ to }` | `{ success, name }`. Moves history, attachments, share links and password; `409` if the name is taken; `403` for `home` |

### Saving

`PUT /api/pages/:name` with:

- `text` (required string): the full new text.
- `baseVersion`: the `version` you loaded or last saved. If the page changed since
  then, the server three-way merges your changes with theirs.
- `force: true`: save without merging (overwrites).
- `snapshot: true`: always keep the previous text in history (used by "Replace
  with a file").

Responses:

- `200 { success, version }`: saved as sent.
- `200 { success, version, merged: true, text }`: someone else changed other lines;
  `text` is the merged result now stored.
- `409 { conflict: true, text, version, updatedBy, bothText? }`: someone changed the
  same lines (or the base version is no longer known). `text` is their version.
  `bothText` keeps both sides of each conflict. Save again with `force: true` and
  your choice.

## Private pages

| Method & path | Access | Body | Response |
| --- | --- | --- | --- |
| `POST /api/unlock` | rate-limited | `{ scope: "page", page, password }` | `{ success }`. The unlock is remembered for this browser **and your account** (all your devices) until the page password changes; `401` if wrong |
| `POST /api/lock` | | `{ scope: "page", page }` or `{ all: true }` | `{ success }`. Locks the page (or all private pages) again for you: this browser and your account. You stay signed in |
| `POST /api/pages/:name/password` | page access | `{ password }` (≥ 4 characters) or `{ password: null }` | `{ success, protected }`. Anyone can set a password on a new or empty page; existing pages with content need an admin |

## History

| Method & path | Response |
| --- | --- |
| `GET /api/pages/:name/history` | `[{ id, savedAt, by, size }]`, newest first (up to 200) |
| `GET /api/pages/:name/history/:id` | `{ id, savedAt, by, size, text }` |
| `POST /api/pages/:name/restore` `{ id }` | `{ success, version, text }`. The replaced text is kept in history |

## Trash

| Method & path | Access | Response |
| --- | --- | --- |
| `GET /api/trash` | | `[{ id, name, title, preview, deletedAt, deletedBy, protected }]`. Private pages are listed only for admins |
| `POST /api/trash/:id/restore` | private pages: admin or `{ password }` (rate-limited) | `{ success, name }`. Restores under the original name, or `<name>-restored` if taken |
| `DELETE /api/trash/:id` | admin | `{ success }`. Deletes permanently |

Trash entries are deleted automatically after 30 days.

## Attachments

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/pages/:name/attachments` | | `[{ name, size, url }]` |
| `POST /api/pages/:name/attachments` | multipart `files` (≤ 20 files, 50 MB each) | `{ success, files: [{ name, size, url }] }`. Names are sanitized and never overwrite |
| `GET /api/pages/:name/attachments/:file` | | The file. Images are shown inline, other files download; all are sandboxed |
| `DELETE /api/pages/:name/attachments/:file` | | `{ success }` |

In Markdown, reference attachments as `attachments/<file>` (for example
`![photo](attachments/photo.png)`); the app rewrites the URL.

## Share links

| Method & path | Access | Response |
| --- | --- | --- |
| `GET /api/pages/:name/shares` | page access | `[{ token, page, createdAt, createdBy, url }]` |
| `POST /api/pages/:name/shares` | page access | `{ success, token, url }` |
| `DELETE /api/shares/:token` | access to that page | `{ success }` |
| `GET /s/:token` | public | Read-only page view |
| `GET /api/share/:token` | public | `{ name, text, updatedAt, updatedBy }` |
| `GET /api/share/:token/attachments/:file` | public | That page's attachment |

## Live updates

`GET /api/pages/:name/events?client=<tab id>` returns a `text/event-stream`
(server-sent events). Page access is required. Events: `presence`, `update`,
`deleted`, `renamed`, `protection`; see
[ARCHITECTURE.md](ARCHITECTURE.md#live-updates). A comment heartbeat is sent every
25 seconds.

## Shared file manager

These endpoints come from v1 and keep their paths. Folders are given as a
`folder` (or `parent`) query parameter relative to the uploads root; names are
sanitized and path traversal is rejected.

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /list-files?folder=` | | `[{ name, size, isDirectory, modifiedAt }]` |
| `POST /upload?folder=` | multipart `files` | `{ success, count, files }` |
| `POST /create-folder` | `{ name, parent }` | `{ success }` |
| `GET /download/:filename?folder=[&inline=1]` | | The file (sandboxed; `inline=1` shows images inline) |
| `GET /view/:filename?folder=` | | `{ success, isText, content? }` (text preview under 5 MB) |
| `DELETE /delete-file/:filename?folder=` | | `{ success }` |
| `DELETE /delete-folder/:foldername?parent=` | | `{ success }` (deletes everything in it) |

## Admin

| Method & path | Response |
| --- | --- |
| `GET /api/admin/backup` | ZIP of the data directory, excluding secrets and old backups |
| `GET /api/admin/backups` | `[{ name, size }]`: automatic daily backups |
| `GET /api/admin/backups/:file` | One daily backup ZIP |

Legacy, kept for compatibility: `POST /api/unlock { scope: "admin", password }`
grants admin for the session if `protected_pages.json` has an `"admin"` password,
and `POST /api/admin/password { key, password }` changes that password. Accounts
with the admin flag don't need either.
