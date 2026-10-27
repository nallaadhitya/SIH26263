const { ComplianceService } = require('../compliance/service');
const { fingerprint } = require('../compliance/canonical');
const { canAccessInstitution } = require('../auth/policy');
const { buildFeatures, FEATURE_VERSION } = require('./features');
const { MlClient, MlError } = require('./client');

class MlService {
  constructor({ store, client = new MlClient(), now = Date.now }) {
    const source = new ComplianceService({ store });
    this.inputs = source.inputs.bind(source);
    this.client = client;
    this.now = now;
  }

  async evaluate(user, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['institutionId', 'programmeId', 'academicYear'].includes(key))
      || Object.values(body).some((value) => typeof value !== 'string' || value.length > 128)) {
      throw new MlError(400, 'Invalid ML evaluation request');
    }
    if (body.institutionId !== undefined && !canAccessInstitution(user, body.institutionId)) throw new MlError(403, 'Access denied');
    const inputs = await this.inputs(user.institutionId);
    const { groups, skippedRecords } = buildFeatures(inputs);
    const selected = groups.filter((group) => (!body.programmeId || group.programmeId === body.programmeId)
      && (!body.academicYear || group.academicYear === body.academicYear));
    if (selected.length > 100) throw new MlError(413, 'Too many aggregate groups; narrow the programme or academic year filters');
    const result = selected.length ? await this.client.predict(selected.map((group) => group.features)) : null;
    const stale = fingerprint(inputs) !== fingerprint(await this.inputs(user.institutionId));
    return { source: 'ml_anomaly', status: selected.length ? 'evaluated' : 'no_data',
      modelVersion: result?.model_version || null, featureVersion: FEATURE_VERSION,
      threshold: result?.threshold ?? null, evaluatedAt: new Date(this.now()).toISOString(),
      stale, freshness: stale ? 'stale' : 'matches_checked_inputs', skippedRecords,
      authenticityVerified: false, results: selected.map((group, index) => ({
        institutionId: user.institutionId, programmeId: group.programmeId, academicYear: group.academicYear,
        anomalyScore: result.results[index].anomaly_score, reviewFlag: result.results[index].review_flag,
        missingFeatures: result.results[index].missing_features,
      })),
      limitations: ['Synthetic-demo review signals, not fraud or compliance decisions',
        'No result persistence; freshness compares only the inputs read during this request'] };
  }
}

module.exports = { MlService };
