const { createHmac, timingSafeEqual } = require('node:crypto');

const ISSUER = 'eduverify-local';
const LIFETIME_SECONDS = 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const CLAIMS = ['v', 'iss', 'kid', 'aid', 'rev', 'iat', 'exp'];
const DOMAIN = 'EduVerify QR HMAC-SHA256 v1\n';

class VerificationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Validate lazily: other application features still work without QR configuration.
class SigningKeys {
  constructor({ keys = process.env.QR_SIGNING_KEYS, activeId = process.env.QR_ACTIVE_KEY_ID,
    forbiddenSecrets = [process.env.ML_SERVICE_KEY, process.env.SESSION_SECRET, process.env.MYSQL_PASSWORD] } = {}) {
    this.activeId = activeId;
    this.available = false;
    this.keys = new Map();
    try {
      const parsed = typeof keys === 'string' ? JSON.parse(keys) : keys;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
        || Object.keys(parsed).length < 1 || Object.keys(parsed).length > 5) return;
      const seen = new Set();
      for (const [id, value] of Object.entries(parsed)) {
        if (!KEY_ID.test(id) || typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return;
        const key = Buffer.from(value, 'base64');
        if (key.length !== 32 || key.toString('base64') !== value || seen.has(value)) return;
        if (forbiddenSecrets.filter(Boolean).some(secret => secret === value
          || Buffer.from(secret, 'utf8').equals(key))) return;
        seen.add(value); this.keys.set(id, key);
      }
      this.available = true;
    } catch { /* Missing/malformed configuration is never replaced with a default. */ }
  }

  requireVerification() {
    if (!this.available) throw new VerificationError(503, 'Verification signing configuration unavailable');
  }

  requireIssuance() {
    this.requireVerification();
    if (!KEY_ID.test(this.activeId || '') || !this.keys.has(this.activeId)) {
      throw new VerificationError(503, 'Verification signing configuration unavailable');
    }
  }
}

// Fixed field order and strictly validated scalar types avoid ambiguous signing.
function canonicalClaims(payload) {
  return JSON.stringify(CLAIMS.map(field => payload[field]));
}

function signature(payload, key) {
  return createHmac('sha256', key).update(DOMAIN).update(canonicalClaims(payload)).digest();
}

function sign(payload, keys) {
  keys.requireIssuance();
  return JSON.stringify({ ...payload, sig: signature(payload, keys.keys.get(payload.kid)).toString('base64url') });
}

function parseAndVerify(text, keys, nowSeconds) {
  keys.requireVerification();
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2048) return null;
  try {
    const payload = JSON.parse(text);
    if (!payload || Array.isArray(payload) || typeof payload !== 'object'
      || Object.keys(payload).length !== CLAIMS.length + 1
      || Object.keys(payload).some(field => ![...CLAIMS, 'sig'].includes(field))
      || payload.v !== 1 || payload.iss !== ISSUER || typeof payload.kid !== 'string' || !KEY_ID.test(payload.kid)
      || typeof payload.aid !== 'string' || !UUID.test(payload.aid)
      || typeof payload.rev !== 'string' || !UUID.test(payload.rev)
      || !Number.isSafeInteger(payload.iat) || payload.iat < 0 || payload.iat > nowSeconds
      || !Number.isSafeInteger(payload.exp) || payload.exp - payload.iat !== LIFETIME_SECONDS
      || typeof payload.sig !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.sig)) return null;
    // Only one textual representation is accepted (also rejects duplicate JSON keys).
    if (JSON.stringify(payload) !== text || Object.keys(payload).join(',') !== [...CLAIMS, 'sig'].join(',')) return null;
    const key = keys.keys.get(payload.kid);
    if (!key) return null;
    const supplied = Buffer.from(payload.sig, 'base64url');
    if (supplied.length !== 32 || supplied.toString('base64url') !== payload.sig
      || !timingSafeEqual(signature(payload, key), supplied)) return null;
    return payload;
  } catch { return null; }
}

module.exports = { SigningKeys, VerificationError, ISSUER, LIFETIME_SECONDS, UUID, canonicalClaims, sign, parseAndVerify };
