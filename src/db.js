import { DatabaseSync } from 'node:sqlite';

const SCHEMA_V1 = `
CREATE TABLE orgs (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  brand_color TEXT NOT NULL DEFAULT '#d9480f',
  logo_url TEXT NOT NULL DEFAULT '',
  stamps_goal INTEGER NOT NULL DEFAULT 8,
  reward_text TEXT NOT NULL DEFAULT 'Un postre de regalo',
  google_review_url TEXT NOT NULL DEFAULT '',
  cooldown_hours INTEGER NOT NULL DEFAULT 6,
  review_delay_min INTEGER NOT NULL DEFAULT 90,
  birthday_days_before INTEGER NOT NULL DEFAULT 7,
  winback_days INTEGER NOT NULL DEFAULT 30,
  welcome_text TEXT NOT NULL DEFAULT '¡Hola {nombre}! 🎉 Ya eres parte del club de {club}. Esta es tu tarjeta de sellos: {tarjeta}',
  review_text TEXT NOT NULL DEFAULT 'Hola {nombre}, ¿cómo estuvo tu visita a {club}? 🙌 Cuéntanos qué tal te fue: {feedback}',
  birthday_text TEXT NOT NULL DEFAULT '🎂 ¡Feliz cumpleaños, {nombre}! En {club} queremos celebrarlo contigo: {promo}. Tu tarjeta: {tarjeta}',
  birthday_promo TEXT NOT NULL DEFAULT 'un postre de cortesía en tu próxima visita',
  winback_text TEXT NOT NULL DEFAULT 'Hola {nombre}, ¡te extrañamos en {club}! 😋 Te esperamos con un detalle: {promo}. Tu tarjeta: {tarjeta}',
  winback_promo TEXT NOT NULL DEFAULT 'una bebida de cortesía',
  timezone TEXT NOT NULL DEFAULT 'America/Bogota',
  country_code TEXT NOT NULL DEFAULT '57',
  admin_email TEXT UNIQUE NOT NULL,
  admin_hash TEXT NOT NULL,
  staff_pin_hash TEXT NOT NULL,
  wa_phone_id TEXT NOT NULL DEFAULT '',
  wa_token_enc TEXT NOT NULL DEFAULT '',
  wa_templates TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE chips (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  birth_md TEXT,
  birth_year INTEGER,
  opt_in INTEGER NOT NULL DEFAULT 1,
  auth_token TEXT UNIQUE NOT NULL,
  stamps INTEGER NOT NULL DEFAULT 0,
  total_visits INTEGER NOT NULL DEFAULT 0,
  rewards_earned INTEGER NOT NULL DEFAULT 0,
  last_visit_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, phone)
);
CREATE INDEX idx_customers_org_last ON customers(org_id, last_visit_at);
CREATE INDEX idx_customers_org_bday ON customers(org_id, birth_md);

CREATE TABLE visits (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  chip_id INTEGER REFERENCES chips(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  device_id TEXT,
  counted INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'nfc',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_visits_org_time ON visits(org_id, created_at);
CREATE INDEX idx_visits_customer ON visits(customer_id, counted, created_at);
CREATE INDEX idx_visits_device ON visits(org_id, device_id, created_at);

CREATE TABLE rewards (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  UNIQUE (org_id, code)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  provider_id TEXT,
  campaign_id INTEGER,
  dedupe_key TEXT UNIQUE,
  send_at INTEGER NOT NULL,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_due ON messages(status, send_at);
CREATE INDEX idx_messages_org ON messages(org_id, created_at);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  segment TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feedback_org ON feedback(org_id, created_at);
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: v } = db.prepare('PRAGMA user_version').get();
  if (v < 1) {
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA_V1);
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

const depth = new WeakMap();

/** Transacción síncrona y reentrante (las anidadas usan SAVEPOINT). */
export function tx(db, fn) {
  const d = depth.get(db) ?? 0;
  const sp = `sp${d}`;
  db.exec(d === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth.set(db, d + 1);
  try {
    const r = fn();
    depth.set(db, d);
    db.exec(d === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth.set(db, d);
    db.exec(d === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}
