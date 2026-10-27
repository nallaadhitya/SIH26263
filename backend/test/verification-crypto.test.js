const { SigningKeys, ISSUER, LIFETIME_SECONDS, sign, parseAndVerify, canonicalClaims } = require('../verification/crypto');

const key = Buffer.alloc(32, 17).toString('base64'); // Deterministic test-only key.
const now = 1800000000;
const claims = { v: 1, iss: ISSUER, kid: 'test', aid: '11111111-1111-4111-8111-111111111111',
  rev: '22222222-2222-4222-8222-222222222222', iat: now, exp: now + LIFETIME_SECONDS };
const configured = () => new SigningKeys({ keys: { test: key }, activeId: 'test', forbiddenSecrets: [] });

test('signs deterministic canonical claims and verifies with the configured key', () => {
  const text = sign(claims, configured());
  expect(sign(claims, configured())).toBe(text);
  expect(parseAndVerify(text, configured(), now)).toMatchObject(claims);
  expect(canonicalClaims({ ...claims })).toBe(JSON.stringify(Object.values(claims)));
  expect(text).not.toContain(key);
});

test.each([
  '', 'not JSON', '[]', 'null', '{}', '{"v":1}', 'a'.repeat(2049),
  JSON.stringify({ ...claims, sig: 'x' }),
])('rejects malformed or oversized payload %#', text => {
  expect(parseAndVerify(text, configured(), now)).toBeNull();
});

test.each([
  { v: 2 }, { iss: 'other' }, { kid: 'missing' }, { kid: ['test'] },
  { aid: ['11111111-1111-4111-8111-111111111111'] }, { rev: null },
  { iat: String(now) }, { iat: now + 1 }, { exp: now + LIFETIME_SECONDS + 1 },
  { extra: 'untrusted' }, { sig: 'a'.repeat(43) },
])('rejects altered payload fields %#', changes => {
  const payload = JSON.parse(sign(claims, configured()));
  expect(parseAndVerify(JSON.stringify({ ...payload, ...changes }), configured(), now)).toBeNull();
});

test('rejects missing fields, duplicate JSON keys, reordering, and noncanonical whitespace', () => {
  const text = sign(claims, configured());
  const parsed = JSON.parse(text);
  delete parsed.exp;
  for (const input of [JSON.stringify(parsed), text.replace('{', '{"v":1,'), ` ${text}`, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).reverse()))]) {
    expect(parseAndVerify(input, configured(), now)).toBeNull();
  }
});

test.each([null, '', '{}', 'invalid JSON', '[]', '{"test":"short"}', JSON.stringify({ test: Buffer.alloc(31).toString('base64') }),
  JSON.stringify({ 'invalid key id': key }), JSON.stringify({ test: key, duplicatedMaterial: key }),
])('missing/invalid key configuration never falls back %#', keys => {
  const ring = new SigningKeys({ keys, activeId: 'test' });
  expect(() => ring.requireIssuance()).toThrow('configuration unavailable');
  expect(() => parseAndVerify(sign(claims, configured()), ring, now)).toThrow('configuration unavailable');
});

test('refuses reused ML/session secrets in encoded or raw form', () => {
  for (const secret of [key, Buffer.alloc(32, 17).toString('utf8')]) {
    const ring = new SigningKeys({ keys: { test: key }, activeId: 'test', forbiddenSecrets: [secret] });
    expect(() => ring.requireIssuance()).toThrow('configuration unavailable');
  }
});

test('retained keys verify old artifacts; only the active key issues; removed key is invalid', () => {
  const other = Buffer.alloc(32, 29).toString('base64');
  const text = sign(claims, configured());
  const rotated = new SigningKeys({ keys: { test: key, next: other }, activeId: 'next', forbiddenSecrets: [] });
  expect(parseAndVerify(text, rotated, now)).not.toBeNull();
  const removed = new SigningKeys({ keys: { next: other }, activeId: 'next', forbiddenSecrets: [] });
  expect(parseAndVerify(text, removed, now)).toBeNull();
  const verifyOnly = new SigningKeys({ keys: { test: key }, activeId: '', forbiddenSecrets: [] });
  expect(parseAndVerify(text, verifyOnly, now)).not.toBeNull();
  expect(() => verifyOnly.requireIssuance()).toThrow();
});
