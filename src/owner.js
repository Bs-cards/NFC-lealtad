import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { html, randomToken } from './util.js';
import { resp } from './http.js';
import { layout } from './views.js';

/**
 * Zona del propietario de la plataforma (tú, no los restaurantes).
 * Se activa solo si defines OWNER_PASSWORD (mínimo 12 caracteres). Permite descargar una copia
 * de TODA la base de datos, por eso NO se ofrece a los administradores de cada restaurante.
 */
export function registerOwner({ router, svc, h, limit, ownerPassword, dbFile, log = console }) {
  const enabled = typeof ownerPassword === 'string' && ownerPassword.length >= 12;
  if (!enabled) return { enabled: false };

  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const passwordOk = (given) => crypto.timingSafeEqual(digest(given), digest(ownerPassword));

  const guard = (fn) => (ctx) => {
    const s = h.getSession(ctx, 'own');
    if (!s || s.role !== 'owner') return resp.redirect('/owner/login');
    if (ctx.req.method === 'POST' && !h.csrfOk(s, ctx.body._csrf)) return resp.text('Solicitud inválida (CSRF). Recarga la página.', 403);
    return fn(ctx, s);
  };

  const loginPage = (error) => layout({
    title: 'Propietario', brand: '#444444', bodyClass: 'customer',
    body: html`<main class="wrap"><header class="hero"><h1>Zona del propietario</h1></header>
      <form class="card" method="post" action="/owner/login">
        ${error ? html`<em class="err">${error}</em>` : ''}
        <label class="field"><span>Contraseña de propietario</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn" type="submit">Entrar</button></form></main>`,
  });

  router.add('GET', '/owner/login', (ctx) => (h.getSession(ctx, 'own') ? resp.redirect('/owner') : resp.html(loginPage())));
  router.add('POST', '/owner/login', (ctx) => {
    if (!limit(`owner:${ctx.ip}`, 6, 15 * 60_000)) return resp.html(loginPage('Demasiados intentos. Espera unos minutos.'), 429);
    if (!passwordOk(ctx.body.password || '')) return resp.html(loginPage('Contraseña incorrecta.'), 401);
    h.startSession(ctx, 'own', 'owner', 0, 2 * 3600_000);
    return resp.redirect('/owner');
  });
  router.add('POST', '/owner/logout', guard((ctx) => {
    h.clearSession(ctx, 'own');
    return resp.redirect('/owner/login');
  }));

  const sizeMb = () => {
    try {
      if (!dbFile || dbFile === ':memory:') return null;
      return (fs.statSync(dbFile).size / 1048576).toFixed(1);
    } catch { return null; }
  };

  router.add('GET', '/owner', guard((ctx, s) => {
    const orgs = svc.all(`SELECT o.id, o.name, o.slug,
      (SELECT COUNT(*) FROM customers c WHERE c.org_id = o.id) AS customers,
      (SELECT COUNT(*) FROM visits v WHERE v.org_id = o.id AND v.counted = 1) AS visits
      FROM orgs o ORDER BY o.id`);
    const mb = sizeMb();
    return resp.html(layout({
      title: 'Propietario', brand: '#444444', bodyClass: 'admin',
      body: html`<header class="top"><strong>Zona del propietario</strong><nav></nav>
        <form method="post" action="/owner/logout"><input type="hidden" name="_csrf" value="${s.csrf}"><button class="link" type="submit">Salir</button></form></header>
        <main class="panel"><h1>Respaldo de la base de datos</h1>
        <section class="box">
          <p>Descarga una copia completa y consistente de la base de datos${mb ? html` (hoy pesa <b>${mb} MB</b>)` : ''}. Incluye los datos de <b>todos</b> los restaurantes.</p>
          <form method="post" action="/owner/backup"><input type="hidden" name="_csrf" value="${s.csrf}">
            <button class="btn" type="submit">⬇ Descargar copia de seguridad</button></form>
          <p class="tiny">El archivo contiene datos personales de clientes, contraseñas con hash y tokens de WhatsApp cifrados. Guárdalo en un lugar privado y no lo compartas.
          No incluye la clave <code>SESSION_SECRET</code>: guárdala aparte, sin ella no se pueden descifrar los tokens de WhatsApp al restaurar.</p>
        </section>
        <section class="box"><h2>Negocios</h2><div class="scroll"><table><thead><tr><th>Negocio</th><th>Clientes</th><th>Visitas</th></tr></thead><tbody>
          ${orgs.map((o) => html`<tr><td>${o.name} <span class="tiny">/${o.slug}</span></td><td>${o.customers}</td><td>${o.visits}</td></tr>`)}
        </tbody></table></div></section></main>`,
    }));
  }));

  router.add('POST', '/owner/backup', guard((ctx) => {
    if (!limit(`backup:${ctx.ip}`, 10, 3600_000)) return resp.text('Demasiadas descargas. Espera un rato.', 429);
    const tmp = path.join(os.tmpdir(), `backup-${randomToken(8)}.db`);
    try {
      // VACUUM INTO genera una copia coherente aunque haya escrituras en curso (a diferencia de copiar el archivo).
      svc.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const data = fs.readFileSync(tmp);
      const stamp = new Date(ctx.now).toISOString().slice(0, 10);
      log.info?.(`Respaldo descargado (${data.length} bytes)`);
      return {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="lealtad-${stamp}.db"`,
        },
        body: data,
      };
    } catch (e) {
      log.error?.('Respaldo falló:', e);
      return resp.text('No se pudo generar el respaldo.', 500);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }));

  return { enabled: true };
}
