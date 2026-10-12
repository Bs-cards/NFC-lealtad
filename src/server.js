import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp, normalizeBase } from './app.js';
import { openDb } from './db.js';

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  let secret = env.SESSION_SECRET;
  if (!secret) {
    // Se genera una sola vez y se guarda junto a la base de datos (permisos 600).
    const f = path.join(dataDir, '.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8').trim();
  }
  return {
    dataDir, secret,
    dbFile: env.DB_FILE || path.join(dataDir, 'lealtad.db'),
    baseUrl: normalizeBase(env.BASE_URL),
    port: Number(env.PORT || 3000),
    trustProxy: env.TRUST_PROXY === '1',
    waVerifyToken: env.WA_VERIFY_TOKEN || '',
    waAppSecret: env.WA_APP_SECRET || '',
    waApiVersion: env.WA_API_VERSION || 'v21.0',
    devShowLinks: env.NODE_ENV !== 'production' && !normalizeBase(env.BASE_URL).startsWith('https://'),
    wallet: {
      issuerId: env.GOOGLE_WALLET_ISSUER_ID, saEmail: env.GOOGLE_WALLET_SA_EMAIL,
      saKey: (env.GOOGLE_WALLET_SA_KEY || '').replace(/\\n/g, '\n'),
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const cfg = loadConfig();
  const app = createApp({ ...cfg, db: openDb(cfg.dbFile) });
  const addr = await app.start(cfg.port);
  console.log(`NFC Lealtad escuchando en el puerto ${addr.port} · URL pública: ${cfg.baseUrl}`);
  const shutdown = async () => { await app.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
