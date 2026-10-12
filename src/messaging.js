import { decrypt, localParts } from './util.js';
import { DAY, isMarketing } from './services.js';

const MAX_ATTEMPTS = 4;

/** Ventana horaria local en la que se permite enviar cada tipo de mensaje. */
function allowedHours(kind) {
  if (isMarketing(kind)) return [9, 21]; // 9:00–20:59
  if (kind === 'review') return [8, 23];
  return [0, 24]; // bienvenida y enlaces: siempre
}

class SendError extends Error {
  constructor(message, permanent) { super(message); this.permanent = permanent; }
}

export function createMessenger({ svc, secret, fetchImpl = fetch, log = console, apiVersion = 'v21.0' }) {
  const { db } = svc;
  let running = false;

  function cloudPayload(org, msg, to) {
    let templates = {};
    try { templates = JSON.parse(org.wa_templates || '{}'); } catch { /* sin plantillas */ }
    const t = templates[msg.kind];
    if (t?.name) {
      const params = JSON.parse(msg.params || '[]').map((p) => String(p).replace(/\s*\n+\s*/g, ' ').slice(0, 1000));
      return {
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: t.name, language: { code: t.lang || 'es' },
          components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [],
        },
      };
    }
    // Sin plantilla: texto libre (WhatsApp solo lo entrega dentro de la ventana de 24 h de conversación)
    return { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.body, preview_url: true } };
  }

  async function sendCloud(org, msg, phone) {
    const token = decrypt(org.wa_token_enc, secret);
    const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(org.wa_phone_id)}/messages`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cloudPayload(org, msg, phone)),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new SendError(data?.error?.message || `HTTP ${res.status}`, permanent);
    }
    return data?.messages?.[0]?.id ?? null;
  }

  /** Envía los mensajes pendientes cuya hora ya llegó. */
  async function processOutbox(now = Date.now()) {
    if (running) return { skipped: true };
    running = true;
    const stats = { sent: 0, simulated: 0, failed: 0, deferred: 0, skipped: 0 };
    try {
      const due = db.prepare(
        `SELECT m.*, c.phone AS c_phone, c.opt_in AS c_opt_in FROM messages m
         JOIN customers c ON c.id = m.customer_id
         WHERE m.status = 'pending' AND m.send_at <= ? ORDER BY m.send_at LIMIT 50`,
      ).all(now);
      for (const m of due) {
        const org = svc.getOrg(m.org_id);
        if (!m.c_opt_in && m.kind !== 'link') {
          db.prepare("UPDATE messages SET status = 'skipped', error = 'sin consentimiento' WHERE id = ?").run(m.id);
          stats.skipped++; continue;
        }
        const [from, to] = allowedHours(m.kind);
        const h = localParts(now, org.timezone).hour;
        if (h < from || h >= to) { stats.deferred++; continue; }

        try {
          if (org.wa_phone_id && org.wa_token_enc) {
            const id = await sendCloud(org, m, m.c_phone);
            db.prepare("UPDATE messages SET status = 'sent', sent_at = ?, provider_id = ?, attempts = attempts + 1 WHERE id = ?").run(now, id, m.id);
            stats.sent++;
          } else {
            log.info?.(`[WhatsApp simulado → +${m.c_phone}] ${m.body}`);
            db.prepare("UPDATE messages SET status = 'simulated', sent_at = ?, attempts = attempts + 1 WHERE id = ?").run(now, m.id);
            stats.simulated++;
          }
        } catch (e) {
          const attempts = m.attempts + 1;
          const fail = e.permanent || attempts >= MAX_ATTEMPTS;
          db.prepare('UPDATE messages SET status = ?, attempts = ?, error = ?, send_at = ? WHERE id = ?')
            .run(fail ? 'failed' : 'pending', attempts, String(e.message).slice(0, 300), now + attempts * attempts * 60_000, m.id);
          if (fail) stats.failed++; else stats.deferred++;
          log.warn?.(`WhatsApp falló (msg ${m.id}): ${e.message}`);
        }
      }
    } finally {
      running = false;
    }
    return stats;
  }

  /** Cumpleaños y reactivación. Idempotente: se puede ejecutar cuantas veces se quiera. */
  function runAutomations(now = Date.now()) {
    let queued = 0;
    for (const org of svc.listOrgs()) {

      // Saludo de cumpleaños N días antes
      const target = localParts(now + org.birthday_days_before * DAY, org.timezone);
      let md = target.md;
      const cands = db.prepare('SELECT * FROM customers WHERE org_id = ? AND opt_in = 1 AND birth_md = ?').all(org.id, md);
      // 29 de febrero: en años no bisiestos se celebra el 28 (cuando 'hoy+N' cae en 28-feb)
      if (md === '02-28') {
        const leap = new Date(Date.UTC(target.year, 1, 29)).getUTCMonth() === 1;
        if (!leap) cands.push(...db.prepare("SELECT * FROM customers WHERE org_id = ? AND opt_in = 1 AND birth_md = '02-29'").all(org.id));
      }
      for (const c of cands) {
        if (svc.queueKind('birthday', org, c, now, { dedupeKey: `bday:${c.id}:${target.year}` })) queued++;
      }

      // Reactivación: dejó de venir hace winback_days
      const lapsed = db.prepare(
        'SELECT * FROM customers WHERE org_id = ? AND opt_in = 1 AND last_visit_at IS NOT NULL AND last_visit_at < ?',
      ).all(org.id, now - org.winback_days * DAY);
      for (const c of lapsed) {
        if (svc.queueKind('winback', org, c, now, { dedupeKey: `winback:${c.id}:${c.last_visit_at}` })) queued++;
      }
    }
    return { queued };
  }

  async function tick(now = Date.now()) {
    const a = runAutomations(now);
    const o = await processOutbox(now);
    return { automations: a, outbox: o };
  }

  return { processOutbox, runAutomations, tick, cloudPayload };
}
