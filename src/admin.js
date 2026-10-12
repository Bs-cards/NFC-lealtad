import { html } from './util.js';
import {
  hashSecret, verifySecret, DUMMY_HASH, csvCell, safeColor, safeHttpsUrl, validTimezone,
} from './util.js';
import { resp } from './http.js';
import { adminLayout, adminLoginPage } from './views.js';

const FLASH = {
  saved: ['ok', 'Cambios guardados.'], chip: ['ok', 'Chip creado. Cópialo o escríbelo en la etiqueta NFC.'],
  loc: ['ok', 'Sucursal creada.'], toggled: ['ok', 'Chip actualizado.'], campaign: ['ok', 'Campaña programada: los mensajes saldrán dentro del horario permitido.'],
};
const STATUS_ES = { pending: 'pendiente', sent: 'enviado', simulated: 'simulado (sin WhatsApp conectado)', failed: 'falló', skipped: 'omitido', cancelled: 'cancelado' };
const KIND_ES = { welcome: 'Bienvenida', review: 'Reseña', birthday: 'Cumpleaños', winback: 'Reactivación', link: 'Enlace', campaign: 'Campaña' };
const fmt = (ms, tz) => (ms ? new Date(ms).toLocaleString('es-CO', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '—');
const TEMPLATE_KINDS = ['welcome', 'review', 'birthday', 'winback', 'link', 'campaign'];

export function registerAdmin({ router, svc, h, limit }) {
  const flashOf = (ctx) => {
    const f = FLASH[ctx.query.m];
    if (f) return { type: f[0], text: f[1] };
    if (ctx.query.e) return { type: 'error', text: String(ctx.query.e).slice(0, 200) };
    return null;
  };
  const back = (path, m) => resp.redirect(`${path}?m=${m}`);
  const backErr = (path, e) => resp.redirect(`${path}?e=${encodeURIComponent(e)}`);

  const guard = (fn) => (ctx) => {
    const s = h.getSession(ctx, 'adm');
    if (!s || s.role !== 'admin') return resp.redirect('/admin/login');
    const org = svc.getOrg(s.org);
    if (!org) return resp.redirect('/admin/login');
    if (ctx.req.method === 'POST' && !h.csrfOk(s, ctx.body._csrf)) return resp.text('Solicitud inválida (CSRF). Recarga la página.', 403);
    return fn(ctx, org, s);
  };
  const page = (ctx, org, s, active, title, body, scripts) =>
    resp.html(adminLayout({ org, active, title, body, csrf: s.csrf, flash: flashOf(ctx), scripts }));

  /* ---------- login ---------- */
  router.add('GET', '/admin/login', (ctx) => (h.getSession(ctx, 'adm') ? resp.redirect('/admin') : resp.html(adminLoginPage({}))));
  router.add('POST', '/admin/login', (ctx) => {
    if (!limit(`login:${ctx.ip}`, 8, 10 * 60_000)) return resp.html(adminLoginPage({ error: 'Demasiados intentos. Espera unos minutos.' }), 429);
    const org = svc.getOrgByEmail(ctx.body.email || '');
    const ok = verifySecret(ctx.body.password || '', org ? org.admin_hash : DUMMY_HASH);
    if (!org || !ok) return resp.html(adminLoginPage({ error: 'Correo o contraseña incorrectos.' }), 401);
    h.startSession(ctx, 'adm', 'admin', org.id, 12 * 3600_000);
    return resp.redirect('/admin');
  });
  router.add('POST', '/admin/logout', (ctx) => {
    h.clearSession(ctx, 'adm');
    return resp.redirect('/admin/login');
  });

  /* ---------- resumen ---------- */
  router.add('GET', '/admin', guard((ctx, org, s) => {
    const d = svc.dashboard(org, ctx.now);
    const max = Math.max(1, ...d.daily.map((x) => x.count));
    const sentBy = (kind) => d.msgs.filter((m) => m.kind === kind && ['sent', 'simulated'].includes(m.status)).reduce((a, m) => a + m.n, 0);
    const tile = (n, label) => html`<div class="tile"><b>${n}</b><span>${label}</span></div>`;
    const body = html`<div class="tiles">
      ${tile(d.customers, 'Clientes en tu base')}${tile(d.new30, 'Nuevos (30 días)')}${tile(d.visits30, 'Visitas (30 días)')}
      ${tile(d.active30, 'Clientes activos (30 días)')}${tile(d.repeatRate + '%', 'Han vuelto al menos 1 vez')}
      ${tile(d.rewardsPending, 'Premios por canjear')}${tile(d.rewardsRedeemed30, 'Premios canjeados (30 días)')}
      ${tile(d.inactive, `Inactivos (+${org.winback_days} días)`)}</div>
      <section class="box"><h2>Visitas por día (14 días)</h2>
        <div class="bars">${d.daily.map((x) => html`<div class="bar" title="${x.day}: ${x.count}"><i style="height:${Math.round((x.count / max) * 100)}%"></i><small>${x.day.slice(8)}</small></div>`)}</div></section>
      <section class="box"><h2>Automatizaciones (30 días)</h2>
        <p>Bienvenidas: <b>${sentBy('welcome')}</b> · Pedidos de opinión: <b>${sentBy('review')}</b> · Cumpleaños: <b>${sentBy('birthday')}</b> · Reactivación: <b>${sentBy('winback')}</b> · Campañas: <b>${sentBy('campaign')}</b></p>
        <p>Opiniones recibidas: <b>${d.feedbackCount}</b>${d.feedbackAvg ? html` · Promedio: <b>${d.feedbackAvg} ★</b>` : ''}</p></section>`;
    return page(ctx, org, s, 'dashboard', 'Resumen', body);
  }));

  /* ---------- clientes ---------- */
  router.add('GET', '/admin/customers', guard((ctx, org, s) => {
    const pg = Math.max(1, parseInt(ctx.query.page, 10) || 1);
    const { total, rows } = svc.listCustomers(org.id, ctx.query.q, pg);
    const qs = (p) => `?q=${encodeURIComponent(ctx.query.q || '')}&page=${p}`;
    const body = html`<form method="get" class="inline"><input name="q" value="${ctx.query.q || ''}" placeholder="Buscar por nombre o teléfono"><button class="btn small" type="submit">Buscar</button>
      <a class="btn ghost small" href="/admin/customers.csv">Exportar CSV</a></form>
      <p class="tiny">${total} cliente(s)</p>
      <div class="scroll"><table><thead><tr><th>Nombre</th><th>WhatsApp</th><th>Cumpleaños</th><th>Sellos</th><th>Visitas</th><th>Última visita</th><th>WhatsApp</th></tr></thead><tbody>
      ${rows.map((c) => html`<tr><td>${c.name}</td><td>+${c.phone}</td><td>${c.birth_md || '—'}</td><td>${c.stamps}/${org.stamps_goal}</td><td>${c.total_visits}</td><td>${fmt(c.last_visit_at, org.timezone)}</td><td>${c.opt_in ? 'Acepta' : 'Dado de baja'}</td></tr>`)}
      </tbody></table></div>
      <p class="row">${pg > 1 ? html`<a href="${qs(pg - 1)}">← Anterior</a>` : html`<span></span>`}${pg * 50 < total ? html`<a href="${qs(pg + 1)}">Siguiente →</a>` : ''}</p>`;
    return page(ctx, org, s, 'customers', 'Clientes', body);
  }));

  router.add('GET', '/admin/customers.csv', guard((ctx, org) => {
    const { rows } = svc.listCustomers(org.id, '', 1, 100000);
    const head = ['nombre', 'whatsapp', 'cumpleanos', 'sellos', 'visitas', 'premios_ganados', 'ultima_visita', 'acepta_whatsapp', 'registrado'];
    const lines = [head.join(',')].concat(rows.map((c) => [
      c.name, '+' + c.phone, c.birth_md || '', c.stamps, c.total_visits, c.rewards_earned,
      c.last_visit_at ? new Date(c.last_visit_at).toISOString() : '', c.opt_in ? 'si' : 'no', new Date(c.created_at).toISOString(),
    ].map(csvCell).join(',')));
    return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="clientes.csv"' }, body: '﻿' + lines.join('\r\n') + '\r\n' };
  }));

  /* ---------- chips y sucursales ---------- */
  router.add('GET', '/admin/chips', guard((ctx, org, s) => {
    const locs = svc.all('SELECT * FROM locations WHERE org_id = ? ORDER BY id', org.id);
    const chips = svc.all(`SELECT c.*, l.name AS loc FROM chips c JOIN locations l ON l.id = c.location_id WHERE c.org_id = ? ORDER BY c.id DESC`, org.id);
    const counts = Object.fromEntries(svc.all('SELECT chip_id, COUNT(*) AS n FROM visits WHERE org_id = ? GROUP BY chip_id', org.id).map((r) => [r.chip_id, r.n]));
    const body = html`
      <section class="box"><h2>Nuevo chip</h2>
      <form method="post" action="/admin/chips" class="inline"><input type="hidden" name="_csrf" value="${s.csrf}">
        <select name="location_id">${locs.map((l) => html`<option value="${l.id}">${l.name}</option>`)}</select>
        <input name="label" placeholder="Etiqueta (ej. Caja, Mesa 4, Barra)" maxlength="60"><button class="btn small" type="submit">Crear chip</button></form></section>
      <section class="box"><h2>Tus chips</h2><div class="scroll"><table><thead><tr><th>Sucursal</th><th>Etiqueta</th><th>Enlace para el chip</th><th>Toques</th><th></th></tr></thead><tbody>
      ${chips.map((c) => html`<tr class="${c.active ? '' : 'off'}"><td>${c.loc}</td><td>${c.label || '—'}</td>
        <td><code>${svc.chipUrl(c.token)}</code></td><td>${counts[c.id] || 0}</td>
        <td class="actions"><button class="btn small ghost copy" type="button" data-url="${svc.chipUrl(c.token)}">Copiar</button>
          <button class="btn small write-nfc" type="button" data-url="${svc.chipUrl(c.token)}">Escribir en chip</button>
          <form method="post" action="/admin/chips/${c.id}/toggle"><input type="hidden" name="_csrf" value="${s.csrf}"><button class="link" type="submit">${c.active ? 'Desactivar' : 'Activar'}</button></form></td></tr>`)}
      </tbody></table></div>
      <p class="tiny" id="nfc-status">“Escribir en chip” funciona en Android con Chrome. En iPhone usa la app gratuita NFC Tools (Escribir → Registro → URL/URI) con el enlace copiado.</p></section>
      <section class="box"><h2>Sucursales</h2><ul>${locs.map((l) => html`<li>${l.name}</li>`)}</ul>
      <form method="post" action="/admin/locations" class="inline"><input type="hidden" name="_csrf" value="${s.csrf}"><input name="name" placeholder="Nueva sucursal" maxlength="60" required><button class="btn small" type="submit">Agregar</button></form>
      <p class="tiny">Todas las sucursales comparten la misma tarjeta: los clientes suman y canjean en cualquiera.</p></section>`;
    return page(ctx, org, s, 'chips', 'Chips NFC', body, ['/static/app.js']);
  }));
  router.add('POST', '/admin/chips', guard((ctx, org) => {
    try { svc.createChip(org.id, parseInt(ctx.body.location_id, 10), ctx.body.label, ctx.now); } catch (e) { return backErr('/admin/chips', e.message); }
    return back('/admin/chips', 'chip');
  }));
  router.add('POST', '/admin/chips/:id/toggle', guard((ctx, org) => {
    svc.run('UPDATE chips SET active = 1 - active WHERE id = ? AND org_id = ?', parseInt(ctx.params.id, 10), org.id);
    return back('/admin/chips', 'toggled');
  }));
  router.add('POST', '/admin/locations', guard((ctx, org) => {
    const name = String(ctx.body.name || '').trim().slice(0, 60);
    if (name.length < 2) return backErr('/admin/chips', 'Escribe el nombre de la sucursal.');
    svc.run('INSERT INTO locations(org_id,name,created_at) VALUES (?,?,?)', org.id, name, ctx.now);
    return back('/admin/chips', 'loc');
  }));

  /* ---------- campañas ---------- */
  router.add('GET', '/admin/campaigns', guard((ctx, org, s) => {
    const camps = svc.all('SELECT * FROM campaigns WHERE org_id = ? ORDER BY id DESC LIMIT 30', org.id);
    const body = html`<section class="box"><h2>Nueva campaña de WhatsApp</h2>
      <form method="post" action="/admin/campaigns" class="stack"><input type="hidden" name="_csrf" value="${s.csrf}">
        <label class="field"><span>Nombre interno</span><input name="name" maxlength="80" required></label>
        <label class="field"><span>¿A quién?</span><select name="segment">${Object.entries(svc.SEGMENTS).map(([k, label]) => html`<option value="${k}">${label} (${svc.segmentCustomers(org, k, ctx.now).length})</option>`)}</select></label>
        <label class="field"><span>Mensaje — puedes usar {nombre}, {club}, {tarjeta}</span><textarea name="text" rows="5" maxlength="900" required></textarea></label>
        <p class="tiny">Solo se envía a clientes que aceptaron WhatsApp, entre 9:00 y 21:00 hora local. Se añade el aviso “Responde BAJA…”.</p>
        <button class="btn" type="submit">Programar envío</button></form></section>
      <section class="box"><h2>Historial</h2><table><thead><tr><th>Fecha</th><th>Nombre</th><th>Segmento</th><th>Destinatarios</th></tr></thead><tbody>
      ${camps.map((c) => html`<tr><td>${fmt(c.created_at, org.timezone)}</td><td>${c.name}</td><td>${svc.SEGMENTS[c.segment] || c.segment}</td><td>${c.recipients}</td></tr>`)}</tbody></table></section>`;
    return page(ctx, org, s, 'campaigns', 'Campañas', body);
  }));
  router.add('POST', '/admin/campaigns', guard((ctx, org) => {
    if (!limit(`camp:${org.id}`, 10, 3600_000)) return backErr('/admin/campaigns', 'Demasiadas campañas en poco tiempo.');
    const r = svc.createCampaign(org, { name: ctx.body.name, text: ctx.body.text, segment: ctx.body.segment }, ctx.now);
    return r.ok ? back('/admin/campaigns', 'campaign') : backErr('/admin/campaigns', r.error);
  }));

  /* ---------- mensajes y opiniones ---------- */
  router.add('GET', '/admin/messages', guard((ctx, org, s) => {
    const rows = svc.all(`SELECT m.*, c.name, c.phone FROM messages m JOIN customers c ON c.id = m.customer_id WHERE m.org_id = ? ORDER BY m.id DESC LIMIT 100`, org.id);
    const body = html`<div class="scroll"><table><thead><tr><th>Programado</th><th>Cliente</th><th>Tipo</th><th>Estado</th><th>Mensaje</th></tr></thead><tbody>
      ${rows.map((m) => html`<tr><td>${fmt(m.send_at, org.timezone)}</td><td>${m.name}<br><span class="tiny">+${m.phone}</span></td><td>${KIND_ES[m.kind] || m.kind}</td>
        <td>${STATUS_ES[m.status] || m.status}${m.error ? html`<br><span class="tiny">${m.error}</span>` : ''}</td><td class="msg">${m.body}</td></tr>`)}</tbody></table></div>`;
    return page(ctx, org, s, 'messages', 'Mensajes', body);
  }));
  router.add('GET', '/admin/feedback', guard((ctx, org, s) => {
    const rows = svc.all(`SELECT f.*, c.name, c.phone FROM feedback f JOIN customers c ON c.id = f.customer_id WHERE f.org_id = ? ORDER BY f.id DESC LIMIT 100`, org.id);
    const body = html`${rows.length ? '' : html`<p class="tiny">Aún no hay opiniones. Llegan cuando los clientes responden el mensaje posterior a su visita.</p>`}
      ${rows.map((f) => html`<section class="box"><div class="row"><strong>${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)}</strong><span class="tiny">${fmt(f.created_at, org.timezone)}</span></div>
        <p>${f.comment || html`<em>(sin comentario)</em>`}</p><p class="tiny">${f.name} · +${f.phone}</p></section>`)}`;
    return page(ctx, org, s, 'feedback', 'Opiniones', body);
  }));

  /* ---------- ajustes ---------- */
  router.add('GET', '/admin/settings', guard((ctx, org, s) => {
    const f = (label, name, value, extra = '') => html`<label class="field"><span>${label}</span><input name="${name}" value="${value}" ${extra}></label>`;
    const ta = (label, name, value) => html`<label class="field"><span>${label}</span><textarea name="${name}" rows="3" maxlength="600">${value}</textarea></label>`;
    const body = html`<form method="post" action="/admin/settings" class="stack"><input type="hidden" name="_csrf" value="${s.csrf}">
      <section class="box"><h2>Programa de lealtad</h2>
        ${f('Nombre del negocio', 'name', org.name, 'maxlength="60" required')}
        ${f('Sellos para ganar un premio', 'stamps_goal', org.stamps_goal, 'type="number" min="1" max="30"')}
        ${f('Premio', 'reward_text', org.reward_text, 'maxlength="120"')}
        ${f('Horas mínimas entre sellos (anti-abuso)', 'cooldown_hours', org.cooldown_hours, 'type="number" min="0" max="72"')}
        ${f('Color de marca', 'brand_color', org.brand_color, 'type="color"')}
        ${f('Logo (URL https, PNG/JPG; requerido para Google Wallet)', 'logo_url', org.logo_url)}
        ${f('Enlace de reseña de Google Maps', 'google_review_url', org.google_review_url)}</section>
      <section class="box"><h2>Automatizaciones</h2>
        ${f('Pedir opinión X minutos después de la visita', 'review_delay_min', org.review_delay_min, 'type="number" min="0" max="1440"')}
        ${f('Saludo de cumpleaños X días antes', 'birthday_days_before', org.birthday_days_before, 'type="number" min="0" max="30"')}
        ${f('Reactivar clientes tras X días sin venir', 'winback_days', org.winback_days, 'type="number" min="7" max="365"')}
        ${ta('Mensaje de bienvenida ({nombre} {club} {tarjeta})', 'welcome_text', org.welcome_text)}
        ${ta('Mensaje de opinión ({nombre} {club} {feedback} {resena})', 'review_text', org.review_text)}
        ${ta('Mensaje de cumpleaños ({nombre} {club} {promo} {tarjeta})', 'birthday_text', org.birthday_text)}
        ${f('Promo de cumpleaños', 'birthday_promo', org.birthday_promo, 'maxlength="120"')}
        ${ta('Mensaje de reactivación ({nombre} {club} {promo} {tarjeta})', 'winback_text', org.winback_text)}
        ${f('Promo de reactivación', 'winback_promo', org.winback_promo, 'maxlength="120"')}</section>
      <section class="box"><h2>Región</h2>
        ${f('Zona horaria (IANA)', 'timezone', org.timezone, 'placeholder="America/Bogota"')}
        ${f('Código de país por defecto para teléfonos', 'country_code', org.country_code, 'maxlength="3" inputmode="numeric"')}</section>
      <section class="box"><h2>WhatsApp Business (Cloud API)</h2>
        <p class="tiny">${org.wa_phone_id && org.wa_token_enc ? 'Conectado: los mensajes salen por WhatsApp.' : 'Sin conectar: los mensajes se simulan y quedan en el registro.'}</p>
        ${f('Phone number ID', 'wa_phone_id', org.wa_phone_id, 'inputmode="numeric"')}
        <label class="field"><span>Token de acceso permanente (déjalo vacío para no cambiarlo)</span><input name="wa_token" type="password" autocomplete="off"></label>
        <label class="check"><input type="checkbox" name="clear_token" value="1"><span>Desconectar y borrar el token</span></label>
        ${ta('Plantillas aprobadas (JSON). Ej: {"welcome":{"name":"bienvenida_club","lang":"es"}}', 'wa_templates', org.wa_templates)}</section>
      <section class="box"><h2>Accesos</h2>
        <label class="field"><span>Nueva contraseña del panel (mín. 10 caracteres; vacío = sin cambios)</span><input name="new_password" type="password" autocomplete="new-password"></label>
        <label class="field"><span>Nuevo PIN del personal (4–8 dígitos; vacío = sin cambios)</span><input name="new_pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>
        <p class="tiny">Enlace de acceso del personal: <code>${svc.baseUrl}/o/${org.slug}/staff</code></p></section>
      <button class="btn" type="submit">Guardar cambios</button></form>`;
    return page(ctx, org, s, 'settings', 'Ajustes', body);
  }));

  router.add('POST', '/admin/settings', guard((ctx, org) => {
    const b = ctx.body;
    const err = (m) => backErr('/admin/settings', m);
    const int = (k, lo, hi, label) => {
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label}: debe ser un número entre ${lo} y ${hi}.`);
      return n;
    };
    const text = (k, max, label, required = true) => {
      const v = String(b[k] ?? '').trim();
      if ((required && !v) || v.length > max) throw new Error(`${label}: texto inválido (máx. ${max} caracteres).`);
      return v;
    };
    let f;
    try {
      const g = safeHttpsUrl(b.google_review_url);
      if (g === null) throw new Error('Enlace de reseña: debe empezar por https://');
      const logo = safeHttpsUrl(b.logo_url);
      if (logo === null) throw new Error('Logo: debe ser una URL https://');
      if (!validTimezone(b.timezone)) throw new Error('Zona horaria inválida (ej. America/Bogota).');
      if (!/^\d{1,3}$/.test(String(b.country_code))) throw new Error('Código de país: solo dígitos (ej. 57).');
      if (!/^#[0-9a-fA-F]{6}$/.test(String(b.brand_color))) throw new Error('Color inválido.');
      let templates = String(b.wa_templates || '{}').trim() || '{}';
      try {
        const t = JSON.parse(templates);
        if (typeof t !== 'object' || Array.isArray(t) || t === null) throw new Error('x');
        for (const [k, v] of Object.entries(t)) {
          if (!TEMPLATE_KINDS.includes(k) || typeof v?.name !== 'string' || !/^[a-z0-9_]{1,512}$/.test(v.name)) throw new Error('x');
        }
      } catch { throw new Error('Plantillas: JSON inválido. Tipos permitidos: ' + TEMPLATE_KINDS.join(', ')); }
      if (b.wa_phone_id && !/^\d{5,25}$/.test(String(b.wa_phone_id).trim())) throw new Error('Phone number ID: solo dígitos.');
      f = {
        name: text('name', 60, 'Nombre'),
        stamps_goal: int('stamps_goal', 1, 30, 'Sellos'),
        reward_text: text('reward_text', 120, 'Premio'),
        cooldown_hours: int('cooldown_hours', 0, 72, 'Horas entre sellos'),
        brand_color: safeColor(b.brand_color),
        logo_url: logo, google_review_url: g,
        review_delay_min: int('review_delay_min', 0, 1440, 'Minutos para opinión'),
        birthday_days_before: int('birthday_days_before', 0, 30, 'Días antes del cumpleaños'),
        winback_days: int('winback_days', 7, 365, 'Días de reactivación'),
        welcome_text: text('welcome_text', 600, 'Bienvenida'), review_text: text('review_text', 600, 'Opinión'),
        birthday_text: text('birthday_text', 600, 'Cumpleaños'), birthday_promo: text('birthday_promo', 120, 'Promo de cumpleaños'),
        winback_text: text('winback_text', 600, 'Reactivación'), winback_promo: text('winback_promo', 120, 'Promo de reactivación'),
        timezone: b.timezone, country_code: String(b.country_code), wa_phone_id: String(b.wa_phone_id || '').trim(), wa_templates: templates,
      };
      if (b.clear_token) f.wa_token_enc = '';
      else if (String(b.wa_token || '').trim()) f.wa_token_enc = svc.encryptToken(String(b.wa_token).trim());
      if (b.new_password) {
        if (String(b.new_password).length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres.');
        f.admin_hash = hashSecret(b.new_password);
      }
      if (b.new_pin) {
        if (!/^\d{4,8}$/.test(String(b.new_pin))) throw new Error('El PIN debe tener de 4 a 8 dígitos.');
        f.staff_pin_hash = hashSecret(String(b.new_pin));
      }
    } catch (e) { return err(e.message); }
    svc.updateOrgSettings(org.id, f);
    return back('/admin/settings', 'saved');
  }));

}
