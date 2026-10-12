import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createServices, HOUR } from './services.js';
import { createMessenger } from './messaging.js';
import { createWallet } from './wallet.js';
import { registerAdmin } from './admin.js';
import {
  HttpError, createRouter, parseCookies, serializeCookie, readBody, parseBody, resp, serveStatic, writeResponse,
} from './http.js';
import {
  html, randomToken, signPayload, verifyPayload, verifySecret, DUMMY_HASH, createLimiter,
} from './util.js';
import { joinPage, cardPage, infoPage, feedbackPage, staffLoginPage, staffPage, layout } from './views.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const YEAR = 365 * 24 * 3600;
const CARD_FLASH = new Set(['joined', 'welcome', 'reward']);
const STAFF_NOTES = { redeemed: ['notice', 'Premio canjeado ✅'], stamped: ['notice', 'Visita sumada ✅'], already: ['error', 'Ese premio ya había sido canjeado.'], missing: ['error', 'No se encontró el premio.'], cooldown: ['error', 'No se pudo sumar.'] };

export function createApp(opts = {}) {
  const secret = opts.secret;
  if (!secret || secret.length < 16) throw new Error('Falta SESSION_SECRET (mínimo 16 caracteres)');
  const baseUrl = (opts.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
  const secure = baseUrl.startsWith('https://');
  const clock = opts.now || Date.now;
  const log = opts.log || console;
  const db = opts.db || openDb(opts.dbFile || ':memory:');
  const svc = createServices({ db, baseUrl, secret });
  const wallet = createWallet({ ...(opts.wallet || {}), baseUrl, fetchImpl: opts.fetchImpl || fetch, log });
  const messenger = createMessenger({ svc, secret, fetchImpl: opts.fetchImpl || fetch, log, apiVersion: opts.waApiVersion });
  const limit = createLimiter(clock);
  const router = createRouter();
  const showLinks = Boolean(opts.devShowLinks);

  /* ---------- sesiones y CSRF ---------- */
  const h = {
    getSession(ctx, name) {
      const s = verifyPayload(ctx.cookies[name], secret, ctx.now);
      return s && s.role ? s : null;
    },
    startSession(ctx, name, role, orgId, ttlMs) {
      const s = { role, org: orgId, csrf: randomToken(16), exp: ctx.now + ttlMs };
      ctx.setCookie(name, signPayload(s, secret), { maxAge: ttlMs / 1000 });
      return s;
    },
    clearSession(ctx, name) { ctx.setCookie(name, '', { maxAge: 0 }); },
    csrfOk(session, token) {
      const a = Buffer.from(String(session.csrf)); const b = Buffer.from(String(token ?? ''));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };

  const notFound = () => resp.html(infoPage({ title: 'No encontrado', message: 'Este enlace no existe o ya no está activo.', brand: '#555555' }), 404);
  const cookieNames = (org) => ({ auth: `c_${org.id}`, dev: `d_${org.id}` });
  const setCustomerCookies = (ctx, org, { auth, dev }) => {
    const n = cookieNames(org);
    if (auth) ctx.setCookie(n.auth, auth, { maxAge: YEAR });
    if (dev) ctx.setCookie(n.dev, dev, { maxAge: YEAR });
  };

  /* ---------- páginas públicas ---------- */
  router.add('GET', '/', () => resp.html(layout({ title: 'NFC Lealtad', brand: '#444444', bodyClass: 'customer', body: html`<main class="wrap"><section class="card center"><h1>NFC Lealtad</h1><p>Programa de fidelización con chips NFC.</p><p><a href="/admin">Panel del restaurante</a></p></section></main>` })));
  router.add('GET', '/healthz', () => resp.json({ ok: true }));

  /* ---------- toque del chip ---------- */
  router.add('GET', '/t/:token', (ctx) => {
    if (!limit(`tap:${ctx.ip}`, 90, 60_000)) return resp.text('Demasiadas solicitudes', 429);
    const chip = svc.getChip(ctx.params.token);
    if (!chip) return notFound();
    const org = svc.getOrg(chip.org_id);
    const n = cookieNames(org);
    const deviceId = /^[\w-]{8,40}$/.test(ctx.cookies[n.dev] || '') ? ctx.cookies[n.dev] : randomToken(12);
    const customer = ctx.cookies[n.auth] ? svc.getCustomerByAuth(ctx.cookies[n.auth]) : null;

    if (customer && customer.org_id === org.id) {
      const r = svc.applyVisit(org, customer, { locationId: chip.location_id, chipId: chip.id, deviceId, now: ctx.now });
      setCustomerCookies(ctx, org, { dev: deviceId });
      let flash = 'stamped';
      if (!r.counted) flash = 'cooldown'; else if (r.newReward) flash = 'reward';
      if (r.counted && wallet.enabled) wallet.updateStamps(org, r.customer);
      return resp.html(renderCard(org, r.customer, flash, ctx.now, r.nextAt));
    }
    svc.recordPendingVisit(org, chip, deviceId, ctx.now);
    setCustomerCookies(ctx, org, { dev: deviceId });
    return resp.html(joinPage({ org, token: chip.token }));
  });

  function renderCard(org, customer, flash, now, nextAt) {
    const member = svc.memberCode(customer);
    return cardPage({
      org, customer, rewards: svc.pendingRewards(customer.id), flash, member,
      walletUrl: wallet.saveUrl(org, customer, member, now),
      hoursLeft: nextAt ? Math.max(1, Math.ceil((nextAt - now) / HOUR)) : 0,
    });
  }

  router.add('POST', '/t/:token/join', (ctx) => {
    if (!limit(`join:${ctx.ip}`, 12, 10 * 60_000)) return resp.text('Demasiados intentos. Espera unos minutos.', 429);
    const chip = svc.getChip(ctx.params.token);
    if (!chip) return notFound();
    const org = svc.getOrg(chip.org_id);
    if (ctx.body.website) return resp.html(infoPage({ org, title: '¡Listo!', message: 'Gracias.' })); // honeypot
    const n = cookieNames(org);
    const deviceId = /^[\w-]{8,40}$/.test(ctx.cookies[n.dev] || '') ? ctx.cookies[n.dev] : randomToken(12);
    const input = { name: ctx.body.name, phone: ctx.body.phone, birthday: ctx.body.birthday, consent: ctx.body.consent };
    const r = svc.registerCustomer(org, chip, input, deviceId, ctx.now);
    if (!r.ok) return resp.html(joinPage({ org, token: chip.token, values: { ...input }, errors: r.errors }), 400);
    setCustomerCookies(ctx, org, { dev: deviceId });
    if (r.existing) {
      svc.sendCardLink(org, r.customer, ctx.now);
      const extra = showLinks ? ` (modo desarrollo: ${baseUrl}/c/${r.customer.auth_token})` : '';
      return resp.html(infoPage({ org, title: 'Ya eres parte del club 🎉', message: `Te enviamos un enlace con tu tarjeta al WhatsApp registrado, para confirmar que eres tú.${extra}` }));
    }
    setCustomerCookies(ctx, org, { auth: r.customer.auth_token });
    return resp.redirect(`/c/${r.customer.auth_token}?n=${r.visit.newReward ? 'reward' : 'joined'}`);
  });

  router.add('GET', '/c/:auth', (ctx) => {
    if (!limit(`card:${ctx.ip}`, 120, 60_000)) return resp.text('Demasiadas solicitudes', 429);
    const customer = svc.getCustomerByAuth(ctx.params.auth);
    if (!customer) return notFound();
    const org = svc.getOrg(customer.org_id);
    setCustomerCookies(ctx, org, { auth: customer.auth_token });
    const flash = CARD_FLASH.has(ctx.query.n) ? ctx.query.n : '';
    return resp.html(renderCard(org, customer, flash, ctx.now));
  });

  /* ---------- opiniones ---------- */
  router.add('GET', '/fb/:auth', (ctx) => {
    const customer = svc.getCustomerByAuth(ctx.params.auth);
    if (!customer) return notFound();
    return resp.html(feedbackPage({ org: svc.getOrg(customer.org_id), customer }));
  });
  router.add('POST', '/fb/:auth', (ctx) => {
    if (!limit(`fb:${ctx.ip}`, 10, 10 * 60_000)) return resp.text('Demasiados intentos', 429);
    const customer = svc.getCustomerByAuth(ctx.params.auth);
    if (!customer) return notFound();
    const org = svc.getOrg(customer.org_id);
    const r = svc.submitFeedback(customer, ctx.body.rating, ctx.body.comment, ctx.now);
    if (!r.ok) return resp.html(feedbackPage({ org, customer, error: 'Elige una calificación de 1 a 5.' }), 400);
    return resp.html(feedbackPage({ org, customer, done: true }));
  });

  /* ---------- personal (caja/mesero) ---------- */
  const staffSession = (ctx, org) => {
    const s = h.getSession(ctx, 'stf');
    return s && s.role === 'staff' && s.org === org.id ? s : null;
  };
  const withStaffOrg = (fn) => (ctx) => {
    const org = svc.getOrgBySlug(ctx.params.slug);
    if (!org) return notFound();
    return fn(ctx, org);
  };
  router.add('GET', '/o/:slug/staff', withStaffOrg((ctx, org) => {
    const s = staffSession(ctx, org);
    if (!s) return resp.html(staffLoginPage({ org }));
    const q = String(ctx.query.q || '').slice(0, 60);
    const note = STAFF_NOTES[ctx.query.m];
    return resp.html(staffPage({
      org, csrf: s.csrf, q, results: q ? svc.findForStaff(org.id, q) : [],
      notice: note?.[0] === 'notice' ? note[1] : '', error: note?.[0] === 'error' ? note[1] : '',
    }));
  }));
  router.add('POST', '/o/:slug/staff/login', withStaffOrg((ctx, org) => {
    if (!limit(`pin:${ctx.ip}:${org.id}`, 8, 10 * 60_000)) return resp.html(staffLoginPage({ org, error: 'Demasiados intentos. Espera unos minutos.' }), 429);
    const ok = verifySecret(ctx.body.pin || '', org.staff_pin_hash || DUMMY_HASH);
    if (!ok) return resp.html(staffLoginPage({ org, error: 'PIN incorrecto.' }), 401);
    h.startSession(ctx, 'stf', 'staff', org.id, 12 * HOUR);
    return resp.redirect(`/o/${org.slug}/staff`);
  }));
  const staffPost = (fn) => withStaffOrg((ctx, org) => {
    const s = staffSession(ctx, org);
    if (!s) return resp.redirect(`/o/${org.slug}/staff`);
    if (!h.csrfOk(s, ctx.body._csrf)) return resp.text('Solicitud inválida (CSRF). Recarga la página.', 403);
    return fn(ctx, org);
  });
  const staffBack = (org, q, m) => resp.redirect(`/o/${org.slug}/staff?q=${encodeURIComponent(q || '')}&m=${m}`);
  router.add('POST', '/o/:slug/staff/redeem', staffPost((ctx, org) => {
    const r = svc.redeemReward(org.id, parseInt(ctx.body.reward_id, 10), ctx.now);
    return staffBack(org, ctx.body.q, r.ok ? 'redeemed' : (r.error.includes('ya fue') ? 'already' : 'missing'));
  }));
  router.add('POST', '/o/:slug/staff/stamp', staffPost((ctx, org) => {
    const c = svc.getCustomer(org.id, parseInt(ctx.body.customer_id, 10));
    if (!c) return staffBack(org, ctx.body.q, 'missing');
    const r = svc.applyVisit(org, c, { now: ctx.now, force: true, source: 'staff' });
    if (r.counted && wallet.enabled) wallet.updateStamps(org, r.customer);
    return staffBack(org, ctx.body.q, 'stamped');
  }));
  router.add('POST', '/o/:slug/staff/logout', staffPost((ctx, org) => {
    h.clearSession(ctx, 'stf');
    return resp.redirect(`/o/${org.slug}/staff`);
  }));

  /* ---------- WhatsApp: verificación y bajas (STOP/BAJA) ---------- */
  router.add('GET', '/webhook/whatsapp', (ctx) => {
    const q = ctx.query;
    if (opts.waVerifyToken && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === opts.waVerifyToken) return resp.text(q['hub.challenge'] || '');
    return resp.text('Prohibido', 403);
  });
  router.add('POST', '/webhook/whatsapp', (ctx) => {
    if (!opts.waAppSecret) return resp.text('Webhook no configurado', 503);
    const sig = String(ctx.req.headers['x-hub-signature-256'] || '');
    const expected = 'sha256=' + crypto.createHmac('sha256', opts.waAppSecret).update(ctx.rawBody).digest('hex');
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return resp.text('Firma inválida', 401);
    let changed = 0;
    for (const entry of ctx.body.entry || []) for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const phoneId = v.metadata?.phone_number_id;
      for (const m of v.messages || []) {
        const text = String(m.text?.body || '').trim().toLowerCase();
        if (/^(baja|stop|parar|cancelar|no mas|no más)$/.test(text)) changed += svc.optOutByPhone(String(phoneId), String(m.from));
      }
    }
    return resp.json({ ok: true, optedOut: changed });
  });

  registerAdmin({ router, svc, h, limit });

  /* ---------- despachador ---------- */
  async function handle(req, res) {
    const cookiesOut = [];
    let r;
    try {
      const url = new URL(req.url, baseUrl);
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const remote = req.socket.remoteAddress || '';
      const ip = opts.trustProxy ? (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || remote) : remote;
      if (url.pathname.startsWith('/static/')) {
        r = serveStatic(PUBLIC_DIR, url.pathname.slice('/static/'.length)) || notFound();
      } else {
        const m = router.match(method, url.pathname);
        if (!m) r = router.hasPath(url.pathname) ? resp.text('Método no permitido', 405) : notFound();
        else {
          let rawBody = Buffer.alloc(0); let body = {};
          if (method === 'POST') {
            rawBody = await readBody(req);
            body = parseBody(rawBody, String(req.headers['content-type'] || ''));
          }
          const ctx = {
            req, url, ip, body, rawBody, params: m.params, now: clock(),
            query: Object.fromEntries(url.searchParams), cookies: parseCookies(req.headers.cookie),
            setCookie: (n, v, o) => cookiesOut.push(serializeCookie(n, v, { secure, ...o })),
          };
          r = await m.handler(ctx);
        }
      }
    } catch (e) {
      if (e instanceof HttpError) r = resp.text(e.message, e.status);
      else { log.error?.('Error no controlado:', e); r = resp.text('Error interno', 500); }
    }
    if (req.method === 'HEAD') r = { ...r, body: '' };
    writeResponse(res, r, cookiesOut, secure);
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 15_000;
  let timer = null;

  return {
    server, handle, db, svc, messenger, wallet, clock,
    start(port = 3000, host = '0.0.0.0') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          timer = setInterval(() => { messenger.tick(clock()).catch((e) => log.error?.('tick', e)); }, 60_000);
          timer.unref();
          resolve(server.address());
        });
      });
    },
    async stop() { if (timer) clearInterval(timer); await new Promise((r) => server.close(r)); server.closeAllConnections?.(); },
  };
}
