import fs from 'node:fs';
import path from 'node:path';
import { toStr } from './util.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path: p = '/' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=${sameSite}`;
  if (maxAge !== undefined) s += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  return s;
}

export async function readBody(req, limit = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Solicitud demasiado grande');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function parseBody(buf, contentType = '') {
  const text = buf.toString('utf8');
  if (!text) return {};
  if (contentType.includes('application/json')) {
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'JSON inválido'); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
      routes.push({ method, re, keys, handler });
    },
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { return null; }
        return { handler: r.handler, params };
      }
      return null;
    },
    hasPath(pathname) { return routes.some((r) => r.re.test(pathname)); },
  };
}

/* Respuestas */
export const resp = {
  html: (body, status = 200, headers = {}) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: toStr(body) }),
  text: (body, status = 200, headers = {}) => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body: String(body) }),
  json: (obj, status = 200) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) }),
  redirect: (location, status = 303) => ({ status, headers: { location }, body: '' }),
};

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

export function serveStatic(root, relPath) {
  const full = path.resolve(root, '.' + path.sep + relPath);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  let data;
  try { data = fs.readFileSync(full); } catch { return null; }
  const type = TYPES[path.extname(full)];
  if (!type) return null;
  return { status: 200, headers: { 'content-type': type, 'cache-control': 'public, max-age=300' }, body: data };
}

export function securityHeaders(secure) {
  const h = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'geolocation=(), camera=(), microphone=()',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  };
  if (secure) h['strict-transport-security'] = 'max-age=15552000; includeSubDomains';
  return h;
}

export function writeResponse(res, r, cookies, secure) {
  const headers = { ...securityHeaders(secure), ...r.headers };
  if (!headers['cache-control']) headers['cache-control'] = 'no-store';
  const body = r.body ?? '';
  headers['content-length'] = Buffer.byteLength(body);
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(r.status || 200, headers);
  res.end(body);
}
