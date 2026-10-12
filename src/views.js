import { html, raw, safeColor } from './util.js';

export function layout({ title, body, brand = '#d9480f', scripts = [], bodyClass = '' }) {
  return html`<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="${safeColor(brand)}">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<link rel="stylesheet" href="/static/style.css">
</head><body class="${bodyClass}" style="--brand:${safeColor(brand)}">${body}${scripts.map((s) => html`<script src="${s}" defer></script>`)}</body></html>`;
}

const field = (label, input, error) => html`<label class="field"><span>${label}</span>${input}${error ? html`<em class="err">${error}</em>` : ''}</label>`;

/* ------------------------- cliente ------------------------- */
export function joinPage({ org, token, values = {}, errors = {}, notice = '' }) {
  return layout({
    title: `Únete al club · ${org.name}`, brand: org.brand_color, bodyClass: 'customer',
    body: html`<main class="wrap">
      <header class="hero"><div class="mark">${org.name.slice(0, 1)}</div><h1>${org.name}</h1>
      <p class="sub">¡Visita registrada! 🎉 Únete al club y empieza a sumar sellos.</p></header>
      <form class="card" method="post" action="/t/${token}/join" autocomplete="on" novalidate>
        ${notice ? html`<p class="notice">${notice}</p>` : ''}
        ${field('Tu nombre', html`<input name="name" value="${values.name || ''}" autocomplete="given-name" maxlength="60" required>`, errors.name)}
        ${field('Tu WhatsApp', html`<input name="phone" type="tel" inputmode="tel" value="${values.phone || ''}" autocomplete="tel" placeholder="300 123 4567" required>`, errors.phone)}
        ${field('Tu cumpleaños (opcional)', html`<input name="birthday" type="date" value="${values.birthday || ''}" autocomplete="bday">`, errors.birthday)}
        <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <label class="check"><input type="checkbox" name="consent" value="1" ${values.consent ? 'checked' : ''}>
          <span>Acepto recibir mensajes de ${org.name} por WhatsApp (tarjeta, reseñas, cumpleaños y promociones). Puedo responder BAJA cuando quiera.</span></label>
        ${errors.consent ? html`<em class="err">${errors.consent}</em>` : ''}
        <button class="btn" type="submit">Unirme y sumar mi primer sello</button>
        <p class="tiny">Solo te pedimos nombre, WhatsApp y cumpleaños. No compartimos tus datos.</p>
      </form></main>`,
  });
}

export function cardPage({ org, customer, rewards, flash, walletUrl, member, hoursLeft }) {
  const goal = org.stamps_goal;
  const cols = goal <= 8 ? 4 : 5;
  const stamps = Array.from({ length: goal }, (_, i) => html`<li class="stamp ${i < customer.stamps ? 'on' : ''}" aria-label="${i < customer.stamps ? 'sello' : 'vacío'}">${i < customer.stamps ? '★' : i + 1}</li>`);
  const messages = {
    stamped: '¡Sumaste 1 sello! 🎉', joined: '¡Bienvenido al club! Tu primer sello ya está sumado. 🎉',
    reward: '🎁 ¡Completaste tu tarjeta! Tienes un premio por canjear.',
    cooldown: `Ya registramos tu visita. Podrás sumar otro sello en ${hoursLeft || 1} h.`,
    welcome: 'Esta es tu tarjeta de sellos. Guárdala en favoritos.',
  };
  return layout({
    title: `Tu tarjeta · ${org.name}`, brand: org.brand_color, bodyClass: 'customer',
    body: html`<main class="wrap">
      <header class="hero"><div class="mark">${org.name.slice(0, 1)}</div><h1>${org.name}</h1><p class="sub">Hola, ${customer.name.split(' ')[0]} 👋</p></header>
      ${messages[flash] ? html`<p class="flash ${flash === 'cooldown' ? 'warn' : ''}">${messages[flash]}</p>` : ''}
      <section class="card">
        <div class="row"><strong>${customer.stamps} de ${goal} sellos</strong><span class="tiny">Socio ${member}</span></div>
        <ol class="stamps" style="--cols:${cols}">${stamps}</ol>
        <p class="tiny">Premio: <strong>${org.reward_text}</strong></p>
      </section>
      ${rewards.length ? html`<section class="card reward"><h2>🎁 Premios por canjear</h2>
        ${rewards.map((r) => html`<div class="code">${r.code}</div>`)}
        <p class="tiny">Muestra este código a tu mesero para canjear tu premio.</p></section>` : ''}
      ${walletUrl ? html`<a class="btn ghost" href="${walletUrl}">Agregar a Google Wallet</a>` : ''}
      <p class="tiny center">Visitas totales: ${customer.total_visits} · <a href="/fb/${customer.auth_token}">Danos tu opinión</a></p>
    </main>`,
  });
}

export function infoPage({ org, title, message, brand }) {
  return layout({
    title: `${title}${org ? ' · ' + org.name : ''}`, brand: brand || org?.brand_color, bodyClass: 'customer',
    body: html`<main class="wrap"><section class="card center"><h1>${title}</h1><p>${message}</p></section></main>`,
  });
}

export function feedbackPage({ org, customer, done, error }) {
  return layout({
    title: `Tu opinión · ${org.name}`, brand: org.brand_color, bodyClass: 'customer',
    body: html`<main class="wrap">
      <header class="hero"><div class="mark">${org.name.slice(0, 1)}</div><h1>${org.name}</h1></header>
      ${done ? html`<section class="card center"><h2>¡Gracias, ${customer.name.split(' ')[0]}! 🙏</h2>
        <p>Tu opinión nos llega directamente a nosotros.</p>
        ${org.google_review_url ? html`<p>Si quieres, también puedes contárselo a otras personas:</p><a class="btn" href="${org.google_review_url}" rel="noopener">Dejar reseña en Google</a>` : ''}
      </section>` : html`<form class="card" method="post" action="/fb/${customer.auth_token}">
        <h2>¿Cómo estuvo tu visita?</h2>
        ${error ? html`<em class="err">${error}</em>` : ''}
        <div class="rating">${[1, 2, 3, 4, 5].map((n) => html`<label><input type="radio" name="rating" value="${n}" required><span>${n}★</span></label>`)}</div>
        <label class="field"><span>Cuéntanos más (opcional)</span><textarea name="comment" rows="4" maxlength="1000"></textarea></label>
        <button class="btn" type="submit">Enviar</button></form>`}
    </main>`,
  });
}

/* ------------------------- personal (mesero) ------------------------- */
export function staffLoginPage({ org, error }) {
  return layout({
    title: `Personal · ${org.name}`, brand: org.brand_color, bodyClass: 'customer',
    body: html`<main class="wrap"><header class="hero"><div class="mark">${org.name.slice(0, 1)}</div><h1>${org.name}</h1><p class="sub">Acceso del personal</p></header>
      <form class="card" method="post" action="/o/${org.slug}/staff/login">
        ${error ? html`<em class="err">${error}</em>` : ''}
        ${field('PIN', html`<input name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" required autofocus>`)}
        <button class="btn" type="submit">Entrar</button></form></main>`,
  });
}

export function staffPage({ org, csrf, q, results, notice, error }) {
  return layout({
    title: `Caja · ${org.name}`, brand: org.brand_color, bodyClass: 'customer',
    body: html`<main class="wrap"><header class="hero small"><h1>${org.name} · Caja</h1></header>
      ${notice ? html`<p class="flash">${notice}</p>` : ''}${error ? html`<p class="flash warn">${error}</p>` : ''}
      <form class="card" method="get" action="/o/${org.slug}/staff">
        ${field('Buscar cliente: código de premio, teléfono, nombre o socio (M00012)', html`<input name="q" value="${q || ''}" autocomplete="off" autofocus>`)}
        <button class="btn" type="submit">Buscar</button></form>
      ${q && !results.length ? html`<p class="tiny center">Sin resultados.</p>` : ''}
      ${results.map((c) => html`<section class="card">
        <div class="row"><strong>${c.name}</strong><span class="tiny">${c.member}</span></div>
        <p class="tiny">+${c.phone} · ${c.stamps}/${org.stamps_goal} sellos · ${c.total_visits} visitas</p>
        ${c.rewards.map((r) => html`<form method="post" action="/o/${org.slug}/staff/redeem" class="row">
          <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="reward_id" value="${r.id}"><input type="hidden" name="q" value="${q}">
          <span class="code sm">${r.code}</span><button class="btn small" type="submit">Canjear: ${org.reward_text}</button></form>`)}
        <form method="post" action="/o/${org.slug}/staff/stamp">
          <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="customer_id" value="${c.id}"><input type="hidden" name="q" value="${q}">
          <button class="btn ghost small" type="submit">Sumar visita manual (sin chip)</button></form>
      </section>`)}
      <form method="post" action="/o/${org.slug}/staff/logout" class="center"><input type="hidden" name="_csrf" value="${csrf}"><button class="link" type="submit">Salir</button></form></main>`,
  });
}

/* ------------------------- administración ------------------------- */
const NAV = [
  ['dashboard', 'Resumen', '/admin'], ['customers', 'Clientes', '/admin/customers'], ['chips', 'Chips NFC', '/admin/chips'],
  ['campaigns', 'Campañas', '/admin/campaigns'], ['messages', 'Mensajes', '/admin/messages'],
  ['feedback', 'Opiniones', '/admin/feedback'], ['settings', 'Ajustes', '/admin/settings'],
];

export function adminLayout({ org, active, title, body, csrf, flash, scripts = [] }) {
  return layout({
    title: `${title} · ${org.name}`, brand: org.brand_color, bodyClass: 'admin', scripts,
    body: html`<header class="top"><strong>${org.name}</strong>
      <nav>${NAV.map(([k, label, href]) => html`<a href="${href}" class="${k === active ? 'on' : ''}">${label}</a>`)}</nav>
      <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="link" type="submit">Salir</button></form></header>
      <main class="panel"><h1>${title}</h1>${flash ? html`<p class="flash ${flash.type === 'error' ? 'warn' : ''}">${flash.text}</p>` : ''}${body}</main>`,
  });
}

export function adminLoginPage({ error }) {
  return layout({
    title: 'Ingresar', bodyClass: 'customer',
    body: html`<main class="wrap"><header class="hero"><h1>Panel del restaurante</h1></header>
      <form class="card" method="post" action="/admin/login">
        ${error ? html`<em class="err">${error}</em>` : ''}
        ${field('Correo', html`<input name="email" type="email" autocomplete="username" required>`)}
        ${field('Contraseña', html`<input name="password" type="password" autocomplete="current-password" required>`)}
        <button class="btn" type="submit">Entrar</button></form></main>`,
  });
}

export { raw };
