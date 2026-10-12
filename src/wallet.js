import crypto from 'node:crypto';
import { b64u } from './util.js';

/**
 * Google Wallet (tarjeta de lealtad). Requiere credenciales de Google Wallet API:
 *   GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_EMAIL, GOOGLE_WALLET_SA_KEY (PEM de la cuenta de servicio).
 * - El enlace "Agregar a Google Wallet" es un JWT firmado con RS256 (formato documentado por Google).
 * - La actualización de sellos usa la API REST y NO se ha probado contra Google (necesita credenciales reales).
 * Apple Wallet requiere certificados de Apple Developer y no está implementado (ver README).
 */
export function createWallet({ issuerId, saEmail, saKey, baseUrl, fetchImpl = fetch, log = console }) {
  const enabled = Boolean(issuerId && saEmail && saKey);
  const classId = (org) => `${issuerId}.club_${org.id}`;
  const objectId = (customer) => `${issuerId}.member_${customer.id}`;

  const signJwt = (payload) => {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify(payload));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), saKey);
    return `${head}.${body}.${b64u(sig)}`;
  };

  const loyaltyClass = (org) => ({
    id: classId(org),
    issuerName: org.name,
    programName: `Club ${org.name}`,
    programLogo: { sourceUri: { uri: org.logo_url }, contentDescription: { defaultValue: { language: 'es', value: org.name } } },
    hexBackgroundColor: org.brand_color,
    reviewStatus: 'UNDER_REVIEW',
  });

  const loyaltyObject = (org, customer, memberCode) => ({
    id: objectId(customer),
    classId: classId(org),
    state: 'ACTIVE',
    accountId: memberCode,
    accountName: customer.name,
    loyaltyPoints: { label: `Sellos (meta ${org.stamps_goal})`, balance: { int: customer.stamps } },
    barcode: { type: 'QR_CODE', value: memberCode, alternateText: memberCode },
  });

  function saveUrl(org, customer, memberCode, now = Date.now()) {
    if (!enabled || !org.logo_url) return null;
    const jwt = signJwt({
      iss: saEmail, aud: 'google', typ: 'savetowallet', iat: Math.floor(now / 1000), origins: [baseUrl],
      payload: { loyaltyClasses: [loyaltyClass(org)], loyaltyObjects: [loyaltyObject(org, customer, memberCode)] },
    });
    return `https://pay.google.com/gp/v/save/${jwt}`;
  }

  async function accessToken(now = Date.now()) {
    const iat = Math.floor(now / 1000);
    const assertion = signJwt({
      iss: saEmail, scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
      aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
    });
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`token HTTP ${res.status}`);
    return (await res.json()).access_token;
  }

  /** Actualiza el saldo de sellos de la tarjeta ya guardada (si el cliente no la guardó, Google responde 404 y se ignora). */
  async function updateStamps(org, customer) {
    if (!enabled) return false;
    try {
      const token = await accessToken();
      const res = await fetchImpl(`https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId(customer))}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ loyaltyPoints: { label: `Sellos (meta ${org.stamps_goal})`, balance: { int: customer.stamps } } }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch (e) {
      log.warn?.(`Google Wallet: no se pudo actualizar (${e.message})`);
      return false;
    }
  }

  return { enabled, saveUrl, updateStamps, signJwt };
}
