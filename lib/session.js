const crypto = require('crypto');

const COOKIE_NAME = 'noter_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

// Stateless signed session cookie holding who is signed in and what this
// browser has unlocked:
//   { u: username, v: tokenVersion, p: { page: fingerprint }, f, a, e: expiresAt }
// Fingerprints tie each grant to the current password, and the token version
// ties the sign-in to the account, so changing either revokes access everywhere.
function createSessions(secret) {
  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  }

  function read(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const empty = { u: null, v: null, p: {}, f: null, a: null };
    if (!raw) return empty;
    const [payload, signature] = raw.split('.');
    if (!payload || !signature) return empty;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return empty;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
      if (!data || typeof data !== 'object' || !(data.e > Date.now())) return empty;
      const pages = Object.create(null);
      if (data.p && typeof data.p === 'object') {
        for (const [k, v] of Object.entries(data.p)) if (typeof v === 'string') pages[k] = v;
      }
      return {
        u: typeof data.u === 'string' ? data.u : null,
        v: typeof data.v === 'number' ? data.v : null,
        p: pages,
        f: typeof data.f === 'string' ? data.f : null,
        a: typeof data.a === 'string' ? data.a : null
      };
    } catch (err) {
      return empty;
    }
  }

  function write(req, res, session) {
    const hasGrants = session.u || Object.keys(session.p).length > 0 || session.f || session.a;
    const secure = req.secure ? '; Secure' : '';
    // Lax lets links from email/chat arrive signed in; writes are protected
    // separately by the X-Noter header and Origin checks.
    if (!hasGrants) {
      res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
      return;
    }
    const data = { p: session.p, e: Date.now() + MAX_AGE_MS };
    if (session.u) {
      data.u = session.u;
      data.v = session.v;
    }
    if (session.f) data.f = session.f;
    if (session.a) data.a = session.a;
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const value = `${payload}.${sign(payload)}`;
    res.append('Set-Cookie',
      `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure}`);
  }

  return { read, write };
}

module.exports = { createSessions, parseCookies, COOKIE_NAME };
