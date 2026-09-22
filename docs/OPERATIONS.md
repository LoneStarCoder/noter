# Operations runbook

How to run, deploy, back up, restore and troubleshoot Noter in production.

## Production at a glance

| | |
| --- | --- |
| URL | https://noter-u007.onrender.com |
| Host | Render web service **`noter`** (workspace "noter"), Starter plan, Oregon |
| Code | `main` branch of `LoneStarCoder/noter` |
| Build / start | `npm install` / `npm start` |
| Data | Render disk (1 GB) mounted at `/opt/render/project/src/persistent` |
| Environment | `TRUST_PROXY=1` |
| Auto-deploy | **Off**: deploy manually after merging |

The same workspace also has the services `noter2` and `notertest`. Both are
**suspended**, track `main` with auto-deploy on, and have **no disk**. If you resume
either one, it deploys `main` immediately and anything written to it is lost on
its next deploy.

## Deploying

1. Merge the change into `main` (after `npm test` and, ideally, `npm run test:e2e`
   pass).
2. In the Render dashboard, open **noter → Manual Deploy → Deploy latest commit**.
3. The build takes about 1–2 minutes. Expect a few seconds of `502` while the new
   instance takes over.
4. Check the deploy:

   ```sh
   U=https://noter-u007.onrender.com
   curl -s $U/api/auth/status                              # {"user":null,"setupRequired":false}
   curl -s -o /dev/null -w '%{http_code}\n' $U/api/pages   # 401: data needs sign-in
   curl -s -o /dev/null -w '%{http_code}\n' $U/login       # 200
   ```

   Then sign in and open a page. In **Logs** you should see
   `Listening on http://localhost:10000` and no errors.

Open browser tabs from before a deploy keep working. If one shows errors, reload it.

**Rolling back:** in Render, open **Deploys**, pick the previous successful deploy
and choose **Rollback**, or revert the merge on `main` and deploy again. Data
written by a newer version stays on the disk, and older versions ignore files they
don't know about.

> ⚠️ **Never roll back to a version before 2.1.0 (commit `844f4c3`).** Those
> versions don't have accounts, so the whole site would be **open to anyone
> again**, even though `.noter/users.json` is still on the disk.

## First-time setup (a new, empty install)

1. Deploy. The log prints:
   `Noter setup: no accounts yet. Open /login and create the first (admin) account with setup code XXXXX-XXXXX`
2. Open the site, enter the code, and create your account; it becomes the admin.
3. Add people in **Settings → People**.

Lost the code before using it? It stays in the file until used:

```sh
cat /opt/render/project/src/persistent/.noter/setup-code
```

(Render Shell.) Restarting the service also prints it again.

## Managing people

Everything is in the app, under **Settings → People** (admins only):

- **Add person:** the username is filled in from the name and a temporary password
  is suggested; the sign-in details are copied for you to send.
- **Reset password:** signs them out everywhere, and copies the new password.
- **Make admin / Remove admin**, **Remove.** There is always at least one admin.

People change their own name and password in **Settings → Your account**.

## Account recovery (every admin locked out)

Use the Render **Shell** for the `noter` service:

```sh
cd /opt/render/project/src
node scripts/reset-password.js --list                      # who exists
node scripts/reset-password.js brody 'a-new-long-password' # reset a password
node scripts/reset-password.js brody 'a-new-long-password' --admin   # …and make admin
node scripts/reset-password.js newadmin 'long-password' --admin      # or create a new admin
```

Then **restart the service** (Render: **Manual Deploy → Restart service**, or
deploy again). The running server keeps accounts in memory: until it restarts
it won't accept the new password, and it could overwrite the change if someone
edits accounts in the app in the meantime.

To start over with no accounts (setup mode again), delete
`persistent/.noter/users.json` and restart. The notes are unaffected.

## Private page passwords

Normally managed in the app (page menu → *Password & privacy*). To change one by
hand, edit the file in the Render Shell:

```sh
nano /opt/render/project/src/persistent/protected_pages.json
```

```json
{ "brody": "new-page-password", "elizabeth": "…" }
```

Changes take effect within about 2 seconds, with no restart. Invalid JSON is
ignored while the server runs (the previous passwords stay in effect and an error
is logged), but it stops the server from starting, so check it with
`node -e "require('/opt/render/project/src/persistent/protected_pages.json')"`.

## Backups

| Backup | What | Where |
| --- | --- | --- |
| **Full** (on demand) | The whole data directory: notes, history, trash, attachments, uploads, accounts (hashed), passwords, share links. Not the cookie secret or setup code | Settings → Admin → *Download full backup* (streams a zip) |
| **Daily** (automatic) | Notes, page metadata, attachments, accounts, passwords, share links. Not uploads, history or trash | `persistent/.noter/backups/noter-YYYY-MM-DD.zip`, newest 7 kept; download from Settings → Admin |
| **Render disk snapshots** | The whole disk | Render dashboard → noter → Disks |

The daily backups sit **on the same disk** as the data, so they protect against
mistakes, not against losing the disk. Download a full backup regularly (for
example monthly) and keep it somewhere else.

## Restoring

For a single page, use the app first:

- **Changed by mistake:** page menu → *History* → pick a version → *Restore*.
- **Deleted:** sidebar → *Trash* → *Restore* (within 30 days).

To restore files from a backup zip (Render Shell):

```sh
cd /opt/render/project/src/persistent
# 1. Get the zip onto the disk. Either use a daily backup that is already here:
ls .noter/backups/
#    …or upload a zip through Noter's Files page (it lands in uploads/).
# 2. Unpack it somewhere temporary:
mkdir -p /tmp/restore
unzip -o .noter/backups/noter-2026-09-22.zip -d /tmp/restore \
  || python3 -m zipfile -e .noter/backups/noter-2026-09-22.zip /tmp/restore
# 3a. Restore one page:
cp /tmp/restore/person_groceries.txt .
# 3b. …or everything (overwrites current files):
cp -a /tmp/restore/. .
```

Then **restart the service** so accounts and caches are reloaded.

Restoring onto a fresh disk works the same way. Because the cookie secret isn't in
backups, a new one is generated and everyone signs in again; accounts and
passwords come back from the backup.

## Security maintenance

- **Rotate the session secret** (if you suspect a leak): delete
  `persistent/.noter/secret`, or set a new `NOTER_SECRET`, and restart. Everyone
  is signed out.
- **Dependencies:** run `npm audit` and `npm outdated` now and then; update, run
  both test suites, then deploy.
- **Render account:** use a strong password and two-factor authentication. Anyone
  with Shell access can read all data.
- **Stuck at "Too many failed attempts":** the lock clears 15 minutes after the
  first failed attempt, or on restart.

## Monitoring

- **Logs:** Render → noter → Logs. The app logs startup, `protected_pages.json`
  reloads, backup failures and server errors (with stack traces; clients never see
  those).
- **Disk usage** (1 GB disk):

  ```sh
  du -sh /opt/render/project/src/persistent/{uploads,attachments,.noter/*} 2>/dev/null
  ```

  Uploads and attachments are the usual growth. History is capped at 200 versions
  per page, trash is purged after 30 days, and 7 daily backups are kept.
- **Memory:** one Node process; the merge cache is capped at 32 MB.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Everyone sees the setup screen | No accounts: a new disk, or `.noter/users.json` deleted | Use the setup code from the log, or restore `users.json` from a backup and restart |
| "Wrong username or password" for everyone | Accounts file replaced, or a wrong disk mounted | Check `.noter/users.json` exists; `node scripts/reset-password.js --list` |
| Everyone was signed out | Secret rotated or lost (e.g. restored onto a new disk), or passwords reset | Expected; sign in again |
| Can't sign in: "Too many attempts" | 10 wrong passwords from that IP in 15 minutes | Wait 15 minutes, or restart |
| Rate limit hits everyone at once | `TRUST_PROXY` not set, so every visitor looks like Render's proxy | Set `TRUST_PROXY=1` |
| Private page doesn't unlock after editing the JSON | Invalid JSON (the log shows "Could not reload") | Fix the file; check it with `node -e "require(...)"` |
| A save shows "Edited at the same time" | Two people changed the same lines | Pick *Keep both* if unsure; nothing is lost either way |
| Live updates don't appear | A network or proxy dropped the event stream | It reconnects on its own and catches up; reload if needed |
| Uploads fail with "File too large" | Over 50 MB | Raise `NOTER_MAX_UPLOAD_MB` (mind the disk size) |
| `502` right after a deploy | Instance switching over | Wait a few seconds |
| Server won't start: JSON error | Invalid `protected_pages.json` | Fix the JSON |

## Local development

```sh
npm install
NOTER_DATA_DIR=./dev-data npm start      # separate data from ./persistent
npm test                                  # API tests
npm install --no-save playwright && npx playwright install chromium
npm run test:e2e                          # browser test
```

The API tests create throwaway servers and data directories, so they never touch
your data. `test/helpers.js` creates a signed-in test client per person.
