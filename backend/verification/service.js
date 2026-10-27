const { createHash, randomUUID } = require('node:crypto');
const QRCode = require('qrcode');
const { FIELDS, reviewRows } = require('../students/validation');
const { validAccount, canAccessInstitution, hasPermission } = require('../auth/policy');
const { SigningKeys, VerificationError, ISSUER, LIFETIME_SECONDS, UUID,
  canonicalClaims, sign, parseAndVerify } = require('./crypto');

function recordFingerprint(record) {
  // This digest stays private, so public QR values cannot be used to guess fields.
  return createHash('sha256').update(JSON.stringify([
    record.id, record.verificationRevision ?? null, ...FIELDS.map(field => record[field] ?? null),
  ])).digest('hex');
}

function assertBody(body, field) {
  if (!body || Array.isArray(body) || typeof body !== 'object'
    || Object.keys(body).length !== 1 || typeof body[field] !== 'string') {
    throw new VerificationError(400, 'Invalid verification request fields');
  }
}

class VerificationService {
  constructor({ store, signing = new SigningKeys(), now = Date.now,
    renderQr = payload => QRCode.toDataURL(payload, { type: 'image/png', errorCorrectionLevel: 'M', margin: 4, width: 420 }) }) {
    this.store = store; this.signing = signing; this.now = now; this.renderQr = renderQr;
  }

  async authorize(user, permission) {
    const current = (await this.store.readCollection('users', { initialize: false })).find(entry => entry.id === user.id);
    if (!validAccount(current)) throw new VerificationError(401, 'Authentication required');
    if (!hasPermission(current, permission) || !canAccessInstitution(current, user.institutionId)) {
      throw new VerificationError(403, 'Access denied');
    }
    return current;
  }

  async issue(user, body) {
    assertBody(body, 'studentId');
    if (!UUID.test(body.studentId)) throw new VerificationError(400, 'Invalid student record reference');
    this.signing.requireIssuance();
    // Lock ordering is always students -> verification-records. Existing student
    // updates already use this queue, so API edits cannot interleave with issuance.
    return this.store.withCollectionLock('students', async () => {
      await this.authorize(user, 'verification:issue:own');
      const students = await this.store.readCollection('students', { initialize: false });
      const record = students.find(entry => entry.id === body.studentId && entry.institutionId === user.institutionId);
      if (!record) throw new VerificationError(404, 'Student record unavailable');
      const [institutions, programmes] = await Promise.all(['institutions', 'programmes']
        .map(collection => this.store.readCollection(collection, { initialize: false })));
      const input = Object.fromEntries(FIELDS.map(field => [field, record[field]]));
      const report = reviewRows([{ input, rowNumber: 1 }], user, { institutions, programmes }, students, record.id);
      if (report.summary.valid !== 1 || record.status !== 'active') {
        throw new VerificationError(422, 'Issuance requires an active, valid, nonduplicate institution record');
      }
      const iat = Math.floor(this.now() / 1000);
      const claims = { v: 1, iss: ISSUER, kid: this.signing.activeId, aid: randomUUID(), rev: randomUUID(),
        iat, exp: iat + LIFETIME_SECONDS };
      const payload = sign(claims, this.signing);
      const qrDataUrl = await this.renderQr(payload);
      await this.authorize(user, 'verification:issue:own');
      await this.store.updateCollection('verification-records', entries => [...entries, {
        kind: 'verification-artifact', schemaVersion: 1, id: claims.aid,
        studentId: record.id, institutionId: record.institutionId, recordVersion: recordFingerprint(record),
        claims, issuedBy: user.id, issuedAt: new Date(iat * 1000).toISOString(),
        status: 'active', revokedAt: null, revokedBy: null,
      }]);
      // Persistence must succeed before releasing a usable artifact.
      return { artifactId: claims.aid, revision: claims.rev, issuer: ISSUER,
        issuedAt: new Date(iat * 1000).toISOString(), expiresAt: new Date(claims.exp * 1000).toISOString(),
        payload, qrDataUrl, officialApaarAuthenticity: 'not_verified' };
    });
  }

  async revoke(user, body) {
    assertBody(body, 'artifactId');
    if (!UUID.test(body.artifactId)) throw new VerificationError(400, 'Invalid artifact reference');
    await this.store.updateCollection('verification-records', async entries => {
      await this.authorize(user, 'verification:revoke:own');
      const artifact = entries.find(entry => entry.kind === 'verification-artifact'
        && entry.id === body.artifactId && entry.institutionId === user.institutionId);
      if (!artifact) throw new VerificationError(404, 'Artifact unavailable');
      return entries.map(entry => entry !== artifact || entry.status === 'revoked' ? entry
        : { ...entry, status: 'revoked', revokedAt: new Date(this.now()).toISOString(), revokedBy: user.id });
    });
    return { status: 'revoked' };
  }

  async verify(body) {
    assertBody(body, 'payload');
    const outcome = (status, integrityValid = false, recordCurrent = null) => ({
      status, integrityValid, recordCurrent, checkedAt: new Date(this.now()).toISOString(), officialApaarAuthenticity: 'not_verified',
    });
    const payload = parseAndVerify(body.payload, this.signing, Math.floor(this.now() / 1000));
    if (!payload) return outcome('invalid');
    // Both read locks participate in the same queues as issuance/revocation/edits.
    return this.store.withCollectionLock('students', () =>
      this.store.withCollectionLock('verification-records', async () => {
        const entries = await this.store.readCollection('verification-records', { initialize: false });
        const artifact = entries.find(entry => entry.kind === 'verification-artifact' && entry.id === payload.aid);
        if (!artifact) return outcome('invalid');
        if (artifact.schemaVersion !== 1 || !artifact.claims
          || canonicalClaims(artifact.claims) !== canonicalClaims(payload)
          || !['active', 'revoked'].includes(artifact.status)
          || typeof artifact.recordVersion !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.recordVersion)
          || !UUID.test(artifact.studentId)) throw new VerificationError(503, 'Verification state unavailable');
        if (artifact.status === 'revoked') return outcome('revoked', true);
        if (Math.floor(this.now() / 1000) >= payload.exp) return outcome('expired', true);
        const students = await this.store.readCollection('students', { initialize: false });
        const record = students.find(entry => entry.id === artifact.studentId && entry.institutionId === artifact.institutionId);
        if (!record || recordFingerprint(record) !== artifact.recordVersion) return outcome('outdated', true, false);
        return outcome('valid', true, true);
      }));
  }
}

module.exports = { VerificationService, recordFingerprint };
