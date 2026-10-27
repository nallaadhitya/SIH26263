// Session cookies remain HttpOnly. CSRF lives only in this module's memory.
let csrf;
let generation = 0;
let onExpired = () => {};
const base = import.meta.env.VITE_API_BASE_URL || '/api';
export function setSessionHandler(handler) { onExpired = handler; }
export function clearSession() { csrf = undefined; generation += 1; }
export class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
export async function request(path, { method = 'GET', body, validate = () => true } = {}) {
  if (!base.startsWith('/') || base.startsWith('//')) throw new ApiError('Configure a same-origin API path.', 0);
  const controller = new AbortController();
  const startedGeneration = generation;
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = {};
    if (method !== 'GET') headers['X-CSRF-Token'] = csrf || '';
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, credentials: 'include', cache: 'no-store',
      signal: controller.signal, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) });
    if (startedGeneration !== generation) throw new ApiError('Session changed. Discarded the previous response.', 401);
    if (response.status === 401 && path !== '/auth/login') { clearSession(); onExpired(); }
    if (!response.ok) {
      const messages = { 400: 'Check the request fields and try again.', 401: path === '/auth/login' ? 'Invalid email or password.' : 'Session expired. Please sign in again.',
        403: 'Access denied or CSRF expired. Sign in again and check your permissions.', 404: 'Record unavailable.',
        409: 'Data or preview has changed, expired, or already been used. Refresh records and preview again before retrying.',
        413: 'Request too large. Reduce the file or narrow the filters.', 415: 'Select a UTF-8 CSV file.',
        422: path.startsWith('/v1/verification') ? 'Issuance requires an active, valid, nonduplicate record in your institution.' : 'Check required fields, programme ownership, years and identifiers.', 429: 'Request limit reached. Try again later.',
        502: 'Analysis could not be completed: invalid ML service response.', 503: path.startsWith('/v1/verification') ? 'Verification service or signing configuration unavailable.' : 'Analysis could not be completed: ML service unavailable.', 504: 'Analysis could not be completed: ML service timed out.' };
      throw new ApiError(messages[response.status] || 'Request failed. Refresh to check whether a write completed before retrying.', response.status);
    }
    if (response.status === 204) return null;
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Invalid response');
    const data = await response.json();
    if (startedGeneration !== generation) throw new ApiError('Session changed. Discarded the previous response.', 401);
    if (!data || typeof data !== 'object' || !validate(data)) throw new Error('Invalid response');
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError' ? 'Request timed out. Refresh before retrying a write.' : 'Network or invalid response error. Refresh before retrying a write.', 0);
  } finally { clearTimeout(timer); }
}
const userShape = data => typeof data.user?.id === 'string' && typeof data.user?.role === 'string' && typeof data.user?.displayName === 'string';
export async function bootstrap() {
  const data = await request('/auth/csrf', { validate: d => /^[a-f0-9]{64}$/.test(d.csrfToken) }); csrf = data.csrfToken;
}
export const me = () => request('/auth/me', { validate: userShape });
export async function login(email, password) {
  await bootstrap();
  const data = await request('/auth/login', { method: 'POST', body: { email: email.trim().toLowerCase(), password }, validate: d => userShape(d) && /^[a-f0-9]{64}$/.test(d.csrfToken) });
  csrf = data.csrfToken; return data;
}
export async function logout() { await request('/auth/logout', { method: 'POST' }); clearSession(); }
export const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '')).toString();
