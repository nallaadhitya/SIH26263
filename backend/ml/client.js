const MODEL_VERSION = 'synthetic-isolation-forest-1.0.0';
const NULLABLE_FEATURES = ['intake_ratio', 'year_over_year_change', 'admission_year_concentration'];

class MlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validFeatures(record) {
  return Number.isSafeInteger(record.active_record_count) && record.active_record_count >= 0 && record.active_record_count <= 100000
    && [[record.intake_ratio, 0, 20], [record.year_over_year_change, -1, 20], [record.admission_year_concentration, 0, 1]]
      .every(([value, min, max]) => value === null || (Number.isFinite(value) && value >= min && value <= max));
}

function validResult(body, records) {
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  return exactKeys(body, ['model_version', 'source', 'threshold', 'results'])
    && body.model_version === MODEL_VERSION && body.source === 'ml_anomaly'
    && Number.isFinite(body.threshold) && body.threshold >= 0 && body.threshold <= 1
    && Array.isArray(body.results) && body.results.length === records.length
    && body.results.every((result, index) => exactKeys(result, ['index', 'anomaly_score', 'review_flag', 'missing_features'])
      && result.index === index && Number.isFinite(result.anomaly_score) && result.anomaly_score >= 0 && result.anomaly_score <= 1
      && typeof result.review_flag === 'boolean' && result.review_flag === (result.anomaly_score >= body.threshold)
      && Array.isArray(result.missing_features)
      && JSON.stringify(result.missing_features) === JSON.stringify(NULLABLE_FEATURES.filter((name) => records[index][name] === null)));
}

class MlClient {
  constructor({ url = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000',
    key = process.env.ML_SERVICE_KEY, timeoutMs = Number(process.env.ML_TIMEOUT_MS || 3000),
    fetchImpl = globalThis.fetch } = {}) {
    this.url = url;
    this.key = key;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async predict(records) {
    if (!records.length || records.length > 100 || !records.every(validFeatures)) {
      throw new MlError(422, 'Aggregates are outside the model input domain; manual review is required');
    }
    let url;
    try { url = new URL(this.url); } catch { throw new MlError(503, 'ML service configuration is invalid'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new MlError(503, 'ML service must use a configured loopback HTTP address');
    }
    if (typeof this.key !== 'string' || this.key.length < 32
      || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 10000) {
      throw new MlError(503, 'ML service configuration is incomplete');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(new URL('predict', url), { method: 'POST', redirect: 'error',
        signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-ML-Service-Key': this.key },
        body: JSON.stringify({ records }) });
      if (!response.ok) throw new MlError(response.status === 503 ? 503 : 502, 'ML service could not produce a result');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new MlError(502, 'ML service returned an invalid response');
      let length = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 64 * 1024) throw new MlError(502, 'ML service returned an invalid response');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new MlError(502, 'ML service returned an invalid response'); }
      if (!validResult(body, records)) throw new MlError(502, 'ML service returned an invalid response');
      return body;
    } catch (error) {
      controller.abort();
      if (error instanceof MlError) throw error;
      if (controller.signal.reason?.name === 'TimeoutError' || error.name === 'AbortError') throw new MlError(504, 'ML service timed out');
      throw new MlError(503, 'ML service is unavailable');
    } finally { clearTimeout(timer); }
  }
}

module.exports = { MlClient, MlError, MODEL_VERSION, validFeatures };
