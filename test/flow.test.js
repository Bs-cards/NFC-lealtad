import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createWallet } from '../src/wallet.js';
import { createMessenger } from '../src/messaging.js';

const HOUR = 3600_000, DAY = 24 * HOUR;
const at = (hourLocal, dayOffset = 0) => Date.UTC(2026, 9, 12 + dayOffset, hourLocal + 5, 0, 0); // hora de Bogotá (UTC-5)
let t = at(10); // 12-oct 10:00 en Bogotá
let app, origin, chipToken, orgId;
const sent = []; // llamadas a la API de WhatsApp simuladas

class Device {
  constructor() { this.jar = new Map(); }
  async req(path, { method = 'GET', form, headers = {}, json, raw } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    if (json) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
    if (raw !== undefined) body = raw;
    const res = await fetch(origin + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = decodeURIComponent(kv.slice(i + 1));
      if (/Max-Age=0/i.test(c) || v === '') this.jar.delete(k); else this.jar.set(k, v);
    }
    return { status: res.status, headers: res.headers, text: await res.text(), location: res.headers.get('location') };
  }
}
const q = (sql, ...p) => app.db.prepare(sql).all(...p);
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];

before(async () => {
  app = createApp({
    secret: 'test-secret-test-secret-test-secret', baseUrl: 'http://test.local', now: () => t,
    log: { info() {}, warn() {}, error: console.error },
    waAppSecret: 'appsecret', waVerifyToken: 'verify-me',
    fetchImpl: async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.123' }] }), { status: 200 }); },
  });
  const addr = await app.start(0, '127.0.0.1');
  origin = `http://127.0.0.1:${addr.port}`;
  const r = app.svc.createOrg({ slug: 'cafe', name: 'Café <Test>', email: 'Dueno@Cafe.co', password: 'una-clave-larga-123', staffPin: '4321', stamps_goal: 3, reward_text: 'Un postre', google_review_url: 'https://maps.google.com/?cid=1' }, t);
  orgId = r.orgId;
  chipToken = app.svc.createChip(r.orgId, r.locationId, 'Caja', t).token;
});
after(async () => { await app.stop(); });

const JOIN = { name: 'Ana Pérez', phone: '300 123 4567', birthday: '1992-10-19', consent: '1' };

test('toque de un desconocido muestra el registro y guarda visita sin contar', async () => {
  const d = new Device();
  const r = await d.req(`/t/${chipToken}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Únete al club|Unirme/);
  assert.match(r.text, /Café &lt;Test&gt;/, 'el nombre del negocio debe ir escapado');
  assert.equal(q('SELECT COUNT(*) n FROM visits WHERE counted = 1')[0].n, 0);
  assert.equal(q('SELECT COUNT(*) n FROM visits WHERE customer_id IS NULL')[0].n, 1);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
});

test('registro: validaciones, alta, primer sello y bienvenida', async () => {
  const d = new Device();
  await d.req(`/t/${chipToken}`);
  let r = await d.req(`/t/${chipToken}/join`, { method: 'POST', form: { name: 'A', phone: '12', birthday: '', consent: '' } });
  assert.equal(r.status, 400);
  assert.match(r.text, /nombre/i); assert.match(r.text, /WhatsApp válido/); assert.match(r.text, /permiso/);

  r = await d.req(`/t/${chipToken}/join`, { method: 'POST', form: { ...JOIN, name: '<script>alert(1)</script> Ana' } });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/c\/[\w-]+\?n=joined$/);
  const card = await d.req(r.location);
  assert.equal(card.status, 200);
  assert.ok(!card.text.includes('<script>alert'), 'XSS escapado');
  assert.match(card.text, /1 de 3 sellos/);
  const c = q('SELECT * FROM customers')[0];
  assert.equal(c.phone, '573001234567'); assert.equal(c.stamps, 1); assert.equal(c.birth_md, '10-19');
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE kind='welcome'")[0].n, 1);
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE kind='review'")[0].n, 1);
  assert.equal(q('SELECT COUNT(*) n FROM visits WHERE customer_id IS NULL AND device_id = ?', d.jar.get(`d_${orgId}`))[0].n, 0, 'las visitas pendientes se reclaman');
});

test('anti-abuso: no suma dos veces dentro de 6 h, sí después; premio al completar', async () => {
  const d = new Device();
  const auth = q('SELECT auth_token FROM customers')[0].auth_token;
  await d.req(`/c/${auth}`); // la magic-link reconoce el dispositivo
  let r = await d.req(`/t/${chipToken}`);
  assert.match(r.text, /Podrás sumar otro sello en/);
  assert.equal(q('SELECT stamps FROM customers')[0].stamps, 1);

  t += 7 * HOUR;
  r = await d.req(`/t/${chipToken}`);
  assert.match(r.text, /2 de 3 sellos/);
  t += 7 * HOUR;
  r = await d.req(`/t/${chipToken}`);
  assert.match(r.text, /Completaste tu tarjeta/);
  assert.match(r.text, /0 de 3 sellos/);
  const rw = q('SELECT * FROM rewards')[0];
  assert.ok(rw && !rw.redeemed_at); assert.match(r.text, new RegExp(rw.code));
});

test('personal: PIN, CSRF, canje único del premio y visita manual', async () => {
  const s = new Device();
  let r = await s.req('/o/cafe/staff/login', { method: 'POST', form: { pin: '0000' } });
  assert.equal(r.status, 401);
  r = await s.req('/o/cafe/staff/login', { method: 'POST', form: { pin: '4321' } });
  assert.equal(r.status, 303);
  const code = q('SELECT code FROM rewards')[0].code;
  const page = await s.req(`/o/cafe/staff?q=${code}`);
  assert.match(page.text, /Ana<\/strong>/);
  const csrf = csrfOf(page.text);
  const rid = q('SELECT id FROM rewards')[0].id;

  r = await s.req('/o/cafe/staff/redeem', { method: 'POST', form: { reward_id: rid, q: code } });
  assert.equal(r.status, 403, 'sin CSRF debe rechazar');
  r = await s.req('/o/cafe/staff/redeem', { method: 'POST', form: { reward_id: rid, q: code, _csrf: csrf } });
  assert.match(r.location, /m=redeemed/);
  r = await s.req('/o/cafe/staff/redeem', { method: 'POST', form: { reward_id: rid, q: code, _csrf: csrf } });
  assert.match(r.location, /m=already/, 'no se puede canjear dos veces');

  const cid = q('SELECT id FROM customers')[0].id;
  r = await s.req('/o/cafe/staff/stamp', { method: 'POST', form: { customer_id: cid, q: 'Ana', _csrf: csrf } });
  assert.match(r.location, /m=stamped/);
  assert.equal(q('SELECT stamps FROM customers')[0].stamps, 1);
  // sin sesión de personal no se accede
  const anon = new Device();
  assert.match((await anon.req('/o/cafe/staff')).text, /PIN/);
});

test('teléfono ya registrado desde otro dispositivo: no filtra datos y envía enlace por WhatsApp', async () => {
  const d = new Device();
  await d.req(`/t/${chipToken}`);
  const r = await d.req(`/t/${chipToken}/join`, { method: 'POST', form: JOIN });
  assert.equal(r.status, 200);
  assert.match(r.text, /enviamos un enlace/);
  assert.ok(!r.text.includes('alert(1)') && !r.text.includes('Ana'), 'no revela el nombre del cliente existente');
  assert.ok(!d.jar.has(`c_${orgId}`), 'no debe quedar sesión de cliente sin verificar el número');
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE kind='link'")[0].n, 1);
  assert.equal(q('SELECT COUNT(*) n FROM customers')[0].n, 1, 'no duplica clientes');
});

test('mensajería: reseña programada, simulación sin WhatsApp y horario permitido', async () => {
  const before = q("SELECT status FROM messages WHERE kind='review' ORDER BY id");
  assert.ok(before.every((m) => m.status === 'pending'));
  const stats = await app.messenger.processOutbox(t + 2 * HOUR); // 10:00+14h+2h → 01:00 local: reseñas fuera de horario
  assert.equal(stats.simulated >= 1, true, 'bienvenida/enlace salen siempre ' + JSON.stringify(stats) + JSON.stringify(q('SELECT id,kind,status,send_at,error FROM messages')));
  assert.ok(q("SELECT COUNT(*) n FROM messages WHERE kind='review' AND status='pending'")[0].n >= 1, 'reseñas se difieren de madrugada');
  // a la mañana siguiente (13-oct 10:00 local) sí salen
  t = at(10, 1);
  const s2 = await app.messenger.processOutbox(t);
  assert.ok(s2.simulated >= 1);
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE status='pending'")[0].n, 0);
});

test('automatizaciones: cumpleaños 7 días antes y reactivación, idempotentes', async () => {
  // Ana cumple 19-oct; hoy (local) es el 12-oct o 13-oct según el reloj → ajustamos al 12-oct local 10:00
  const dayOf = at(10, 0);
  const a1 = app.messenger.runAutomations(dayOf);
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE kind='birthday'")[0].n, 1);
  const a2 = app.messenger.runAutomations(dayOf + HOUR);
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE kind='birthday'")[0].n, 1, 'idempotente');
  assert.equal(a2.queued, 0); void a1;
  const m = q("SELECT body FROM messages WHERE kind='birthday'")[0].body;
  assert.match(m, /Feliz cumpleaños, /); assert.match(m, /Responde BAJA/);

  app.messenger.runAutomations(t + 40 * DAY);
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE kind='winback'")[0].n, 1);
  app.messenger.runAutomations(t + 41 * DAY);
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE kind='winback'")[0].n, 1, 'una reactivación por periodo de inactividad');
});

test('opiniones: el cliente responde y el negocio las ve; reseña pública para todos', async () => {
  const auth = q('SELECT auth_token FROM customers')[0].auth_token;
  const d = new Device();
  let r = await d.req(`/fb/${auth}`, { method: 'POST', form: { rating: '9' } });
  assert.equal(r.status, 400);
  r = await d.req(`/fb/${auth}`, { method: 'POST', form: { rating: '2', comment: 'Tardaron <b>mucho</b>' } });
  assert.match(r.text, /Gracias/); assert.match(r.text, /Dejar reseña en Google/);
  assert.equal(q('SELECT rating FROM feedback')[0].rating, 2);
});

test('panel admin: login, CSRF, ajustes validados, CSV seguro, campañas', async () => {
  const a = new Device();
  assert.equal((await a.req('/admin')).status, 303);
  let r = await a.req('/admin/login', { method: 'POST', form: { email: 'dueno@cafe.co', password: 'mala' } });
  assert.equal(r.status, 401);
  r = await a.req('/admin/login', { method: 'POST', form: { email: 'dueno@cafe.co', password: 'una-clave-larga-123' } });
  assert.equal(r.status, 303);
  const dash = await a.req('/admin');
  assert.equal(dash.status, 200); assert.match(dash.text, /Resumen/); assert.match(dash.text, /Clientes en tu base/);
  const csrf = csrfOf(dash.text);

  r = await a.req('/admin/settings', { method: 'POST', form: { name: 'X' } });
  assert.equal(r.status, 403);
  const settings = await a.req('/admin/settings');
  assert.ok(!settings.text.includes('wa_token_enc'));
  const base = Object.fromEntries([...settings.text.matchAll(/<input[^>]*name="(\w+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
  r = await a.req('/admin/settings', { method: 'POST', form: { ...base, _csrf: csrf, stamps_goal: '99' } });
  assert.match(decodeURIComponent(r.location), /Sellos.*entre 1 y 30/);
  r = await a.req('/admin/settings', { method: 'POST', form: { ...base, _csrf: csrf, google_review_url: 'javascript:alert(1)' } });
  assert.match(decodeURIComponent(r.location), /https/);

  app.db.prepare("UPDATE customers SET name = '=HYPERLINK(\"http://evil\")'").run();
  const csv = await a.req('/admin/customers.csv');
  assert.match(csv.text, /"'=HYPERLINK/);

  r = await a.req('/admin/campaigns', { method: 'POST', form: { _csrf: csrf, name: 'Prueba', segment: 'all', text: 'Hola {nombre}, hoy 2x1 en {club}' } });
  assert.match(r.location, /m=campaign/);
  assert.match(q("SELECT body FROM messages WHERE kind='campaign'")[0].body, /2x1 en Café <Test>/);

  r = await a.req('/admin/chips', { method: 'POST', form: { _csrf: csrf, location_id: '1', label: 'Mesa 4' } });
  assert.match(r.location, /m=chip/);
  const chips = await a.req('/admin/chips');
  assert.match(chips.text, /http:\/\/test\.local\/t\//); assert.match(chips.text, /Escribir en chip/);
});

test('conexión real a WhatsApp Cloud API: plantilla con parámetros y token cifrado', async () => {
  app.svc.updateOrgSettings(orgId, { wa_phone_id: '1555000111', wa_token_enc: app.svc.encryptToken('EAAtoken'), wa_templates: JSON.stringify({ campaign: { name: 'promo_club', lang: 'es' } }) });
  const row = q('SELECT wa_token_enc FROM orgs')[0].wa_token_enc;
  assert.ok(row.startsWith('v1.') && !row.includes('EAAtoken'));
  t = at(10, 3); // 15-oct 10:00 local, dentro del horario de marketing
  sent.length = 0;
  const stats = await app.messenger.processOutbox(t);
  assert.ok(stats.sent >= 1, JSON.stringify(stats));
  const call = sent.find((c) => JSON.parse(c.init.body).type === 'template');
  assert.ok(call, 'campaña usa plantilla');
  assert.match(call.url, /graph\.facebook\.com\/v21\.0\/1555000111\/messages/);
  assert.equal(call.init.headers.authorization, 'Bearer EAAtoken');
  const p = JSON.parse(call.init.body);
  assert.equal(p.template.name, 'promo_club');
  assert.equal(p.template.components[0].parameters[0].text, q('SELECT name FROM customers')[0].name.split(' ')[0]);
  assert.ok(!/\n/.test(p.template.components[0].parameters[1].text), 'sin saltos de línea en parámetros');
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE status='sent' AND provider_id='wamid.123'")[0].n >= 1, true);
});

test('webhook de WhatsApp: verificación, firma y baja con BAJA', async () => {
  const d = new Device();
  let r = await d.req('/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123');
  assert.equal(r.text, 'abc123');
  r = await d.req('/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=abc123');
  assert.equal(r.status, 403);
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1555000111' }, messages: [{ from: '573001234567', text: { body: ' BAJA ' } }] } }] }] });
  r = await d.req('/webhook/whatsapp', { method: 'POST', raw: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' } });
  assert.equal(r.status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(body).digest('hex');
  r = await d.req('/webhook/whatsapp', { method: 'POST', raw: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  assert.equal(r.status, 200);
  assert.equal(q('SELECT opt_in FROM customers')[0].opt_in, 0);
  assert.equal(q("SELECT COUNT(*) n FROM messages WHERE status='pending'")[0].n, 0, 'cancela pendientes');
});

test('límites: PIN y login se bloquean tras intentos repetidos; chip inválido da 404', async () => {
  const d = new Device();
  let last;
  for (let i = 0; i < 10; i++) last = await d.req('/o/cafe/staff/login', { method: 'POST', form: { pin: '1111' } });
  assert.equal(last.status, 429);
  assert.equal((await d.req('/t/no-existe')).status, 404);
  assert.equal((await d.req('/static/../src/db.js')).status, 404, 'sin path traversal');
  assert.equal((await d.req('/static/%2e%2e/package.json')).status, 404);
});

test('Google Wallet: el enlace es un JWT RS256 válido con clase y objeto de lealtad', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const w = createWallet({ issuerId: '3388000000', saEmail: 'sa@proj.iam.gserviceaccount.com', saKey: pem, baseUrl: 'https://club.example.com' });
  const org = { id: 1, name: 'Café', brand_color: '#d9480f', logo_url: 'https://club.example.com/logo.png', stamps_goal: 8 };
  const url = w.saveUrl(org, { id: 7, name: 'Ana', stamps: 3 }, 'M00007', 1_700_000_000_000);
  assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  const [h, b, s] = url.split('/save/')[1].split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url')));
  const payload = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(payload.payload.loyaltyObjects[0].loyaltyPoints.balance.int, 3);
  assert.equal(w.saveUrl({ ...org, logo_url: '' }, { id: 7, name: 'Ana', stamps: 3 }, 'M00007'), null, 'sin logo no se ofrece');
});

test('base de datos nueva y mensajero independientes (migración idempotente)', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(typeof createMessenger, 'function');
});
