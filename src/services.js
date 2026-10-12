import { tx } from './db.js';
import {
  randomToken, randomCode, fill, firstName, localParts, hashSecret, encrypt,
  normalizePhone, cleanName, parseBirthday,
} from './util.js';

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

const MARKETING = new Set(['birthday', 'winback', 'campaign']);
export const isMarketing = (kind) => MARKETING.has(kind);

export function createServices({ db, baseUrl, secret }) {
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  /* ---------------- lecturas básicas ---------------- */
  const getOrg = (id) => get('SELECT * FROM orgs WHERE id = ?', id);
  const getOrgBySlug = (slug) => get('SELECT * FROM orgs WHERE slug = ?', slug);
  const getOrgByEmail = (email) => get('SELECT * FROM orgs WHERE admin_email = ?', String(email).trim().toLowerCase());
  const listOrgs = () => all('SELECT * FROM orgs ORDER BY id');
  const getChip = (token) => get('SELECT * FROM chips WHERE token = ? AND active = 1', token);
  const getCustomerByAuth = (token) => get('SELECT * FROM customers WHERE auth_token = ?', String(token));
  const getCustomer = (orgId, id) => get('SELECT * FROM customers WHERE org_id = ? AND id = ?', orgId, id);
  const getCustomerByPhone = (orgId, phone) => get('SELECT * FROM customers WHERE org_id = ? AND phone = ?', orgId, phone);
  const pendingRewards = (customerId) =>
    all('SELECT * FROM rewards WHERE customer_id = ? AND redeemed_at IS NULL ORDER BY created_at', customerId);
  const memberCode = (customer) => 'M' + String(customer.id).padStart(5, '0');

  /* ---------------- alta de negocio ---------------- */
  function createOrg({ slug, name, email, password, staffPin, ...rest }, now = Date.now()) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw new Error('slug inválido (usa a-z, 0-9 y guiones)');
    if (!password || password.length < 10) throw new Error('la contraseña debe tener al menos 10 caracteres');
    if (!/^\d{4,8}$/.test(String(staffPin))) throw new Error('el PIN del personal debe tener 4 a 8 dígitos');
    return tx(db, () => {
      const r = run(
        `INSERT INTO orgs(slug,name,admin_email,admin_hash,staff_pin_hash,created_at) VALUES (?,?,?,?,?,?)`,
        slug, name, String(email).trim().toLowerCase(), hashSecret(password), hashSecret(String(staffPin)), now,
      );
      const orgId = Number(r.lastInsertRowid);
      const allowed = ['brand_color', 'stamps_goal', 'reward_text', 'google_review_url', 'timezone', 'country_code', 'logo_url'];
      for (const k of allowed) if (rest[k] !== undefined) run(`UPDATE orgs SET ${k} = ? WHERE id = ?`, rest[k], orgId);
      const loc = run('INSERT INTO locations(org_id,name,created_at) VALUES (?,?,?)', orgId, rest.locationName || 'Local principal', now);
      return { orgId, locationId: Number(loc.lastInsertRowid) };
    });
  }

  function createChip(orgId, locationId, label, now = Date.now()) {
    const loc = get('SELECT id FROM locations WHERE id = ? AND org_id = ?', locationId, orgId);
    if (!loc) throw new Error('sucursal no encontrada');
    const token = randomToken(12);
    const r = run('INSERT INTO chips(org_id,location_id,token,label,created_at) VALUES (?,?,?,?,?)', orgId, locationId, token, String(label || '').slice(0, 60), now);
    return { id: Number(r.lastInsertRowid), token };
  }
  const chipUrl = (token) => `${baseUrl}/t/${token}`;

  /* ---------------- mensajes ---------------- */
  function buildMessage(kind, org, customer, extra = {}) {
    const v = {
      nombre: firstName(customer.name), club: org.name,
      tarjeta: `${baseUrl}/c/${customer.auth_token}`,
      feedback: `${baseUrl}/fb/${customer.auth_token}`,
      resena: org.google_review_url || '', premio: org.reward_text,
      ...extra,
    };
    let body; let params;
    switch (kind) {
      case 'welcome': body = fill(org.welcome_text, v); params = [v.nombre, v.club, v.tarjeta]; break;
      case 'review': body = fill(org.review_text, v); params = [v.nombre, v.club, v.feedback]; break;
      case 'birthday': v.promo = org.birthday_promo; body = fill(org.birthday_text, v); params = [v.nombre, v.club, v.promo, v.tarjeta]; break;
      case 'winback': v.promo = org.winback_promo; body = fill(org.winback_text, v); params = [v.nombre, v.club, v.promo, v.tarjeta]; break;
      case 'link': body = `Hola ${v.nombre}, aquí está tu tarjeta de sellos de ${v.club}: ${v.tarjeta}`; params = [v.nombre, v.club, v.tarjeta]; break;
      case 'campaign': body = fill(extra.text, v); params = [v.nombre, body]; break;
      default: throw new Error('tipo de mensaje desconocido: ' + kind);
    }
    if (isMarketing(kind)) body += '\n\nResponde BAJA para no recibir más mensajes.';
    return { body, params };
  }

  function queueMessage({ orgId, customerId, kind, body, params = [], sendAt, now, dedupeKey = null, campaignId = null }) {
    const r = run(
      `INSERT OR IGNORE INTO messages(org_id,customer_id,kind,body,params,status,send_at,created_at,dedupe_key,campaign_id)
       VALUES (?,?,?,?,?,'pending',?,?,?,?)`,
      orgId, customerId, kind, body, JSON.stringify(params), sendAt, now, dedupeKey, campaignId,
    );
    return r.changes > 0 ? Number(r.lastInsertRowid) : null;
  }

  function queueKind(kind, org, customer, now, { delayMs = 0, dedupeKey = null, extra, campaignId } = {}) {
    const { body, params } = buildMessage(kind, org, customer, extra);
    return queueMessage({ orgId: org.id, customerId: customer.id, kind, body, params, sendAt: now + delayMs, now, dedupeKey, campaignId });
  }

  /* ---------------- visitas y sellos ---------------- */
  function newRewardCode(orgId) {
    for (let i = 0; i < 20; i++) {
      const code = randomCode(6);
      if (!get('SELECT 1 FROM rewards WHERE org_id = ? AND code = ?', orgId, code)) return code;
    }
    throw new Error('no se pudo generar un código único');
  }

  /** Registra la visita de un cliente conocido y suma el sello si corresponde. */
  function applyVisit(org, customer, { locationId = null, chipId = null, deviceId = null, now, force = false, source = 'nfc' }) {
    return tx(db, () => {
      const fresh = get('SELECT * FROM customers WHERE id = ?', customer.id);
      const last = get('SELECT MAX(created_at) AS m FROM visits WHERE customer_id = ? AND counted = 1', fresh.id).m;
      const cooldown = org.cooldown_hours * HOUR;
      const counted = force || !last || now - last >= cooldown;
      const v = run(
        'INSERT INTO visits(org_id,location_id,chip_id,customer_id,device_id,counted,source,created_at) VALUES (?,?,?,?,?,?,?,?)',
        org.id, locationId, chipId, fresh.id, deviceId, counted ? 1 : 0, source, now,
      );
      if (!counted) return { counted: false, reason: 'cooldown', nextAt: last + cooldown, customer: fresh, newReward: null };

      let stamps = fresh.stamps + 1;
      let earned = fresh.rewards_earned;
      let newReward = null;
      if (stamps >= org.stamps_goal) {
        stamps -= org.stamps_goal;
        earned += 1;
        const code = newRewardCode(org.id);
        run('INSERT INTO rewards(org_id,customer_id,code,created_at) VALUES (?,?,?,?)', org.id, fresh.id, code, now);
        newReward = { code };
      }
      run('UPDATE customers SET stamps = ?, total_visits = total_visits + 1, rewards_earned = ?, last_visit_at = ? WHERE id = ?', stamps, earned, now, fresh.id);
      const updated = get('SELECT * FROM customers WHERE id = ?', fresh.id);
      if (org.review_delay_min >= 0 && source === 'nfc') {
        queueKind('review', org, updated, now, { delayMs: org.review_delay_min * 60_000, dedupeKey: `review:${Number(v.lastInsertRowid)}` });
      }
      return { counted: true, customer: updated, newReward, visitId: Number(v.lastInsertRowid) };
    });
  }

  /** Visita de alguien aún no registrado: se guarda sin contar hasta que se una al club. */
  function recordPendingVisit(org, chip, deviceId, now) {
    const recent = get(
      'SELECT id FROM visits WHERE org_id = ? AND device_id = ? AND customer_id IS NULL AND created_at > ?',
      org.id, deviceId, now - 10 * 60_000,
    );
    if (recent) return recent.id;
    const r = run(
      'INSERT INTO visits(org_id,location_id,chip_id,customer_id,device_id,counted,source,created_at) VALUES (?,?,?,NULL,?,0,?,?)',
      org.id, chip.location_id, chip.id, deviceId, 'nfc', now,
    );
    return Number(r.lastInsertRowid);
  }

  function validateJoin(org, input) {
    const errors = {};
    const name = cleanName(input.name);
    if (!name) errors.name = 'Escribe tu nombre (2 a 60 letras).';
    const phone = normalizePhone(input.phone, org.country_code);
    if (!phone) errors.phone = 'Escribe un número de WhatsApp válido.';
    const bd = parseBirthday(input.birthday);
    if (!bd) errors.birthday = 'La fecha de cumpleaños no es válida.';
    if (!input.consent) errors.consent = 'Necesitamos tu permiso para escribirte por WhatsApp.';
    return { errors, name, phone, bd };
  }

  /**
   * Alta de cliente. Si el teléfono ya existe NO se revela ni se fusiona nada:
   * se devuelve {existing:true} y el llamador envía el enlace por WhatsApp (verifica la propiedad del número).
   */
  function registerCustomer(org, chip, input, deviceId, now) {
    const { errors, name, phone, bd } = validateJoin(org, input);
    if (Object.keys(errors).length) return { ok: false, errors };
    return tx(db, () => {
      const dup = getCustomerByPhone(org.id, phone);
      if (dup) return { ok: true, existing: true, customer: dup };
      const token = randomToken(18);
      const r = run(
        `INSERT INTO customers(org_id,name,phone,birth_md,birth_year,opt_in,auth_token,created_at) VALUES (?,?,?,?,?,1,?,?)`,
        org.id, name, phone, bd.md, bd.year, token, now,
      );
      const customer = get('SELECT * FROM customers WHERE id = ?', Number(r.lastInsertRowid));
      // Reclama la visita pendiente de este dispositivo (la que originó el registro)
      const pend = get(
        `SELECT id, location_id, chip_id FROM visits WHERE org_id = ? AND device_id = ? AND customer_id IS NULL
         AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        org.id, deviceId, now - 3 * HOUR,
      );
      run('DELETE FROM visits WHERE org_id = ? AND device_id = ? AND customer_id IS NULL', org.id, deviceId);
      const visit = applyVisit(org, customer, {
        locationId: pend?.location_id ?? chip?.location_id ?? null, chipId: pend?.chip_id ?? chip?.id ?? null, deviceId, now,
      });
      queueKind('welcome', org, visit.customer, now, { dedupeKey: `welcome:${customer.id}` });
      return { ok: true, existing: false, customer: visit.customer, visit };
    });
  }

  function sendCardLink(org, customer, now) {
    const bucket = Math.floor(now / (5 * 60_000));
    return queueKind('link', org, customer, now, { dedupeKey: `link:${customer.id}:${bucket}` });
  }

  function optOutByPhone(waPhoneId, phone) {
    const org = get('SELECT id FROM orgs WHERE wa_phone_id = ? AND wa_phone_id != ?', waPhoneId, '');
    if (!org) return 0;
    const r = run('UPDATE customers SET opt_in = 0 WHERE org_id = ? AND phone = ?', org.id, phone);
    run(`UPDATE messages SET status = 'cancelled' WHERE status = 'pending' AND customer_id IN
         (SELECT id FROM customers WHERE org_id = ? AND phone = ?)`, org.id, phone);
    return r.changes;
  }

  /* ---------------- premios y personal ---------------- */
  function findForStaff(orgId, q) {
    const s = String(q ?? '').trim();
    if (!s) return [];
    const upper = s.toUpperCase().replace(/\s+/g, '');
    let rows = [];
    const rw = get('SELECT customer_id FROM rewards WHERE org_id = ? AND code = ?', orgId, upper);
    if (rw) rows = all('SELECT * FROM customers WHERE id = ?', rw.customer_id);
    else if (/^M\d{1,8}$/.test(upper)) rows = all('SELECT * FROM customers WHERE org_id = ? AND id = ?', orgId, parseInt(upper.slice(1), 10));
    else {
      const digits = s.replace(/\D/g, '');
      const like = `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      rows = digits.length >= 4
        ? all(`SELECT * FROM customers WHERE org_id = ? AND phone LIKE ? ESCAPE '\\' ORDER BY last_visit_at DESC LIMIT 10`, orgId, `%${digits}%`)
        : all(`SELECT * FROM customers WHERE org_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY last_visit_at DESC LIMIT 10`, orgId, like);
    }
    return rows.map((c) => ({ ...c, rewards: pendingRewards(c.id), member: memberCode(c) }));
  }

  function redeemReward(orgId, rewardId, now) {
    return tx(db, () => {
      const r = get('SELECT * FROM rewards WHERE id = ? AND org_id = ?', rewardId, orgId);
      if (!r) return { ok: false, error: 'No se encontró el premio.' };
      if (r.redeemed_at) return { ok: false, error: 'Este premio ya fue canjeado.' };
      run('UPDATE rewards SET redeemed_at = ? WHERE id = ?', now, r.id);
      return { ok: true, reward: r };
    });
  }

  /* ---------------- encuestas ---------------- */
  function submitFeedback(customer, rating, comment, now) {
    const r = Math.round(Number(rating));
    if (!(r >= 1 && r <= 5)) return { ok: false };
    run('INSERT INTO feedback(org_id,customer_id,rating,comment,created_at) VALUES (?,?,?,?,?)',
      customer.org_id, customer.id, r, String(comment ?? '').trim().slice(0, 1000), now);
    return { ok: true };
  }

  /* ---------------- segmentos y campañas ---------------- */
  const SEGMENTS = {
    all: 'Todos los clientes',
    inactive: 'Inactivos (sin venir hace el tiempo de reactivación)',
    birthday_month: 'Cumpleañeros de este mes',
    with_reward: 'Con un premio pendiente por canjear',
    new30: 'Nuevos de los últimos 30 días',
  };

  function segmentCustomers(org, segment, now) {
    const base = 'SELECT * FROM customers WHERE org_id = ? AND opt_in = 1';
    switch (segment) {
      case 'all': return all(base, org.id);
      case 'inactive': return all(`${base} AND last_visit_at IS NOT NULL AND last_visit_at < ?`, org.id, now - org.winback_days * DAY);
      case 'birthday_month': {
        const m = String(localParts(now, org.timezone).month).padStart(2, '0');
        return all(`${base} AND birth_md LIKE ?`, org.id, `${m}-%`);
      }
      case 'with_reward': return all(`${base} AND id IN (SELECT customer_id FROM rewards WHERE redeemed_at IS NULL)`, org.id);
      case 'new30': return all(`${base} AND created_at >= ?`, org.id, now - 30 * DAY);
      default: return null;
    }
  }

  function createCampaign(org, { name, text, segment }, now) {
    const list = segmentCustomers(org, segment, now);
    if (!list) return { ok: false, error: 'Segmento inválido.' };
    const t = String(text ?? '').trim();
    if (t.length < 5 || t.length > 900) return { ok: false, error: 'El mensaje debe tener entre 5 y 900 caracteres.' };
    return tx(db, () => {
      const c = run('INSERT INTO campaigns(org_id,name,body,segment,recipients,created_at) VALUES (?,?,?,?,?,?)',
        org.id, String(name || 'Campaña').slice(0, 80), t, segment, list.length, now);
      const id = Number(c.lastInsertRowid);
      for (const cust of list) queueKind('campaign', org, cust, now, { extra: { text: t }, dedupeKey: `camp:${id}:${cust.id}`, campaignId: id });
      return { ok: true, id, recipients: list.length };
    });
  }

  /* ---------------- métricas ---------------- */
  function dashboard(org, now) {
    const since30 = now - 30 * DAY;
    const n = (sql, ...p) => get(sql, ...p).n;
    const total = n('SELECT COUNT(*) AS n FROM customers WHERE org_id = ?', org.id);
    const repeat = n('SELECT COUNT(*) AS n FROM customers WHERE org_id = ? AND total_visits >= 2', org.id);
    const fb = get('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM feedback WHERE org_id = ? AND created_at >= ?', org.id, since30);
    const rows = all('SELECT created_at FROM visits WHERE org_id = ? AND counted = 1 AND created_at >= ?', org.id, now - 14 * DAY);
    const perDay = new Map();
    for (let i = 13; i >= 0; i--) perDay.set(localParts(now - i * DAY, org.timezone).ymd, 0);
    for (const r of rows) { const k = localParts(r.created_at, org.timezone).ymd; if (perDay.has(k)) perDay.set(k, perDay.get(k) + 1); }
    return {
      customers: total,
      new30: n('SELECT COUNT(*) AS n FROM customers WHERE org_id = ? AND created_at >= ?', org.id, since30),
      visits30: n('SELECT COUNT(*) AS n FROM visits WHERE org_id = ? AND counted = 1 AND created_at >= ?', org.id, since30),
      active30: n('SELECT COUNT(DISTINCT customer_id) AS n FROM visits WHERE org_id = ? AND counted = 1 AND created_at >= ?', org.id, since30),
      repeatRate: total ? Math.round((repeat / total) * 100) : 0,
      rewardsPending: n('SELECT COUNT(*) AS n FROM rewards WHERE org_id = ? AND redeemed_at IS NULL', org.id),
      rewardsRedeemed30: n('SELECT COUNT(*) AS n FROM rewards WHERE org_id = ? AND redeemed_at >= ?', org.id, since30),
      inactive: n('SELECT COUNT(*) AS n FROM customers WHERE org_id = ? AND last_visit_at < ?', org.id, now - org.winback_days * DAY),
      msgs: all(`SELECT kind, status, COUNT(*) AS n FROM messages WHERE org_id = ? AND created_at >= ? GROUP BY kind, status`, org.id, since30),
      feedbackCount: fb.n, feedbackAvg: fb.avg ? Math.round(fb.avg * 10) / 10 : null,
      daily: [...perDay].map(([day, count]) => ({ day, count })),
    };
  }

  function listCustomers(orgId, q, page = 1, pageSize = 50) {
    const s = String(q ?? '').trim();
    const like = `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const where = s ? `AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')` : '';
    const params = s ? [orgId, like, like] : [orgId];
    const total = get(`SELECT COUNT(*) AS n FROM customers WHERE org_id = ? ${where}`, ...params).n;
    const rows = all(`SELECT * FROM customers WHERE org_id = ? ${where} ORDER BY COALESCE(last_visit_at, created_at) DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, (Math.max(1, page) - 1) * pageSize);
    return { total, rows };
  }

  /* ---------------- ajustes del negocio ---------------- */
  function updateOrgSettings(orgId, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    db.prepare(`UPDATE orgs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => fields[c]), orgId);
  }
  const encryptToken = (t) => encrypt(t, secret);

  return {
    db, baseUrl, get, all, run,
    getOrg, getOrgBySlug, getOrgByEmail, listOrgs, getChip, getCustomerByAuth, getCustomer, getCustomerByPhone,
    pendingRewards, memberCode, createOrg, createChip, chipUrl,
    buildMessage, queueMessage, queueKind, applyVisit, recordPendingVisit, validateJoin, registerCustomer,
    sendCardLink, optOutByPhone, findForStaff, redeemReward, submitFeedback,
    SEGMENTS, segmentCustomers, createCampaign, dashboard, listCustomers, updateOrgSettings, encryptToken,
  };
}
