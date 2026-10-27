const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { validAccount, publicUser, INSTITUTION_ROLES } = require('./policy');

const SESSION_LIFETIME_MS = 30 * 60 * 1000;
const COOKIE_NAME = 'eduverify.sid';
const newToken = () => randomBytes(32).toString('hex');
const normalizeEmail = (email) => email.trim().toLowerCase();
// Reuse a random dummy hash for unknown-user timing protection. Recomputing it
// for every app instance adds expensive work unrelated to any login request.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(newToken(), 12);

function createAuth({ store, secret = process.env.SESSION_SECRET || newToken(),
  sessionLifetimeMs = SESSION_LIFETIME_MS, loginLimit = 10,
  origin = process.env.APP_ORIGIN || 'http://localhost:5000',
  secureCookies = process.env.COOKIE_SECURE === 'true', now = Date.now } = {}) {
  const router = express.Router();
  const sessionMiddleware = session({
    name: COOKIE_NAME, secret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: secureCookies,
      maxAge: sessionLifetimeMs, path: '/' },
  });
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many requests; try again later' } }));
  router.use(sessionMiddleware);

  function requireCsrf(request, response, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const supplied = request.get('X-CSRF-Token');
    const expected = request.session.csrfToken;
    if ((request.get('Origin') && request.get('Origin') !== origin)
      || request.get('Sec-Fetch-Site') === 'cross-site'
      || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
      || typeof expected !== 'string'
      || supplied.length !== expected.length
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return response.status(403).json({ error: 'Invalid CSRF token or origin' });
    }
    return next();
  }

  async function requireAuthentication(request, response, next) {
    if (!request.session?.userId || now() >= request.session.expiresAt) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    const users = await store.readCollection('users');
    const user = users.find((entry) => entry.id === request.session.userId);
    if (!validAccount(user)) {
      await new Promise((resolve, reject) => request.session.destroy((error) => error ? reject(error) : resolve()));
      return response.status(401).json({ error: 'Authentication required' });
    }
    if (INSTITUTION_ROLES.includes(user.role)) {
      const institutions = await store.readCollection('institutions');
      if (!institutions.some((institution) => institution.id === user.institutionId)) {
        return response.status(401).json({ error: 'Authentication required' });
      }
    }
    request.user = publicUser(user);
    return next();
  }

  router.get('/csrf', (request, response) => {
    if (!request.session.csrfToken) request.session.csrfToken = newToken();
    response.json({ csrfToken: request.session.csrfToken });
  });
  router.use(requireCsrf);
  router.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: loginLimit,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many login attempts; try again later' } }), async (request, response) => {
    const body = request.body;
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string'
      || Object.keys(body).some((key) => !['email', 'password'].includes(key))
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(body.email))
      || body.email.length > 254 || Buffer.byteLength(body.password) > 72 || !body.password.length) {
      return response.status(400).json({ error: 'A valid email and password are required' });
    }
    const users = await store.readCollection('users');
    const user = users.find((entry) => entry.email === normalizeEmail(body.email));
    const matches = await bcrypt.compare(body.password, user?.passwordHash || DUMMY_PASSWORD_HASH);
    if (!matches || !validAccount(user)) {
      return response.status(401).json({ error: 'Invalid email or password' });
    }
    if (INSTITUTION_ROLES.includes(user.role)) {
      const institutions = await store.readCollection('institutions');
      if (!institutions.some((institution) => institution.id === user.institutionId)) {
        return response.status(401).json({ error: 'Invalid email or password' });
      }
    }
    await new Promise((resolve, reject) => request.session.regenerate((error) => error ? reject(error) : resolve()));
    request.session.userId = user.id;
    request.session.expiresAt = now() + sessionLifetimeMs;
    request.session.csrfToken = newToken();
    response.json({ user: publicUser(user), csrfToken: request.session.csrfToken });
  });
  router.get('/me', requireAuthentication, (request, response) => response.json({ user: request.user }));
  router.post('/logout', requireAuthentication, async (request, response) => {
    await new Promise((resolve, reject) => request.session.destroy((error) => error ? reject(error) : resolve()));
    response.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies });
    response.status(204).end();
  });

  return { router, sessionMiddleware, requireAuthentication, requireCsrf };
}

module.exports = { createAuth, normalizeEmail };
