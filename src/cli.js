import { openDb } from './db.js';
import { createServices } from './services.js';
import { loadConfig } from './server.js';

const [, , cmd, ...rest] = process.argv;
const args = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
const svc = createServices({ db, baseUrl: cfg.baseUrl, secret: cfg.secret });

function usage() {
  console.log(`Uso:
  node src/cli.js create-org --slug=mi-restaurante --name="Mi Restaurante" --email=dueno@correo.com --password=******** --pin=1234 [--goal=8] [--reward="Un postre"] [--tz=America/Bogota] [--cc=57]
  node src/cli.js add-chip --slug=mi-restaurante [--label="Caja"]
  node src/cli.js seed-demo        (crea un negocio de demostración con datos de ejemplo)
  node src/cli.js tick             (ejecuta automatizaciones y envía mensajes pendientes una vez)`);
}

function org(slug) {
  const o = svc.getOrgBySlug(slug);
  if (!o) { console.error('No existe el negocio', slug); process.exit(1); }
  return o;
}

try {
  if (cmd === 'create-org') {
    const r = svc.createOrg({
      slug: args.slug, name: args.name, email: args.email, password: String(args.password || ''), staffPin: String(args.pin || ''),
      stamps_goal: args.goal ? Number(args.goal) : undefined, reward_text: typeof args.reward === 'string' ? args.reward : undefined,
      timezone: args.tz, country_code: args.cc ? String(args.cc) : undefined,
    });
    const chip = svc.createChip(r.orgId, r.locationId, 'Caja');
    console.log(`Negocio creado.\n  Panel:    ${cfg.baseUrl}/admin\n  Personal: ${cfg.baseUrl}/o/${args.slug}/staff\n  Chip NFC (escribe esta URL en la etiqueta): ${svc.chipUrl(chip.token)}`);
  } else if (cmd === 'add-chip') {
    const o = org(args.slug);
    const loc = svc.get('SELECT id FROM locations WHERE org_id = ? ORDER BY id LIMIT 1', o.id);
    const chip = svc.createChip(o.id, loc.id, typeof args.label === 'string' ? args.label : '');
    console.log(svc.chipUrl(chip.token));
  } else if (cmd === 'seed-demo') {
    const now = Date.now();
    const r = svc.createOrg({ slug: 'demo', name: 'Café Demo', email: 'demo@example.com', password: 'demo-password-123', staffPin: '1234', stamps_goal: 6, reward_text: 'Un café gratis' }, now);
    const chip = svc.createChip(r.orgId, r.locationId, 'Caja', now);
    const o = svc.getOrg(r.orgId);
    const names = ['Ana Ruiz', 'Luis Mora', 'Sofía Díaz', 'Carlos Vega', 'Marta Peña'];
    names.forEach((n, i) => {
      const reg = svc.registerCustomer(o, svc.getChip(chip.token), { name: n, phone: `30012300${i}0`, birthday: `199${i}-0${i + 1}-1${i}`, consent: '1' }, `dev${i}`, now - (40 - i * 9) * 86400000);
      for (let k = 0; k < i; k++) svc.applyVisit(o, reg.customer, { now: now - (30 - i * 5 - k * 3) * 86400000 });
    });
    console.log(`Demo lista.\n  Panel: ${cfg.baseUrl}/admin  (demo@example.com / demo-password-123)\n  Personal: ${cfg.baseUrl}/o/demo/staff  (PIN 1234)\n  Chip: ${svc.chipUrl(chip.token)}`);
  } else if (cmd === 'tick') {
    const { createMessenger } = await import('./messaging.js');
    console.log(await createMessenger({ svc, secret: cfg.secret }).tick(Date.now()));
  } else usage();
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
