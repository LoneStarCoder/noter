// Sign-in page, and first-run setup when there are no accounts yet
import { get, post } from './lib/api.js';
import { identity } from './lib/identity.js';

const $ = id => document.getElementById(id);

// Only same-site paths are allowed as the place to return to
function nextUrl() {
  const next = new URLSearchParams(window.location.search).get('next') || '/';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

function done(user) {
  identity.name = user.name;
  window.location.replace(nextUrl());
}

function errorText(err) {
  if (err.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
  if (err instanceof TypeError) return 'Can’t reach the server. Check your connection.';
  return err.message;
}

async function start() {
  let status;
  try {
    status = await get('/api/auth/status');
  } catch (err) {
    $('login-form').hidden = false;
    $('login-error').textContent = errorText(err);
    return;
  }
  if (status.user) return done(status.user);
  const form = status.setupRequired ? $('setup-form') : $('login-form');
  form.hidden = false;
  form.querySelector('input').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('login-error');
  error.textContent = '';
  try {
    const result = await post('/api/auth/login', { username: $('login-username').value, password: $('login-password').value });
    done(result.user);
  } catch (err) {
    error.textContent = errorText(err);
    $('login-password').select();
  }
});

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('setup-error');
  error.textContent = '';
  try {
    const result = await post('/api/auth/setup', {
      code: $('setup-code').value,
      name: $('setup-name').value,
      username: $('setup-username').value,
      password: $('setup-password').value
    });
    done(result.user);
  } catch (err) {
    error.textContent = errorText(err);
  }
});

start();
