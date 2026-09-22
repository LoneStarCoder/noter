#!/usr/bin/env node
// Account recovery from the command line (e.g. the Render Shell), for when
// nobody who is an admin can sign in.
//
//   node scripts/reset-password.js --list
//   node scripts/reset-password.js <username> <new-password> [--admin]
//
// Sets the password (creating the account if it doesn't exist) and, with
// --admin, makes it an admin. The running server keeps accounts in memory, so
// restart the service right afterwards for the change to take effect.
const path = require('path');
const { UserStore } = require('../lib/users');

const dataDir = process.env.NOTER_DATA_DIR || path.join(__dirname, '..', 'persistent');
const args = process.argv.slice(2);
const store = new UserStore(dataDir);

if (args[0] === '--list' || args.length === 0) {
  const people = store.list();
  if (!people.length) console.log(`No accounts in ${dataDir}. Open the site to run first-time setup.`);
  for (const p of people) console.log(`${p.username}\t${p.name}${p.admin ? '\t(admin)' : ''}`);
  if (args.length === 0) console.log('\nUsage: node scripts/reset-password.js <username> <new-password> [--admin]');
  process.exit(0);
}

const [username, password] = args;
const makeAdmin = args.includes('--admin');

try {
  if (store.get(username)) {
    store.setPassword(username, password);
    if (makeAdmin) store.update(username, { admin: true });
    console.log(`Password changed for ${username}${makeAdmin ? ' (admin)' : ''}.`);
  } else {
    store.addUser({ username, password, admin: makeAdmin });
    store.finishSetup(); // an account exists now: the first-run setup code is no longer needed
    console.log(`Created ${username}${makeAdmin ? ' (admin)' : ''}.`);
  }
  console.log('Now restart the service so the running server picks this up.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
