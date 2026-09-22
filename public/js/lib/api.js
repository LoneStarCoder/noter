import { identity } from './identity.js';

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.message) || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}

// JSON API helper. Adds the CSRF header and who-is-editing headers; throws
// ApiError for non-2xx responses and TypeError for network failures.
export async function api(method, url, body, options = {}) {
  const headers = {
    'X-Noter': '1',
    'X-Noter-User': encodeURIComponent(identity.name),
    'X-Noter-Client': identity.clientId,
    ...options.headers
  };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (options.raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = { message: text };
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const get = url => api('GET', url);
export const post = (url, body) => api('POST', url, body === undefined ? {} : body);
export const put = (url, body) => api('PUT', url, body);
export const del = url => api('DELETE', url);

export const pageUrl = name => `/api/pages/${encodeURIComponent(name)}`;
