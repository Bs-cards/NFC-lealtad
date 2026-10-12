import crypto from 'node:crypto';

/* ---------- HTML seguro (auto-escape) ---------- */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s ?? ''));

function render(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}
export const toStr = render;

/** Plantilla etiquetada: todo valor interpolado se escapa salvo que sea raw()/html``. */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Raw(out);
}

/* ---------- Tokens y códigos ---------- */
export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos, sin I/O/0/1
export function randomCode(len = 6) {
  const b = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

/* ---------- Contraseñas / PIN (scrypt) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(secret), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
export function verifySecret(secret, stored) {
  try {
    const [alg, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(h, 'base64url');
    const got = crypto.scryptSync(String(secret), Buffer.from(s, 'base64url'), expected.length, SCRYPT);
    return crypto.timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}
export const DUMMY_HASH = hashSecret('dummy-' + crypto.randomBytes(8).toString('hex'));

/* ---------- Firma de cookies/sesiones (HMAC) ---------- */
export function signPayload(obj, secret) {
  const body = b64u(JSON.stringify(obj));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}
export function verifyPayload(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1), 'base64url');
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (obj.exp && obj.exp < now) return null;
    return obj;
  } catch {
    return null;
  }
}

/* ---------- Cifrado de secretos en reposo (AES-256-GCM) ---------- */
const encKey = (secret) => crypto.createHash('sha256').update('enc:' + secret).digest();
export function encrypt(text, secret) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(secret), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1.' + b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}
export function decrypt(blob, secret) {
  if (!blob || !blob.startsWith('v1.')) return '';
  try {
    const buf = Buffer.from(blob.slice(3), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(secret), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/* ---------- Validación y normalización ---------- */
export function normalizePhone(input, countryCode = '57') {
  let s = String(input ?? '').trim();
  const hasPlus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!hasPlus) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.length <= 10) d = String(countryCode) + d.replace(/^0+/, '');
  }
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export function cleanName(input) {
  const s = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 60 ? s : null;
}
export const firstName = (name) => String(name ?? '').trim().split(' ')[0] || '';

/** 'YYYY-MM-DD' (año opcional '0000' o vacío) → { md:'MM-DD', year } | null */
export function parseBirthday(input) {
  const s = String(input ?? '').trim();
  if (!s) return { md: null, year: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, da] = m;
  const month = +mo, day = +da;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > dim) return null;
  const year = +y;
  if (year !== 0 && (year < 1900 || year > new Date().getUTCFullYear())) return null;
  return { md: `${mo}-${da}`, year: year || null };
}

export const safeColor = (c, fallback = '#d9480f') => (/^#[0-9a-fA-F]{6}$/.test(String(c)) ? c : fallback);

export function safeHttpsUrl(u) {
  const s = String(u ?? '').trim();
  if (!s) return '';
  try {
    const url = new URL(s);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/* ---------- Fechas en zona horaria del negocio ---------- */
export function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, md: `${p.month}-${p.day}`, ymd: `${p.year}-${p.month}-${p.day}` };
}

/* ---------- Texto con {variables} ---------- */
export const fill = (text, vars) => String(text ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));

/* ---------- CSV seguro (evita inyección de fórmulas) ---------- */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ---------- Limitador de tasa en memoria ---------- */
export function createLimiter(clock = Date.now) {
  const hits = new Map();
  return function hit(key, max, windowMs) {
    const now = clock();
    let e = hits.get(key);
    if (!e || e.reset <= now) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
    e.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    return e.n <= max;
  };
}
